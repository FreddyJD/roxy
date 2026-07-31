import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
  Square,
  Terminal,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { MessagePart, ToolDiff } from '@shared/types'
import { cn } from '../lib/cn'
import { TerminalOutput } from './TerminalOutput'
import { BrailleSpinner } from './ThinkingIndicator'

const FileDiffView = lazy(() => import('./FileDiffView'))
const FileView = lazy(() => import('./FileView'))

const TOOL_ICON: Record<string, LucideIcon> = {
  bash: Terminal,
  bash_list: Terminal,
  bash_output: Terminal,
  bash_kill: Terminal,
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
 * How many steps a subagent has taken — tool calls only. Its reasoning and prose
 * are how it narrates the work, not work itself, and counting them would inflate
 * "12 steps" for a delegate that only thought out loud.
 */
const countSteps = (parts: MessagePart[]): number =>
  parts.reduce((n, p) => (p.type === 'tool' ? n + 1 : n), 0)

/**
 * What a subagent is doing RIGHT NOW, from the last part of its live transcript.
 * Shown on the collapsed `task` card so a delegation reads as visible progress
 * instead of an opaque spinner.
 *
 * Returns the label AND the index of the part it came from. The index is the
 * animation key: it changes once per STEP, whereas the label changes on every
 * token while the delegate writes prose. Keying on the text would restart the
 * entrance animation on each token — a flicker, not a transition.
 */
function activity(parts: MessagePart[]): { label: string; step: number } {
  const step = parts.length - 1
  const last = parts[step]
  if (!last) return { label: 'starting…', step: -1 }
  if (last.type === 'tool') {
    return { label: [last.tool, last.title].filter(Boolean).join(' '), step }
  }
  if (last.type === 'reasoning') return { label: 'thinking…', step }
  if (last.type === 'image') return { label: 'captured an image', step }
  // Prose: the delegate is writing its report — show its last line so you can
  // watch the conclusion form rather than a static "writing…".
  const line = last.text.trim().split('\n').filter(Boolean).pop()
  return { label: line ? line.slice(0, 120) : 'writing…', step }
}

/**
 * The live one-liner under a running `task` header: what the subagent is doing
 * and how far it has got. Both halves animate on step boundaries only.
 */
function ActivityLine({ parts }: { parts: MessagePart[] }): JSX.Element {
  const { label, step } = activity(parts)
  const steps = countSteps(parts)
  return (
    // pl-8 aligns the spinner with the header's tool icon (px-2.5 + chevron + gap),
    // so the strip reads as a continuation of the card rather than a new row.
    <div className="flex items-center gap-2 border-t border-border/60 py-1 pl-8 pr-2.5">
      <BrailleSpinner className="shrink-0 text-xs text-accent" />
      {/* Keys are prefixed: they're siblings, and a bare index would collide with
          the counter's whenever the two numbers happen to match. */}
      <span
        key={`at-${step}`}
        className="animate-ticker-in truncate font-mono text-[11px] text-text-subtle"
      >
        {label}
      </span>
      {steps > 0 && (
        <span
          key={`n-${steps}`}
          className="animate-ticker-in ml-auto shrink-0 font-mono text-[10px] tabular-nums text-text-subtle"
        >
          {steps} {steps === 1 ? 'step' : 'steps'}
        </span>
      )}
    </div>
  )
}

/**
 * Renders a single tool call as an inline, expandable card — the way an agent
 * step shows up between reasoning and prose. Click to reveal the output.
 *
 * A `task` card is special: it owns a subagent's whole transcript. Its steps
 * stream into `children` and render nested inside this card (via `renderNested`,
 * a callback rather than a direct import so the recursion stays one-directional).
 */
export const ToolCall = memo(function ToolCall({
  tool,
  state,
  title,
  output,
  image,
  diff,
  nested: nestedParts,
  renderNested,
  onCancel
}: {
  tool: string
  state: 'running' | 'done' | 'error'
  title?: string
  output?: string
  image?: string
  diff?: ToolDiff
  /**
   * Cancel just this call — supplied only for a running `task` card whose
   * delegate we can address. Absent means there is nothing honest to offer, and
   * no button is drawn (a Stop that does nothing is worse than no Stop).
   */
  onCancel?: () => void
  /** A subagent's live transcript, for a `task` card. */
  nested?: MessagePart[]
  /**
   * Renders that transcript — supplied by MessageParts so this file needn't
   * import it. Takes the card's own liveness so the callback itself can stay
   * referentially stable across a streaming turn (a per-card closure would
   * change identity on every delta and defeat this component's memo).
   */
  renderNested?: (parts: MessagePart[], live: boolean) => ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[tool] ?? Wrench
  const body = output?.trimEnd() ?? ''
  const nested = nestedParts && nestedParts.length > 0 ? nestedParts : undefined
  const live = state === 'running'
  // A finished subagent's transcript stays available but collapses to its report;
  // reopening replays the steps. While running, the activity strip is the summary.
  const showNested = Boolean(nested && renderNested)

  // Auto-open a running bash command so you can watch its logs stream in live,
  // then collapse it again once it finishes -- completed calls shouldn't leave a
  // terminal preview expanded, cluttering the transcript (click to re-expand).
  useEffect(() => {
    if (tool === 'bash') setOpen(state === 'running')
  }, [tool, state])

  // A `task` card deliberately does NOT auto-expand while running: a subagent
  // emits dozens of steps, and dumping them inline would bury the parent turn.
  // The collapsed activity strip is the live view; expanding is opt-in.
  // Once expanded during a run, keep the newest step in sight.
  const tailRef = useRef<HTMLDivElement>(null)
  const stepCount = nested ? countSteps(nested) : 0
  useEffect(() => {
    if (open && live && showNested) tailRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, live, showNested, stepCount])

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
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform duration-200 ease-out-quart',
            open && 'rotate-90'
          )}
        />
        <Icon
          className={cn(
            'h-4 w-4 shrink-0 text-text-muted',
            live && tool === 'task' && 'text-accent'
          )}
        />
        <span className="shrink-0 text-xs font-medium text-text">{tool}</span>
        {title && (
          <span className="truncate font-mono text-xs text-text-muted" title={title}>
            {title}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Once finished, the card collapses to "how much work did it do" — the
              same count the live strip was showing, so it doesn't appear to jump. */}
          {showNested && !live && stepCount > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-text-subtle">
              {stepCount} {stepCount === 1 ? 'step' : 'steps'}
            </span>
          )}
          {/* Skip this delegate without stopping the turn — the answer to "a hook
              spun up a README subagent and I just want it gone". Rendered as a
              nested <span role="button">, not a <button>: the header is itself a
              button (expand/collapse) and nesting one is invalid HTML that React
              warns about and browsers un-nest. Stops propagation so cancelling
              doesn't also toggle the card open. */}
          {live && onCancel && (
            <span
              role="button"
              tabIndex={0}
              title="Cancel this subagent"
              onClick={(e) => {
                e.stopPropagation()
                onCancel()
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                e.stopPropagation()
                onCancel()
              }}
              className="press-scale flex h-5 w-5 items-center justify-center rounded text-text-subtle transition-colors hover:bg-white/10 hover:text-text"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
            </span>
          )}
          {state === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-text-subtle" />}
          {state === 'done' && <Check className="h-3.5 w-3.5 text-success" />}
          {/* Grey, not red: a failed tool is part of how the agent works — grep
              finds nothing, a build surfaces the error it was run to surface.
              The icon shape already sets it apart; red would make routine
              debugging read like an incident. */}
          {state === 'error' && <TriangleAlert className="h-3.5 w-3.5 text-text-muted" />}
        </span>
      </button>
      {/* Collapsed + running: a live one-liner of what the delegate is doing now. */}
      {showNested && live && !open && <ActivityLine parts={nested!} />}
      {open && diff ? (
        <div className="animate-fade-in max-h-96 overflow-auto border-t border-border bg-surface">
          <Suspense
            fallback={
              <div className="px-3 py-2 font-mono text-xs text-text-subtle">Loading diff…</div>
            }
          >
            <FileDiffView path={diff.path} before={diff.before} after={diff.after} />
          </Suspense>
        </div>
      ) : open && tool === 'read' && state === 'done' && body && !image ? (
        <div className="animate-fade-in max-h-96 overflow-auto border-t border-border bg-surface">
          <Suspense
            fallback={<div className="px-3 py-2 font-mono text-xs text-text-subtle">Loading…</div>}
          >
            <FileView name={title || 'file.txt'} contents={body} />
          </Suspense>
        </div>
      ) : open && (tool === 'bash' || tool === 'bash_output') ? (
        <TerminalOutput text={body} state={state} />
      ) : open && showNested ? (
        <div className="animate-fade-in border-t border-border bg-surface">
          {/* The subagent's own transcript, indented under a rail so it reads as a
              separate agent's work rather than more of the parent's. */}
          <div className="max-h-[28rem] overflow-auto px-3 py-2">
            <div className="border-l-2 border-border pl-3">{renderNested!(nested!, live)}</div>
            <div ref={tailRef} />
          </div>
          {body && !live && (
            <div className="border-t border-border">
              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
                Report
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-xs leading-relaxed text-text-muted">
                {body}
              </pre>
            </div>
          )}
        </div>
      ) : open ? (
        <pre className="animate-fade-in max-h-72 overflow-auto border-t border-border bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-text-muted">
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
})
