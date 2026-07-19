/**
 * The typed contract exposed to the renderer as `window.roxy`.
 * Implemented in src/preload/index.ts, handled in src/main/ipc/*.
 */
import type {
  AddMessageInput,
  AppSettings,
  AppVersions,
  ActivityStats,
  Chat,
  ConnectedProvider,
  ConnectProviderInput,
  DeviceFlowStart,
  IntegrationConnection,
  Loop,
  Message,
  QueueImage,
  QueueItem,
  ReasoningEffort,
  SessionKind,
  ToolDiff,
  ToolResult,
  UsageStats
} from './types'
import type { McpServerConfig } from './mcp'

/** A configured MCP server merged with its live connection status (for Settings). */
export interface McpServerView {
  id: string
  config: McpServerConfig
  enabled: boolean
  status: 'connected' | 'error' | 'disabled'
  /** Unqualified tool names exposed by the server when connected. */
  tools: string[]
  error?: string
}

/** Payload to create/replace an MCP server entry. */
export interface UpsertMcpServerInput {
  id: string
  config: McpServerConfig
  enabled?: boolean
}

/** A skill discovered on disk (metadata only — the body is loaded on demand by the tool). */
export interface SkillView {
  name: string
  description?: string
  /** Absolute path to the source SKILL.md / <name>.md. */
  location: string
  /** 'workspace' (a project source) or 'global' (under the user's home). */
  source: 'workspace' | 'global'
}

/** A skill plus its full markdown body — returned by `skills.read` for the editor. */
export interface SkillDetail extends SkillView {
  body: string
}

/** Payload to create/edit a skill from the UI (mirrors the `skill_manage` tool). */
export interface SkillWriteInput {
  name: string
  description?: string
  body?: string
  /** Where to write it — defaults to 'global' from the Skills page (no workspace context). */
  scope?: 'workspace' | 'global'
}

/** Outcome of installing skill(s) from a remote source (`skills.install`). */
export interface SkillInstallResult {
  ok: boolean
  /** The skills written to disk (folder name + SKILL.md path). */
  installed: { name: string; location: string }[]
  /** Sources that were found but not installed, with a reason. */
  skipped?: { name: string; reason: string }[]
  /** A friendly error when nothing installed. */
  error?: string
  /** The refreshed discovered-skills list, so the caller can update its view. */
  skills: SkillView[]
}

export interface CreateChatInput {
  title?: string
  kind?: SessionKind
  providerId?: string | null
  model?: string | null
  workspacePath?: string | null
  parentId?: string | null
}

export interface CreateLoopInput {
  name: string
  prompt: string
  intervalMinutes: number
  /** Project (workspace folder) the loop's agent runs in; null = no workspace. */
  workspacePath?: string | null
}

/** An image attached to a user message, sent to vision-capable models. */
export interface ChatImage {
  /** Image as a data URL (data:image/png;base64,…). */
  dataUrl: string
  /** MIME type, e.g. 'image/png'. */
  mediaType: string
}

/** A single chat-completion message sent to the model. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Images to send alongside the text (user messages only). */
  images?: ChatImage[]
  /**
   * Structured tool calls this assistant turn made (name + JSON-string args),
   * so multi-turn tool history survives instead of being flattened to text.
   * Each id pairs with a following `role:'tool'` message's `toolCallId`.
   */
  toolCalls?: { id: string; name: string; arguments: string }[]
  /** For `role:'tool'` messages — which assistant tool call this result answers. */
  toolCallId?: string
}

export interface LlmStartInput {
  requestId: string
  sessionId: string
  providerId: string
  model: string
  messages: ChatMessage[]
  /** Which primary agent to run (e.g. "build" or "plan"). Defaults to build. */
  agentId?: string
  /** Thinking effort for reasoning-capable models. */
  reasoningEffort?: ReasoningEffort
  /** Whether the model supports reasoning (gates sending the effort param). */
  reasoning?: boolean
  /** Effective context-window budget in tokens (drives large-context headers). */
  contextLimit?: number
}

export interface LlmResult {
  ok: boolean
  error?: string
}

