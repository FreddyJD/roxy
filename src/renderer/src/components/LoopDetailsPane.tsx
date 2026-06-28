import { Repeat, X } from 'lucide-react'
import type { Chat, Loop } from '@shared/types'
import { cn } from '../lib/cn'

function fmtTime(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

/** Rough relative time like "in 4m" / "2h ago" for the schedule rows. */
function rel(ts: number | null): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  const past = diff < 0
  const m = Math.round(Math.abs(diff) / 60000)
  if (m < 1) return past ? 'just now' : 'in <1m'
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return past ? `${h}h ago` : `in ${h}h`
  const d = Math.round(h / 24)
  return past ? `${d}d ago` : `in ${d}d`
}

function Row({
  label,
  children,
  mono
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
        {label}
      </span>
      <div className={cn('break-words text-sm text-text', mono && 'font-mono text-xs text-text-muted')}>
        {children}
      </div>
    </div>
  )
}

/**
 * A read-only side pane that lays out exactly how a loop is configured — handy
 * for reviewing/debugging a workflow without touching it. Slides in below the
 * ChatView header (the parent is `relative`).
 */
export function LoopDetailsPane({
  loop,
  chat,
  onClose
}: {
  loop: Loop
  chat: Chat
  onClose: () => void
}): JSX.Element {
  return (
    <aside className="absolute bottom-0 right-0 top-12 z-30 flex w-80 flex-col border-l border-border bg-surface shadow-2xl">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Repeat className="h-3.5 w-3.5 text-text-muted" />
          <span className="text-sm font-medium">Loop settings</span>
        </div>
        <button
          onClick={onClose}
          title="Close"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <Row label="Name">{loop.name}</Row>

        <Row label="Status">
          <span className="flex items-center gap-2">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                loop.enabled ? 'bg-success' : 'bg-text-subtle'
              )}
            />
            {loop.enabled ? 'Running' : 'Paused'} · every {loop.intervalMinutes}m
          </span>
        </Row>

        <Row label="Prompt">
          <div className="whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-2.5 text-xs leading-relaxed text-text-muted">
            {loop.prompt}
          </div>
        </Row>

        <Row label="Next run">
          {fmtTime(loop.nextRunAt)}
          {rel(loop.nextRunAt) && <span className="text-text-subtle"> · {rel(loop.nextRunAt)}</span>}
        </Row>

        <Row label="Last run">
          {loop.lastRunAt ? (
            <>
              {fmtTime(loop.lastRunAt)}
              <span className="text-text-subtle"> · {rel(loop.lastRunAt)}</span>
            </>
          ) : (
            'Never'
          )}
        </Row>

        <Row label="Workspace" mono>
          {chat.workspacePath ?? '—'}
        </Row>

        <Row label="Created">{fmtTime(loop.createdAt)}</Row>
        <Row label="Loop ID" mono>
          {loop.id}
        </Row>
        <Row label="Chat ID" mono>
          {loop.chatId}
        </Row>

        <p className="mt-1 text-[11px] leading-relaxed text-text-subtle">
          Read-only. Ask Roxy to change a loop with the loop tools (e.g. “pause the {loop.name}
          loop”).
        </p>
      </div>
    </aside>
  )
}
