import { useState } from 'react'
import { useRoxyStore } from '../lib/store'
import { Button, Input, Textarea } from './ui'
import { formatInterval } from '@shared/format'

// Heartbeat presets, in minutes -- minute-grained to an hour, then hours/day.
const INTERVALS = [1, 5, 15, 30, 60, 180, 360, 720, 1440]

export function HeartbeatDot({ enabled }: { enabled: boolean }): JSX.Element {
  if (!enabled) return <span className="h-2 w-2 shrink-0 rounded-full bg-text-subtle/40" />
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
    </span>
  )
}

export function NewLoopDialog({
  workspacePath,
  projectName,
  onClose
}: {
  workspacePath: string | null
  projectName?: string
  onClose: () => void
}): JSX.Element {
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
      await createLoop({ name: name.trim(), prompt: prompt.trim(), intervalMinutes, workspacePath })
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
          A loop runs a prompt on a heartbeat — like a cron job for your agent
          {projectName ? ` in ${projectName}` : ''}. It posts into its own chat, where you can step
          in any time.
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
                  Every {formatInterval(m)}
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
