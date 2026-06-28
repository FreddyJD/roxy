/**
 * Live model calls. Turns a connected provider's credential into a streamed
 * chat completion. GitHub Copilot needs an extra hop: the stored GitHub OAuth
 * token is exchanged for a short-lived Copilot token, then used against the
 * OpenAI-compatible Copilot endpoint. Other `openai-chat` providers use their
 * API key + base URL directly.
 */
import * as repo from '../db/repo'
import type { ChatMessage } from '../../shared/api'
import type { ReasoningEffort } from '../../shared/types'

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const COPILOT_CHAT_URL = 'https://api.githubcopilot.com/chat/completions'

interface CopilotToken {
  token: string
  expiresAt: number
}
let copilotCache: CopilotToken | null = null

// ---- Vision helpers ----------------------------------------------------------

/** OpenAI-style multimodal content part. */
export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Strip the `data:<mime>;base64,` prefix, leaving raw base64. */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/** True if any message carries images (so we can flip on vision headers). */
export function messagesHaveImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => !!m.images && m.images.length > 0)
}

/** OpenAI-compatible content: a plain string, or text + image_url parts. */
export function openAiContent(m: ChatMessage): string | OpenAiContentPart[] {
  if (!m.images || m.images.length === 0) return m.content
  const parts: OpenAiContentPart[] = []
  if (m.content) parts.push({ type: 'text', text: m.content })
  for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
  return parts
}

/** Anthropic content blocks: a plain string, or text + base64 image blocks. */
function anthropicContent(m: ChatMessage): string | unknown[] {
  if (!m.images || m.images.length === 0) return m.content
  const blocks: unknown[] = []
  if (m.content) blocks.push({ type: 'text', text: m.content })
  for (const img of m.images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: base64Of(img.dataUrl) }
    })
  }
  return blocks
}

/** Gemini parts: text plus inline_data image parts. */
function geminiParts(m: ChatMessage): unknown[] {
  const parts: unknown[] = []
  if (m.content) parts.push({ text: m.content })
  for (const img of m.images ?? []) {
    parts.push({ inline_data: { mime_type: img.mediaType, data: base64Of(img.dataUrl) } })
  }
  if (parts.length === 0) parts.push({ text: '' })
  return parts
}

/** Exchange the stored GitHub token for a short-lived Copilot token (cached). */
async function getCopilotToken(): Promise<string> {
  if (copilotCache && copilotCache.expiresAt - 60_000 > Date.now()) return copilotCache.token

  const github = repo.getProviderToken('github-copilot')
  if (!github) throw new Error('GitHub Copilot is not linked. Connect it in onboarding or Settings.')

  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${github}`,
      'User-Agent': 'Roxy',
      Accept: 'application/json'
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Copilot token exchange failed (${res.status}). Your GitHub account may not have an active Copilot subscription.`
      )
    }
    throw new Error(`Copilot token exchange failed (${res.status}). ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { token: string; expires_at: number }
  copilotCache = { token: data.token, expiresAt: data.expires_at * 1000 }
  return data.token
}

function copilotHeaders(token: string, vision = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Version': 'Roxy/0.0.1',
    'Editor-Plugin-Version': 'Roxy/0.0.1',
    'Openai-Intent': 'conversation-panel',
    'User-Agent': 'Roxy',
    ...(vision ? { 'Copilot-Vision-Request': 'true' } : {})
  }
}

/** Resolve the OpenAI-compatible chat endpoint + headers (Copilot or openai-chat). */
export async function openaiEndpoint(
  providerId: string,
  opts: { vision?: boolean } = {}
): Promise<{ url: string; headers: Record<string, string> }> {
  if (providerId === 'github-copilot') {
    return { url: COPILOT_CHAT_URL, headers: copilotHeaders(await getCopilotToken(), opts.vision) }
  }
  const provider = repo.listConnectedProviders().find((p) => p.id === providerId)
  if (!provider) throw new Error(`Provider "${providerId}" is not connected.`)
  const key = repo.getProviderToken(providerId)
  const base = (provider.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  return {
    url: `${base}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    }
  }
}

/** Anthropic/Gemini thinking budget (tokens) per effort level. */
const THINK_BUDGET: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 49152
}

/**
 * OpenAI-style `reasoning_effort`, only when the model supports reasoning.
 * GitHub Copilot accepts the full Low→Max ladder (it's exactly what VS Code
 * sends for Claude); strict OpenAI-compatible endpoints only know low/medium/
 * high, so clamp the extra levels there to avoid a 400.
 */
function openAiReasoning(
  providerId: string,
  reasoning?: boolean,
  effort?: ReasoningEffort
): { reasoning_effort?: ReasoningEffort } {
  if (!reasoning || !effort) return {}
  if (providerId !== 'github-copilot' && (effort === 'xhigh' || effort === 'max')) {
    return { reasoning_effort: 'high' }
  }
  return { reasoning_effort: effort }
}

export interface StreamChatOptions {
  providerId: string
  model: string
  messages: ChatMessage[]
  signal: AbortSignal
  onDelta: (text: string) => void
  /** Whether the model supports reasoning (gates the reasoning params). */
  reasoning?: boolean
  reasoningEffort?: ReasoningEffort
  /** Effective context budget (tokens) — enables large-context headers. */
  contextLimit?: number
}

