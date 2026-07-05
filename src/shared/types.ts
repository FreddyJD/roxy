/**
 * Shared domain types used by both the Electron main process and the React
 * renderer. This module must stay isomorphic — types and plain data only, no
 * Node, Electron, or browser-specific imports.
 */

// ---- Providers ---------------------------------------------------------------

/** Wire protocol a provider speaks. Everything reduces to one of these. */
export type ProviderWire = 'anthropic' | 'openai' | 'openai-chat' | 'google' | 'bedrock' | 'azure'

/** Auth flow a provider needs. There are only seven. */
export type ProviderAuth =
  | 'api-key'
  | 'oauth'
  | 'device-flow'
  | 'aws-sigv4'
  | 'gcp-adc'
  | 'azure-ad'
  | 'none'

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

export interface Chat {
  id: string
  title: string
  kind: SessionKind
  providerId: string | null
  model: string | null
  workspacePath: string | null
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
      /** Result body, shown when the card is expanded. */
      output?: string
      /** Optional inline image (data URL), e.g. a browser screenshot. */
      image?: string
      /** Before/after file contents for write/edit, shown as a diff on expand. */
      diff?: ToolDiff
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

export interface AppSettings {
  onboardingCompleted: boolean
  activeProviderId: string | null
  activeModel: string | null
  /** Thinking effort applied to reasoning-capable models. */
  reasoningEffort: ReasoningEffort
  /** Chosen context-window budget in tokens; null = use the model default. */
  contextLimit: number | null
  /** Optional Exa API key for `websearch` (empty = use the keyless public endpoint). */
  webSearchApiKey: string | null
}

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
}
