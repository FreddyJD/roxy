/**
 * Persistent terminal sessions — long-lived shells the agent (and, soon, the
 * user) can drive: start a dev server and keep it running, send commands, read
 * the streamed output. Cross-platform: PowerShell on Windows, `$SHELL`
 * (bash/zsh) on macOS/Linux.
 *
 * No PTY (so ZERO native dependencies — nothing to rebuild for Electron). The
 * shell is a normal long-lived child process; we write commands to its stdin
 * and detect when each finishes with a unique sentinel marker echoed after the
 * command. A node-pty + xterm.js upgrade can later slot in behind this same
 * interface for true terminal emulation.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { TerminalSessionInfo } from '../../shared/api'

/** Ring-buffer cap per session (chars) — keeps memory bounded for chatty servers. */
const MAX_BUFFER = 200_000
/** Unique marker echoed after each command so we know when it finished. */
const DONE = '__ROXY_DONE__'
/** Default wait for a command to finish before treating it as long-running. */
const DEFAULT_TIMEOUT = 15_000

export interface CommandResult {
  output: string
  exitCode: number | null
  /** True when the command was still running when we returned (e.g. a server). */
  timedOut: boolean
}

interface Pending {
  resolve: (r: CommandResult) => void
  acc: string
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  id: string
  name: string
  shell: string
  cwd: string
  proc: ChildProcess
  buffer: string
  status: 'running' | 'exited'
  exitCode: number | null
  createdAt: number
  /** The in-flight command awaiting its sentinel, if any. */
  pending: Pending | null
}

let seq = 0
const sessions = new Map<string, Session>()

/** Emits `data` {id, chunk}, `exit` {id, code}, and `sessions` (list changed). */
export const terminalEvents = new EventEmitter()

/** The platform's default interactive shell. */
function shellSpec(): { cmd: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NoLogo'], label: 'powershell' }
  }
  const sh = process.env.SHELL || '/bin/bash'
  return { cmd: sh, args: [], label: sh.split('/').pop() || sh }
}

/** Strip ANSI escapes, our sentinel lines, and bare PowerShell prompts. */
function clean(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // ANSI CSI sequences
    .replace(new RegExp('.*' + DONE + '-?\\d*.*\\r?\\n?', 'g'), '') // completion sentinel
    .replace(/^PS [^\n]*?>[ ]?/gm, '') // Windows PowerShell prompts
}

function toInfo(s: Session): TerminalSessionInfo {
  return {
    id: s.id,
    name: s.name,
    shell: s.shell,
    cwd: s.cwd,
    status: s.status,
    exitCode: s.exitCode,
    busy: s.pending !== null,
    createdAt: s.createdAt
  }
}

/** Append output to a session, stream it, and resolve a pending command on its sentinel. */
function append(s: Session, chunk: string): void {
  s.buffer += chunk
  if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER)
  terminalEvents.emit('data', { id: s.id, chunk })
  const p = s.pending
  if (!p) return
  p.acc += chunk
  const m = p.acc.match(new RegExp(DONE + '(-?\\d*)'))
  if (!m || m.index === undefined) return
  const raw = m[1]
  const code = raw === '' ? null : Number.parseInt(raw, 10)
  s.pending = null
  clearTimeout(p.timer)
  p.resolve({
    output: clean(p.acc.slice(0, m.index)).trim(),
    exitCode: code !== null && Number.isNaN(code) ? null : code,
    timedOut: false
  })
  terminalEvents.emit('sessions')
}

