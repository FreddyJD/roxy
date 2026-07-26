import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, ExternalLink, Play, RotateCw, ScrollText, Square } from 'lucide-react'
import type { ServiceView } from '@shared/api'
import { isServiceFailure, serviceStatusLabel, servicesSummary } from '@shared/services'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'
import { TerminalOutput } from './TerminalOutput'

/**
 * The Services panel — what this session is actually running.
 *
 *   ▾ SERVICES
 *     ● dev  :3101  running 4m   [logs] [restart] [stop] [open ↗]
 *
 * Background processes were previously invisible: the only way to learn a dev
 * server was up was to ask the agent. With worktree sessions that's worse, since
 * each workstream has its OWN server on its OWN port — so "which of my three
 * sessions is serving what" needs an answer you can see.
 *
 * Deliberately a declarative list rather than a terminal emulator. "This session
 * owns these processes" is the right mental model for N parallel workstreams; a
 * scrollback buffer is the right model for one.
 */

/** How often to refresh while the panel is OPEN, or while anything is running. */
const POLL_MS = 2_000
/**
 * Cadence when COLLAPSED. Deliberately not "never": a worktree's setup script is
 * spawned on the session's first turn, long after the one-shot load on mount, so
 * polling only on session switch left the panel invisible until you clicked away
 * and back — exactly the case it exists for. The handler reads an in-memory Map,
 * so this is close to free.
 */
const IDLE_POLL_MS = 10_000
/** Log refresh while a log pane is open — faster, since it's the focus. */
const LOG_POLL_MS = 1_000

export function ServicesPanel(): JSX.Element | null {
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const services = useRoxyStore((s) => s.services)
  const refreshServices = useRoxyStore((s) => s.refreshServices)
  const [open, setOpen] = useState(false)
  const [logsFor, setLogsFor] = useState<string | null>(null)

  // One cheap load on session switch tells us whether to show the header at all.
  useEffect(() => {
    if (!activeChatId) return
    void refreshServices(activeChatId)
  }, [activeChatId, refreshServices])

  // Keep polling when collapsed too, just slowly: a setup script that starts (or
  // finishes) mid-session has to be able to reach the panel on its own.
  const anyRunning = services.some((s) => s.status === 'running')
  useEffect(() => {
    if (!activeChatId) return
    const every = open || anyRunning ? POLL_MS : IDLE_POLL_MS
    const timer = setInterval(() => void refreshServices(activeChatId), every)
    return () => clearInterval(timer)
  }, [open, anyRunning, activeChatId, refreshServices])

  // Collapsing closes any open log pane, so reopening starts clean.
  useEffect(() => {
    if (!open) setLogsFor(null)
  }, [open])

  if (!activeChatId || services.length === 0) return null

  const failed = services.filter(isServiceFailure).length

  return (
    // Same px-4 gutter + centered max-w-3xl column as the composer and the
    // workstream strip, so the panel reads as part of that stack instead of a
    // full-bleed bar stretched across a wide window.
    <div className="shrink-0 px-4 pb-1">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-border bg-elevated/40">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-text-muted transition hover:bg-white/5 hover:text-text"
        >
          <ChevronRight className={cn('h-3 w-3 transition', open && 'rotate-90')} />
          <span>SERVICES</span>
          {/* Collapsed, this line is the ONLY thing most people read, so it has
              to state the outcome. "1 stopped" for a clean install was a lie by
              omission: a setup script that succeeded looked identical to one
              that died. Failures stay tinted so a broken worktree setup is
              visible without expanding. */}
          <span className={cn(failed > 0 ? 'text-danger' : 'text-text-subtle')}>
            {servicesSummary(services)}
          </span>
        </button>

        {open && (
          <div className="border-t border-border">
            {services.map((svc) => (
              <ServiceRow
                key={svc.id}
                service={svc}
                sessionId={activeChatId}
                logsOpen={logsFor === svc.id}
                onToggleLogs={() => setLogsFor((cur) => (cur === svc.id ? null : svc.id))}
              />
            ))}
          </div>
        )}
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
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            isRunning ? 'bg-success' : failed ? 'bg-danger' : 'bg-text-subtle/50'
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
          className={cn('shrink-0 tabular-nums', failed ? 'text-danger' : 'text-text-subtle')}
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
        className="max-h-56 overflow-auto border-t border-border bg-[#0b0b0d] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#d4d4d4]"
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
        'flex h-5 w-5 items-center justify-center rounded transition',
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
