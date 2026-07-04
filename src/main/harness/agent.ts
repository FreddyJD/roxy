/**
 * The agent loop — the thing that makes Roxy *do* the work instead of just
 * describing it. It gives the model the executable tools, streams its turn,
 * runs any tool calls it makes (in the session's workspace), feeds the results
 * back, and repeats until the model answers with prose. Emits `LlmEvent`s so the
 * renderer can render interleaved text + tool cards live.
 *
 * Tool calling covers every provider family: the OpenAI function-calling format
 * drives the openai/openai-chat wires (the large majority) plus GitHub Copilot,
 * and the Vercel AI SDK drives the Anthropic (Claude) and Google (Gemini) wires.
 * Wires without tool support yet (azure/bedrock) fall back to a plain answer.
 */
import type { ChatMessage, LlmEvent } from '../../shared/api'
import type { MessagePart, ReasoningEffort } from '../../shared/types'
import { getAgent, DEFAULT_AGENT_ID, type AgentDef } from '../../shared/agents'
import { selectPromptName, buildEnvironment, assembleSystemPrompt } from '../../shared/prompt'
import { flattenToolHistory } from '../../shared/tool-history'
import { pruneToolMessages, KEEP_RECENT_TOKENS } from '../../shared/context'
import {
  MAX_PARALLEL_SUBAGENTS,
  mapWithConcurrency,
  parseTaskInput,
  partitionToolCalls,
  renderBackgroundStarted,
  renderTaskResult,
  type TaskInput
} from '../../shared/parallel'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as repo from '../db/repo'
import { runTool } from './tools'
import { boundToolOutput } from '../services/tool-output-store'
import {
  ensureMcpConnected,
  loadWorkspaceMcpServers,
  mcpInstructions,
  mcpToolSchemas,
  mcpToolTitle,
  isMcpTool
} from '../services/mcp'
import type { McpServerRecord } from '../../shared/mcp'
import {
  SKILL_TOOL_NAME,
  SKILL_TOOL_DESCRIPTION
} from '../../shared/skills'
import { listSkills, skillInstructions } from '../services/skills'
import {
  registerBackgroundJob,
  finishBackgroundJob
} from '../services/background-tasks'
import {
  messagesHaveImages,
  openAiContent,
  openaiEndpoint,
  streamChat,
  withCopilotRetry,
  ModelHttpError,
  type OpenAiContentPart
} from '../services/llm'
import { streamViaAiSdk, usesAiSdk } from '../services/aisdk'
import { APICallError } from 'ai'

const MAX_SUBAGENT_DEPTH = 1

// ---- Overnight resilience: ride out transient model failures -----------------
// There is NO cap on how many tool calls a turn may make — the loop below runs
// `for (;;)` until the model finishes with prose or the user stops it. The thing
// that actually kills a long unattended run is a single transient provider
// failure (a rate-limit, a 5xx, a dropped socket) throwing out of the model
// stream. `streamTurn` wraps each model call so those blips are retried instead
// of ending the turn — an overnight run survives them.

/** Ceiling on the exponential backoff between model-call retries (ms). A rate-
 *  limited or blipped provider is re-tried at most this often, indefinitely,
 *  until it recovers or the user stops the turn. */
const MODEL_RETRY_MAX_DELAY = 30_000

/** How many times to retry a NON-transient model error (bad request / auth /
 *  404) before giving up. Transient errors (429 / 5xx / network) ignore this and
 *  retry forever, so a long autonomous run isn't killed by a temporary outage. */
export const MODEL_FATAL_ATTEMPTS = 5

/** Backoff (ms) before retry attempt N (0-based): 1s, 2s, 4s, 8s, 16s, then
 *  capped at 30s. Capped so an overnight run keeps poking a rate-limited
 *  provider roughly twice a minute rather than backing off into oblivion. */
export function nextRetryDelay(attempt: number): number {
  return Math.min(MODEL_RETRY_MAX_DELAY, 1000 * 2 ** Math.min(Math.max(attempt, 0), 5))
}

/** Resolve after `ms`, or immediately when the turn is aborted — so the user's
 *  Stop button interrupts a backoff wait instantly instead of hanging. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Node/undici network + stream error codes that mean "try again" — a dropped
 *  socket, refused/timed-out connection, DNS blip. These carry no HTTP status. */
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTDOWN'
])
const TRANSIENT_NET_RE =
  /fetch failed|socket hang ?up|network (?:error|timeout)|terminated|other side closed|premature close|stream (?:closed|error|aborted)|connection (?:closed|reset|refused|error)|timed? ?out|econnreset|und_err/i

/** Whether a STATUS-LESS error looks like a transient network/stream failure
 *  (worth retrying forever overnight) vs. a permanent setup error — a revoked
 *  token, "provider not connected", an unsupported wire, or a programming bug —
 *  which must surface instead of looping. Undici nests the real cause under
 *  `.cause`, so we walk the chain for a `code`. */
function looksLikeNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  let cur: unknown = e
  for (let hops = 0; cur instanceof Error && hops < 5; hops++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_NET_CODES.has(code)) return true
    const cause = (cur as { cause?: unknown }).cause
    cur = cause === cur ? undefined : cause
  }
  return TRANSIENT_NET_RE.test(e.message || '')
}

/** Billing / quota / credit-exhaustion phrases. These surface across providers
 *  with INCONSISTENT status codes — OpenAI returns 429 with code
 *  `insufficient_quota`, Anthropic a 400 "credit balance is too low", others a
 *  402 Payment Required — but they ALL mean the same thing: the account is out of
 *  money/allowance and retrying is futile until the user tops up. Kept
 *  deliberately narrow so a plain rate-limit ("rate limit reached, try again in
 *  2s") or a per-minute quota window stays a retryable transient rather than
 *  being mistaken for a hard billing wall. */
const QUOTA_BILLING_RE =
  /insufficient[_ ]?quota|exceeded your current quota|check your plan and billing|billing[_ ]?hard[_ ]?limit|hard limit (?:has been |was )?reached|out of credits|credit balance is too low|insufficient[_ ]?credits?|not enough credits|no credits (?:remaining|left)|purchase (?:more )?credits|add a payment method|payment required|billing details/i

/** The searchable text for billing/quota detection: an error's message plus any
 *  response body/data the transport captured (the JSON error the provider
 *  returned). Bounded so a huge body can't blow up the regex. */
function modelErrorText(e: unknown): string {
  if (APICallError.isInstance(e)) {
    let data = ''
    try {
      if (e.data != null) data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data)
    } catch {
      /* un-stringifiable data — ignore */
    }
    return `${e.message} ${e.responseBody ?? ''} ${data}`.slice(0, 2000)
  }
  if (e instanceof Error) return e.message.slice(0, 2000)
  return String(e).slice(0, 2000)
}

