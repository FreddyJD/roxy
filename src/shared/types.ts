/**
 * Shared domain types used by both the Electron main process and the React
 * renderer. This module must stay isomorphic — types and plain data only, no
 * Node, Electron, or browser-specific imports.
 */

// ---- Providers ---------------------------------------------------------------

/** Wire protocol a provider speaks. Everything reduces to one of these. */
export type ProviderWire = 'anthropic' | 'openai' | 'openai-chat' | 'google' | 'bedrock' | 'azure'

/** Auth flow a provider needs. There are only eight. */
export type ProviderAuth =
  | 'api-key'
  | 'oauth'
  | 'device-flow'
  | 'aws-sigv4'
  | 'gcp-adc'
  | 'azure-ad'
  | 'none'
  /**
   * Signed in through the locally-managed CLIProxyAPI sidecar: the user's own
   * ChatGPT/Codex subscription, brokered by a proxy bound to 127.0.0.1 that
   * holds the OAuth tokens on disk itself. Nothing lands in Roxy's own
   * credential table, because there is no key to store.
   */
  | 'subscription'

export type ProviderGroup =
  | 'frontier'
  | 'enterprise'
  | 'gateway'
  | 'gpu'
  | 'labs'
  | 'github'
  | 'local'
  | 'custom'

/** A hand-maintained seed entry: wire protocol + auth method per provider. */
export interface SeedProvider {
  id: string
  name: string
  wire: ProviderWire
  auth: ProviderAuth
  group: ProviderGroup
  /** Fixed base URL, or undefined when the user supplies it. */
  baseURL?: string
  /** Env var name(s) models.dev advertises for headless auth. */
  env?: string[]
  /** GPT-5+ on this provider routes to the Responses API instead of chat. */
  responsesForGpt5?: boolean
  /** Surface this provider prominently (badge + top of the list) in onboarding. */
  recommended?: boolean
  notes?: string
}

/** A provider the user has connected. Persisted in SQLite. */
export interface ConnectedProvider {
  id: string
  name: string
  wire: ProviderWire
  auth: ProviderAuth
  baseURL?: string
  defaultModel?: string
  hasCredential: boolean
  enabled: boolean
  /** User-defined provider order (higher = higher in Settings/model picker). */
  sortOrder: number
  createdAt: number
}

export interface ConnectProviderInput {
  id: string
  apiKey?: string
  baseURL?: string
  defaultModel?: string
}

export interface DeviceFlowStart {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
  expiresIn: number
}

// ---- Chats & messages --------------------------------------------------------

/**
 * Every chat row is a session. Main sessions are the ones a user opens against a
 * workspace; sub sessions are spawned by the harness (e.g. the `task` tool);
 * loop sessions are driven by a scheduled Loop.
 */
export type SessionKind = 'main' | 'sub' | 'loop'

