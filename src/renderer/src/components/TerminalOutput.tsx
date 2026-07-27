import { renderAnsi } from '../lib/ansi'

/**
 * Shell output as a colored terminal block — prompt line, ANSI body, status
 * footer.
 *
 * Extracted from ToolCall so the Services panel renders live dev-server logs
 * exactly like a `bash` tool card does. Deliberately NOT a real terminal: no
 * node-pty, no xterm. Agent-driven commands are non-interactive, and a native
 * module rebuilt per Electron version across four platforms is a real cost for
 * a scrollback buffer we already have.
 */

/** A trailing status line our bash wrapper appends, e.g. `[exit 1]` / `[timed out after 60s …]`. */
const FOOTER_RE = /^\[(exit \d+|timed out[\s\S]*|error:[\s\S]*)\]$/

/**
 * One grey for every footer, success or not.
 *
 * `[exit 1]` in an agent's shell is ordinary: the model runs a build to see what
 * breaks, greps for a match that isn't there, probes a port before the server is
 * up. Rendering each of those in red made a perfectly normal transcript read
 * like a disaster log, and a colour that fires on routine events stops meaning
 * anything when something is genuinely wrong. The footer still says "exit 1" —
 * the fact is intact, it just doesn't shout.
 */
const FOOTER_COLOR = '#9a9aa3'

export function TerminalOutput({
  text,
  state,
  className
}: {
  text: string
  state: 'running' | 'done' | 'error'
  /** Overrides the default max height (the panel wants a shorter log pane). */
  className?: string
}): JSX.Element {
  let prompt = ''
  let body = text
  // Pull off our own `$ command` header line so we can tint it like a prompt.
  if (body.startsWith('$ ')) {
    const nl = body.indexOf('\n')
    prompt = nl === -1 ? body : body.slice(0, nl)
    body = nl === -1 ? '' : body.slice(nl + 1)
  }
  // Pull off a trailing status line so we can set it apart from the body.
  let footer = ''
  const lines = body.split('\n')
  const lastLine = lines[lines.length - 1]
  if (lastLine && FOOTER_RE.test(lastLine)) {
    footer = lastLine
    body = lines.slice(0, -1).join('\n')
  }
  const trimmed = body.replace(/[\r\n]+$/, '')
  return (
    <pre
      className={
        className ??
        'max-h-72 overflow-auto border-t border-border bg-[#0b0b0d] px-3 py-2 font-mono text-xs leading-relaxed text-[#d4d4d4]'
      }
    >
      {prompt && <div style={{ color: '#4ade80' }}>{prompt}</div>}
      {trimmed && <span>{renderAnsi(trimmed)}</span>}
      {!prompt && !trimmed && !footer && (state === 'running' ? 'Running…' : '(no output)')}
      {footer && (
        <div className="mt-0.5" style={{ color: FOOTER_COLOR }}>
          {footer}
        </div>
      )}
    </pre>
  )
}
