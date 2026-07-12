/**
 * The Vercel AI SDK transport for the agent tool loop. This is what unlocks
 * tool-calling on the wires the hand-rolled OpenAI SSE path can't drive —
 * Anthropic (Claude) and Google (Gemini), the two best coding families.
 *
 * It's a thin adapter, not a rewrite of the loop: `streamViaAiSdk` runs ONE
 * model turn and returns the same `{ text, toolCalls }` shape the OpenAI path
 * returns, so `runLoop` in `agent.ts` keeps owning tool dispatch, persistence,
 * trimming, and subagents. The AI SDK is used purely as a streaming +
 * tool-call-parsing engine: tools are declared WITHOUT an `execute` fn, so the
 * model stops at the tool call and hands it back to us (single step —
 * `streamText` defaults to `stopWhen: stepCountIs(1)`).
 *
 * Message + tool schemas stay in the OpenAI shape the rest of the harness uses;
 * this module converts them to the AI SDK's `ModelMessage`/tool format at the
 * call boundary and maps `fullStream` parts back to our text/reasoning/tool
 * callbacks.
 */
import {
  streamText,
  tool,
  jsonSchema,
  type ModelMessage,
  type LanguageModel,
  type ToolSet
} from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { ProviderWire, ReasoningEffort, TokenUsage } from '../../shared/types'
import type { OpenAiContentPart } from './llm'

/** The wires this transport can drive with tools (the rest use the OpenAI SSE path). */
const AI_SDK_WIRES = new Set<ProviderWire>(['anthropic', 'google'])

/** Whether a wire's tool loop should route through the AI SDK instead of the OpenAI SSE path. */
export function usesAiSdk(wire: ProviderWire | undefined): wire is 'anthropic' | 'google' {
  return wire !== undefined && AI_SDK_WIRES.has(wire)
}

/** OpenAI-shaped message (matches `OpenAiMessage` in agent.ts) — converted below. */
export interface AiSdkMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAiContentPart[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** OpenAI function-calling schema (matches `ToolSchema` in agent.ts). */
export interface AiSdkToolSchema {
  type: 'function'
  function: Record<string, unknown>
}

/** One parsed tool call, in the same shape the OpenAI path accumulates. */
export interface AiSdkToolCall {
  id: string
  name: string
  args: string
}

export interface AiSdkStreamOptions {
  wire: 'anthropic' | 'google'
  baseURL?: string
  apiKey: string | null
  model: string
  messages: AiSdkMessage[]
  tools: AiSdkToolSchema[]
  signal: AbortSignal
  /** Reserved: extended thinking is disabled on the tool path for now (see outputSettings / Phase 5). */
  reasoning?: boolean
  /** Reserved: paired with `reasoning`; unused until thinking-block preservation lands (Phase 5). */
  effort?: ReasoningEffort
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
}

/** Anthropic requires an explicit output cap; 8192 is universally safe across Claude models. */
const ANTHROPIC_MAX_OUTPUT_TOKENS = 8192

/** Collapse an OpenAI content value to plain text (drops image parts). */
function asText(content: string | OpenAiContentPart[] | null): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
  }
  return ''
}

type UserPart = { type: 'text'; text: string } | { type: 'image'; image: string }

/** Convert an OpenAI user content value to AI SDK user parts (text + images). */
function userContent(content: string | OpenAiContentPart[] | null): string | UserPart[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: UserPart[] = []
  for (const p of content) {
    if (p.type === 'text') parts.push({ type: 'text', text: p.text })
    else if (p.type === 'image_url') parts.push({ type: 'image', image: p.image_url.url })
  }
  return parts.length ? parts : ''
}

/** Parse a tool call's JSON-string arguments into an object (empty on failure). */
function parseArgs(raw: string): unknown {
  const trimmed = raw?.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return {}
  }
}

