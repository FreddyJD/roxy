import { useState } from 'react'
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
  // Show the cute "thinking" indicator while the turn is live but has nothing to
  // show yet: before the first token, or waiting after a finished tool step.
  const last = parts[parts.length - 1]
  const waiting =
    streaming &&
    (last === undefined ||
      (last.type === 'tool' && last.state !== 'running') ||
      ((last.type === 'text' || last.type === 'reasoning') && last.text.trim() === ''))
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
      {waiting && <ThinkingIndicator />}
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
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-subtle transition hover:text-text-muted"
      >
        <Brain className={cn('h-3.5 w-3.5 shrink-0', streaming && 'animate-pulse text-accent')} />
        <span className="font-medium">{streaming ? 'Thinking…' : 'Reasoning'}</span>
        <ChevronRight
          className={cn('ml-auto h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
        />
      </button>
      {expanded && (
        <div className="whitespace-pre-wrap break-words border-t border-border/60 px-3 py-2 text-xs italic leading-relaxed text-text-muted">
          {text || '…'}
        </div>
      )}
    </div>
  )
}
