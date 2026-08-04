import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useMenuAnchor } from '../lib/useMenuAnchor'
import { ExternalLink, Play, RotateCw, ScrollText, Square, Terminal } from 'lucide-react'
import type { ServiceView } from '@shared/api'
import { isServiceFailure, serviceStatusLabel, servicesSummary } from '@shared/services'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'
import { TerminalOutput } from './TerminalOutput'

/**
 * The Services segment — what this session is actually running.
 *
 *   ⌥ auth work │ ⎇ roxy/auth │ ▣ 1 running │ ○ local
 *
 * Background processes were previously invisible: the only way to learn a dev
 * server was up was to ask the agent. With worktree sessions that's worse, since
 * each workstream has its OWN server on its OWN port — so "which of my three
 * sessions is serving what" needs an answer you can see.
 *
 * This lives in the workstream strip rather than in a card above the composer.
 * It is the same KIND of fact as the branch and the push state — provenance
 * about where this session's work is happening — and a full-width card stacked
 * on the composer claimed far more attention than "1 stopped" deserves. As a
 * segment it costs one word until you ask for more, and the popover matches the
 * workstream menu, so the whole row behaves one way.
 *
 * The list is deliberately declarative rather than a terminal emulator. "This
 * session owns these processes" is the right mental model for N parallel
 * workstreams; a scrollback buffer is the right model for one.
 */

/** How often to refresh while the popover is OPEN, or while anything is running. */
const POLL_MS = 2_000
/**
 * Cadence when closed. Deliberately not "never": a worktree's setup script is
 * spawned on the session's first turn, long after the one-shot load on mount, so
 * polling only on session switch left the segment invisible until you clicked
 * away and back — exactly the case it exists for. The handler reads an in-memory
 * Map, so this is close to free.
 */
const IDLE_POLL_MS = 10_000
/** Log refresh while a log pane is open — faster, since it's the focus. */
const LOG_POLL_MS = 1_000
/**
 * Menu width, in px rather than a Tailwind class because the anchoring math
 * needs the number. Wider than the workstream menu: these rows carry a full
 * shell command plus a port, a status and four actions.
 */
const MENU_W = 416

/**
 * Keeps the store's service list warm and reports whether there is anything to
 * show. Split from the segment so the strip can decide whether to render a
 * divider before it without reaching into this component's state.
 */
export function useServices(): { services: ServiceView[]; sessionId: string | null } {
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const services = useRoxyStore((s) => s.services)
  const refreshServices = useRoxyStore((s) => s.refreshServices)

  useEffect(() => {
    if (!activeChatId) return
    void refreshServices(activeChatId)
  }, [activeChatId, refreshServices])

  const anyRunning = services.some((s) => s.status === 'running')
  useEffect(() => {
    if (!activeChatId) return
    const every = anyRunning ? POLL_MS : IDLE_POLL_MS
    const timer = setInterval(() => void refreshServices(activeChatId), every)
    return () => clearInterval(timer)
  }, [anyRunning, activeChatId, refreshServices])

  return { services, sessionId: activeChatId }
}

