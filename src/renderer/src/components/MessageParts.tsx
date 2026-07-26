import { useEffect, useState } from 'react'
import { Streamdown } from 'streamdown'
import { Brain, ChevronRight } from 'lucide-react'
import type { MessagePart } from '@shared/types'
import { ToolCall } from './ToolCall'
import { ThinkingIndicator } from './ThinkingIndicator'
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
 * A signature that changes on every streamed delta: total streamed characters +
 * part count + the last tool's state. When it stops changing, the turn has gone
 * "quiet" even though it's still live (the model is building a tool call whose
 * args stream in the main process, emitting nothing here).
 */
function streamSignature(parts: MessagePart[]): string {
  let chars = 0
  for (const p of parts) {
    if (p.type === 'text' || p.type === 'reasoning') chars += p.text.length
    else if (p.type === 'tool') chars += p.output?.length ?? 0
  }
  const last = parts[parts.length - 1]
  return `${parts.length}:${chars}:${last?.type === 'tool' ? last.state : ''}`
}

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
  return (
    <div className="flex flex-col gap-1 text-sm leading-relaxed text-text">
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1
        if (part.type === 'tool') {
          return (
            <ToolCall
              key={i}
              tool={part.tool}
              state={part.state}
              title={part.title}
              output={part.output}
              image={part.image}
              diff={part.diff}
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
        return (
          <div key={i} className="streamdown max-w-none">
            <Streamdown animated={STREAM_ANIMATION} isAnimating={streaming && isLast}>
              {part.text}
            </Streamdown>
          </div>
        )
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

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
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
}