/** A single item in a session's agent-maintained task checklist. */
export interface SessionTask {
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * How a session wants its worktree created.
 *   new        — a fresh branch off the default branch
 *   fromBranch — a new worktree checking out an existing branch
 *   attach     — reuse the worktree that already holds `branch`
 */
export interface WorktreeIntent {
  mode: 'new' | 'fromBranch' | 'attach'
  branch?: string
  /**
   * For `new`: the commit the fresh branch starts from, instead of the usual
   * `origin/<default>`. Set when a session is FORKED, so the copy continues
   * from the code its inherited transcript is actually about — branching a fork
   * off main would hand it a history describing files that aren't there.
   *
   * Advisory: a ref that no longer resolves (the source branch was deleted in
   * between) falls back to the normal base rather than failing the first turn.
   */
  baseRef?: string
}

export interface Chat {
  id: string
  title: string
  kind: SessionKind
  /**
   * This session's own inference config. Sessions are CONFIG-ISOLATED: each row
   * pins the provider/model/mode/effort/context it runs with, stamped from the
   * global `AppSettings` at create time, so changing the model in one session
   * never disturbs another. Null means "never chosen" - inherit the global
   * default, which is what every session created before this existed does.
   *
   * `providerId` + `model` resolve as a PAIR (a provider pins its own model, so
   * a fallback can never cross one provider with another's model id). Read them
   * only through `resolveSessionConfig` in shared/session-config.ts.
   */
  providerId: string | null
  model: string | null
  /** Primary agent (mode) id, e.g. 'build' / 'plan'. Null = the default agent. */
  agentId: string | null
  /** Thinking effort for reasoning models. Null = inherit the global default. */
  reasoningEffort: ReasoningEffort | null
  /** Context budget in tokens. Null = inherit the global default. */
  contextLimit: number | null
  workspacePath: string | null
  /**
   * This session's git worktree — an isolated checkout of the project's repo on
   * its own branch. Null means the session works directly in `workspacePath`.
   * Sub-sessions never set this; they run in their parent's tree.
   */
  worktreePath: string | null
  /**
   * A worktree this session asked for but hasn't got yet. Materialized on the
   * first turn (so an abandoned composer leaves nothing on disk) and cleared
   * either way — on success, and on failure so it isn't retried forever.
   */
  worktreePending: WorktreeIntent | null
  /** The branch checked out in `worktreePath`. Git is the source of truth. */
  branch: string | null
  /** The dev-server port this session owns, so parallel sessions don't collide. */
  devPort: number | null
  /** The chat that spawned this one (set for `sub` subagent sessions). */
  parentId: string | null
  /** Compaction summary of earlier turns, or null if not compacted. */
  contextSummary: string | null
  /** createdAt of the last message folded into the summary (0/null = none). */
  contextSummaryAt: number | null
  /** A short agent-written summary of what this session is about. */
  description: string | null
  /** Agent-maintained task checklist for this session. */
  tasks: SessionTask[]
  /** User-defined sort key within its project (higher = higher in the list). */
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * One ordered piece of a turn. An assistant turn is a sequence of these, so
 * reasoning, tool calls, and prose interleave in the order they happened
 * (reasoning → tool → reasoning → tool → text) and render through one entry point.
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'image'
      /** Image as a data URL (data:image/png;base64,…). */
      dataUrl: string
      /** MIME type, e.g. 'image/png'. */
      mediaType: string
      /** Original file name, when known. */
      name?: string
    }
  | {
      type: 'tool'
      /** Tool id, e.g. 'bash', 'read', 'list', 'task'. */
      tool: string
      state: 'running' | 'done' | 'error'
      /**
       * The model's tool-call id (correlates the call with its result). Stored so
       * the turn can be replayed as structured `assistant.tool_calls` + `role:'tool'`
       * messages on later turns instead of a flattened text blob. Absent on legacy
       * rows and manual `!verb` tool cards (those fall back to text flattening).
       */
      callId?: string
      /** The arguments the model passed to the tool — rebuilds `tool_calls[].function.arguments`. */
      input?: Record<string, unknown>
      /** One-line summary shown on the tool card (e.g. the command run). */
      title?: string
      /**
       * For a `task` card: the subagent session it spawned, so the card can
       * offer to cancel that one delegate (and link to its transcript). Absent
       * on every other tool, and on task cards from before this existed.
       */
      subChatId?: string
      /** Result body, shown when the card is expanded. */
      output?: string
      /** Optional inline image (data URL), e.g. a browser screenshot. */
      image?: string
      /** Before/after file contents for write/edit, shown as a diff on expand. */
      diff?: ToolDiff
      /**
       * A `task` card's subagent transcript — the delegate's own reasoning, prose,
       * and tool calls, streamed live and nested INSIDE this card rather than
       * leaking out as flat sibling cards in the parent turn.
       *
       * Recursive by type but only ever one level deep in practice
       * (MAX_SUBAGENT_DEPTH = 1 in the harness).
       *
       * DISPLAY-ONLY: `reconstructAssistant` deliberately never replays children as
       * the parent's own `tool_calls` — the parent model never made those calls;
       * all it ever saw was the subagent's final report.
       */
      children?: MessagePart[]
    }

export interface Message {
  id: string
  chatId: string
  role: MessageRole
  content: string
  /** Ordered parts for rich rendering; falls back to a single text part. */
  parts: MessagePart[]
  createdAt: number
}

export interface AddMessageInput {
  chatId: string
  role: MessageRole
  content: string
  parts?: MessagePart[]
}

// ---- Loops (scheduled agentic prompts) ---------------------------------------

/** A Loop is a prompt that runs on a heartbeat (cron-like) into its own chat. */
export interface Loop {
  id: string
  name: string
  prompt: string
  intervalMinutes: number
  enabled: boolean
  /** The chat this loop drives — its conversation + manual interventions. */
  chatId: string
  lastRunAt: number | null
  nextRunAt: number
  createdAt: number
}

/** Lightweight session status used by the list_sessions / check_session tools. */
export interface SessionStatus {
  id: string
  title: string
  workspacePath: string | null
  messageCount: number
  lastActivityAt: number
  idle: boolean
}

/** Result of running an agent tool — a plain string output (as an LLM tool returns). */
export interface ToolResult {
  ok: boolean
  output: string
  /** Optional inline image (data URL), e.g. a browser screenshot. */
  image?: string
  /** Before/after file contents (write/edit) so the UI can render a diff. */
  diff?: ToolDiff
}

/** A before/after snapshot of a single file, produced by the write/edit tools. */
export interface ToolDiff {
  /** Workspace-relative path of the changed file. */
  path: string
  /** File contents before the change ('' when the file was created). */
  before: string
  /** File contents after the change. */
  after: string
}

/** An image attached to a queued message (mirrors a user message's image part). */
export interface QueueImage {
  dataUrl: string
  mediaType: string
  name?: string
}

/** A pending prompt queued on a chat (FIFO). Generic across sessions/loops/subagents. */
export interface QueueItem {
  id: string
  chatId: string
  content: string
  /** Images to send with the prompt when it's dequeued. */
  images?: QueueImage[]
  createdAt: number
}

// ---- Integrations & skills ---------------------------------------------------

export type CatalogStatus = 'available' | 'coming-soon'

/** A messaging surface Roxy's chat can be reached from (Telegram, WhatsApp…). */
export interface IntegrationDef {
  id: string
  name: string
  description: string
  status: CatalogStatus
  /** lucide-react icon name resolved by the renderer's icon map. */
  icon: string
  accent: string
}

/** Persisted integration state. */
export interface IntegrationConnection {
  id: string
  enabled: boolean
  config: Record<string, unknown>
  createdAt: number
}

/** A tool/skill the agent can use (Browser, GitHub CLI, Gmail…). */
export interface SkillDef {
  id: string
  name: string
  description: string
  status: CatalogStatus
  icon: string
  category: string
}

// ---- Settings ----------------------------------------------------------------

/** Thinking/reasoning effort, mapped per provider (reasoning models only). */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Global app settings.
 *
 * For the inference fields (`activeProviderId`, `activeModel`, `activeAgentId`,
 * `reasoningEffort`, `contextLimit`) this is the LAST-USED TEMPLATE, not the
 * live config of any session: each session pins its own copy (see `Chat`), and
 * changing a picker updates both the open session and this template, so the
 * next new session starts where you left off.
 */
export interface AppSettings {
  onboardingCompleted: boolean
  activeProviderId: string | null
  activeModel: string | null
  /** Last-used primary agent (mode) id, e.g. 'build' / 'plan'. */
  activeAgentId: string | null
  /** Thinking effort applied to reasoning-capable models. */
  reasoningEffort: ReasoningEffort
  /** Chosen context-window budget in tokens; null = use the model default. */
  contextLimit: number | null
  /** Optional Exa API key for `websearch` (empty = use the keyless public endpoint). */
  webSearchApiKey: string | null
  /**
   * Give every new session in a git repo its own workstream (an isolated
   * worktree on its own branch) instead of running it in the project folder.
   *
   * On by default: the shared checkout is also the folder the user's editor is
   * open in, so two sessions editing it at once corrupt each other's work, and
   * the agent's edits fight whatever the user is typing. Isolation is the
   * behaviour people expect from parallel sessions; the old default only looked
   * safe because most people ran one session at a time.
   *
   * Off falls back to the project folder. Non-repos ignore this entirely --
   * there is nothing to branch from.
   */
  autoWorkstream: boolean
  /**
   * Prefix for the branch a new workstream generates, e.g. `roxy` ->
   * `roxy/a1b2c3d4`. Empty means no prefix at all (`a1b2c3d4`), which some
   * people prefer; it is a real choice, not a reason to reimpose the default.
   */
  branchPrefix: string
}

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
}

