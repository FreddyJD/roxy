/**
 * Context-management primitives — the pure, dependency-free half of Phase 9.
 *
 * These helpers decide *when* a conversation overflows the model's real budget
 * (so compaction can fire automatically) and *how* to shed bulk without losing
 * the reasoning thread: prune old tool outputs to a head/tail preview before
 * dropping whole turns, and turn oversized tool results into a preview + pointer
 * (the disk write itself lives in the main process — see
 * `main/services/tool-output-store.ts`). Kept pure and char-based (no Buffer, no
 * Node/Electron) so it runs in the renderer, the harness, and the smoke:shared
 * pure-Node harness alike. Modeled on opencode's `session/compaction.ts` +
 * `tool-output-store.ts`, adapted to Roxy's ~4-chars/token estimate.
 */

/** Headroom (tokens) reserved for the next reply when checking overflow. */
export const COMPACTION_BUFFER = 20_000
/** Most-recent tokens whose tool outputs are protected from pruning. */
export const KEEP_RECENT_TOKENS = 8_000

/** A tool result larger than either bound gets spilled to disk (main process). */
export const TOOL_OUTPUT_MAX_LINES = 2_000
export const TOOL_OUTPUT_MAX_CHARS = 50_000

/** Size of the head/tail preview the model sees in place of a spilled result. */
export const TOOL_PREVIEW_LINES = 40
export const TOOL_PREVIEW_CHARS = 4_000

/** Older, in-context tool outputs are shrunk to this when pruning to fit. */
export const TOOL_PRUNE_LINES = 20
export const TOOL_PRUNE_CHARS = 2_000

/** Marker dropped between a preview's head and tail so the model knows it's cut. */
export const PRUNE_MARKER = '…[earlier tool output trimmed to fit the context window]…'

/** Roxy's rough token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Flat token cost charged per image, matching the renderer's window estimate
 * (store.ts). Vision models bill an image as a bounded number of visual tokens
 * (~1-2k), NOT the length of its base64 data URL. Sizing an image by
 * `JSON.stringify`-ing its content would count the raw base64 (~1.37x the file
 * size, i.e. 100k+ "tokens" for a normal screenshot), which made the trimmer
 * treat one pasted image as an overflow and drop the whole user turn — leaving a
 * system-only request that 400s ("at least one message is required"). Keep this
 * in lockstep with the renderer's per-image constant so both sides agree a turn
 * fits.
 */
export const IMAGE_TOKEN_COST = 800

/**
 * Count how many image parts an OpenAI-shaped content value carries, WITHOUT
 * charging for their base64 bytes. A plain string has none; an array counts its
 * `image_url` parts (the shape `openAiContent` in llm.ts produces).
 */
export function countContentImages(content: unknown): number {
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const p of content) {
    if (p && typeof p === 'object' && (p as { type?: unknown }).type === 'image_url') n++
  }
  return n
}

/**
 * Token estimate for one OpenAI-shaped message that is image-aware: text +
 * tool-call args counted by length (~4 chars/token), each image charged a flat
 * {@link IMAGE_TOKEN_COST} rather than its base64 length. This is the sizing the
 * harness trimmer and the renderer window cut must share so a turn that carries a
 * pasted image is never mis-sized into oblivion.
 */
export function messageTokens(m: {
  content?: unknown
  tool_calls?: unknown
  toolCalls?: unknown
}): number {
  const images = countContentImages(m.content)
  // Text: a string is itself; a part-array is sized by its TEXT only (images are
  // charged flat above, so drop them before stringifying to avoid the base64 blow-up).
  let textLen: number
  if (typeof m.content === 'string') textLen = m.content.length
  else if (Array.isArray(m.content)) {
    textLen = m.content.reduce((n, p) => {
      const t = p && typeof p === 'object' ? (p as { type?: unknown; text?: unknown }) : {}
      return n + (t.type === 'text' && typeof t.text === 'string' ? t.text.length : 0)
    }, 0)
  } else textLen = 0
  const calls = m.tool_calls ?? m.toolCalls
  const callsLen = calls ? JSON.stringify(calls).length : 0
  return Math.ceil((textLen + callsLen) / 4) + images * IMAGE_TOKEN_COST
}

