import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Camera,
  Check,
  ChevronRight,
  Code,
  FileText,
  Globe,
  Hammer,
  ListTree,
  Loader2,
  Repeat,
  ScanText,
  Search,
  Terminal,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ToolDiff } from '@shared/types'
import { cn } from '../lib/cn'
import { renderAnsi } from '../lib/ansi'

const FileDiffView = lazy(() => import('./FileDiffView'))
const FileView = lazy(() => import('./FileView'))

const TOOL_ICON: Record<string, LucideIcon> = {
  bash: Terminal,
  read: FileText,
  write: FileText,
  edit: Code,
  apply_patch: Code,
  list: ListTree,
  glob: Search,
  grep: Search,
  webfetch: Globe,
  websearch: Globe,
  task: Hammer,
  browser_open: Globe,
  browser_screenshot: Camera,
  browser_read: ScanText,
  browser_console: Terminal,
  browser_close: Globe,
  browser_click: Globe,
  browser_scroll: Globe,
  browser_type: ScanText,
  browser_tabs: ListTree,
  browser_new_tab: Globe,
  browser_activate_tab: Globe,
  loop_create: Repeat,
  loop_list: Repeat,
  loop_enable: Repeat,
  loop_disable: Repeat,
  loop_remove: Repeat
}

/**
 * Renders a single tool call as an inline, expandable card — the way an agent
 * step shows up between reasoning and prose. Click to reveal the output.
 */
/** A trailing status line our bash wrapper appends, e.g. `[exit 1]` / `[timed out]`. */
const FOOTER_RE = /^\[(exit \d+|timed out|error:[\s\S]*)\]$/

/** Renders bash/shell output as a colored terminal block (prompt + ANSI body + status). */
function TerminalOutput({
  text,
  state
}: {
  text: string
  state: 'running' | 'done' | 'error'
}): JSX.Element {
  let prompt = ''
  let body = text
  // Pull off our own `$ command` header line so we can tint it like a prompt.
  if (body.startsWith('$ ')) {
    const nl = body.indexOf('\n')
    prompt = nl === -1 ? body : body.slice(0, nl)
    body = nl === -1 ? '' : body.slice(nl + 1)
  }
  // Pull off a trailing status line so we can color it green/amber/red.
  let footer = ''
  const lines = body.split('\n')
  const lastLine = lines[lines.length - 1]
  if (lastLine && FOOTER_RE.test(lastLine)) {
    footer = lastLine
    body = lines.slice(0, -1).join('\n')
  }
  const footerColor = footer.startsWith('[timed')
    ? '#fbbf24'
    : footer.startsWith('[exit') || footer.startsWith('[error')
      ? '#f87171'
      : '#9a9aa3'
  const trimmed = body.replace(/[\r\n]+$/, '')
  return (
    <pre className="max-h-72 overflow-auto border-t border-border bg-[#0b0b0d] px-3 py-2 font-mono text-xs leading-relaxed text-[#d4d4d4]">
      {prompt && <div style={{ color: '#4ade80' }}>{prompt}</div>}
      {trimmed && <span>{renderAnsi(trimmed)}</span>}
      {!prompt && !trimmed && !footer && (state === 'running' ? 'Running…' : '(no output)')}
      {footer && (
        <div className="mt-0.5" style={{ color: footerColor }}>
          {footer}
        </div>
      )}
    </pre>
  )
}

export function ToolCall({
  tool,
  state,
  title,
  output,
  image,
  diff
}: {
  tool: string
  state: 'running' | 'done' | 'error'
  title?: string
  output?: string
  image?: string
  diff?: ToolDiff
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[tool] ?? Wrench
  const body = output?.trimEnd() ?? ''

  // Auto-open a running command so you can watch its logs stream in live.
  useEffect(() => {
    if (tool === 'bash' && state === 'running') setOpen(true)
  }, [tool, state])

  // Warm the heavy syntax-highlight chunk as soon as a code card appears, so the
  // FIRST expand renders immediately instead of suspending on a lazy import
  // (the suspend-then-reveal under StrictMode was glitching the card open/closed
  // until you re-clicked).
  useEffect(() => {
    if (diff) void import('./FileDiffView')
    else if (tool === 'read' && !image) void import('./FileView')
  }, [diff, tool, image])

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-border bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-elevated"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform',
            open && 'rotate-90'
          )}
        />
        <Icon className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="shrink-0 text-xs font-medium text-text">{tool}</span>
        {title && (
          <span className="truncate font-mono text-xs text-text-muted" title={title}>
            {title}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {state === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-text-subtle" />}
          {state === 'done' && <Check className="h-3.5 w-3.5 text-success" />}
          {state === 'error' && <TriangleAlert className="h-3.5 w-3.5 text-danger" />}
        </span>
      </button>
      {open && diff ? (
        <div className="max-h-96 overflow-auto border-t border-border bg-surface">
          <Suspense
            fallback={
              <div className="px-3 py-2 font-mono text-xs text-text-subtle">Loading diff…</div>
            }
          >
            <FileDiffView path={diff.path} before={diff.before} after={diff.after} />
          </Suspense>
        </div>
      ) : open && tool === 'read' && state === 'done' && body && !image ? (
        <div className="max-h-96 overflow-auto border-t border-border bg-surface">
          <Suspense
            fallback={
              <div className="px-3 py-2 font-mono text-xs text-text-subtle">Loading…</div>
            }
          >
            <FileView name={title || 'file.txt'} contents={body} />
          </Suspense>
        </div>
      ) : open && tool === 'bash' ? (
        <TerminalOutput text={body} state={state} />
      ) : open ? (
        <pre className="max-h-72 overflow-auto border-t border-border bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-text-muted">
          {body || (state === 'running' ? 'Running…' : '(no output)')}
        </pre>
      ) : null}
      {image && (
        <div className="border-t border-border bg-surface p-2">
          <img
            src={image}
            alt="Browser screenshot"
            className="max-h-96 w-full rounded-md object-contain ring-1 ring-border"
          />
        </div>
      )}
    </div>
  )
}