/** Whether a model failure is a HARD billing/quota/credit wall that retrying
 *  cannot fix (out of credits, quota exhausted, payment required). Unlike a plain
 *  rate-limit or 5xx (ride it out during a long run) or a generic 4xx (retry a
 *  few times in case it's a fluke), these surface IMMEDIATELY — hammering the
 *  endpoint for hours won't refill the account, and the user needs to know now so
 *  they can top up or switch providers. Detected by status (402 Payment Required)
 *  or by the provider's error text, so it catches an out-of-credits 429 that
 *  would otherwise look like an infinitely-retryable rate-limit. */
export function isNonRetryableModelError(e: unknown): boolean {
  if (e instanceof ModelHttpError && e.status === 402) return true
  if (APICallError.isInstance(e) && e.statusCode === 402) return true
  return QUOTA_BILLING_RE.test(modelErrorText(e))
}

/** Whether a failed model turn looks transient (worth riding out during a long
 *  run) vs. permanent (surface it). 429 / 5xx / 408 / 409 and recognized network
 *  errors are transient; other 4xx (bad request, auth, not-found) AND unknown
 *  status-less errors (revoked token, provider-not-connected, bugs) are fatal, so
 *  a permanently broken turn surfaces after `MODEL_FATAL_ATTEMPTS` instead of
 *  looping forever. Covers both transports: the AI SDK's `APICallError`
 *  (Anthropic/Google) and our `ModelHttpError` (OpenAI/Copilot SSE). */
export function isTransientModelError(e: unknown): boolean {
  // A billing / quota / out-of-credits wall is never worth retrying, whatever
  // status it rides in on — OpenAI returns 429 for `insufficient_quota`, others
  // a 402 or a 400 — so classify it as fatal BEFORE the status checks below (a
  // 429 would otherwise be mistaken for a plain, retry-forever rate-limit).
  if (isNonRetryableModelError(e)) return false
  if (APICallError.isInstance(e)) {
    if (typeof e.isRetryable === 'boolean') return e.isRetryable
    const s = e.statusCode
    return s === undefined || s === 408 || s === 409 || s === 429 || s >= 500
  }
  if (e instanceof ModelHttpError) {
    return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500
  }
  // No HTTP status → transient ONLY if it looks like a network/stream blip.
  // Everything else (config/auth/programming errors) is fatal and bounded.
  return looksLikeNetworkError(e)
}

/** A short, log-friendly description of a model failure. */
function describeModelError(e: unknown): string {
  if (APICallError.isInstance(e)) return `HTTP ${e.statusCode ?? '?'}`
  if (e instanceof ModelHttpError) return `HTTP ${e.status}`
  return e instanceof Error ? e.message.slice(0, 140) : String(e)
}

/** Injectable seams for `streamTurn`, used only by the smoke tests to stub the
 *  model call + skip the real backoff wait. Production passes neither. */
interface StreamTurnDeps {
  runOnce?: typeof streamOnce
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Drive ONE model turn, riding out transient provider failures so a long
 * autonomous run (many tool calls, overnight) isn't killed by a rate-limit or a
 * momentary network blip. Behaviour:
 *   - Transient error (429 / 5xx / network) BEFORE any output streamed → wait
 *     with capped exponential backoff (1s → 30s) and retry, effectively forever.
 *   - Fatal error (bad request / auth / 404) → retry a few times, then surface.
 *   - Error AFTER bytes have already streamed this attempt → rethrow, since
 *     re-running would duplicate the partial output the user already saw.
 *   - Aborted → stop immediately (the Stop button wins mid-wait and mid-attempt).
 * Same leading signature as `streamOnce`, so callers just swap the name.
 */
export async function streamTurn(
  providerId: string,
  vision: boolean,
  model: string,
  messages: OpenAiMessage[],
  signal: AbortSignal,
  reasoning: boolean | undefined,
  effort: ReasoningEffort | undefined,
  tools: ToolSchema[],
  onText: (delta: string) => void,
  onReasoning: (delta: string) => void,
  deps: StreamTurnDeps = {}
): Promise<{ text: string; toolCalls: ToolCallAccum[] }> {
  const runOnce = deps.runOnce ?? streamOnce
  const delay = deps.delay ?? abortableDelay
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) return { text: '', toolCalls: [] }
    let emitted = false
    try {
      return await runOnce(
        providerId,
        vision,
        model,
        messages,
        signal,
        reasoning,
        effort,
        tools,
        (d) => {
          emitted = true
          onText(d)
        },
        (d) => {
          emitted = true
          onReasoning(d)
        }
      )
    } catch (e) {
      if (signal.aborted) throw e
      // Once this attempt started streaming, retrying would duplicate output —
      // only clean pre-stream failures (rate limits, 5xx, refused connections)
      // are safe to ride out.
      if (emitted) throw e
      // A hard billing / quota / out-of-credits wall won't heal by retrying —
      // surface it at once (not after minutes of pointless backoff) so the user
      // can top up or switch providers instead of watching the run silently spin.
      if (isNonRetryableModelError(e)) throw e
      const transient = isTransientModelError(e)
      if (!transient && attempt + 1 >= MODEL_FATAL_ATTEMPTS) throw e
      const ms = nextRetryDelay(attempt)
      console.warn(
        `[agent] model turn failed (${describeModelError(e)}); ` +
          `retrying in ${Math.round(ms / 1000)}s (attempt ${attempt + 1}${
            transient ? '' : `/${MODEL_FATAL_ATTEMPTS}`
          })`
      )
      await delay(ms, signal)
    }
  }
}

/**
 * The tuned per-model prompt text, injected once at app startup by `main/index.ts`
 * (`setPromptText(PROMPT_TEXT)`). It stays empty in the esbuild smoke harness,
 * which never runs a model turn — hence the FALLBACK_PROMPT below.
 */
let promptText: Record<string, string> = {}

/** Inject the tuned per-model prompt text (called from the main entry). */
export function setPromptText(text: Record<string, string>): void {
  promptText = text
}

/**
 * Agent-specific prompt text, keyed by `AgentDef.promptFile` (e.g. "plan.txt"),
 * injected at startup by `main/index.ts` (`setAgentPromptText(AGENT_PROMPT_TEXT)`).
 * Layered on top of the model prompt when an agent overrides it (e.g. Plan mode).
 */
let agentPromptText: Record<string, string> = {}

/** Inject the agent-specific prompt text (called from the main entry). */
export function setAgentPromptText(text: Record<string, string>): void {
  agentPromptText = text
}

