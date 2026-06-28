/**
 * The agent loop — the thing that makes Roxy *do* the work instead of just
 * describing it. It gives the model the executable tools, streams its turn,
 * runs any tool calls it makes (in the session's workspace), feeds the results
 * back, and repeats until the model answers with prose. Emits `LlmEvent`s so the
 * renderer can render interleaved text + tool cards live.
 *
 * Tool calling uses the OpenAI function-calling format, which covers the
 * openai/openai-chat providers (the large majority) plus GitHub Copilot. Other
 * wires (anthropic/google/azure) fall back to a plain streamed answer for now.
 */
import type { ChatMessage, LlmEvent } from '../../shared/api'
import type { MessagePart, ReasoningEffort } from '../../shared/types'
import { getAgent, type AgentDef } from '../../shared/agents'
import * as repo from '../db/repo'
import { runTool } from './tools'
import {
  messagesHaveImages,
  openAiContent,
  openaiEndpoint,
  streamChat,
  type OpenAiContentPart
} from '../services/llm'

const MAX_STEPS = 16
const MAX_SUBAGENT_DEPTH = 1

/** OpenAI function schemas for the workspace/browser tools (the base toolset). */
const BASE_SCHEMAS = [
  fn('read', 'Read a file from the workspace.', { path: str('File path, relative to the workspace.') }, ['path']),
  fn(
    'write',
    'Create or overwrite a file with the given content. Creates parent folders.',
    { path: str('File path, relative to the workspace.'), content: str('Full file content.') },
    ['path', 'content']
  ),
  fn(
    'edit',
    'Replace an exact unique substring in a file with new text.',
    {
      path: str('File path.'),
      oldString: str('Exact text to replace (must be unique in the file).'),
      newString: str('Replacement text.')
    },
    ['path', 'oldString', 'newString']
  ),
  fn('list', 'List the entries of a directory.', { path: str('Directory path (default ".").') }, []),
  fn('glob', 'Find files matching a glob pattern.', { pattern: str('e.g. "src/**/*.ts"') }, ['pattern']),
  fn(
    'grep',
    'Search file contents with a case-insensitive regex.',
    { pattern: str('Regex.'), include: str('Glob of files to search (default "**/*").') },
    ['pattern']
  ),
  fn('bash', 'Run a quick ONE-OFF shell command in the workspace (PowerShell on Windows). Each call is a FRESH shell — the working directory and env do NOT persist between calls, and a command that never returns (a dev server) will time out. For a long-running process, or a shell whose state must persist, use terminal_create / terminal_send instead.', { command: str('The command.') }, [
    'command'
  ]),
  fn('browser_open', 'Open the built-in browser to a URL.', { url: str('URL or bare host.') }, ['url']),
  fn('browser_screenshot', 'Screenshot the current browser page.', {}, []),
  fn('browser_read', 'Read the current page HTML (optionally a CSS selector).', { selector: str('CSS selector.') }, []),
  fn('browser_console', 'Read console logs/errors from the current page.', {}, []),
  fn('browser_click', 'Click the first element matching a CSS selector on the current page.', { selector: str('CSS selector, e.g. "button[type=submit]" or "a.login".') }, ['selector']),
  fn(
    'browser_scroll',
    'Scroll the current page — into a selector, or by direction.',
    {
      selector: str('Optional CSS selector to scroll into view.'),
      direction: str('One of: up, down, top, bottom (used when no selector).'),
      amount: { type: 'number', description: 'Pixels to scroll for up/down (default 700).' }
    },
    []
  ),
  fn('browser_type', 'Type text into an input/textarea/contenteditable matching a CSS selector.', { selector: str('CSS selector of the field.'), text: str('Text to type.') }, ['selector', 'text']),
  fn('browser_tabs', 'List the open browser tabs (id, title, URL, and which is active).', {}, []),
  fn('browser_new_tab', 'Open a new browser tab (optionally at a URL) and make it active.', { url: str('Optional URL or bare host.') }, []),
  fn('browser_activate_tab', 'Switch to a browser tab by its id (ids come from browser_tabs).', { id: str('Tab id from browser_tabs.') }, ['id']),
  fn(
    'loop_create',
    'Create a scheduled loop (a recurring "heartbeat") that re-runs a prompt in THIS project every N minutes — the agent runs fully each beat. Use when the user wants ongoing/recurring/autonomous/looping work (e.g. "every 5 min, keep improving the site").',
    {
      name: str('Short label for the loop.'),
      prompt: str('The instruction to run every interval.'),
      interval_minutes: { type: 'number', description: 'Minutes between runs (>= 1).' }
    },
    ['name', 'prompt', 'interval_minutes']
  ),
  fn('loop_list', 'List the scheduled loops and whether each is running.', {}, []),
  fn('loop_enable', 'Resume a paused loop by name or id.', { loop: str('Loop name or id.') }, ['loop']),
  fn('loop_disable', 'Pause a running loop by name or id.', { loop: str('Loop name or id.') }, ['loop']),
  fn('loop_remove', 'Delete a loop by name or id.', { loop: str('Loop name or id.') }, ['loop']),
  fn('terminal_list', 'List the persistent terminal sessions running in THIS workspace (id, name, status, shell). These are separate from the one-shot `bash` tool. Use it to find a session id.', {}, []),
  fn(
    'terminal_create',
    'Start a NEW persistent terminal session (a long-lived shell) in this workspace — separate from the one-shot `bash` tool. Use it for processes that should keep running, e.g. a dev server (`npm run dev`). Optionally run an initial command.',
    { name: str('Optional short label.'), command: str('Optional command to run on start, e.g. "npm run dev".') },
    []
  ),
  fn(
    'terminal_send',
    'Run a command in an existing terminal session (in this workspace) and return its output. Long-running processes (dev servers) return their startup output and keep running in the background — use terminal_read to see more.',
    { id: str('Session id from terminal_list / terminal_create.'), command: str('The command to run.') },
    ['id', 'command']
  ),
  fn('terminal_read', 'Read the recent output of a terminal session in this workspace — e.g. to check on a running dev server.', { id: str('Session id.') }, ['id']),
  fn('terminal_kill', 'Stop and remove a terminal session in this workspace (kills its process).', { id: str('Session id.') }, ['id'])
]