/** Count lines cheaply (newlines + 1) without allocating a split array. */
export function countLines(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * The token count above which we should compact: the model's real budget minus
 * whichever is larger — the reserved reply size or a safety buffer. Mirrors
 * opencode's `context - max(output, buffer)`. The reserve is capped at 30% of
 * the window so the threshold stays positive (and sane) even for small-context
 * models where a flat 20k buffer would exceed the whole window. Returns 0 for a
 * missing/invalid limit (callers treat a non-positive threshold as "never
 * overflow").
 */
export function compactionThreshold(
  contextLimit: number,
  outputReserve: number,
  buffer: number = COMPACTION_BUFFER
): number {
  if (!contextLimit || contextLimit <= 0) return 0
  const reserve = Math.min(Math.max(outputReserve, buffer), Math.floor(contextLimit * 0.3))
  return contextLimit - reserve
}

/** True when the used tokens exceed the model's real budget (minus headroom). */
export function isOverflow(
  used: number,
  contextLimit: number,
  outputReserve: number,
  buffer: number = COMPACTION_BUFFER
): boolean {
  const threshold = compactionThreshold(contextLimit, outputReserve, buffer)
  return threshold > 0 && used > threshold
}

/** True when a tool result is big enough to warrant a preview + disk spill. */
export function needsTruncation(
  text: string,
  maxLines: number = TOOL_OUTPUT_MAX_LINES,
  maxChars: number = TOOL_OUTPUT_MAX_CHARS
): boolean {
  return text.length > maxChars || countLines(text) > maxLines
}

export interface PreviewOptions {
  maxLines?: number
  maxChars?: number
  /** Text placed between the head and tail (e.g. a "full output saved to …" pointer). */
  marker?: string
}

/**
 * Shrink `text` to a head + marker + tail preview bounded by both line and char
 * budgets (split evenly, head-heavy). Returns the text unchanged when it already
 * fits. Char-based (no Buffer) so it is safe in the renderer bundle. Port of
 * opencode's `boundedPreview`/`preview`.
 */
export function previewText(text: string, opts: PreviewOptions = {}): string {
  const maxLines = opts.maxLines ?? TOOL_PREVIEW_LINES
  const maxChars = opts.maxChars ?? TOOL_PREVIEW_CHARS
  const marker = opts.marker ?? PRUNE_MARKER
  const lines = text.split('\n')
  if (lines.length <= maxLines && text.length <= maxChars) return text

  const headLines = Math.max(1, Math.ceil(maxLines / 2))
  const tailLines = Math.max(0, Math.floor(maxLines / 2))
  let head = lines.slice(0, headLines).join('\n')
  let tail = tailLines > 0 ? lines.slice(lines.length - tailLines).join('\n') : ''

  const headChars = Math.ceil(maxChars / 2)
  const tailChars = Math.floor(maxChars / 2)
  if (head.length > headChars) head = head.slice(0, headChars)
  if (tail.length > tailChars) tail = tail.slice(tail.length - tailChars)

  return tail ? `${head}\n\n${marker}\n\n${tail}` : `${head}\n\n${marker}`
}

/** A conversation message with enough shape to prune its tool output. */
export interface PrunableMessage {
  role: string
  content: unknown
}

export interface PruneOptions {
  /** Most-recent tokens kept fully intact (tool outputs untouched). */
  keepRecentTokens?: number
  previewLines?: number
  previewChars?: number
}

/**
 * Turn-aware pruning: keep the most recent `keepRecentTokens` of conversation
 * fully intact, then shrink *older* `role:'tool'` outputs to a small preview so
 * the reasoning thread (user/assistant turns + the tool calls themselves) is
 * preserved while the bulky bytes are shed. Returns a new array of the same
 * length/order (non-tool and recent messages are returned as-is). Callers run
 * this before dropping whole turns, matching opencode's "prune tool output
 * first" compaction step.
 */
export function pruneToolMessages<T extends PrunableMessage>(messages: T[], opts: PruneOptions = {}): T[] {
  const keepRecentTokens = opts.keepRecentTokens ?? KEEP_RECENT_TOKENS
  const previewLines = opts.previewLines ?? TOOL_PRUNE_LINES
  const previewChars = opts.previewChars ?? TOOL_PRUNE_CHARS
  const out = messages.slice()
  let budget = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const isText = typeof m.content === 'string'
    // Image-aware sizing: charge each image a flat cost instead of JSON-stringifying
    // its base64 (see messageTokens), so a pasted image doesn't blow up the recent-
    // token window and shove real turns out of the protected zone.
    const tokens = messageTokens(m)
    const withinRecent = budget <= keepRecentTokens
    budget += tokens
    if (withinRecent) continue // protected recent window — leave intact
    if (m.role === 'tool' && isText && needsTruncation(m.content as string, previewLines, previewChars)) {
      out[i] = {
        ...m,
        content: previewText(m.content as string, { maxLines: previewLines, maxChars: previewChars })
      }
    }
  }
  return out
}