/** Minimal prompt used only when no tuned text was injected (e.g. the smoke harness). */
const FALLBACK_PROMPT =
  'You are Roxy, an autonomous AI coding agent running inside a desktop app. You have tools to read, write, and edit files, run shell commands, search the workspace, and drive a browser. When the user asks you to build, fix, or change something, use the tools to actually do it, then give a short summary of what you did.'

/** Walk up from `dir` looking for a `.git` entry; returns the repo root if found. */
function findGitRoot(dir: string): string | undefined {
  let cur = dir
  for (let i = 0; i < 64 && cur; i++) {
    try {
      if (existsSync(join(cur, '.git'))) return cur
    } catch {
      /* ignore unreadable dirs */
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Project-instruction filenames to look for, in precedence order (mirrors
 * opencode's `session/instruction.ts`). AGENTS.md is the standard; CLAUDE.md is
 * supported for Claude Code compatibility; CONTEXT.md is a deprecated legacy name.
 */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md']

/**
 * Load the project's instruction files and format them for the system prompt,
 * mirroring opencode's `Instruction.system()`. Walks up from `cwd` to the git
 * root (or just `cwd` when not in a repo), collecting instruction files so a
 * package-level `AGENTS.md` and a monorepo-root one both apply (nearest first).
 *
 * The first filename that matches *anywhere* up the tree wins, so we don't stack
 * `AGENTS.md` + `CLAUDE.md` + `CONTEXT.md` (they're usually the same guidance
 * under different names). De-duped by resolved path. Each file becomes a block:
 * `Instructions from: <path>\n<content>`.
 */
function loadProjectInstructions(cwd: string): string[] {
  if (!cwd) return []
  const root = findGitRoot(cwd) ?? cwd

  // Ancestor dirs from cwd up to (and including) the repo root — nearest first.
  const dirs: string[] = []
  let cur = cwd
  for (let i = 0; i < 64; i++) {
    dirs.push(cur)
    if (cur === root) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }

  const seen = new Set<string>()
  for (const file of INSTRUCTION_FILES) {
    const blocks: string[] = []
    for (const dir of dirs) {
      const p = resolve(join(dir, file))
      if (seen.has(p)) continue
      let content = ''
      try {
        if (existsSync(p)) content = readFileSync(p, 'utf8')
      } catch {
        continue // unreadable file — skip it
      }
      if (content.trim()) {
        seen.add(p)
        blocks.push(`Instructions from: ${p}\n${content.trim()}`)
      }
    }
    // First matching filename wins — don't also pull in the other names.
    if (blocks.length) return blocks
  }
  return []
}

/** Exposed so the renderer (via IPC) can size the context meter accurately. */
export function projectInstructions(cwd: string): string[] {
  return loadProjectInstructions(cwd)
}

/**
 * Build the system prompt for a turn: pick the tuned prompt for the model
 * (opencode's selector), append a live environment block (model identity, cwd,
 * workspace root, git, platform, date), fold in the project's instruction files
 * (AGENTS.md/CLAUDE.md/CONTEXT.md), layer any agent-specific prompt on top (e.g.
 * Plan mode's read-only reminder), and fold in any compaction summary.
 */
function buildSystemMessage(
  providerId: string,
  model: string,
  cwd: string,
  chatId?: string,
  agent?: AgentDef,
  mcpInfo?: string,
  skillInfo?: string
): string {
  const base = promptText[selectPromptName(model)] || promptText.default || FALLBACK_PROMPT
  const gitRoot = cwd ? findGitRoot(cwd) : undefined
  const environment = buildEnvironment({
    cwd: cwd || undefined,
    worktree: gitRoot,
    isGitRepo: cwd ? gitRoot !== undefined : undefined,
    platform: process.platform,
    modelId: model,
    providerId,
    date: new Date().toDateString()
  })
  // Project instructions (AGENTS.md etc.) come after the env, then any discovered
  // skills, then connected MCP servers, then the agent prompt layers last so a
  // Plan-mode reminder keeps recency priority over them.
  const instructions = cwd ? loadProjectInstructions(cwd) : []
  const agentPrompt = agent?.promptFile ? agentPromptText[agent.promptFile] : undefined
  const extra = [
    ...instructions,
    ...(skillInfo ? [skillInfo] : []),
    ...(mcpInfo ? [mcpInfo] : []),
    ...(agentPrompt ? [agentPrompt] : [])
  ]
  const contextSummary = chatId ? repo.getChat(chatId)?.contextSummary ?? undefined : undefined
  return assembleSystemPrompt({
    base,
    environment,
    extra: extra.length ? extra : undefined,
    contextSummary
  })
}

/** Strip ANSI escape sequences so colored shell output doesn't pollute the model's context. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

/**
 * The MCP servers to connect for a turn: DB-configured globals overlaid by any
 * workspace `.roxy/mcp.json` entries (workspace wins on an id collision).
 */
function gatherMcpRecords(cwd: string): McpServerRecord[] {
  const byId = new Map<string, McpServerRecord>()
  for (const r of repo.listMcpServers()) byId.set(r.id, r)
  for (const r of loadWorkspaceMcpServers(cwd)) byId.set(r.id, r)
  return [...byId.values()]
}

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
  fn(
    'webfetch',
    'Fetch a URL and return its contents as markdown (default), plain text, or raw HTML. Read-only; http:// is upgraded to https://. Use this to read docs, articles, RFCs, changelogs, or any web page. For an interactive/JS-heavy site or one needing a login, use the browser_* tools instead.',
    {
      url: str('The http(s) URL to fetch.'),
      format: str('Output format: "markdown" (default), "text", or "html".'),
      timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 120).' }
    },
    ['url']
  ),
  fn(
    'websearch',
    'Search the web for fresh, current information beyond the training cutoff, and get back the most relevant results with snippets. Use it to find docs, error messages, library versions, or recent events, then webfetch a result URL for the full page.',
    {
      query: str('The search query.'),
      numResults: { type: 'number', description: 'How many results to return (default 8, max 20).' }
    },
    ['query']
  ),
  fn(
    'bash',
    'Run a shell command in the workspace (PowerShell on Windows). By default each call is a FRESH shell (cwd/env do NOT persist) that returns when the command finishes or after `timeout` seconds. For a LONG-RUNNING process (a dev server, watcher, `npm run dev`), pass background:true — it starts the process and returns immediately with an id; then use bash_output to read its logs and bash_kill to stop it.',
    {
      command: str('The command.'),
      timeout: { type: 'number', description: 'Foreground timeout in seconds (default 60, max 600). Ignored when background is true.' },
      background: { type: 'boolean', description: 'Run as a long-lived background process (servers/watchers) instead of waiting. Returns a process id.' }
    },
    ['command']
  ),
  fn('bash_list', 'List the background processes running in this workspace (id, status, runtime, command).', {}, []),
  fn(
    'bash_output',
    'Read new output from a background process started by bash (background:true), and whether it is still running or has exited.',
    { id: str('The background process id, e.g. "bg_1" (from bash or bash_list).') },
    ['id']
  ),
  fn('bash_kill', 'Stop a background process started by bash (background:true).', { id: str('The background process id, e.g. "bg_1".') }, ['id']),
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
  fn('browser_close', 'Close the built-in browser and end the current browsing session.', {}, []),
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
  fn(
    'change_session_metadata',
    "Organize THIS session: set its `title` (shown in the sidebar), a one-line `description` of what it's about, and/or a `tasks` checklist you maintain as you work. Send the FULL tasks array each time — it REPLACES the previous list. Use it to rename a vaguely-named session and to track multi-step work (mark a task in_progress when you start it, completed when done).",
    {
      title: str('A short session name, ≤ 80 chars. Optional.'),
      description: str('A one-line summary of what this session is for. Optional.'),
      tasks: {
        type: 'array',
        description: 'The full task checklist, replacing the previous one. Optional.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What the task is.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Task status.'
            }
          },
          required: ['title', 'status']
        }
      }
    },
    []
  ),
  fn(
    'lsp',
    'Report the language server diagnostics (type errors, unused symbols, unresolved imports, warnings) for a file. Edits and writes already append fresh diagnostics automatically, so use this to re-check a file on demand — e.g. after a bash build/codegen step, or to inspect a file you did not just edit. Returns nothing when the file is clean or its language server is not installed.',
    { path: str('File path, relative to the workspace.') },
    ['path']
  ),
  fn(
    'mcp',
    'Manage external MCP (Model Context Protocol) tool servers for this workspace — add one, list them, (re)connect, enable/disable, or remove. Adding or reconnecting a server connects it immediately and its namespaced tools (`mcp__<server>__<tool>`) become available to you right away, in this same turn. Use this whenever the user wants to hook up an MCP server (e.g. a filesystem, GitHub, Postgres, or Playwright server) so you can use its tools — no app restart or Settings visit needed.',
    {
      action: {
        type: 'string',
        enum: ['add', 'list', 'reconnect', 'enable', 'disable', 'remove'],
        description:
          '"add" (create/replace a server and connect it), "list" (show configured servers with status + tools), "reconnect" (refresh/retry a server), "enable"/"disable" (activate/deactivate), "remove" (delete).'
      },
      id: str('A short unique name for the server, e.g. "filesystem" or "github". Required for every action except "list".'),
      command: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For a LOCAL (stdio) server on "add": the argv to spawn, e.g. ["npx","-y","@modelcontextprotocol/server-filesystem","/abs/dir"]. Provide EITHER command (local) OR url (remote).'
      },
      url: str('For a REMOTE (HTTP) server on "add": the server URL. Provide EITHER url (remote) OR command (local).'),
      env: {
        type: 'object',
        description: 'Optional environment variables for a local server, e.g. {"API_KEY":"…"}.',
        additionalProperties: { type: 'string' }
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers for a remote server, e.g. {"Authorization":"Bearer …"}.',
        additionalProperties: { type: 'string' }
      },
      cwd: str('Optional working directory for a local server (relative paths resolve from the workspace).')
    },
    ['action']
  ),
  fn(
    'skill_manage',
    'Create and manage reusable Skills — SKILL.md workflow files the agent can later load on demand with the `skill` tool. A skill packages a repeatable workflow, house style, or domain playbook as named instructions so it can be reused across turns and sessions. Use this when the user asks you to "save/create a skill", capture a workflow for next time, install a skill from a GitHub repo/URL (like `npx skills add`), or edit/remove an existing skill. A newly created or installed skill becomes loadable on the next turn.',
    {
      action: {
        type: 'string',
        enum: ['create', 'install', 'list', 'edit', 'remove'],
        description:
          '"create" (write a new skill from a body), "install" (fetch skill(s) from a GitHub repo/URL given in `source`), "list" (show discovered skills), "edit" (update an existing skill — omitted fields are kept), "remove" (delete one).'
      },
      name: str(
        'The skill name — letters, digits, dot, dash, or underscore (no spaces or slashes). Required for create/edit/remove; not used by "install" (names come from the fetched SKILL.md).'
      ),
      source: str(
        'For action "install": where to fetch from — a GitHub "owner/repo" shorthand, a github.com repo/tree/blob URL, or a direct https URL to a SKILL.md. Installs every SKILL.md it finds (repo root + skills/).'
      ),
      description: str(
        "A one-line summary of WHEN to use this skill. Stored in frontmatter and shown to the agent so it knows when to load the skill. Strongly recommended on create."
      ),
      body: {
        type: 'string',
        description:
          "The skill's full instructions as Markdown — the workflow/guidance injected when the skill is loaded. Required on create."
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'global'],
        description:
          '"workspace" (default) writes to <workspace>/.roxy/skills/<name>/SKILL.md (committed with the project); "global" writes to ~/.roxy/skills/<name>/SKILL.md (available in every project).'
      }
    },
    ['action']
  )
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
  'Delegate a focused, self-contained sub-task to a specialized subagent that runs on its own and reports back. Use this to parallelize or offload work (e.g. build a page, research the codebase). The subagent has NO memory of this conversation, so put ALL the context it needs into `prompt`. It returns a single report. Call task multiple times IN ONE turn to run several subagents concurrently — they execute in parallel (bounded), so batch independent work together.',
  {
    description: str('A short (3-5 word) label for the task.'),
    prompt: str('The complete task for the subagent, including every bit of context it needs.'),
    subagent_type: str(
      'Which subagent: "general" (full tools, multi-step work) or "explore" (read-only search/understanding).'
    ),
    background: {
      type: 'boolean',
      description:
        'Run detached: return immediately and notify you when it finishes, instead of blocking for the result. Use ONLY for independent, long-running work you can continue past. Do NOT poll it or duplicate its work. Default false (wait for the result).'
    }
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

/**
 * The `skill` tool — loads a discovered SKILL.md on demand. Kept out of
 * BASE_SCHEMAS so it's offered only when the workspace actually has skills (and
 * only to agents whose allowlist permits it). Loading a skill is read-only, so it
 * is available to Plan too.
 */
const SKILL_SCHEMA = fn(
  SKILL_TOOL_NAME,
  SKILL_TOOL_DESCRIPTION,
  { name: str('The exact name of the skill to load, from the available skills list in the system prompt.') },
  ['name']
)

/** Whether an agent's tool allowlist permits the `skill` tool. */
function agentAllowsSkill(agent: AgentDef): boolean {
  return agent.tools === 'all' || agent.tools.includes(SKILL_TOOL_NAME)
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
      reasoning_content?: string
      reasoning?: string
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
  /** Which primary agent to run (e.g. "build" or "plan"). Defaults to build. */
  agentId?: string
  signal: AbortSignal
  emit: (event: LlmEvent) => void
  /** Whether the model supports reasoning (gates the reasoning params). */
  reasoning?: boolean
  reasoningEffort?: ReasoningEffort
  /** Effective context budget (tokens). */
  contextLimit?: number
}

/**
 * An agent is read-only when it may not write or edit files (its tool allowlist
 * excludes both). Plan mode qualifies; such agents also may only delegate to
 * other read-only subagents (mirrors opencode denying `task.general` in plan).
 */
function isReadOnlyAgent(agent: AgentDef): boolean {
  return agent.tools !== 'all' && !agent.tools.includes('write') && !agent.tools.includes('edit')
}

/**
 * Convert a persisted `ChatMessage` into the loop's OpenAI-shaped message,
 * preserving structured tool history: an assistant turn keeps its `tool_calls`,
 * and a `role:'tool'` result keeps its `tool_call_id`. Both the OpenAI SSE path
 * and the AI SDK path (`toModelMessages`) understand this shape, so Claude/Gemini
 * and OpenAI/Copilot all replay prior tool calls structurally.
 */
function toOpenAiMessage(m: ChatMessage): OpenAiMessage {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
    return {
      role: 'assistant',
      // Anthropic rejects an assistant turn with tool_calls and empty content is fine,
      // but an empty string trips some OpenAI-compatible servers — use null instead.
      content: m.content ? m.content : null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments }
      }))
    }
  }
  return { role: m.role, content: openAiContent(m) }
}