// ---- Usage / cost ------------------------------------------------------------

/**
 * Token counts for ONE model call. `input`/`output` are fresh (uncached) tokens;
 * `cacheRead`/`cacheWrite` split out so pricing can charge them at their (cheaper)
 * rates. `estimated` marks rows we derived from text length rather than a real
 * provider `usage` frame, so the UI can be honest about precision.
 */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  estimated: boolean
}

/** One persisted usage record — a single model call, attributed to a provider/model. */
export interface UsageRecord extends TokenUsage {
  id: string
  chatId: string | null
  providerId: string
  model: string
  /** USD cost priced at record time from the model catalog (0 when price unknown). */
  cost: number
  createdAt: number
}

/** Rolled-up totals for one provider (or model), over a window. */
export interface UsageBucket {
  tokens: number
  cost: number
  calls: number
}

/** One day of spend, for the popover's bar graph (oldest → newest). */
export interface UsageDay {
  /** Local YYYY-MM-DD. */
  date: string
  tokens: number
  cost: number
}

/** Per-provider usage summary shown as a tab in the popover. */
export interface ProviderUsage {
  providerId: string
  /** Human label (falls back to the id when the provider was removed). */
  name: string
  today: UsageBucket
  last30d: UsageBucket
  /** Most-used model over the window, by token volume. */
  topModel: string | null
  /** Daily spend for the last 30 days (bar graph). */
  daily: UsageDay[]
  /** True if any priced-in record was estimated (drives the "~/estimated" note). */
  hasEstimates: boolean
  /** True if any record lacked catalog pricing (cost is a floor, not exact). */
  hasUnpriced: boolean
}