function str(description: string): { type: 'string'; description: string } {
  return { type: 'string', description }
}
function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): { type: 'function'; function: Record<string, unknown> } {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } }
  }
}

type ToolSchema = ReturnType<typeof fn>

/** The delegation tool — lets a primary agent spawn a focused subagent. */
const TASK_SCHEMA = fn(
  'task',
  'Delegate a focused, self-contained sub-task to a specialized subagent that runs on its own and reports back. Use this to parallelize or offload work (e.g. build a page, research the codebase). The subagent has NO memory of this conversation, so put ALL the context it needs into `prompt`. It returns a single report. Call task multiple times to run several subagents.',
  {
    description: str('A short (3-5 word) label for the task.'),
    prompt: str('The complete task for the subagent, including every bit of context it needs.'),
    subagent_type: str(
      'Which subagent: "general" (full tools, multi-step work) or "explore" (read-only search/understanding).'
    )
  },
  ['description', 'prompt', 'subagent_type']
)

/** The schemas an agent may call: its allowlisted base tools, plus `task` for primaries. */
function schemasFor(tools: string[] | 'all', includeTask: boolean): ToolSchema[] {
  const base =
    tools === 'all'
      ? BASE_SCHEMAS
      : BASE_SCHEMAS.filter((s) => tools.includes(s.function.name as string))
  return includeTask ? [...base, TASK_SCHEMA] : base
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAiContentPart[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

interface ToolCallAccum {
  id: string
  name: string
  args: string
}

interface StreamDelta {
  choices?: {
    delta?: {
      content?: string
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
}

export interface RunTurnOptions {
  providerId: string
  model: string
  messages: ChatMessage[]
  cwd: string
  /** The session this turn runs in — the parent for any subagents it spawns. */
  chatId?: string
  signal: AbortSignal
  emit: (event: LlmEvent) => void
  /** Whether the model supports reasoning (gates the reasoning params). */
  reasoning?: boolean
  reasoningEffort?: ReasoningEffort
  /** Effective context budget (tokens). */
  contextLimit?: number
}

/** Run one user turn: the tool-using agent loop (primary "build" agent) or a plain answer. */
export async function runAgentTurn(opts: RunTurnOptions): Promise<void> {
  const { providerId, model, messages, cwd, chatId, signal, emit, reasoning, reasoningEffort, contextLimit } =
    opts
  const wire =
    providerId === 'github-copilot'
      ? 'openai-chat'
      : repo.listConnectedProviders().find((p) => p.id === providerId)?.wire
  const toolCapable = providerId === 'github-copilot' || wire === 'openai' || wire === 'openai-chat'

  // No workspace, or a wire without tool support yet → plain streamed answer.
  if (!toolCapable || !cwd) {
    await streamChat({
      providerId,
      model,
      messages,
      signal,
      onDelta: (text) => emit({ type: 'text', delta: text }),
      reasoning,
      reasoningEffort,
      contextLimit
    })
    return
  }

  const { url, headers } = await openaiEndpoint(providerId, { vision: messagesHaveImages(messages) })
  const convo: OpenAiMessage[] = messages.map((m) => ({ role: m.role, content: openAiContent(m) }))

  // The primary "build" agent gets every tool, plus `task` to delegate to subagents.
  await runLoop({
    url,
    headers,
    model,
    convo,
    cwd,
    parentChatId: chatId,
    signal,
    emitTool: emit,
    onText: (delta) => emit({ type: 'text', delta }),
    tools: schemasFor('all', true),
    reasoning,
    effort: reasoningEffort,
    depth: 0
  })
}

interface LoopOptions {
  url: string
  headers: Record<string, string>
  model: string
  convo: OpenAiMessage[]
  cwd: string
  /** Parent session id — subagents spawned here persist as its `sub` children. */
  parentChatId?: string
  signal: AbortSignal
  /** Tool cards — the parent's and any subagent's tool work both surface here. */
  emitTool: (event: LlmEvent) => void
  /** Prose deltas — the parent streams them; a subagent swallows them (captured via the return). */
  onText: (delta: string) => void
  tools: ToolSchema[]
  reasoning?: boolean
  effort?: ReasoningEffort
  depth: number
}

/** The shared agent loop: stream → run tools (incl. `task`) → repeat. Returns the final prose. */
async function runLoop(o: LoopOptions): Promise<string> {
  const { url, headers, model, convo, cwd, parentChatId, signal, emitTool, onText, tools, reasoning, effort, depth } =
    o
  let lastText = ''

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return lastText
    const { text, toolCalls } = await streamOnce(
      url,
      headers,
      model,
      convo,
      signal,
      reasoning,
      effort,
      tools,
      onText
    )
    if (text) lastText = text
    if (toolCalls.length === 0) return lastText // model finished with prose

    convo.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args }
      }))
    })

    for (const tc of toolCalls) {
      if (signal.aborted) return lastText
      let input: Record<string, unknown> = {}
      try {
        input = tc.args.trim() ? (JSON.parse(tc.args) as Record<string, unknown>) : {}
      } catch {
        input = {}
      }

      if (tc.name === 'task') {
        const result = await runSubagent({
          callId: tc.id,
          description: typeof input.description === 'string' ? input.description : 'subtask',
          prompt: typeof input.prompt === 'string' ? input.prompt : '',
          subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : 'general',
          url,
          headers,
          model,
          cwd,
          parentChatId,
          signal,
          emit: emitTool,
          reasoning,
          effort,
          depth
        })
        convo.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 12_000) })
        continue
      }

      emitTool({ type: 'tool-start', callId: tc.id, tool: tc.name, title: toolTitle(tc.name, input) })
      const result = await runTool(tc.name, input, {
        cwd,
        onChunk: (chunk) => emitTool({ type: 'tool-delta', callId: tc.id, chunk })
      })
      emitTool({
        type: 'tool-end',
        callId: tc.id,
        output: result.output,
        ok: result.ok,
        image: result.image,
        diff: result.diff
      })
      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.output.slice(0, 8000) || '(no output)'
      })
    }
  }
  onText('\n\n_[stopped after reaching the tool-step limit]_')
  return lastText
}