/** Run one user turn: the tool-using agent loop (primary "build" agent) or a plain answer. */
export async function runAgentTurn(opts: RunTurnOptions): Promise<void> {
  const { providerId, model, messages, cwd, chatId, agentId, signal, emit, reasoning, reasoningEffort, contextLimit } =
    opts
  const wire =
    providerId === 'github-copilot'
      ? 'openai-chat'
      : repo.listConnectedProviders().find((p) => p.id === providerId)?.wire
  // Tool-capable wires: the OpenAI SSE path (openai/openai-chat + Copilot) and
  // the AI SDK path (anthropic/google). Azure/Bedrock still fall back to a plain
  // answer until their tool transports land.
  const toolCapable =
    providerId === 'github-copilot' || wire === 'openai' || wire === 'openai-chat' || usesAiSdk(wire)

  // Resolve the chosen primary agent (Build by default). A subagent id or an
  // unknown id falls back to Build so a bad selection can't disable tools.
  const selected = getAgent(agentId ?? DEFAULT_AGENT_ID)
  const agent = selected && selected.mode === 'primary' ? selected : getAgent(DEFAULT_AGENT_ID)!
  const readOnly = isReadOnlyAgent(agent)

  // Connect any configured MCP servers (DB globals + workspace `.roxy/mcp.json`)
  // before building the prompt, so their tools + a describing blurb are available.
  // Gated to tool-capable, workspace-bound, non-read-only turns; the connection
  // pool is warm, so only the first turn pays the spawn/handshake latency.
  let mcpSchemas: ReturnType<typeof mcpToolSchemas> = []
  let mcpInfo: string | undefined
  if (toolCapable && cwd && !readOnly) {
    const records = gatherMcpRecords(cwd)
    if (records.length) {
      await ensureMcpConnected(records, cwd)
      // Scope to THIS turn's records so a workspace's `.roxy/mcp.json` servers can't
      // leak into a different workspace's chat (the pool is process-global).
      const ids = new Set(records.map((r) => r.id))
      mcpSchemas = mcpToolSchemas(ids)
      mcpInfo = mcpInstructions(ids)
    }
  }

  // Discover SKILL.md files (workspace + global) and, if any exist, advertise them
  // in the prompt + offer the `skill` tool. Loading a skill just injects text, so
  // this is read-only-safe — available in Plan mode too, subject to the agent's
  // tool allowlist. Discovery is cached per workspace (first turn pays the scan).
  // `skillInfo` is the workspace's skills block as data (threaded to subagents,
  // which gate their own injection); the parent only advertises/offers it when its
  // own allowlist permits the tool, so we never dangle a tool the agent can't call.
  let skillSchemas: ToolSchema[] = []
  let skillInfo: string | undefined
  if (toolCapable && cwd) {
    const skills = await listSkills(cwd)
    if (skills.length) {
      skillInfo = await skillInstructions(cwd)
      if (agentAllowsSkill(agent)) skillSchemas = [SKILL_SCHEMA]
    }
  }
  const parentSkillInfo = agentAllowsSkill(agent) ? skillInfo : undefined

  // Prepend the system prompt. It's built here in the main process so it can see
  // the provider + model + workspace (and pick the right per-model prompt) and
  // layer the agent's own prompt (e.g. Plan mode); the renderer no longer sends
  // its own system message.
  const systemText = buildSystemMessage(providerId, model, cwd ?? '', chatId, agent, mcpInfo, parentSkillInfo)
  const systemMessage: ChatMessage = { role: 'system', content: systemText }

  // No workspace, or a wire without tool support yet → plain streamed answer.
  // The simple streamChat builders don't speak tool roles, so fold any structured
  // tool history from earlier turns back into plain text first.
  if (!toolCapable || !cwd) {
    await streamChat({
      providerId,
      model,
      messages: [systemMessage, ...flattenToolHistory(messages)],
      signal,
      onDelta: (text) => emit({ type: 'text', delta: text }),
      reasoning,
      reasoningEffort,
      contextLimit
    })
    return
  }

  const vision = messagesHaveImages(messages)
  // Preserve structured tool history: assistant `tool_calls` + `role:'tool'`
  // results survive across turns so the model keeps its multi-turn reasoning.
  const convo: OpenAiMessage[] = [systemMessage, ...messages].map(toOpenAiMessage)

  // The agent runs with its allowlisted tools. Primaries may delegate via `task`;
  // a read-only agent (Plan) may only spawn read-only subagents (enforced below).
  await runLoop({
    providerId,
    vision,
    model,
    convo,
    cwd,
    parentChatId: chatId,
    sessionId: chatId,
    signal,
    emitTool: emit,
    onText: (delta) => emit({ type: 'text', delta }),
    onReasoning: (delta) => emit({ type: 'reasoning', delta }),
    tools: [...schemasFor(agent.tools, true), ...mcpSchemas, ...skillSchemas],
    mcpTools: mcpSchemas,
    skillTools: skillSchemas,
    skillInfo,
    readOnly,
    reasoning,
    effort: reasoningEffort,
    contextLimit,
    depth: 0
  })
}

