/**
 * Conversation compaction — the "compact" half of context management. It asks
 * the active model to summarize a chat's history into a dense brief, stores it
 * on the chat, and marks how far it covers. buildChatMessages then sends the
 * summary in place of the older turns, freeing the context window while keeping
 * the essential state. Works for any chat (main / sub / loop).
 */
import * as repo from '../db/repo'
import { streamChat } from './llm'
import { getAgent } from '../../shared/agents'
import { AGENT_PROMPT_TEXT } from '../../shared/prompt-text'
import type { Chat, Message } from '../../shared/types'

/**
 * The compaction agent's tuned system prompt (resources/prompts/agent-compaction.txt,
 * resolved via its `promptFile`), with a terse inline fallback if the asset is ever
 * missing. The agent-compaction prompt is an anchored summarizer: it honors a
 * `<previous-summary>` block and follows the output structure the user prompt asks for.
 */
const COMPACT_SYSTEM =
  AGENT_PROMPT_TEXT[getAgent('compaction')?.promptFile ?? ''] ??
  'You are an anchored context-summarization assistant for coding sessions. Summarize only the conversation history you are given, preserving the essential context needed to continue. Output only the summary.'

/** The output structure the summary must follow (lives in the user prompt so the
 * anchored agent-compaction system prompt stays generic). */
const COMPACT_STRUCTURE = [
  'Summarize the conversation below so the assistant can continue with no loss of essential context.',
  'Preserve: the user’s goals and constraints, decisions made, files created or edited (with exact paths), key code, commands run and their results or errors, the current state, and any open tasks or questions.',
  'Drop greetings and redundant detail. Use terse markdown bullet points grouped by topic. Output ONLY the summary.'
].join(' ')

/** Flatten a message's parts to plain text for the summarizer. */
function flatten(m: Message): string {
  return m.parts
    .map((p) =>
      p.type === 'tool'
        ? p.output
          ? `[tool:${p.tool}] ${p.output}`
          : `[tool:${p.tool}]`
        : p.type === 'image'
          ? '[image]'
          : p.text
    )
    .join('')
    .trim()
}

/** Summarize a chat's history and persist it as the chat's compaction summary. */
export async function compactChat(
  chatId: string,
  providerId: string,
  model: string
): Promise<Chat> {
  const existing = repo.getChat(chatId)
  if (!existing) throw new Error('Chat not found')
  const messages = repo
    .listMessages(chatId)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
  if (messages.length === 0) return existing

  // Most recent ~120k chars (older turns matter less if the convo is enormous).
  const convo = messages
    .map((m) => `${m.role.toUpperCase()}: ${flatten(m)}`)
    .join('\n\n')
    .slice(-120_000)
  const prior = existing.contextSummary
    ? `<previous-summary>\n${existing.contextSummary}\n</previous-summary>\n\n`
    : ''

  let summary = ''
  await streamChat({
    providerId,
    model,
    messages: [
      { role: 'system', content: COMPACT_SYSTEM },
      { role: 'user', content: `${COMPACT_STRUCTURE}\n\n${prior}Conversation to compact:\n\n${convo}` }
    ],
    signal: new AbortController().signal,
    onDelta: (t) => {
      summary += t
    }
  })

  summary = summary.trim()
  if (!summary) throw new Error('Compaction produced an empty summary.')
  const through = messages[messages.length - 1].createdAt
  return repo.setChatSummary(chatId, summary, through)
}