interface SubagentOptions {
  callId: string
  description: string
  prompt: string
  subagentType: string
  url: string
  headers: Record<string, string>
  model: string
  cwd: string
  parentChatId?: string
  signal: AbortSignal
  emit: (event: LlmEvent) => void
  reasoning?: boolean
  effort?: ReasoningEffort
  depth: number
}

/** Spawn a subagent: a focused child run of the same loop, returned as a `task` result. */
async function runSubagent(o: SubagentOptions): Promise<string> {
  const { callId, description, prompt, subagentType, url, headers, model, cwd, parentChatId, signal, emit, reasoning, effort, depth } =
    o
  const fail = (msg: string): string => {
    emit({ type: 'tool-start', callId, tool: 'task', title: description })
    emit({ type: 'tool-end', callId, output: msg, ok: false })
    return renderTaskResult(subagentType, 'error', msg)
  }

  const agent = getAgent(subagentType)
  if (!agent || agent.mode !== 'subagent') {
    return fail(`Unknown subagent "${subagentType}". Valid subagents: general, explore.`)
  }
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return fail('Subagents cannot spawn further subagents.')
  }

  const subConvo: OpenAiMessage[] = [
    { role: 'system', content: subagentSystemPrompt(agent, cwd) },
    { role: 'user', content: prompt || description }
  ]

  // Persist the subagent as its own `sub` session linked to the parent, created
  // and seeded with the prompt UP FRONT so it shows in the sidebar (with its
  // badge) the moment it spins up — not only once it finishes.
  const subChatId =
    parentChatId != null
      ? repo.createChat({
          title: `${agent.name}: ${description}`.slice(0, 80),
          kind: 'sub',
          workspacePath: cwd,
          parentId: parentChatId
        }).id
      : null
  if (subChatId) {
    try {
      repo.addMessage({
        chatId: subChatId,
        role: 'user',
        content: prompt || description,
        parts: [{ type: 'text', text: prompt || description }]
      })
    } catch {
      // best-effort — never break the parent turn over sub-session persistence
    }
  }

  // Announce the task AFTER the sub session exists, so the renderer's refresh on
  // this tool-start finds it and shows the sub session live.
  emit({ type: 'tool-start', callId, tool: 'task', title: `${agent.name}: ${description}` })

  const parts: MessagePart[] = []
  const toolAt = new Map<string, number>()
  const addText = (delta: string): void => {
    const last = parts[parts.length - 1]
    if (last && last.type === 'text') last.text += delta
    else parts.push({ type: 'text', text: delta })
  }
  const persistSub = (): void => {
    if (!subChatId) return
    try {
      const prose: string[] = []
      for (const p of parts) if (p.type === 'text' || p.type === 'reasoning') prose.push(p.text)
      repo.addMessage({ chatId: subChatId, role: 'assistant', content: prose.join('\n').trim(), parts })
    } catch {
      // best-effort — never break the parent turn over sub-session persistence
    }
  }

  // The subagent's own tool calls surface as nested cards (prefixed call ids) in
  // the parent AND are recorded into its own session's parts; its prose is
  // captured (returned as the task result + stored as the sub session's reply).
  const emitNested = (event: LlmEvent): void => {
    if (event.type === 'tool-start') {
      toolAt.set(event.callId, parts.length)
      parts.push({ type: 'tool', tool: event.tool, state: 'running', title: event.title })
      emit({ ...event, callId: `${callId}.${event.callId}` })
    } else if (event.type === 'tool-delta') {
      const p = parts[toolAt.get(event.callId) ?? -1]
      if (p?.type === 'tool') p.output = (p.output ?? '') + event.chunk
      emit({ ...event, callId: `${callId}.${event.callId}` })
    } else if (event.type === 'tool-end') {
      const p = parts[toolAt.get(event.callId) ?? -1]
      if (p?.type === 'tool') {
        p.state = event.ok ? 'done' : 'error'
        p.output = event.output
        p.image = event.image
        p.diff = event.diff
      }
      emit({ ...event, callId: `${callId}.${event.callId}` })
    }
  }

  try {
    const text = await runLoop({
      url,
      headers,
      model,
      convo: subConvo,
      cwd,
      signal,
      emitTool: emitNested,
      onText: addText,
      tools: schemasFor(agent.tools, false),
      reasoning,
      effort,
      depth: depth + 1
    })
    const report = text.trim() || '(subagent returned no report)'
    persistSub()
    emit({ type: 'tool-end', callId, output: report, ok: true })
    return renderTaskResult(subagentType, 'completed', report)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    persistSub()
    emit({ type: 'tool-end', callId, output: `Subagent failed: ${msg}`, ok: false })
    return renderTaskResult(subagentType, 'error', msg)
  }
}

