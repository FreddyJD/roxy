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
  MessagePart,
  QueueImage,
  QueueItem,
  ReasoningEffort,
  SessionKind,
  ToolDiff,
  ToolResult,
  UsageStats,
  WorktreeIntent
} from './types'
import type { McpServerConfig } from './mcp'
import type { CliProxyLoginResult, CliProxyState } from './cliproxy'
import type { ForgeStatusView, ForgeHostView, ForgeKind } from './forge'
import type { SessionConfigPatch } from './session-config'

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
  /**
   * Pin this session to a provider/model instead of inheriting the last-used
   * ones. Passed together or not at all - a provider without a model resolves
   * to that provider's default rather than the previous provider's model id.
   */
  providerId?: string | null
  model?: string | null
  workspacePath?: string | null
  parentId?: string | null
  /**
   * Run this session in its own git worktree — an isolated checkout on its own
   * branch, so it can't collide with other sessions on the same repo. Recorded
   * now, created on the first turn.
   */
  worktree?: WorktreeIntent
}

export interface ForkChatInput {
  /** Defaults to `<source title> (fork)`. */
  title?: string
  /**
   * Give the fork its own worktree, branched off the commit the source is
   * sitting on right now. Only honoured when the source has a workstream (main
   * process decides); a session running in the project folder forks in place,
   * because putting the copy somewhere else would strand the transcript it just
   * inherited.
   */
  worktree?: boolean
}

/**
 * A background process owned by a session — a dev server, a watcher, an install.
 *
 * Subagent-started processes are owned by the ROOT session, so they appear in
 * their parent's panel; the parent is who can stop them.
 */
export interface ServiceView {
  id: string
  command: string
  cwd: string
  status: 'running' | 'exited' | 'killed' | 'error'
  exitCode: number | null
  startedAt: number
  /** Humanised status, e.g. `running 4m` / `exited (exit 1)`. */
  state: string
  /** The session's dev port, when it owns one. */
  port: number | null
}

/**
 * Git state for the workstream strip. Everything is optional-by-degradation:
 * a folder with no repo (or no git binary) reports `isRepo: false` and the UI
 * renders nothing at all.
 */
export interface GitStatusView {
  isRepo: boolean
  /** The repository root, when `cwd` is inside one. */
  root: string | null
  branch: string | null
  dirty: boolean
  /** Changed entries: staged + unstaged + untracked. */
  changed: number
  ahead: number
  behind: number
  hasUpstream: boolean
  /** The branch new workstreams branch off (origin/HEAD, else main/master). */
  defaultBranch: string | null
}

/** One checkout of a repository — the main working tree, or a workstream's. */
export interface WorktreeView {
  path: string
  branch: string | null
  head: string | null
  /** The repo's own working tree; never removable. */
  isMain: boolean
}

export interface CreateWorktreeInput {
  /** Any folder inside the repo (usually a session's project folder). */
  cwd: string
  mode: 'new' | 'fromBranch' | 'attach'
  /** Required for fromBranch/attach; omitted for `new` -> a generated name. */
  branch?: string
}

export interface CreateWorktreeResult {
  ok: boolean
  worktree?: WorktreeView
  /** True when an existing worktree was reused instead of a new one created. */
  attached?: boolean
  error?: string
}

/** What `worktrees.prune` found and (when not a dry run) removed. */
/** The result of a sync action (`forge.pull` / `forge.reset`). */
export interface SyncOutcome {
  ok: boolean
  error?: string
  /** The ref we synced to, e.g. `origin/main`. */
  upstream?: string
  /** False when the branch was already in sync and nothing moved. */
  updated?: boolean
  /**
   * Set by `reset` when it parked uncommitted work in the stash. The UI says so
   * out loud - a destructive action that silently hides the escape route is
   * indistinguishable from one that lost the work.
   */
  stashed?: boolean
}