/**
 * Convert the harness's OpenAI-shaped conversation into AI SDK `ModelMessage`s.
 * Assistant `tool_calls` become `tool-call` parts; consecutive `role:'tool'`
 * replies are merged into a single tool message with one `tool-result` part
 * each (Anthropic wants all results for a turn grouped together). Tool names are
 * recovered from the assistant call that produced each id.
 */
export function toModelMessages(messages: AiSdkMessage[]): ModelMessage[] {
  const out: ModelMessage[] = []
  const toolNames = new Map<string, string>()

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    if (m.role === 'system') {
      out.push({ role: 'system', content: asText(m.content) })
      continue
    }

    if (m.role === 'user') {
      out.push({ role: 'user', content: userContent(m.content) })
      continue
    }

    if (m.role === 'assistant') {
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []
      const text = asText(m.content)
      if (text) parts.push({ type: 'text', text })
      for (const tc of m.tool_calls ?? []) {
        toolNames.set(tc.id, tc.function.name)
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: parseArgs(tc.function.arguments)
        })
      }
      // An assistant turn must carry content; fall back to a space if it somehow had none.
      out.push({ role: 'assistant', content: parts.length ? parts : ' ' })
      continue
    }

    // role === 'tool' — coalesce this and any following tool replies into one message.
    const results: Array<{
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: { type: 'text'; value: string }
    }> = []
    while (i < messages.length && messages[i].role === 'tool') {
      const tm = messages[i]
      const id = tm.tool_call_id ?? ''
      results.push({
        type: 'tool-result',
        toolCallId: id,
        toolName: toolNames.get(id) ?? 'tool',
        output: { type: 'text', value: asText(tm.content) }
      })
      i++
    }
    i-- // step back so the outer loop's i++ lands on the next non-tool message
    out.push({ role: 'tool', content: results })
  }

  return out
}

/** Convert OpenAI function schemas into an AI SDK tool set (no `execute` → stop at the call). */
export function toToolSet(tools: AiSdkToolSchema[]): ToolSet {
  const set: Record<string, ReturnType<typeof tool>> = {}
  for (const schema of tools) {
    const fn = schema.function as { name: string; description?: string; parameters?: unknown }
    if (!fn?.name) continue
    set[fn.name] = tool({
      description: typeof fn.description === 'string' ? fn.description : undefined,
      inputSchema: jsonSchema((fn.parameters ?? { type: 'object', properties: {} }) as object)
    })
  }
  return set
}

/** Build the AI SDK model instance for a wire, honoring a custom base URL. */
function modelFor(
  wire: 'anthropic' | 'google',
  baseURL: string | undefined,
  apiKey: string | null,
  model: string
): LanguageModel {
  const base = baseURL ? baseURL.replace(/\/+$/, '') : undefined
  if (wire === 'anthropic') {
    const provider = createAnthropic({ apiKey: apiKey ?? '', ...(base ? { baseURL: base } : {}) })
    return provider(model)
  }
  const provider = createGoogleGenerativeAI({
    apiKey: apiKey ?? '',
    ...(base ? { baseURL: base } : {})
  })
  return provider(model)
}

/**
 * Per-wire call settings for the tool loop.
 *
 * Extended thinking is deliberately NOT enabled on this multi-turn tool path.
 * Anthropic requires the signed `thinking` block to be replayed alongside the
 * `tool_use` block on every following turn (else it 400s), and roxy's loop keeps
 * an OpenAI-shaped conversation that has nowhere to carry that signed block. So
 * we run tool loops without provider-side thinking — reliable Claude/Gemini tool
 * use now; preserving + replaying reasoning blocks (with their signatures) is
 * Phase 5's job (structured tool history). Plain, single-turn Q&A still gets full
 * thinking via the untouched `streamChat` path in llm.ts.
 */
function outputSettings(wire: 'anthropic' | 'google'): { maxOutputTokens?: number } {
  // Anthropic requires max_tokens; Gemini defaults are fine.
  return wire === 'anthropic' ? { maxOutputTokens: ANTHROPIC_MAX_OUTPUT_TOKENS } : {}
}

