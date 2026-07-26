import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  ExternalLink,
  Play,
  RotateCw,
  ScrollText,
  Square
} from 'lucide-react'
import type { ServiceView } from '@shared/api'
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

/** How often to refresh while the panel is OPEN. Closed, it doesn't poll at all. */
const POLL_MS = 2_000
/** Log refresh while a log pane is open — faster, since it's the focus. */
const LOG_POLL_MS = 1_000

export function ServicesPanel(): JSX.Element | null {
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const services = useRoxyStore((s) => s.services)
  const refreshServices = useRoxyStore((s) => s.refreshServices)
  const [open, setOpen] = useState(false)
  const [logsFor, setLogsFor] = useState<string | null>(null)

  // One cheap load on session switch tells us whether to show the header at all;
  // the interval only runs while expanded.
  useEffect(() => {
    if (!activeChatId) return
    void refreshServices(activeChatId)
  }, [activeChatId, refreshServices])

  useEffect(() => {
    if (!open || !activeChatId) return
    const timer = setInterval(() => void refreshServices(activeChatId), POLL_MS)
    return () => clearInterval(timer)
  }, [open, activeChatId, refreshServices])

  // Collapsing closes any open log pane, so reopening starts clean.
  useEffect(() => {
    if (!open) setLogsFor(null)
  }, [open])

  if (!activeChatId || services.length === 0) return null

  const running = services.filter((s) => s.status === 'running').length

  return (
    <div className="shrink-0 px-4 pb-1">
      <div className="overflow-hidden rounded-lg border border-border bg-elevated/40">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-text-muted transition hover:bg-white/5 hover:text-text"
        >
          <ChevronRight className={cn('h-3 w-3 transition', open && 'rotate-90')} />
          <span>SERVICES</span>
          <span className="text-text-subtle">
            {running > 0 ? `${running} running` : `${services.length} stopped`}
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
  const failed = service.status === 'error' || (service.exitCode != null && service.exitCode !== 0)

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
        <span className="shrink-0 tabular-nums text-text-subtle">{service.state}</span>

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
  return s.status === 'error' || (s.exitCode != null && s.exitCode !== 0) ? 'error' : 'done'
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
