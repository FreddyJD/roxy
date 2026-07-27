import { Check } from 'lucide-react'
import type { Chat } from '@shared/types'
import { cn } from '../lib/cn'

/**
 * A slim strip under the chat header showing the session's agent-set
 * description and task checklist (managed by the `change_session_metadata`
 * tool). Read-only — the agent maintains it. Renders nothing when empty.
 */
export function SessionInfo({ chat }: { chat: Chat }): JSX.Element | null {
  const tasks = chat.tasks ?? []
  const description = chat.description?.trim()
  if (!description && tasks.length === 0) return null
  const done = tasks.filter((t) => t.status === 'completed').length

  return (
    <div className="shrink-0 border-b border-border bg-surface/40 px-4 py-2.5">
      {description && <p className="text-xs leading-relaxed text-text-muted">{description}</p>}
      {tasks.length > 0 && (
        <div className={cn(description && 'mt-2')}>
          <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
            <span>Tasks</span>
            <span className="tabular-nums">
              {done}/{tasks.length}
            </span>
          </div>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {tasks.map((t, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full',
                    t.status === 'completed'
                      ? 'bg-success/20 text-success'
                      : t.status === 'in_progress'
                        ? 'bg-accent/20'
                        : 'ring-1 ring-inset ring-text-subtle/50'
                  )}
                >
                  {t.status === 'completed' ? (
                    <Check className="h-2.5 w-2.5" />
                  ) : t.status === 'in_progress' ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  ) : null}
                </span>
                <span
                  className={cn(
                    'min-w-0 truncate',
                    t.status === 'completed'
                      ? 'text-text-subtle line-through'
                      : t.status === 'in_progress'
                        ? 'text-text'
                        : 'text-text-muted'
                  )}
                >
                  {t.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