/** Start a new persistent shell in `cwd`. */
export function createSession(opts: { cwd: string; name?: string }): TerminalSessionInfo {
  const spec = shellSpec()
  const id = `term-${++seq}`
  const cwd = opts.cwd || process.cwd()
  const proc = spawn(spec.cmd, spec.args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, TERM: 'xterm-256color' }
  })
  const session: Session = {
    id,
    name: opts.name?.trim() || `Terminal ${seq}`,
    shell: spec.label,
    cwd,
    proc,
    buffer: '',
    status: 'running',
    exitCode: null,
    createdAt: Date.now(),
    pending: null
  }
  sessions.set(id, session)
  proc.stdout?.on('data', (b: Buffer) => append(session, b.toString()))
  proc.stderr?.on('data', (b: Buffer) => append(session, b.toString()))
  proc.on('exit', (code) => {
    session.status = 'exited'
    session.exitCode = code ?? null
    const p = session.pending
    if (p) {
      session.pending = null
      clearTimeout(p.timer)
      p.resolve({ output: clean(p.acc).trim(), exitCode: code ?? null, timedOut: false })
    }
    terminalEvents.emit('exit', { id, code: code ?? null })
    terminalEvents.emit('sessions')
  })
  proc.on('error', (e) => append(session, `\n[shell error: ${e.message}]\n`))
  // Quiet the PowerShell prompt so the buffer isn't full of "PS C:\>" noise.
  if (process.platform === 'win32') {
    try {
      proc.stdin?.write('function prompt { "" }\n')
    } catch {
      /* best effort */
    }
  }
  terminalEvents.emit('sessions')
  return toInfo(session)
}

/**
 * Run a command in a session and resolve when it finishes (sentinel) or after
 * `timeoutMs` (for long-running processes like dev servers — they keep running
 * in the background; read more with `readOutput`).
 */
export function sendCommand(
  id: string,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT
): Promise<CommandResult> {
  const s = sessions.get(id)
  if (!s) return Promise.resolve({ output: `No terminal session "${id}".`, exitCode: null, timedOut: false })
  if (s.status === 'exited') {
    return Promise.resolve({ output: `Session "${id}" has exited.`, exitCode: s.exitCode, timedOut: false })
  }
  // A command is already running (e.g. a dev server owns the shell): treat this
  // as raw input to that process, like typing into a real terminal.
  if (s.pending) {
    writeInput(id, command + '\n')
    return Promise.resolve({ output: '(sent to the running process)', exitCode: null, timedOut: false })
  }
  return new Promise<CommandResult>((resolve) => {
    const timer = setTimeout(() => {
      const p = s.pending
      if (!p) return
      s.pending = null
      p.resolve({ output: clean(p.acc).trim(), exitCode: null, timedOut: true })
      terminalEvents.emit('sessions')
    }, timeoutMs)
    s.pending = { resolve, acc: '', timer }
    terminalEvents.emit('sessions')
    const marker =
      process.platform === 'win32' ? `Write-Output "${DONE}$LASTEXITCODE"` : `echo "${DONE}$?"`
    try {
      s.proc.stdin?.write(`${command}\n${marker}\n`)
    } catch (e) {
      clearTimeout(timer)
      s.pending = null
      resolve({
        output: `write failed: ${e instanceof Error ? e.message : String(e)}`,
        exitCode: null,
        timedOut: false
      })
    }
  })
}

/** Write raw bytes to a session's stdin (interactive input — used by the UI). */
export function writeInput(id: string, data: string): boolean {
  const s = sessions.get(id)
  if (!s || s.status === 'exited') return false
  try {
    s.proc.stdin?.write(data)
    return true
  } catch {
    return false
  }
}

/** The recent (cleaned) output of a session, tail-trimmed for the agent. */
export function readOutput(id: string, tailChars = 8_000): string {
  const s = sessions.get(id)
  if (!s) return ''
  const text = clean(s.buffer)
  return text.length > tailChars ? '…\n' + text.slice(-tailChars) : text
}

export function listSessions(): TerminalSessionInfo[] {
  return [...sessions.values()].map(toInfo)
}

export function getSession(id: string): TerminalSessionInfo | undefined {
  const s = sessions.get(id)
  return s ? toInfo(s) : undefined
}

/** Kill a session's process and drop it. */
export function killSession(id: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  const p = s.pending
  if (p) {
    s.pending = null
    clearTimeout(p.timer)
    p.resolve({ output: clean(p.acc).trim(), exitCode: null, timedOut: false })
  }
  try {
    s.proc.kill()
  } catch {
    /* already gone */
  }
  sessions.delete(id)
  terminalEvents.emit('sessions')
  return true
}

/** Kill every session (call on app quit so no shell/dev-server is orphaned). */
export function killAll(): void {
  for (const s of sessions.values()) {
    try {
      s.proc.kill()
    } catch {
      /* ignore */
    }
  }
  sessions.clear()
  terminalEvents.emit('sessions')
}