export interface PruneWorktreesResult {
  ok: boolean
  candidates: { path: string; branch: string | null }[]
  removed: string[]
  failed: { path: string; error: string }[]
  error?: string
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
      /**
       * For a `task` call: the delegate's own session id.
       *
       * Carried beside `input` rather than inside it on purpose — `input` is
       * replayed verbatim as the model's `tool_calls` arguments on later turns
       * (see reconstructTurn), and an id the model never passed has no business
       * in its history. This is UI addressing: it's what lets the card's cancel
       * button name the one delegate to stop.
       */
      subChatId?: string
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
  /**
   * One step of a SUBAGENT's turn, addressed to the `task` card that spawned it.
   * `callId` is the parent `task` call; `event` is the child's own event, folded
   * into that card's `children` instead of the top-level parts list.
   *
   * Wrapping (rather than prefixing child call ids and emitting them flat) keeps
   * the nesting explicit end-to-end: the fold knows a child event is a child, so
   * it can never be mistaken for a call the parent model made and replayed as
   * bogus tool history on the next turn.
   */
  | { type: 'tool-child'; callId: string; event: LlmChildEvent }

/** The subset of `LlmEvent` a subagent can emit — everything except further nesting. */
export type LlmChildEvent = Exclude<LlmEvent, { type: 'tool-child' }>

export interface LlmDelta {
  requestId: string
  event: LlmEvent
}

/**
 * One step of a subagent's turn, tagged with the SUB session's own id.
 *
 * The twin of `LlmDelta`'s `tool-child` wrapper, aimed the other way. That one
 * addresses the parent's `task` card (keyed by the parent's requestId + callId)
 * so the launching session shows the delegate working. This one addresses the
 * subagent's OWN session, so opening it mid-run streams live instead of sitting
 * on the seeded prompt until the run ends. Same events, two audiences.
 *
 * `run` frames bracket the stream so the renderer knows exactly when to open the
 * live bubble and when to drop it in favour of the persisted transcript.
 */
export type SubagentDelta =
  | { subChatId: string; kind: 'event'; event: LlmChildEvent }
  | { subChatId: string; kind: 'run'; state: 'running' | 'completed' | 'error' }

/** A subagent run in flight, for restoring live state after a window (re)load. */
export interface SubagentRunView {
  subChatId: string
  parentChatId: string | null
  description: string
  subagentType: string
  /** True for a detached (`background: true`) run — it outlives its launching turn. */
  background: boolean
  startedAt: number
}

/**
 * main -> renderer: session rows changed in MAIN, with no renderer call to hang
 * a refresh off.
 *
 * `worktree_path`, `branch` and `dev_port` are written by the main process on
 * the turn path (lazy worktree materialization), so the renderer's copy is stale
 * from the moment the turn starts until something unrelated refetches. This is
 * the push that closes that window.
 */
export interface SessionsUpdated {
  /**
   * Why the rows changed. `worktree` is the one that needs more than a refetch:
   * the session just moved to a git path the renderer has never polled, so its
   * status map has no entry for it yet.
   */
  reason: 'worktree' | 'branch' | 'metadata'
  /** The sessions affected — usually one. */
  sessionIds: string[]
  /**
   * The session's git path after the change (its worktree, else its project
   * folder), so the renderer can prime `gitStatus` for a key it has never seen
   * instead of blanking the strip until the next poll tick.
   */
  statusKey?: string | null
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

/**
 * A streamed step of a phone-driven turn, pushed to the desktop renderer (via
 * `remote:delta`) so the PC mirrors the reply token-by-token — exactly like a
 * local turn's `LlmDelta` — instead of only reloading from disk when it ends.
 * Tagged with `sessionId` (not a requestId) since the renderer keys the live
 * mirror by chat, and a phone turn isn't tied to a local llm request.
 *
 * `turn` frames bracket the stream so the desktop knows precisely when to open
 * the live bubble and when to drop it (queue edits also bump `remote:state`, so
 * turn boundaries can't be inferred from the rev alone).
 */
export type RemoteDelta =
  | { sessionId: string; kind: 'event'; event: LlmEvent }
  | { sessionId: string; kind: 'turn'; state: 'running' | 'idle' }

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
    /** Remember the last-used mode, so the next NEW session opens in it. */
    setActiveAgent(agentId: string): Promise<AppSettings>
    setReasoningEffort(level: ReasoningEffort): Promise<AppSettings>
    setContextLimit(limit: number | null): Promise<AppSettings>
    setWebSearchApiKey(key: string | null): Promise<AppSettings>
    setAutoWorkstream(enabled: boolean): Promise<AppSettings>
    setBranchPrefix(prefix: string): Promise<AppSettings>
    completeOnboarding(): Promise<AppSettings>
    reset(): Promise<void>
  }
  providers: {
    listConnected(): Promise<ConnectedProvider[]>
    connect(input: ConnectProviderInput): Promise<ConnectedProvider>
    disconnect(id: string): Promise<void>
    /** Reorder connected providers; `ids` is the full Settings list, top-to-bottom. */
    reorder(ids: string[]): Promise<void>
  }
  chats: {
    list(): Promise<Chat[]>
    create(input?: CreateChatInput): Promise<Chat>
    /**
     * Copy a session's transcript + context into a NEW session, so a line of
     * work can branch without re-explaining itself. The source is untouched.
     */
    fork(id: string, input?: ForkChatInput): Promise<Chat>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    /** Pin part of one session's inference config (model / mode / effort / context). */
    setConfig(id: string, patch: SessionConfigPatch): Promise<Chat>
    /** Reorder a project's sessions; `ids` is the full project session list, top-to-bottom. */
    reorder(workspacePath: string | null, ids: string[]): Promise<void>
    /**
     * Subscribe to session rows changed by MAIN with no renderer call behind
     * them — a worktree materialized on the first turn, a branch renamed under
     * it. Returns an unsubscribe fn.
     */
    onUpdated(callback: (payload: SessionsUpdated) => void): () => void
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
  /**
   * The CLIProxyAPI sidecar behind the subscription providers (ChatGPT/Codex and
   * Google Gemini). The main process owns the binary + process; the renderer
   * only drives sign-in and reflects status.
   *
   * ONE process serves both providers, so `status()` is global while everything
   * account-shaped is scoped by provider id. `accountsFor(state, providerId)`
   * from `@shared/cliproxy` is how a panel narrows the shared state to its own.
   */
  cliproxy: {
    /** Current install/run state, reconciled against what is on disk. */
    status(): Promise<CliProxyState>
    /**
     * Run one provider's whole sign-in: install + start the sidecar if needed,
     * open its OAuth page in the user's browser, wait for the callback, then
     * connect the provider. Resolves when the flow reaches a terminal state.
     */
    login(providerId: string): Promise<CliProxyLoginResult>
    /**
     * Sign one account out by deleting its token file. The provider id is what
     * decides whether that was its LAST account, and so whether the provider row
     * should be dropped.
     */
    signOut(providerId: string, file: string): Promise<CliProxyState>
    /** Stop the local proxy (keeps the install and the signed-in accounts). */
    stop(): Promise<CliProxyState>
    /**
     * Install from an archive the user downloaded themselves, for networks that
     * block or rewrite the download. Opens a file picker; the archive still has
     * to match the pinned release's checksum.
     */
    installFromFile(): Promise<CliProxyState>
    /** Subscribe to sidecar state pushes; returns an unsubscribe fn. */
    onState(callback: (state: CliProxyState) => void): () => void
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
    /**
     * Stop everything in flight for a session — the streaming turn, any
     * compaction running ahead of it, and every subagent it spawned. Works even
     * before a requestId exists, which `abort` cannot.
     */
    abortSession(sessionId: string): Promise<void>
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
  subagents: {
    /**
     * Live parts of a subagent already mid-run, for a window that opens its
     * session halfway through. Null when nothing is running for that id (its
     * persisted transcript is then the truth).
     */
    snapshot(subChatId: string): Promise<MessagePart[] | null>
    /** Every subagent currently running — restores live state after a window reload. */
    listRunning(): Promise<SubagentRunView[]>
    /**
     * Tell main which chat is on screen, so the end-of-turn prune spares a sub
     * session the user is reading. Pass null when the open chat isn't a sub.
     */
    setViewed(chatId: string | null): Promise<void>
    /**
     * Cancel ONE running subagent, foreground or background, without touching
     * the turn that spawned it. Resolves false when nothing was running for that
     * id (it finished between the click and the call).
     */
    cancel(subChatId: string): Promise<boolean>
    /**
     * Subscribe to a subagent's own live stream, keyed by ITS session id, so its
     * individual chat view streams like any other. Returns an unsubscribe fn.
     */
    onDelta(callback: (payload: SubagentDelta) => void): () => void
  }
  models: {
    /** Live model list for a provider id, from models.dev. */
    list(providerId: string): Promise<ModelInfo[]>
    /** Last 5 distinct model picks for a provider, newest first. */
    recent(providerId: string): Promise<{ model: string; usedAt: number }[]>
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
  services: {
    /** Background processes owned by a session (includes its subagents'). */
    list(sessionId: string): Promise<ServiceView[]>
    /** Full buffered output for the log view (does NOT move the agent's cursor). */
    output(sessionId: string, id: string): Promise<string>
    /** Stop a service (kills the whole process tree on Windows). */
    stop(sessionId: string, id: string): Promise<{ ok: boolean; error?: string }>
    /** Stop and re-run the same command in the same cwd. */
    restart(sessionId: string, id: string): Promise<{ ok: boolean; id?: string; error?: string }>
    /** Open this session's OWN browser window at a service's localhost URL. */
    open(sessionId: string, port: number): Promise<void>
  }
  /**
   * The git HOST behind `origin` - GitHub, Azure DevOps, GitLab or Bitbucket.
   * Named "forge" because `remote` already means the roxy.gg phone relay here.
   */
  forge: {
    /**
     * Branch state, local + remote, in one call. Returns instantly with git
     * state; pull-request data is served from cache and refreshed in the
     * background, so a 5s poll never waits on the network. `force` waits.
     */
    status(cwd: string, force?: boolean): Promise<ForgeStatusView>
    /** Push the current branch to origin, setting upstream when it has none. */
    push(cwd: string): Promise<{ ok: boolean; error?: string }>
    /**
     * Fast-forward the branch onto its upstream. Never merges or rebases: when
     * the branch has local commits git refuses and nothing is touched.
     */
    pull(cwd: string): Promise<SyncOutcome>
    /**
     * Hard-reset the branch onto its upstream, stashing uncommitted work first
     * (including untracked files) so nothing is unrecoverable.
     */
    reset(cwd: string): Promise<SyncOutcome>
    /** The host's "create a pull request" URL, pre-filled for this branch. */
    createUrl(cwd: string): Promise<string | null>
    /**
     * Git hosts this user's projects use, with live connection state read from
     * git's credential helper. Not a list of "accounts Roxy owns" - Roxy owns
     * none; this is a view of what git already has.
     */
    listHosts(): Promise<ForgeHostView[]>
    /** Record which software an unrecognised host runs (null clears it). */
    setHostKind(host: string, kind: ForgeKind | null): Promise<void>
  }
  git: {
    /** Whether a usable `git` binary exists (probed once, cached). */
    available(): Promise<boolean>
    /** Repo/branch/dirty/ahead-behind for a folder. `isRepo:false` when it isn't one. */
    status(cwd: string): Promise<GitStatusView>
    /** Local + origin branches, deduped and sorted. */
    branches(cwd: string): Promise<string[]>
    /** Live worktrees for the repo containing `cwd` (stale records dropped). */
    worktrees(cwd: string): Promise<WorktreeView[]>
    /** Create (or attach to) a worktree. */
    createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult>
    /** Remove a worktree directory and prune git's record of it. */
    removeWorktree(path: string, force?: boolean): Promise<{ ok: boolean; error?: string }>
    /**
     * Rename a session's workstream branch. Safe while checked out — git
     * rewrites the worktree's HEAD in place, leaving uncommitted work alone.
     */
    renameBranch(sessionId: string, to: string): Promise<{ ok: boolean; error?: string }>
    /**
     * Find worktrees no session points at. Reports by default; pass
     * `dryRun:false` to actually delete them.
     */
    pruneWorktrees(cwd: string, dryRun?: boolean): Promise<PruneWorktreesResult>
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
    /**
     * Subscribe to streamed events from a phone-driven turn, so the desktop can
     * mirror the reply live (token-by-token) instead of only on turn end.
     * Returns an unsubscribe fn.
     */
    onDelta(callback: (payload: RemoteDelta) => void): () => void
  }
}
