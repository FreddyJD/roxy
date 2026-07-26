/**
 * Streamed-parts folding — pure functions, no Electron/DB/React deps, so they run
 * in the plain-Node smoke and are shared by every consumer of `LlmEvent`.
 *
 * There used to be THREE hand-written copies of this fold (the renderer's local
 * send handler, the renderer's remote-mirror handler, and the main process's
 * `PartsAccumulator`), which meant every new event type had to be implemented
 * three times or one surface would silently drop it. This is the single one.
 *
 * The fold is immutable: `apply` returns a NEW parts array and never mutates the
 * previous one, so React sees a changed reference on every delta (the renderer
 * was already written this way) and the main process just reassigns.
 */
import type { LlmChildEvent, LlmEvent } from './api'
import type { MessagePart } from './types'
import { previewText } from './context'

/**
 * How much of a SUBAGENT tool's output the parent's `task` card keeps.
 *
 * A nested transcript is a *summary* view: the subagent's own session persists
 * the full thing, so mirroring every byte onto the parent turn would double-store
 * potentially megabytes of tool output in the parent's `parts` JSON column for no
 * added information. Head/tail preview keeps the card useful (you can see what it
 * ran and how it ended) at a bounded cost; "open the sub session" is the full view.
 */
export const CHILD_OUTPUT_CAP = 2000

/**
 * Hard ceiling on nested parts per `task` card. A runaway subagent (hundreds of
 * steps) must not be able to grow one parent message row without bound. Past the
 * cap we keep folding into EXISTING parts (a running tool still finishes and
 * flips to done) but stop appending new ones.
 */
export const MAX_CHILD_PARTS = 400

const CHILD_MARKER = '…[truncated — open the subagent session for the full output]…'

const capChildOutput = (text: string): string =>
  previewText(text, {
    maxChars: CHILD_OUTPUT_CAP,
    maxLines: CHILD_OUTPUT_CAP,
    marker: CHILD_MARKER
  })

/**
 * Fold one event into a parts list, returning a new list. `index` maps a tool
 * call id to its slot and is mutated in place (it's bookkeeping, not state React
 * renders). `cap` bounds appends for nested transcripts; 0 means unbounded.
 */
function foldInto(
  parts: MessagePart[],
  index: Map<string, number>,
  event: LlmChildEvent,
  cap = 0
): MessagePart[] {
  const full = cap > 0 && parts.length >= cap
  if (event.type === 'text' || event.type === 'reasoning') {
    const last = parts[parts.length - 1]
    // Grow the trailing text/reasoning part so prose reveals token by token
    // instead of fragmenting into one part per delta.
    if (last && last.type === event.type) {
      const text = last.text + event.delta
      return parts.map((p, i) => (i === parts.length - 1 ? { type: event.type, text } : p))
    }
    if (full) return parts
    return [...parts, { type: event.type, text: event.delta }]
  }
  if (event.type === 'tool-start') {
    if (full) return parts
    index.set(event.callId, parts.length)
    return [
      ...parts,
      {
        type: 'tool',
        tool: event.tool,
        state: 'running',
        title: event.title,
        callId: event.callId,
        input: event.input
      }
    ]
  }
  if (event.type === 'tool-delta') {
    const idx = index.get(event.callId)
    if (idx === undefined) return parts
    return parts.map((p, i) =>
      i === idx && p.type === 'tool'
        ? {
            ...p,
            output:
              cap > 0
                ? capChildOutput((p.output ?? '') + event.chunk)
                : (p.output ?? '') + event.chunk
          }
        : p
    )
  }
  if (event.type === 'tool-end') {
    const idx = index.get(event.callId)
    if (idx === undefined) return parts
    return parts.map((p, i) =>
      i === idx && p.type === 'tool'
        ? {
            ...p,
            state: event.ok ? 'done' : 'error',
            output: cap > 0 ? capChildOutput(event.output) : event.output,
            image: event.image,
            diff: event.diff
          }
        : p
    )
  }
  return parts
}

/**
 * Folds a turn's streamed events into ordered message parts. One instance per
 * live turn; read `parts` after each `apply` (the reference changes on every
 * event that mutated anything).
 */