/** One streamed step of an agent turn: prose text, or a tool call start/delta/end. */
export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | {
      type: 'tool-start'
      callId: string
      tool: string
      title?: string
      input?: Record<string, unknown>
    }
  | { type: 'tool-delta'; callId: string; chunk: string }
  | {
      type: 'tool-end'
      callId: string
      output: string
      ok: boolean
      image?: string
      diff?: ToolDiff
    }

export interface LlmDelta {
  requestId: string
  event: LlmEvent
}

/** A background subagent task's lifecycle state, broadcast to all windows. */
export interface TaskUpdate {
  jobId: string
  /** The parent session that launched the task. */
  sessionId: string
  /** The subagent's own `sub` session, when persisted. */
  subChatId: string | null
  description: string
  subagentType: string
  state: 'running' | 'completed' | 'error'
  startedAt: number
  finishedAt?: number
}

/** A model offered by a provider (from models.dev). */
export interface ModelInfo {
  id: string
  name: string
  reasoning: boolean
  toolCall: boolean
  /** Max input context window in tokens, when known. */
  contextLimit?: number
  /** Max output tokens, when known. */
  outputLimit?: number
  /** USD price per 1M tokens (from models.dev), when known — powers cost math. */
  cost?: ModelCost
}

/** USD price per 1,000,000 tokens, split by kind (as models.dev reports it). */
export interface ModelCost {
  /** Fresh input (prompt) tokens. */
  input?: number
  /** Output (completion) tokens. */
  output?: number
  /** Cache-read (cached input) tokens — usually far cheaper than `input`. */
  cacheRead?: number
  /** Cache-write tokens. */
  cacheWrite?: number
}

/** Navigation state of the Roxy browser, for the URL-bar toolbar. */
export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/** One open tab in the Roxy browser, for the toolbar's tab strip. */
export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
}

/** Auto-update lifecycle state (main -> renderer). */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'not-available' }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

/** Snapshot returned by `updates.getState()`. */
export interface UpdateInfo {
  /** The running app version. */
  version: string
  /** False in dev/unpacked builds, where updates are inert. */
  packaged: boolean
  state: UpdateState
}

/**
 * Remote Workspace — take the running desktop session to a phone via roxy.gg.
 * The desktop stays authoritative (it runs the model + tools); the phone is a
 * thin remote control + live viewer paired through the relay.
 */

/** Lifecycle of the desktop's connection to the Remote Workspace relay. */
export type RemotePhase =
  | 'idle' // not sharing
  | 'starting' // minting the room + dialing the relay
  | 'live' // host socket connected; phones may pair
  | 'offline' // lost the relay; retrying with the same token
  | 'error' // gave up (see `error`)

/**
 * Sharing status pushed to the renderer (via `remote:state`) and returned by
 * start/stop/status. Holds everything the dialog needs: the safe URL + PIN to
 * show, which session is live, and the current phone count.
 */
export interface RemoteState {
  phase: RemotePhase
  /** Room id on roxy.gg (present once minted). */
  brokerId?: string
  /** Safe URL to open on the phone — guest token lives in the fragment. */
  url?: string
  /** PIN shown on the desktop; the phone must enter it to pair. */
  pin?: string
  /** The workspace session the phone is currently viewing (it can switch between all). */
  sessionId?: string
  /** Number of phones currently paired. */
  guests: number
  /** Epoch ms when the room/token expires. */
  expiresAt?: number
  /** Human-readable failure, when `phase === 'error'`. */
  error?: string
  /**
   * Bumped on every state change *and* on shared-session activity (a remote
   * prompt or reply landed), so the renderer can cheaply decide when to reload
   * the shared chat without diffing message lists.
   */
  rev: number
}

/** Which session to share when starting a Remote Workspace. */
export interface RemoteStartInput {
  sessionId: string
}

/** Outcome of exporting the portable config bundle (skills + MCP servers). */
export interface ConfigExportResult {
  /** True when a file was written; false when the user cancelled the dialog. */
  ok: boolean
  /** Absolute path the bundle was saved to (when ok). */
  path?: string
  skills: number
  mcpServers: number
  /** e.g. "3 skills, 2 MCP servers". */
  summary: string
  error?: string
}

