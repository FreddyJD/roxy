import { useState } from 'react'
import { Plus, Repeat, Trash2 } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { Button, Input, Textarea } from './ui'
import { cn } from '../lib/cn'

const INTERVALS = [1, 5, 15, 30, 60]

export function LoopsSection(): JSX.Element {
  const loops = useRoxyStore((s) => s.loops)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const removeLoop = useRoxyStore((s) => s.removeLoop)
  const [creating, setCreating] = useState(false)

  return (
    <section>
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
          <Repeat className="h-3.5 w-3.5" /> Loops
        </span>
        <button
          onClick={() => setCreating(true)}
          title="New loop"
          className="flex h-5 w-5 items-center justify-center rounded text-text-subtle transition hover:bg-white/5 hover:text-text"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {loops.length === 0 ? (
        <button
          onClick={() => setCreating(true)}
          className="w-full rounded-lg border border-dashed border-border px-2.5 py-2 text-left text-xs text-text-subtle transition hover:border-border-strong hover:text-text-muted"
        >
          Create a loop — a prompt on a heartbeat
        </button>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {loops.map((loop) => (
            <li key={loop.id}>
              <div
                className={cn(
                  'group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition',
                  loop.chatId === activeChatId
                    ? 'bg-elevated text-text'
                    : 'text-text-muted hover:bg-white/5 hover:text-text'
                )}
              >
                <HeartbeatDot enabled={loop.enabled} />
                <button onClick={() => selectChat(loop.chatId)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate">{loop.name}</span>
                  <span className="block text-[11px] text-text-subtle">
                    every {loop.intervalMinutes}m{loop.enabled ? '' : ' · paused'}
                  </span>
                </button>
                <button
                  onClick={() => removeLoop(loop.id)}
                  title="Delete loop"
                  className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-subtle transition hover:bg-white/5 hover:text-danger group-hover:flex"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating && <NewLoopDialog onClose={() => setCreating(false)} />}
    </section>
  )
}

function HeartbeatDot({ enabled }: { enabled: boolean }): JSX.Element {
  if (!enabled) return <span className="h-2 w-2 shrink-0 rounded-full bg-text-subtle/40" />
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
    </span>
  )
}

function NewLoopDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const createLoop = useRoxyStore((s) => s.createLoop)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState(5)
  const [busy, setBusy] = useState(false)

  const canCreate = name.trim().length > 0 && prompt.trim().length > 0

  const submit = async (): Promise<void> => {
    if (!canCreate || busy) return
    setBusy(true)
    try {
      await createLoop({ name: name.trim(), prompt: prompt.trim(), intervalMinutes })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">New loop</h2>
        <p className="mt-1 text-sm text-text-muted">
          A loop runs a prompt on a heartbeat — like a cron job for your agent. It posts into its own
          chat, where you can step in any time.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-muted">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. PR watcher"
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-muted">Prompt (runs every heartbeat)</span>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Check the open PR, resolve review comments, and report the status. When it merges, start the next feature."
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-muted">Heartbeat</span>
            <select
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className="h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none transition focus:border-accent/70"
            >
              {INTERVALS.map((m) => (
                <option key={m} value={m}>
                  Every {m} minute{m === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canCreate || busy}>
            {busy ? 'Creating…' : 'Create loop'}
          </Button>
        </div>
      </div>
    </div>
  )
}