/** A permissive view of the AI SDK `fullStream` parts this transport consumes. */
export interface AiSdkStreamPart {
  type: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  error?: unknown
  /** Present on the terminal `finish` part — cumulative token usage for the call. */
  totalUsage?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
  }
}

/**
 * Consume an AI SDK `fullStream`, forwarding text/reasoning deltas and
 * collecting tool calls. Returns the accumulated prose + calls in the OpenAI
 * path's shape, plus real token usage from the terminal `finish` part (Anthropic
 * / Gemini report it — no extra request). A user stop (abort) resolves with
 * whatever arrived so far. Exported so the mapping can be exercised directly in
 * tests.
 */
export async function consumeAiSdkStream(
  parts: AsyncIterable<AiSdkStreamPart>,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onReasoning: (delta: string) => void
): Promise<{ text: string; toolCalls: AiSdkToolCall[]; usage: TokenUsage | null }> {
  let text = ''
  const calls: AiSdkToolCall[] = []
  let usage: TokenUsage | null = null
  try {
    for await (const part of parts) {
      switch (part.type) {
        case 'text-delta':
          if (part.text) {
            text += part.text
            onText(part.text)
          }
          break
        case 'reasoning-delta':
          if (part.text) onReasoning(part.text)
          break
        case 'tool-call':
          calls.push({
            id: part.toolCallId ?? '',
            name: part.toolName ?? '',
            args: JSON.stringify(part.input ?? {})
          })
          break
        case 'finish':
          if (part.totalUsage) {
            const tu = part.totalUsage
            const cached = tu.cachedInputTokens ?? 0
            usage = {
              // AI SDK's inputTokens INCLUDES cached ones; split them out so cache
              // reads price at their cheaper rate.
              input: Math.max(0, (tu.inputTokens ?? 0) - cached),
              output: tu.outputTokens ?? 0,
              cacheRead: cached,
              cacheWrite: 0,
              reasoning: tu.reasoningTokens ?? 0,
              estimated: false
            }
          }
          break
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        default:
          break
      }
    }
  } catch (err) {
    // A user stop surfaces as an abort error — return what we have instead of throwing.
    if (signal.aborted) return { text, toolCalls: calls.filter((c) => c.name), usage }
    throw err
  }
  return { text, toolCalls: calls.filter((c) => c.name), usage }
}

/**
 * Stream one model turn via the AI SDK, accumulating prose text and tool calls.
 * Returns the same `{ text, toolCalls }` shape as the OpenAI SSE path so the
 * agent loop is wire-agnostic, plus `usage` (real Anthropic/Gemini token counts).
 */
export async function streamViaAiSdk(
  opts: AiSdkStreamOptions
): Promise<{ text: string; toolCalls: AiSdkToolCall[]; usage: TokenUsage | null }> {
  // `reasoning`/`effort` are intentionally unused here — see outputSettings (extended
  // thinking is disabled on the tool path until Phase 5 can preserve thinking blocks).
  const { wire, baseURL, apiKey, model, messages, tools, signal, onText, onReasoning } = opts
  const toolSet = toToolSet(tools)
  const hasTools = Object.keys(toolSet).length > 0
  const { maxOutputTokens } = outputSettings(wire)

  const result = streamText({
    model: modelFor(wire, baseURL, apiKey, model),
    messages: toModelMessages(messages),
    abortSignal: signal,
    maxRetries: 0, // the loop re-drives on failure; keep aborts snappy
    ...(hasTools ? { tools: toolSet, toolChoice: 'auto' as const } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {})
  })

  const out = await consumeAiSdkStream(result.fullStream, signal, onText, onReasoning)
  // Anthropic/Gemini normally report usage in the `finish` part; if a proxy or
  // an aborted stream drops it, estimate (~chars/4) so a row is still recorded.
  if (!out.usage) {
    const inputChars = messages.reduce((n, m) => n + asText(m.content).length, 0)
    out.usage = {
      input: Math.ceil(inputChars / 4),
      output: Math.ceil(out.text.length / 4),
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      estimated: true
    }
  }
  return out
}