/** Outcome of importing a portable config bundle from a file. */
export interface ConfigImportResult {
  /** True when at least one skill or server was applied; false on cancel/empty/error. */
  ok: boolean
  /** False specifically when the user cancelled the open dialog (not an error). */
  cancelled?: boolean
  /** Global skills written (replaced=true when one already existed). */
  skills: { name: string; replaced: boolean }[]
  /** MCP servers written (replaced=true when one already existed). */
  mcpServers: { id: string; replaced: boolean }[]
  /** Entries found but not applied, with a reason. */
  skipped: { name: string; reason: string }[]
  /** e.g. "Imported 3 skills and 2 MCP servers." */
  summary: string
  error?: string
}

export interface RoxyApi {
  settings: {
    getAll(): Promise<AppSettings>
    setActiveProvider(providerId: string, model: string | null): Promise<AppSettings>
    setReasoningEffort(level: ReasoningEffort): Promise<AppSettings>
    setContextLimit(limit: number | null): Promise<AppSettings>
    setWebSearchApiKey(key: string | null): Promise<AppSettings>
    completeOnboarding(): Promise<AppSettings>
    reset(): Promise<void>
  }
  providers: {
    listConnected(): Promise<ConnectedProvider[]>
    connect(input: ConnectProviderInput): Promise<ConnectedProvider>
    disconnect(id: string): Promise<void>
  }
  chats: {
    list(): Promise<Chat[]>
    create(input?: CreateChatInput): Promise<Chat>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    /** Reorder a project's sessions; `ids` is the full project session list, top-to-bottom. */
    reorder(workspacePath: string | null, ids: string[]): Promise<void>
  }
  projects: {
    /** Workspace paths in sidebar display order, top → bottom. */
    listOrder(): Promise<string[]>
    /** Persist the project order; `paths` is the full list, top → bottom. */
    reorder(paths: string[]): Promise<void>
  }
  messages: {
    list(chatId: string): Promise<Message[]>
    add(input: AddMessageInput): Promise<Message>
  }
  integrations: {
    list(): Promise<IntegrationConnection[]>
    setEnabled(id: string, enabled: boolean): Promise<void>
  }
  mcp: {
    /** List configured MCP servers merged with their live connection status. */
    list(): Promise<McpServerView[]>
    /** Create or replace a server entry (persisted; connects lazily on next turn). */
    upsert(input: UpsertMcpServerInput): Promise<McpServerView[]>
    /** Delete a server entry and close any open connection. */
    remove(id: string): Promise<McpServerView[]>
    /** Enable/disable a server; disabling closes its connection. */
    setEnabled(id: string, enabled: boolean): Promise<McpServerView[]>
    /** Force a fresh connection attempt (to validate config); returns updated list. */
    reconnect(id: string): Promise<McpServerView[]>
  }
  skills: {
    /** Discovered SKILL.md skills (workspace when a cwd is given, else the user's global skills). */
    list(cwd?: string): Promise<SkillView[]>
    /** Re-scan from disk (drops the cache) and return the fresh list. */
    refresh(cwd?: string): Promise<SkillView[]>
    /** Read one skill in full (including its body) for editing; null if not found. */
    read(name: string, cwd?: string): Promise<SkillDetail | null>
    /** Create a new skill on disk; returns the updated list. Rejects duplicate names. */
    create(input: SkillWriteInput, cwd?: string): Promise<SkillView[]>
    /** Edit an existing skill (omitted fields are kept); returns the updated list. */
    update(input: SkillWriteInput, cwd?: string): Promise<SkillView[]>
    /** Delete a skill by name; returns the updated list. */
    remove(name: string, cwd?: string): Promise<SkillView[]>
    /**
     * Install skill(s) from a remote source — a GitHub `owner/repo`, a github.com
     * URL, or a direct SKILL.md URL (Roxy's in-app `npx skills add`). Writes global
     * skills by default (or workspace when a cwd is given).
     */
    install(source: string, cwd?: string): Promise<SkillInstallResult>
  }
  system: {
    getVersions(): Promise<AppVersions>
    openExternal(url: string): Promise<void>
  }
  updates: {
    /** Manually trigger an update check. */
    check(): Promise<void>
    /** Quit and install a downloaded update. */
    install(): Promise<void>
    /** The running version + the latest known update state. */
    getState(): Promise<UpdateInfo>
    /** Subscribe to update-status changes; returns an unsubscribe fn. */
    onStatus(callback: (state: UpdateState) => void): () => void
  }
  copilot: {
    start(): Promise<DeviceFlowStart>
    poll(deviceCode: string, interval: number): Promise<ConnectedProvider>
  }
  dialog: {
    openWorkspace(): Promise<string | null>
  }
  config: {
    /** Export global skills + MCP configs to a file chosen via a save dialog. */
    export(): Promise<ConfigExportResult>
    /** Import a config bundle chosen via an open dialog (overwrites by name/id). */
    import(): Promise<ConfigImportResult>
  }
  loops: {
    list(): Promise<Loop[]>
    create(input: CreateLoopInput): Promise<Loop>
    setEnabled(id: string, enabled: boolean): Promise<void>
    remove(id: string): Promise<void>
    /** Subscribe to heartbeat ticks; returns an unsubscribe fn. */
    onTick(callback: (loopId: string) => void): () => void
  }
  tools: {
    run(sessionId: string, name: string, input: Record<string, unknown>): Promise<ToolResult>
  }
  queue: {
    list(chatId: string): Promise<QueueItem[]>
    add(chatId: string, content: string, images?: QueueImage[]): Promise<QueueItem>
    remove(id: string): Promise<void>
    /** Reorder a chat's queue; `ids` is the full queue front-to-back. */
    reorder(chatId: string, ids: string[]): Promise<void>
    /** Edit a queued item in place — new text + images, same queue position. */
    update(id: string, content: string, images?: QueueImage[]): Promise<QueueItem | undefined>
  }
  usage: {
    /** The token-usage + cost dashboard payload for the last 30 days. */
    stats(): Promise<UsageStats>
  }
  activity: {
    /** Per-day agent activity (assistant turns) for the Settings contribution graph. */
    stats(): Promise<ActivityStats>
  }
  llm: {
    /** Stream a completion; text deltas arrive via onDelta. Resolves when done. */
    start(input: LlmStartInput): Promise<LlmResult>
    abort(requestId: string): Promise<void>
    onDelta(callback: (payload: LlmDelta) => void): () => void
  }
  tasks: {
    /** The background subagent tasks still running for a session. */
    listRunning(sessionId: string): Promise<TaskUpdate[]>
    /** Cancel a running background task by its job id. */
    cancel(jobId: string): Promise<void>
    /** Subscribe to background-task state changes; returns an unsubscribe fn. */
    onUpdate(callback: (update: TaskUpdate) => void): () => void
  }
  models: {
    /** Live model list for a provider id, from models.dev. */
    list(providerId: string): Promise<ModelInfo[]>
  }
  context: {
    /** Summarize a chat's history into a compaction summary; returns the chat. */
    compact(chatId: string, providerId: string, model: string): Promise<Chat>
    /** Load project instruction files (AGENTS.md/CLAUDE.md/CONTEXT.md) for a cwd. */
    instructions(cwd: string): Promise<string[]>
  }
  browser: {
    /** Open/focus the browser window (optionally navigating to a URL). */
    open(url?: string): Promise<void>
    navigate(url: string): Promise<void>
    back(): Promise<void>
    forward(): Promise<void>
    reload(): Promise<void>
    stop(): Promise<void>
    /** Open a new tab (optionally at a URL) and make it active. */
    newTab(url?: string): Promise<void>
    closeTab(id: string): Promise<void>
    activateTab(id: string): Promise<void>
    /** Reorder a tab to a new index in the strip (drag-to-reorder). */
    moveTab(id: string, toIndex: number): Promise<void>
    /** Subscribe to the browser toolbar's navigation state; returns an unsubscribe fn. */
    onState(callback: (state: BrowserState) => void): () => void
    /** Subscribe to the open tab list; returns an unsubscribe fn. */
    onTabs(callback: (tabs: BrowserTab[]) => void): () => void
  }
  remote: {
    /** Mint a room on roxy.gg + open the host relay socket for a session. */
    start(input: RemoteStartInput): Promise<RemoteState>
    /** Tear down the room + revoke the tokens (Stop sharing). */
    stop(): Promise<RemoteState>
    /** Current sharing status. */
    status(): Promise<RemoteState>
    /** Subscribe to sharing status changes; returns an unsubscribe fn. */
    onState(callback: (state: RemoteState) => void): () => void
  }
}