export function ServicesSegment({
  services,
  sessionId
}: {
  services: ServiceView[]
  sessionId: string
}): JSX.Element {
  const refreshServices = useRoxyStore((s) => s.refreshServices)
  const [open, setOpen] = useState(false)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // The widest menu in the strip, on the segment that sits furthest right — so
  // it is the first one to run off the window edge if left unclamped.
  const anchor = useMenuAnchor(ref, open, MENU_W)

  // While the popover is open, poll fast regardless of state: the user is
  // watching, and an install that finishes should say so immediately.
  useEffect(() => {
    if (!open || !sessionId) return
    const timer = setInterval(() => void refreshServices(sessionId), POLL_MS)
    return () => clearInterval(timer)
  }, [open, sessionId, refreshServices])

  // Closing drops any open log pane, so reopening starts clean.
  useEffect(() => {
    if (!open) setLogsFor(null)
  }, [open])

  // Click-outside + Escape, matching the workstream menu next door.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const running = services.filter((s) => s.status === 'running').length
  const failed = services.filter(isServiceFailure).length

  return (
    <div className="relative" ref={ref}>
      {open && (
        <ServicesMenu
          services={services}
          sessionId={sessionId}
          logsFor={logsFor}
          style={anchor}
          onToggleLogs={(id) => setLogsFor((cur) => (cur === id ? null : id))}
        />
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Processes this session is running"
        className={cn(
          'flex min-w-0 items-center gap-1.5 sq sq-md rounded-md px-1.5 py-1 transition hover:bg-white/5',
          open ? 'text-text' : 'text-text-muted hover:text-text'
        )}
      >
        {/* A live dot beats an icon for "something is running" — it is the same
            language the rows themselves use. */}
        {running > 0 ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        ) : (
          <Terminal className="h-3.5 w-3.5 shrink-0 opacity-70" />
        )}
        {/* Collapsed, this is the ONLY thing most people read, so it states the
            outcome rather than the process state: a setup script that succeeded
            must not look like one that died.

            A failure here is deliberately NOT red. These are the agent's own
            background processes: a probe that exits 1, a build the model ran to
            see what breaks. None of them are emergencies the user must act on.
            Red is a claim on attention, and spending it on routine debugging
            noise teaches people to ignore it everywhere else in the app. Grey
            states the fact and leaves it there. */}
        <span className={cn('truncate', failed > 0 && 'text-text-muted')}>
          {servicesSummary(services)}
        </span>
      </button>
    </div>
  )
}

/** The popover: one row per process, same shape as the workstream menu. */
function ServicesMenu({
  services,
  sessionId,
  logsFor,
  onToggleLogs,
  style
}: {
  services: ServiceView[]
  sessionId: string
  logsFor: string | null
  onToggleLogs: (id: string) => void
  /** Width + edge-clamped offset + height cap, from useMenuAnchor. */
  style: CSSProperties
}): JSX.Element {
  return (
    // `left` and `maxHeight` come from the anchor rather than from classes: a
    // fixed `left-0` on a trigger this far right sends the menu off the window,
    // and there is no scroll container to rescue it.
    <div className="absolute bottom-full z-50 flex flex-col pb-1.5" style={style}>
      <div className="flex min-h-0 flex-col overflow-hidden sq-frame sq-xl sq-fill-elevated sq-ring rounded-xl border border-border bg-elevated py-1 shadow-2xl">
        <div className="shrink-0 px-3 py-1 text-[11px] font-medium text-text-muted">Processes</div>
        {/* Scrolls instead of growing past the top of the window: a worktree
            setup can leave several processes behind, and the header has to stay
            on screen or the list loses its label. */}
        <div className="min-h-0 overflow-y-auto">
          {services.map((svc) => (
            <ServiceRow
              key={svc.id}
              service={svc}
              sessionId={sessionId}
              logsOpen={logsFor === svc.id}
              onToggleLogs={() => onToggleLogs(svc.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ServiceRow({
  service,
  sessionId,
  logsOpen,
  onToggleLogs
}: {
  service: ServiceView
  sessionId: string
  logsOpen: boolean
  onToggleLogs: () => void
}): JSX.Element {
  const refreshServices = useRoxyStore((s) => s.refreshServices)
  const [busy, setBusy] = useState(false)
  const isRunning = service.status === 'running'
  const failed = isServiceFailure(service)

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      await refreshServices(sessionId)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            isRunning ? 'bg-success' : failed ? 'bg-text-muted' : 'bg-text-subtle/50'
          )}
          title={service.status}
        />
        {/* Full command on hover — truncated here to keep the row one line. */}
        <span className="min-w-0 flex-1 truncate font-mono text-text-muted" title={service.command}>
          {service.command}
        </span>
        {service.port != null && isRunning && (
          <span className="shrink-0 tabular-nums text-text-subtle">:{service.port}</span>
        )}
        <span
          className={cn('shrink-0 tabular-nums', failed ? 'text-text-muted' : 'text-text-subtle')}
          title={service.state}
        >
          {serviceStatusLabel(service)}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          <RowAction onClick={onToggleLogs} label="Logs" active={logsOpen}>
            <ScrollText className="h-3 w-3" />
          </RowAction>
          <RowAction
            onClick={() => void act(() => api().services.restart(sessionId, service.id))}
            label={isRunning ? 'Restart' : 'Start'}
            disabled={busy}
          >
            {isRunning ? <RotateCw className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </RowAction>
          {isRunning && (
            <RowAction
              onClick={() => void act(() => api().services.stop(sessionId, service.id))}
              label="Stop"
              disabled={busy}
            >
              <Square className="h-3 w-3" />
            </RowAction>
          )}
          {isRunning && service.port != null && (
            <RowAction
              onClick={() => void api().services.open(sessionId, service.port!)}
              label={`Open localhost:${service.port} in this session's browser`}
            >
              <ExternalLink className="h-3 w-3" />
            </RowAction>
          )}
        </div>
      </div>

      {logsOpen && <ServiceLogs sessionId={sessionId} service={service} />}
    </div>
  )
}

/** Live log pane. Polls only while open, and only for the one expanded service. */
function ServiceLogs({
  sessionId,
  service
}: {
  sessionId: string
  service: ServiceView
}): JSX.Element {
  const [text, setText] = useState('')
  const paneRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const load = useCallback(async () => {
    try {
      setText(await api().services.output(sessionId, service.id))
    } catch {
      // Keep whatever we have.
    }
  }, [sessionId, service.id])

  useEffect(() => {
    void load()
    if (service.status !== 'running') return
    const timer = setInterval(() => void load(), LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [load, service.status])

  // Follow the tail, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    const el = paneRef.current?.querySelector('pre')
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <div
      ref={paneRef}
      onScrollCapture={(e) => {
        const el = e.target as HTMLElement
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      <TerminalOutput
        text={text}
        state={service.status === 'running' ? 'running' : failedState(service)}
        className="max-h-56 overflow-auto border-y border-border bg-[#0b0b0d] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#d4d4d4]"
      />
    </div>
  )
}

function failedState(s: ServiceView): 'done' | 'error' {
  return isServiceFailure(s) ? 'error' : 'done'
}

function RowAction({
  children,
  onClick,
  label,
  disabled,
  active
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
  disabled?: boolean
  active?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'flex h-5 w-5 items-center justify-center sq sq-base rounded transition',
        active ? 'bg-white/10 text-text' : 'text-text-subtle hover:bg-white/5 hover:text-text',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      {children}
    </button>
  )
}

/** Lazily reach the preload bridge (keeps this module import-light). */
function api(): typeof window.roxy {
  return window.roxy
}
