import { useEffect, useRef, useState } from 'react'
import { Terminal as TerminalIcon, Trash2 } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

/**
 * A persistent terminal session — the user-facing view of a long-lived shell
 * (the same sessions the agent's terminal_* tools drive). It streams the shell's
 * cleaned output buffer live and writes typed commands to the shell's stdin.
 *
 * Dependency-free on purpose: the output is re-read (coalesced via rAF) from the
 * main-process ring buffer on each `data` event, so ANSI escapes / the
 * completion sentinel are stripped server-side. A future upgrade can swap this
 * <pre> for xterm.js behind the same IPC for full color/cursor fidelity.
 */
export function TerminalView({ id }: { id: string }): JSX.Element {
  const terminal = useRoxyStore((s) => s.terminals.find((t) => t.id === id))
  const killTerminal = useRoxyStore((s) => s.killTerminal)
  const [output, setOutput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Load the buffer on open + re-read it live as output streams in.
  useEffect(() => {
    let alive = true
    let raf = 0
    const load = async (): Promise<void> => {
      const text = await api.terminal.read(id)
      if (alive) setOutput(text)
    }
    void load()
    const off = api.terminal.onData((p) => {
      if (p.id !== id) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => void load())
    })
    return () => {
      alive = false
      off()
      cancelAnimationFrame(raf)
    }
  }, [id])

  // Pin to the latest output.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  // Focus the prompt when the session opens.
  useEffect(() => {
    inputRef.current?.focus()
  }, [id])

  const exited = terminal?.status === 'exited'

  const run = (): void => {
    const el = inputRef.current
    if (!el || exited) return
    void api.terminal.write(id, el.value + '\n')
    el.value = ''
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      <header className="titlebar reserve-controls-right flex h-12 shrink-0 items-center gap-2 px-4">
        <TerminalIcon
          className={cn('h-4 w-4 shrink-0', exited ? 'text-text-subtle' : 'text-success')}
        />
        <span className="shrink-0 text-sm font-medium">{terminal?.name ?? 'Terminal'}</span>
        <span className="truncate text-xs text-text-subtle" title={terminal?.cwd}>
          {terminal?.shell}
          {exited ? ` · exited${terminal?.exitCode != null ? ` (${terminal.exitCode})` : ''}` : ''}
        </span>
        <button
          onClick={() => void killTerminal(id)}
          title="Kill terminal"
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-[#070708] px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-muted">
          {output || (exited ? '(session ended)' : 'Starting shell…')}
        </pre>
      </div>

      <div className="bg-bg p-3">
        <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 focus-within:border-border-strong">
          <span className="shrink-0 font-mono text-xs text-text-subtle">$</span>
          <input
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            disabled={exited}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run()
            }}
            placeholder={
              exited ? 'Session ended — kill it and start a new one.' : 'Type a command, press Enter…'
            }
            className="h-9 flex-1 bg-transparent font-mono text-xs text-text outline-none placeholder:text-text-subtle disabled:opacity-50"
          />
        </div>
      </div>
    </div>
  )
}
