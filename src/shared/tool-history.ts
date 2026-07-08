/**
 * Structured tool-history rebuild — pure functions, no Electron/DB/UI deps, so
 * they run in the plain-Node smoke and are shared by the renderer (rebuilding the
 * request from persisted parts) and the main process (folding history back to
 * plain text for the tool-less path).
 *
 * The point: keep a turn's `assistant.tool_calls` + `role:'tool'` results as
 * structured messages across turns instead of flattening them to a text blob, so
 * the model keeps its multi-turn tool reasoning (mirrors how good harnesses like
 * opencode replay tool parts). Legacy rows and manual `!verb` cards (tool parts
 * with no `callId`) fall back to the old fenced-text flatten, so historic chats
 * are byte-for-byte unchanged.
 */
import type { ChatMessage } from './api'
import type { Message, MessagePart } from './types'
import { previewText } from './context'

/** Cap a replayed tool result to what the live loop sent (agent.ts runLoop bounds big outputs). */
export const REPLAY_OUTPUT_CAP = 8000

/** Characters NOT allowed in a tool-call id by the strictest provider (Copilot's Claude proxy). */
const TOOL_ID_DISALLOWED = /[^a-zA-Z0-9-]/g

/**
 * Coerce a tool-call id to the strictest cross-provider pattern (letters, digits,
 * and hyphens only).
 *
 * GitHub Copilot proxies Claude/Opus and validates a `tool_use.id` against that
 * set -- no underscores, dots, or colons (stricter even than Anthropic's own
 * pattern, which also allows underscores). So replaying a prior turn's raw ids
 * (`call_...`, `toolu_...`, or an MCP id like `server.tool:1`) 400s on the NEXT
 * message with "tool_use.id: String should match pattern ...".
 *
 * The transform is deterministic (every disallowed char becomes a hyphen), so an
 * assistant `tool_calls[].id` and its paired `tool_call_id`/`tool_use_id` always
 * map to the SAME value and stay matched. The sanitized form is a subset valid
 * for every provider, so it is safe on all wires (also fixes cross-provider
 * replay after a mid-session model switch). Empty/blank ids get a stable
 * placeholder so the trailing quantifier never fails on an empty string.
 */
export function sanitizeToolCallId(id: string | undefined | null): string {
  const cleaned = (id ?? '').replace(TOOL_ID_DISALLOWED, '-')
  return cleaned.length ? cleaned : 'tool-call'
}

/** Shown between the head and tail of a replayed result that was too big to keep whole. */
const REPLAY_MARKER = '…[tool output truncated to fit context — full result was shown live]…'

/**
 * Rebuild one persisted assistant turn into structured chat messages. Interleaved
 * text/tool parts become `assistant` messages carrying `toolCalls` plus the
 * matching `role:'tool'` result messages. Text that arrives after a tool call
 * opens a new assistant step (OpenAI multi-step form). Reasoning/image parts are
 * display-only here and skipped.
 */
export function reconstructAssistant(parts: MessagePart[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let text = ''
  let calls: { id: string; name: string; arguments: string }[] = []
  let results: ChatMessage[] = []
  const commit = (): void => {
    if (!text.trim() && calls.length === 0 && results.length === 0) return
    out.push({ role: 'assistant', content: text.trim(), ...(calls.length ? { toolCalls: calls } : {}) })
    out.push(...results)
    text = ''
    calls = []
    results = []
  }
  for (const p of parts) {
    if (p.type === 'text') {
      if (calls.length > 0) commit() // text after a tool call starts a new step
      text += p.text
    } else if (p.type === 'reasoning' || p.type === 'image') {
      continue
    } else if (p.type === 'tool') {
      if (p.callId) {
        calls.push({ id: p.callId, name: p.tool, arguments: JSON.stringify(p.input ?? {}) })
        results.push({
          role: 'tool',
          toolCallId: p.callId,
          content: p.output
            ? previewText(p.output, {
                maxChars: REPLAY_OUTPUT_CAP,
                maxLines: REPLAY_OUTPUT_CAP,
                marker: REPLAY_MARKER
              })
            : '(no output)'
        })
      } else if (p.output) {
        // Legacy tool part (no id) or a manual `!verb` card → old fenced-text flatten.
        text += `\n\`\`\`\n${p.output}\n\`\`\`\n`
      }
    }
  }
  commit()
  return out
}

/** Rebuild one persisted turn (user or assistant) into structured chat messages. */
export function reconstructTurn(m: Message): ChatMessage[] {
  if (m.role === 'assistant') return reconstructAssistant(m.parts)
  const content = m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim()
  const images = m.parts
    .filter((p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image')
    .map((p) => ({ dataUrl: p.dataUrl, mediaType: p.mediaType }))
  if (!content && images.length === 0) return []
  return [{ role: 'user', content, ...(images.length ? { images } : {}) }]
}

/**
 * Fold structured tool history back into plain alternating text messages for the
 * tool-less path (whose provider builders don't speak tool roles). A `role:'tool'`
 * result and an assistant turn's `tool_calls` collapse into the preceding
 * assistant bubble as a fenced block — mirroring the old flattening, so a chat
 * that used tools before (then lost its workspace or switched to a tool-less wire)
 * still answers without ever sending an unsupported `tool` role.
 */
export function flattenToolHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  const appendToLastAssistant = (block: string): void => {
    if (!block) return
    const last = out[out.length - 1]
    if (last && last.role === 'assistant') last.content = `${last.content}\n${block}`.trim()
    else out.push({ role: 'assistant', content: block })
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      appendToLastAssistant(m.content ? `\`\`\`\n${m.content}\n\`\`\`` : '')
      continue
    }
    if (m.role === 'assistant') {
      // Merge consecutive assistant messages (a multi-step tool turn is one bubble).
      const last = out[out.length - 1]
      if (last && last.role === 'assistant') appendToLastAssistant(m.content)
      else out.push({ role: 'assistant', content: m.content, ...(m.images ? { images: m.images } : {}) })
      continue
    }
    out.push({ ...m })
  }
  return out.filter((m) => m.content.trim().length > 0 || (m.images && m.images.length > 0))
}