interface LoopOptions {
  /** The connected provider — re-resolved each call so Copilot's token can refresh. */
  providerId: string
  /** Whether the initial messages carry images (flips on vision headers). */
  vision: boolean
  model: string
  convo: OpenAiMessage[]
  cwd: string
  /** Parent session id — subagents spawned here persist as its `sub` children. */
  parentChatId?: string
  /** The session this loop runs — the target of `change_session_metadata`. */
  sessionId?: string
  signal: AbortSignal
  /** Tool cards — the parent's and any subagent's tool work both surface here. */
  emitTool: (event: LlmEvent) => void
  /** Prose deltas — the parent streams them; a subagent swallows them (captured via the return). */
  onText: (delta: string) => void
  /** Reasoning/thinking deltas (when the model streams them) — the parent shows them live. */
  onReasoning: (delta: string) => void
  tools: ToolSchema[]
  /** MCP tool schemas (subset of `tools`) — passed to non-read-only subagents too. */
  mcpTools?: ToolSchema[]
  /** The `skill` tool schema (when the workspace has skills) — passed to subagents that allow it. */
  skillTools?: ToolSchema[]
  /** The discovered-skills prompt block — injected into subagent system prompts too. */
  skillInfo?: string
  /** Read-only agent (Plan): its `task` calls may only spawn read-only subagents. */
  readOnly?: boolean
  reasoning?: boolean
  effort?: ReasoningEffort
  /** Token budget for the rolling conversation (drops oldest tool results to fit). */
  contextLimit?: number
  depth: number
}

