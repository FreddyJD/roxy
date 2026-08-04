import { memo, useCallback, useEffect, useState } from 'react'
import { Streamdown } from 'streamdown'
import { Brain, ChevronRight } from 'lucide-react'
import type { MessagePart } from '@shared/types'
import { streamSignature } from '@shared/parts'
import { ToolCall } from './ToolCall'
import { ThinkingIndicator } from './ThinkingIndicator'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'

// Fade streamed markdown in as it arrives. `stagger: 0` is deliberate: the
// upstream default (40ms) animates characters out of order during streaming,
// which reads as jittery, half-rendered text. Flat timing keeps prose in order.
const STREAM_ANIMATION = {
  animation: 'fadeIn',
  duration: 150,
  easing: 'ease',
  stagger: 0
} as const

/**
 * True once a streaming turn has emitted nothing for `delayMs`. Resets on every
 * delta, so it never fires during live text; it only trips during the "dead air"
 * between visible steps (prose finished → building a tool call, or between tools).
 */
function useStreamQuiet(parts: MessagePart[], streaming: boolean, delayMs = 500): boolean {
  const sig = streaming ? streamSignature(parts) : ''
  const [quiet, setQuiet] = useState(false)
  useEffect(() => {
    if (!streaming) {
      setQuiet(false)
      return
    }
    setQuiet(false)
    const t = setTimeout(() => setQuiet(true), delayMs)
    return () => clearTimeout(t)
  }, [sig, streaming, delayMs])
  return quiet
}

/**
 * The single entry point for rendering an assistant turn: it walks `parts` in
 * order so reasoning, tool calls, and prose appear exactly when they happened
 * (reasoning → tool → reasoning → tool → text) instead of being grouped by kind.
 * Only the last part animates while streaming; code/tool output never flickers.
 */
export function MessageParts({
  parts,
  streaming = false
}: {
  parts: MessagePart[]
  streaming?: boolean
}): JSX.Element {
  // Keep the indicator visible for the WHOLE live turn and only hide it when
  // something else is already signalling progress — so it can't vanish while the
  // model is still working (the sidebar, driven by the whole-turn `sendingChats`
  // flag, kept spinning; this now stays in sync). Two things count as "already
  // signalling": a tool that's mid-execution (its card shows its own spinner),
  // and text/reasoning that's actively arriving (a delta within the last 500ms).
  // Every other live moment — before the first token, between steps, or while the
  // model silently builds a tool call (its args stream in the main process,
  // emitting nothing here) — shows the indicator. `quiet` covers text AND
  // reasoning, closing the old gap where a finished reasoning block hid it.
  const last = parts[parts.length - 1]
  const quiet = useStreamQuiet(parts, streaming)
  const runningTool = last?.type === 'tool' && last.state === 'running'
  const liveText =
    (last?.type === 'text' || last?.type === 'reasoning') && last.text.trim() !== '' && !quiet
  const waiting = streaming && !runningTool && !liveText

  // Stable across renders so a memoized ToolCall can actually hit. It used to be
  // an inline arrow that closed over the specific part's `state`, giving every
  // card a fresh callback identity on every delta — which alone defeated any
  // memo on ToolCall. The card passes its own liveness in instead, leaving this
  // dependent only on the turn-level `streaming` boolean.
  const renderNested = useCallback(
    (children: MessagePart[], live: boolean) => (
      <MessageParts parts={children} streaming={streaming && live} />
    ),
    [streaming]
  )

  // Selected (not called through `getState()`) so the identities are stable and
  // the per-card callbacks below stay memo-friendly.
  const cancelSubagent = useRoxyStore((s) => s.cancelSubagent)
  const cancelToolCall = useRoxyStore((s) => s.cancelToolCall)

  return (
    <div className="flex flex-col gap-1 text-sm leading-relaxed text-text">
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1
        if (part.type === 'tool') {
          // Two cancels, one button. A live `task` card cancels its DELEGATE (by
          // session id — that path tears the subagent down and reports back to
          // the parent model). Any other live call cancels ITSELF (by call id),
          // but only when the harness said it's interruptible: a `read` that
          // returns in 2ms has no window to click, and a button that can't do
          // anything is worse than none.
          //
          // Both leave the turn running — that is the whole point, and the
          // difference from the composer's Stop.
          const subChatId = part.subChatId
          const callId = part.callId
          const cancel =
            part.state !== 'running'
              ? undefined
              : part.tool === 'task'
                ? subChatId
                  ? () => void cancelSubagent(subChatId)
                  : undefined
                : part.cancellable && callId
                  ? () => void cancelToolCall(callId)
                  : undefined
          return (
            <ToolCall
              key={i}
              tool={part.tool}
              state={part.state}
              title={part.title}
              output={part.output}
              image={part.image}
              diff={part.diff}
              onCancel={cancel}
              nested={part.children}
              // A subagent's transcript renders through this same component, so a
              // nested tool card looks and behaves exactly like a top-level one.
              // Passed as a callback (not a self-import) to keep the recursion
              // explicit and one-directional: ToolCall never reaches back up.
              //
              // The card supplies its own `live` flag: once a subagent has
              // reported, its transcript is history and must stop animating even
              // while the parent turn keeps going.
              renderNested={renderNested}
            />
          )
        }
        if (part.type === 'reasoning') {
          return <ReasoningBlock key={i} text={part.text} streaming={streaming && isLast} />
        }
        if (part.type === 'image') {
          return (
            <img
              key={i}
              src={part.dataUrl}
              alt={part.name ?? 'image'}
              className="max-h-72 max-w-full rounded-lg border border-border object-contain"
            />
          )
        }
        return <Prose key={i} text={part.text} animating={streaming && isLast} />
      })}
      {waiting && (
        <ThinkingIndicator
          label={
            last === undefined ||
            ((last.type === 'text' || last.type === 'reasoning') && last.text.trim() === '')
              ? 'thinking'
              : 'working'
          }
        />
      )}
    </div>
  )
}

/**
 * One markdown block.
 *
 * Split out and memoized because Streamdown re-parses its whole source on every
 * render, and a live turn re-renders this list on every token. Without this, a
 * turn that had already written five paragraphs and was streaming a sixth
 * re-parsed all six per token instead of one — the cost grew with the length of
 * the reply, which is exactly why long answers got progressively choppier.
 */
const Prose = memo(function Prose({
  text,
  animating
}: {
  text: string
  animating: boolean
}): JSX.Element {
  return (
    <div className="streamdown max-w-none">
      <Streamdown animated={STREAM_ANIMATION} isAnimating={animating}>
        {text}
      </Streamdown>
    </div>
  )
})

const ReasoningBlock = memo(function ReasoningBlock({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const expanded = open || streaming
  return (
    <div className="my-0.5 rounded-lg border border-border/60 bg-surface-2/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-subtle transition-colors hover:text-text-muted"
      >
        <Brain className={cn('h-3.5 w-3.5 shrink-0', streaming && 'animate-pulse text-accent')} />
        <span className="font-medium">{streaming ? 'Thinking…' : 'Reasoning'}</span>
        <ChevronRight
          className={cn(
            'ml-auto h-3.5 w-3.5 transition-transform duration-200 ease-out-quart',
            expanded && 'rotate-90'
          )}
        />
      </button>
      {expanded && (
        <div className="animate-fade-in whitespace-pre-wrap break-words border-t border-border/60 px-3 py-2 text-xs italic leading-relaxed text-text-muted">
          {text || '…'}
        </div>
      )}
    </div>
  )
})