/** The whole usage dashboard payload — an "Overview" plus a tab per provider. */
export interface UsageStats {
  overview: {
    today: UsageBucket
    last30d: UsageBucket
    topModel: string | null
    daily: UsageDay[]
    hasEstimates: boolean
    hasUnpriced: boolean
  }
  providers: ProviderUsage[]
}

// ---- Activity (contribution graph) ------------------------------------------

/**
 * One calendar day in the Settings contribution graph. `count` is the number of
 * agent turns (assistant replies) recorded that day across every session; `level`
 * is the GitHub-style 0–4 intensity bucket (0 = nothing, 4 = the busiest tier),
 * derived from the window's peak so the graph self-scales to how you actually use
 * Roxy.
 */
export interface ActivityDay {
  /** Local YYYY-MM-DD. */
  date: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

/**
 * The activity dashboard payload for the Settings contribution graph — a
 * zero-filled daily series (oldest → newest) plus the headline figures that ride
 * above it (total, streaks, busiest day).
 */
export interface ActivityStats {
  /** Daily activity, oldest → newest, exactly `days` entries (zero-filled). */
  days: ActivityDay[]
  /** Total turns counted across the window. */
  total: number
  /** Busiest single day's count (drives the level scale + legend). */
  max: number
  /** Distinct days with any activity. */
  activeDays: number
  /** Longest run of consecutive active days anywhere in the window. */
  longestStreak: number
  /** Active-day run ending today (0 if today is idle). */
  currentStreak: number
}