/** The shared agent loop: stream → run tools (incl. `task`) → repeat. Returns the final prose. */
async function runLoop(o: LoopOptions): Promise<string> {
  const { providerId, vision, model, convo, cwd, parentChatId, sessionId, signal, emitTool, onText, onReasoning, tools, mcpTools, skillTools, skillInfo, readOnly, reasoning, effort, contextLimit, depth } =
    o
  let lastText = ''

  // The tool list is normally fixed for the turn, but the `mcp` tool can connect a
  // brand-new server mid-turn. When it does, we recompute the MCP schemas and merge
  // them back in so the just-added server's tools are callable on the very next
  // model step — "add a server and use it in the same breath". `baseTools` is
  // everything that ISN'T an MCP schema (built-ins + `task` + skill), captured by
  // reference so the rebuild is exact; `liveTools`/`liveMcpTools` start unchanged.
  const mcpSet = new Set(mcpTools ?? [])
  const baseTools = tools.filter((t) => !mcpSet.has(t))
  let liveMcpTools = mcpTools ?? []
  let liveTools = tools

  // No step cap — keep streaming → running tools → repeating until the model
  // finishes with prose (no tool calls) or the user stops it (signal aborts).
  for (;;) {
    if (signal.aborted) return lastText
    const { text, toolCalls } = await streamTurn(
      providerId,
      vision,
      model,
      trimConvo(convo, contextLimit),
      signal,
      reasoning,
      effort,
      liveTools,
      onText,
      onReasoning
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

    // Run the turn's tool calls. `task` delegations run concurrently through a
    // bounded pool (parallel subagents — Phase 11) and overlap with the other
    // tools, which stay sequential so file-mutating calls can't race each other.
    // Every result is paired back to its call id in the ORIGINAL order, so the
    // assistant.tool_calls ↔ role:'tool' structure the model sees stays valid.
    const { tasks, others } = partitionToolCalls(toolCalls)

    // Kick the subagents off first so they run while the sequential tools below
    // execute. The pool never throws (runSubagent handles its own errors); the
    // extra guard just turns any unexpected setup failure into a task_error.
    const tasksSettled = mapWithConcurrency(tasks, MAX_PARALLEL_SUBAGENTS, async (tc) => {
      const parsed = parseTaskInput(tc.args)
      try {
        const result = await runSubagent({
          callId: tc.id,
          input: parsed,
          providerId,
          vision,
          model,
          cwd,
          parentChatId,
          readOnly,
          signal,
          emit: emitTool,
          reasoning,
          effort,
          contextLimit,
          depth,
          mcpTools: liveMcpTools,
          skillTools,
          skillInfo
        })
        return { id: tc.id, content: result.slice(0, 12_000) }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { id: tc.id, content: renderTaskResult(parsed.subagentType, 'error', msg) }
      }
    })

    const resultById = new Map<string, string>()
    for (const tc of others) {
      if (signal.aborted) break
      let input: Record<string, unknown> = {}
      try {
        input = tc.args.trim() ? (JSON.parse(tc.args) as Record<string, unknown>) : {}
      } catch {
        input = {}
      }

      emitTool({ type: 'tool-start', callId: tc.id, tool: tc.name, title: toolTitle(tc.name, input), input })
      const result = await runTool(tc.name, input, {
        cwd,
        sessionId,
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
      // Full output still streams to the UI (tool-end above); for the model's
      // rolling context, spill oversized results to disk and keep a head/tail
      // preview + a read-tool pointer instead of a blind 8k cut (Phase 9.3).
      const toolText = stripAnsi(result.output) || '(no output)'
      resultById.set(tc.id, await boundToolOutput(sessionId ?? '', tc.id, toolText))
    }

    // If the model just added/enabled/reconnected an MCP server via the `mcp` tool,
    // its connection is now live in the process-global pool — recompute this
    // workspace's MCP schemas and merge them into the tool list so the new tools
    // are callable on the very next model step (this turn), not only next message.
    if (cwd && !readOnly && others.some((tc) => tc.name === 'mcp')) {
      const ids = new Set(gatherMcpRecords(cwd).map((r) => r.id))
      liveMcpTools = mcpToolSchemas(ids)
      liveTools = [...baseTools, ...liveMcpTools]
    }

    // Join the parallel subagents, then append every tool result in the original
    // tool_calls order so the paired structure is preserved for the next stream.
    for (const r of await tasksSettled) resultById.set(r.id, r.content)
    if (signal.aborted) return lastText
    for (const tc of toolCalls) {
      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultById.get(tc.id) ?? '(no result)'
      })
    }
  }
}

interface SubagentOptions {
  callId: string
  /** The parsed `task` arguments (description/prompt/subagent_type/background). */
  input: TaskInput
  providerId: string
  vision: boolean
  model: string
  cwd: string
  parentChatId?: string
  /** The parent is read-only (Plan) — only read-only subagents may be spawned. */
  readOnly?: boolean
  signal: AbortSignal
  emit: (event: LlmEvent) => void
  reasoning?: boolean
  effort?: ReasoningEffort
  contextLimit?: number
  depth: number
  /** MCP tool schemas to expose to non-read-only subagents. */
  mcpTools?: ToolSchema[]
  /** The `skill` tool schema to expose to subagents whose allowlist permits it. */
  skillTools?: ToolSchema[]
  /** The discovered-skills prompt block to inject into the subagent's system prompt. */
  skillInfo?: string
}

/** Spawn a subagent: a focused child run of the same loop, returned as a `task` result. */
async function runSubagent(o: SubagentOptions): Promise<string> {
  const { callId, input, providerId, vision, model, cwd, parentChatId, readOnly, signal, emit, reasoning, effort, contextLimit, depth, mcpTools, skillTools, skillInfo } =
    o
  const { description, prompt, subagentType, background } = input
  const fail = (msg: string): string => {
    emit({
      type: 'tool-start',
      callId,
      tool: 'task',
      title: description,
      input: { description, prompt, subagent_type: subagentType }
    })
    emit({ type: 'tool-end', callId, output: msg, ok: false })
    return renderTaskResult(subagentType, 'error', msg)
  }

  const agent = getAgent(subagentType)
  if (!agent || agent.mode !== 'subagent') {
    return fail(`Unknown subagent "${subagentType}". Valid subagents: general, explore.`)
  }
  // A read-only agent (Plan) may only delegate to read-only subagents, so it can't
  // sidestep its own restriction by spawning an editing subagent (opencode denies
  // `task.general` in plan mode for the same reason).
  if (readOnly && !isReadOnlyAgent(agent)) {
    return fail(
      `In read-only (Plan) mode you can only delegate to the read-only "explore" subagent, not "${subagentType}".`
    )
  }
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return fail('Subagents cannot spawn further subagents.')
  }

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

  // Run the subagent's own loop: record its steps as parts, persist them to the
  // sub session, and return the final report + state. `forwardToParent` streams
  // the nested tool cards into the launching turn (foreground) — a background run
  // skips that (the turn may already be over) and reports via the sub session.
  const runBody = async (
    runSignal: AbortSignal,
    forwardToParent: boolean
  ): Promise<{ report: string; state: 'completed' | 'error' }> => {
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
    // the parent AND are recorded into its own session's parts.
    const emitNested = (event: LlmEvent): void => {
      if (event.type === 'tool-start') {
        toolAt.set(event.callId, parts.length)
        parts.push({ type: 'tool', tool: event.tool, state: 'running', title: event.title })
        if (forwardToParent) emit({ ...event, callId: `${callId}.${event.callId}` })
      } else if (event.type === 'tool-delta') {
        const p = parts[toolAt.get(event.callId) ?? -1]
        if (p?.type === 'tool') p.output = (p.output ?? '') + event.chunk
        if (forwardToParent) emit({ ...event, callId: `${callId}.${event.callId}` })
      } else if (event.type === 'tool-end') {
        const p = parts[toolAt.get(event.callId) ?? -1]
        if (p?.type === 'tool') {
          p.state = event.ok ? 'done' : 'error'
          p.output = event.output
          p.image = event.image
          p.diff = event.diff
        }
        if (forwardToParent) emit({ ...event, callId: `${callId}.${event.callId}` })
      }
    }

    try {
      const text = await runLoop({
        providerId,
        vision,
        model,
        convo: [
          { role: 'system', content: subagentSystemPrompt(agent, cwd, skillInfo) },
          { role: 'user', content: prompt || description }
        ],
        cwd,
        signal: runSignal,
        emitTool: emitNested,
        onText: addText,
        onReasoning: () => {},
        tools: [
          ...schemasFor(agent.tools, false),
          ...(isReadOnlyAgent(agent) ? [] : (mcpTools ?? [])),
          ...(agentAllowsSkill(agent) ? (skillTools ?? []) : [])
        ],
        mcpTools,
        skillTools,
        skillInfo,
        reasoning,
        effort,
        contextLimit,
        depth: depth + 1
      })
      persistSub()
      return { report: text.trim() || '(subagent returned no report)', state: 'completed' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      persistSub()
      return { report: `Subagent failed: ${msg}`, state: 'error' }
    }
  }

  // ---- Background: launch detached, return immediately, report on completion. ----
  // opencode gates this behind an experimental flag; Roxy makes it first-class.
  // Requires a parent session to persist the report onto; without one, run inline.
  if (background && parentChatId != null) {
    emit({
      type: 'tool-start',
      callId,
      tool: 'task',
      title: `${agent.name}: ${description} (background)`,
      input: { description, prompt, subagent_type: subagentType, background: true }
    })
    emit({ type: 'tool-end', callId, output: `Started "${description}" in the background.`, ok: true })

    // Its own signal — the launching turn ending must NOT cancel it (that's the
    // whole point). Session delete / app quit cancel it via the registry.
    const { jobId, signal: bgSignal } = registerBackgroundJob({
      sessionId: parentChatId,
      subChatId,
      description,
      subagentType
    })
    void runBody(bgSignal, false)
      .then(({ report, state }) => {
        // A cancelled job (session delete, app quit, or explicit cancel) aborts
        // bgSignal. That abort can land BETWEEN steps, where runLoop returns
        // normally with a partial/empty report — so `state` may be 'completed'
        // even though the work was cut short. Never record a cancelled run as a
        // successful completion: the transcript card AND the structured tool
        // history the next turn reconstructs from it would both mislead.
        const cancelled = bgSignal.aborted
        const finalState: 'completed' | 'error' = cancelled ? 'error' : state
        const finalReport = cancelled
          ? `The "${description}" background task was cancelled before it finished.`
          : report
        // Deliver the report onto the parent session as a self-contained task card,
        // so it's visible in the transcript AND becomes structured tool history the
        // next turn can see (reconstructTurn pairs the call with its result).
        try {
          repo.addMessage({
            chatId: parentChatId,
            role: 'assistant',
            content: '',
            parts: [
              {
                type: 'tool',
                tool: 'task',
                state: finalState === 'error' ? 'error' : 'done',
                title: `Background ${
                  cancelled ? 'cancelled' : finalState === 'error' ? 'failed' : 'done'
                }: ${description}`,
                callId: `bgres_${jobId}`,
                input: { description, subagent_type: subagentType, background: true },
                output: finalReport
              }
            ]
          })
        } catch {
          // parent may have been deleted mid-run — the broadcast below still fires
        }
        finishBackgroundJob(jobId, finalState)
      })
      .catch(() => {
        // runBody is written never to reject, but guard the detached chain anyway:
        // once the launching turn is gone there is no owner for a stray rejection.
        finishBackgroundJob(jobId, 'error')
      })
    return renderBackgroundStarted(subagentType, description)
  }

  // ---- Foreground: announce, run to completion, return the report. ----
  emit({
    type: 'tool-start',
    callId,
    tool: 'task',
    title: `${agent.name}: ${description}`,
    input: { description, prompt, subagent_type: subagentType }
  })
  const { report, state } = await runBody(signal, true)
  emit({ type: 'tool-end', callId, output: report, ok: state === 'completed' })
  return renderTaskResult(subagentType, state, report)
}

/** A subagent's focused system prompt: who it is, that it starts blank, and to report back. */
function subagentSystemPrompt(agent: AgentDef, cwd: string, skillInfo?: string): string {
  // Prefer the agent's tuned prompt (e.g. explore's "file search specialist") when
  // one is injected; otherwise fall back to a generic identity line.
  const injected = agent.promptFile ? agentPromptText[agent.promptFile] : undefined
  const lines = [
    injected?.trim() || `You are the "${agent.name}" subagent. ${agent.description}`,
    'A lead agent delegated a focused task to you. You have NO memory of the prior conversation — work only from the task below.',
    'Use your tools to complete it, then reply with a concise report: what you found or did, files created/edited (with paths), and key results. Be terse.'
  ]
  if (agent.tools !== 'all') {
    lines.push(`You may only use these tools: ${agent.tools.join(', ')}.`)
  }
  // Surface any discovered skills so the subagent can load one when it allows the tool.
  if (skillInfo && agentAllowsSkill(agent)) lines.push(skillInfo)
  if (cwd) lines.push(`The workspace folder is ${cwd}. Tool paths are relative to it.`)
  return lines.join('\n\n')
}

/** Stream one model turn, accumulating prose text and tool calls. */
async function streamOnce(
  providerId: string,
  vision: boolean,
  model: string,
  messages: OpenAiMessage[],
  signal: AbortSignal,
  reasoning: boolean | undefined,
  effort: ReasoningEffort | undefined,
  tools: ToolSchema[],
  onText: (delta: string) => void,
  onReasoning: (delta: string) => void
): Promise<{ text: string; toolCalls: ToolCallAccum[] }> {
  // Anthropic/Google speak their own wire — route them through the AI SDK, which
  // handles their tool-calling. The return shape matches the OpenAI path below,
  // so the loop stays wire-agnostic. (Copilot is always openai-chat → SSE path.)
  const provider =
    providerId === 'github-copilot'
      ? undefined
      : repo.listConnectedProviders().find((p) => p.id === providerId)
  const wire = providerId === 'github-copilot' ? 'openai-chat' : provider?.wire
  if (usesAiSdk(wire)) {
    return streamViaAiSdk({
      wire,
      baseURL: provider?.baseURL,
      apiKey: repo.getProviderToken(providerId),
      model,
      messages,
      tools,
      signal,
      reasoning,
      effort,
      onText,
      onReasoning
    })
  }

  const payload = JSON.stringify({
    model,
    messages,
    tools,
    tool_choice: 'auto',
    ...(reasoning && effort ? { reasoning_effort: effort } : {}),
    stream: true
  })
  // Resolve a FRESH endpoint + auth on EVERY model call. For GitHub Copilot this
  // re-exchanges the short-lived Copilot token as it nears expiry, so a long
  // agent loop (many tool calls) never sends a stale token — the root cause of
  // the intermittent "IDE token expired" 401.
  const send = async (): Promise<Response> => {
    const { url, headers } = await openaiEndpoint(providerId, { vision })
    return fetch(url, { method: 'POST', headers, body: payload, signal })
  }
  // On a 401 the token was rejected (expiry race / clock skew) — drop it, wait,
  // and retry a few times before surfacing the error.
  const res = await withCopilotRetry(providerId === 'github-copilot', send, signal)
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new ModelHttpError(res.status, `Model request failed (${res.status}). ${body.slice(0, 300)}`)
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
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
      if (reasoningDelta) onReasoning(reasoningDelta)
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

/** Rough token estimate for a message (~4 chars/token, incl. tool-call args). */
function msgTokens(m: OpenAiMessage): number {
  const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
  const calls = m.tool_calls ? JSON.stringify(m.tool_calls) : ''
  return Math.ceil((c.length + calls.length) / 4)
}

/**
 * Keep the rolling agent conversation under the model's context budget. Two
 * stages, matching opencode's "prune tool output first, then drop turns":
 * (1) shrink *old* tool outputs to a preview (recent ones stay intact) so the
 * reasoning thread survives; (2) if still over, drop the oldest turns. System
 * messages always stay. A `tool` reply can't lead the kept window (its assistant
 * call would be gone → an orphaned tool message), so leading tool replies are
 * trimmed too. Prevents a long tool-heavy loop from blowing past 100% (the
 * "Tool Results 101%" overflow).
 */
function trimConvo(convo: OpenAiMessage[], budget = 200_000): OpenAiMessage[] {
  const cap = Math.max(8000, budget - 12_000) // leave room for the model's reply
  if (convo.reduce((n, m) => n + msgTokens(m), 0) <= cap) return convo
  // Stage 1 — prune older tool outputs to a preview before dropping any turn.
  const pruned = pruneToolMessages(convo, { keepRecentTokens: Math.min(KEEP_RECENT_TOKENS, cap) })
  const total = pruned.reduce((n, m) => n + msgTokens(m), 0)
  if (total <= cap) return pruned
  // Stage 2 — still over budget: drop the oldest non-system turns.
  const sys = pruned.filter((m) => m.role === 'system')
  const rest = pruned.filter((m) => m.role !== 'system')
  let used = sys.reduce((n, m) => n + msgTokens(m), 0)
  const kept: OpenAiMessage[] = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = msgTokens(rest[i])
    if (used + t > cap && kept.length > 0) break
    kept.unshift(rest[i])
    used += t
  }
  // Normalize the leading edge to a user message. Stripping leading role:'tool'
  // messages avoids orphaning a tool_result from its (trimmed) tool_call; also
  // dropping a dangling leading assistant keeps the window valid for providers
  // that require a user-role first message (Anthropic). Suffix-trimming above
  // guarantees any kept assistant tool_calls still have their following results,
  // so this only ever removes stale boundary turns.
  while (kept.length && kept[0].role !== 'user') kept.shift()
  return [...sys, ...kept]
}

/** A short, human-readable summary shown on the tool card. */
function toolTitle(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'bash':
      return s(input.command)
    case 'bash_output':
    case 'bash_kill':
      return s(input.id)
    case 'bash_list':
      return 'background processes'
    case 'read':
    case 'write':
    case 'edit':
      return s(input.path)
    case 'browser_open':
      return s(input.url)
    case 'webfetch':
      return s(input.url)
    case 'websearch':
      return s(input.query)
    case 'glob':
    case 'grep':
      return s(input.pattern)
    case 'list':
      return s(input.path) || '.'
    case 'change_session_metadata':
      return s(input.title) || s(input.name) || 'session metadata'
    case 'skill':
      return s(input.name)
    default:
      return isMcpTool(name) ? mcpToolTitle(name) : ''
  }
}