/** A permissive shape covering the SSE payloads of every wire we support. */
interface SseJson {
  choices?: { delta?: { content?: string } }[]
  type?: string
  delta?: { type?: string; text?: string }
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

/**
 * Stream a chat completion, invoking `onDelta` for each text chunk. Dispatches
 * on the provider's wire protocol: OpenAI-compatible (the default — ~44 of the
 * seed providers, plus GitHub Copilot), Anthropic, Google Gemini, and Azure
 * OpenAI. Bedrock (AWS SigV4) and Google Vertex (GCP ADC) need cloud-credential
 * signing and aren't wired up yet.
 */
export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const { providerId, model, messages, signal, onDelta, reasoning, reasoningEffort, contextLimit } =
    opts

  // GitHub Copilot: exchange the GitHub token, then an OpenAI-compatible endpoint.
  if (providerId === 'github-copilot') {
    const res = await fetch(COPILOT_CHAT_URL, {
      method: 'POST',
      headers: copilotHeaders(await getCopilotToken(), messagesHaveImages(messages)),
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: openAiContent(m) })),
        ...openAiReasoning('github-copilot', reasoning, reasoningEffort),
        stream: true
      }),
      signal
    })
    return readSse(res, (j) => emitOpenAi(j, onDelta))
  }

  const provider = repo.listConnectedProviders().find((p) => p.id === providerId)
  if (!provider) throw new Error(`Provider "${providerId}" is not connected.`)
  const key = repo.getProviderToken(providerId)

  switch (provider.wire) {
    case 'anthropic':
      return streamAnthropic(provider.baseURL, key, model, messages, signal, onDelta, reasoning, reasoningEffort, contextLimit)
    case 'google':
      if (provider.auth === 'gcp-adc') {
        throw new Error('Google Vertex (ADC) auth is not supported yet. Use the Gemini API-key provider.')
      }
      return streamGemini(provider.baseURL, key, model, messages, signal, onDelta, reasoning, reasoningEffort)
    case 'azure':
      return streamAzure(provider.baseURL, key, model, messages, signal, onDelta, reasoning, reasoningEffort)
    case 'bedrock':
      throw new Error('Amazon Bedrock (AWS SigV4) is not supported yet.')
    default: {
      // openai + openai-chat: standard /chat/completions with a Bearer key.
      const base = (provider.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {})
        },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: openAiContent(m) })),
          ...openAiReasoning(providerId, reasoning, reasoningEffort),
          stream: true
        }),
        signal
      })
      return readSse(res, (j) => emitOpenAi(j, onDelta))
    }
  }
}

function emitOpenAi(j: SseJson, onDelta: (t: string) => void): void {
  const delta = j.choices?.[0]?.delta?.content
  if (typeof delta === 'string' && delta.length > 0) onDelta(delta)
}

/** Anthropic Messages API (`/v1/messages`, x-api-key, system split out). */
async function streamAnthropic(
  baseURL: string | undefined,
  key: string | null,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (t: string) => void,
  reasoning?: boolean,
  effort?: ReasoningEffort,
  contextLimit?: number
): Promise<void> {
  const base = (baseURL || 'https://api.anthropic.com').replace(/\/+$/, '')
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const msgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: anthropicContent(m) }))
  // Cap the thinking budget so max_tokens (budget + 4096) stays under Claude's
  // per-model output ceiling — xhigh/max would otherwise overshoot 32K models.
  const budget = reasoning && effort ? Math.min(THINK_BUDGET[effort], 24_000) : 0
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': key ?? '',
    'anthropic-version': '2023-06-01'
  }
  // Opt into Anthropic's 1M-token context beta when a large budget is chosen.
  if (contextLimit && contextLimit > 200_000) headers['anthropic-beta'] = 'context-1m-2025-08-07'
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: budget ? Math.max(4096, budget + 4096) : 4096,
      ...(system ? { system } : {}),
      ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      messages: msgs,
      stream: true
    }),
    signal
  })
  return readSse(res, (j) => {
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta.text) {
      onDelta(j.delta.text)
    }
  })
}

/** Google Gemini (`:streamGenerateContent?alt=sse`, role 'model', systemInstruction). */
async function streamGemini(
  baseURL: string | undefined,
  key: string | null,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (t: string) => void,
  reasoning?: boolean,
  effort?: ReasoningEffort
): Promise<void> {
  const base = (baseURL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m) }))
  const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key ?? '')}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(reasoning && effort
        ? {
            generationConfig: {
              thinkingConfig: { thinkingBudget: Math.min(THINK_BUDGET[effort], 24_576) }
            }
          }
        : {})
    }),
    signal
  })
  return readSse(res, (j) => {
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text
    if (typeof text === 'string' && text) onDelta(text)
  })
}

/** Azure OpenAI (deployment URL + api-key header; OpenAI body/stream). */
async function streamAzure(
  baseURL: string | undefined,
  key: string | null,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (t: string) => void,
  reasoning?: boolean,
  effort?: ReasoningEffort
): Promise<void> {
  if (!baseURL) throw new Error('Azure OpenAI needs your resource endpoint set as the base URL.')
  const base = baseURL.replace(/\/+$/, '')
  // For Azure, `model` is the deployment name.
  const url = `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-06-01`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key ?? '' },
    body: JSON.stringify({
      messages: messages.map((m) => ({ role: m.role, content: openAiContent(m) })),
      ...openAiReasoning('azure', reasoning, effort),
      stream: true
    }),
    signal
  })
  return readSse(res, (j) => emitOpenAi(j, onDelta))
}

/** Read an SSE body line-by-line, parsing each `data: {json}` (stops on `[DONE]`). */
async function readSse(res: Response, onJson: (json: SseJson) => void): Promise<void> {
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`Model request failed (${res.status}). ${body.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        onJson(JSON.parse(payload) as SseJson)
      } catch {
        // keep-alive lines / partial JSON
      }
    }
  }
}