export class PartsFold {
  parts: MessagePart[] = []
  /** callId → slot in `parts`, for the turn's own tool calls. */
  private readonly index = new Map<string, number>()
  /** Parent `task` callId → its subagent's own callId → slot in that card's `children`. */
  private readonly childIndex = new Map<string, Map<string, number>>()

  /**
   * Adopt an existing parts list as this fold's state, rebuilding the call-id
   * indexes from the cards themselves so subsequent events land on the right
   * slots.
   *
   * This is what makes a fold *resumable*: a viewer joining a run already in
   * progress (opening a subagent's session mid-flight) seeds from a snapshot and
   * keeps folding from there. Assigning `parts` directly would leave the indexes
   * empty, so every inherited card's `tool-end` would be dropped and the card
   * would spin forever.
   */
  seed(parts: MessagePart[]): MessagePart[] {
    this.parts = parts
    this.index.clear()
    this.childIndex.clear()
    parts.forEach((part, i) => {
      if (part.type !== 'tool' || !part.callId) return
      this.index.set(part.callId, i)
      if (!part.children?.length) return
      const sub = new Map<string, number>()
      part.children.forEach((child, j) => {
        if (child.type === 'tool' && child.callId) sub.set(child.callId, j)
      })
      this.childIndex.set(part.callId, sub)
    })
    return this.parts
  }

  apply(event: LlmEvent): MessagePart[] {
    if (event.type !== 'tool-child') {
      this.parts = foldInto(this.parts, this.index, event)
      return this.parts
    }
    // A subagent step: fold it into its `task` card's nested transcript. Dropping
    // it when the card is missing is correct — a child event can only arrive
    // after its parent `tool-start` (the harness emits the card first).
    const idx = this.index.get(event.callId)
    if (idx === undefined) return this.parts
    const parent = this.parts[idx]
    if (parent?.type !== 'tool') return this.parts
    let sub = this.childIndex.get(event.callId)
    if (!sub) {
      sub = new Map()
      this.childIndex.set(event.callId, sub)
    }
    const children = foldInto(parent.children ?? [], sub, event.event, MAX_CHILD_PARTS)
    if (children === parent.children) return this.parts
    this.parts = this.parts.map((p, i) => (i === idx ? { ...parent, children } : p))
    return this.parts
  }
}

/**
 * Total streamed characters across a parts tree, INCLUDING nested subagent
 * transcripts. Callers use it as a liveness signal: while this keeps climbing,
 * the turn is visibly producing something.
 */
export function countStreamedChars(parts: MessagePart[]): number {
  let chars = 0
  for (const p of parts) {
    if (p.type === 'text' || p.type === 'reasoning') chars += p.text.length
    else if (p.type === 'tool') {
      chars += p.output?.length ?? 0
      if (p.children) chars += countStreamedChars(p.children)
    }
  }
  return chars
}

/** Total parts in a tree, counting nested subagent parts — the other half of the liveness signal. */
export function countParts(parts: MessagePart[]): number {
  let n = 0
  for (const p of parts) {
    n += 1
    if (p.type === 'tool' && p.children) n += countParts(p.children)
  }
  return n
}

/**
 * A signature that changes on every streamed delta anywhere in the tree (nested
 * subagent activity included). When it stops changing, the turn has gone quiet.
 */
export function streamSignature(parts: MessagePart[]): string {
  const last = parts[parts.length - 1]
  const tail = last?.type === 'tool' ? `${last.state}:${last.children?.length ?? 0}` : ''
  return `${countParts(parts)}:${countStreamedChars(parts)}:${tail}`
}

/** Collapse parts into a plain-text preview for a message's `content` column. */
export function partsToContent(parts: MessagePart[]): string {
  let text = ''
  let reasoning = ''
  let toolOutput = ''
  for (const part of parts) {
    if (part.type === 'text') text += part.text
    else if (part.type === 'reasoning') reasoning += part.text
    else if (part.type === 'tool' && part.output) toolOutput = part.output
  }
  return (text.trim() || reasoning.trim() || toolOutput).trim()
}