/** A subagent's focused system prompt: who it is, that it starts blank, and to report back. */
function subagentSystemPrompt(agent: AgentDef, cwd: string): string {
  const lines = [
    `You are the "${agent.name}" subagent. ${agent.description}`,
    'A lead agent delegated a focused task to you. You have NO memory of the prior conversation — work only from the task below.',
    'Use your tools to complete it, then reply with a concise report: what you found or did, files created/edited (with paths), and key results. Be terse.'
  ]
  if (agent.tools !== 'all') {
    lines.push(`You may only use these tools: ${agent.tools.join(', ')}.`)
  }
  if (cwd) lines.push(`The workspace folder is ${cwd}. Tool paths are relative to it.`)
  return lines.join('\n\n')
}

/** Wrap a subagent's result so the parent model sees the delegation collapse into one tool result. */
function renderTaskResult(subagent: string, state: 'completed' | 'error', text: string): string {
  const tag = state === 'error' ? 'task_error' : 'task_result'
  return [`<task subagent="${subagent}" state="${state}">`, `<${tag}>`, text, `</${tag}>`, '</task>'].join(
    '\n'
  )
}

/** Stream one model turn, accumulating prose text and tool calls. */
async function streamOnce(
  url: string,
  headers: Record<string, string>,
  model: string,
  messages: OpenAiMessage[],
  signal: AbortSignal,
  reasoning: boolean | undefined,
  effort: ReasoningEffort | undefined,
  tools: ToolSchema[],
  onText: (delta: string) => void
): Promise<{ text: string; toolCalls: ToolCallAccum[] }> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      ...(reasoning && effort ? { reasoning_effort: effort } : {}),
      stream: true
    }),
    signal
  })
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`Model request failed (${res.status}). ${body.slice(0, 300)}`)
  }

  let text = ''
  const calls: ToolCallAccum[] = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const finish = (): { text: string; toolCalls: ToolCallAccum[] } => {
    const toolCalls = calls.filter(Boolean)
    toolCalls.forEach((c, i) => {
      if (!c.id) c.id = `call_${i}`
    })
    return { text, toolCalls: toolCalls.filter((c) => c.name) }
  }

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
      if (payload === '[DONE]') return finish()
      let json: StreamDelta
      try {
        json = JSON.parse(payload) as StreamDelta
      } catch {
        continue
      }
      const delta = json.choices?.[0]?.delta
      if (delta?.content) {
        text += delta.content
        onText(delta.content)
      }
      for (const tcd of delta?.tool_calls ?? []) {
        const i = tcd.index ?? 0
        if (!calls[i]) calls[i] = { id: '', name: '', args: '' }
        if (tcd.id) calls[i].id = tcd.id
        if (tcd.function?.name) calls[i].name = tcd.function.name
        if (tcd.function?.arguments) calls[i].args += tcd.function.arguments
      }
    }
  }
  return finish()
}

/** A short, human-readable summary shown on the tool card. */
function toolTitle(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'bash':
      return s(input.command)
    case 'read':
    case 'write':
    case 'edit':
      return s(input.path)
    case 'browser_open':
      return s(input.url)
    case 'glob':
    case 'grep':
      return s(input.pattern)
    case 'list':
      return s(input.path) || '.'
    case 'terminal_create':
      return s(input.command) || s(input.name) || 'new terminal'
    case 'terminal_send':
      return s(input.command)
    case 'terminal_read':
    case 'terminal_kill':
      return s(input.id)
    default:
      return ''
  }
}
