import { create } from 'zustand'
import { DEFAULT_AGENT_ID, getAgent } from '@shared/agents'
import type {
  AppSettings,
  Chat,
  ConnectedProvider,
  Loop,
  Message,
  MessagePart,
  QueueItem,
  ReasoningEffort,
  UsageStats
} from '@shared/types'
import type {
  ChatMessage,
  CreateLoopInput,
  LlmEvent,
  ModelInfo,
  RemoteDelta,
  RemoteState,
  SessionsUpdated,
  SubagentDelta,
  TaskUpdate
} from '@shared/api'
import { selectPromptName, buildEnvironment, assembleSystemPrompt } from '@shared/prompt'
import { PROMPT_TEXT, AGENT_PROMPT_TEXT } from '@shared/prompt-text'
import { reconstructTurn, REPLAY_OUTPUT_CAP } from '@shared/tool-history'
import { PartsFold, partsToContent } from '@shared/parts'
import { isOverflow, pruneToolMessages, KEEP_RECENT_TOKENS } from '@shared/context'
import { pickDefaultModel } from '@shared/models'
import {
  contextBudgetFor,
  resolveSessionConfig,
  type SessionConfig,
  type SessionConfigPatch
} from '@shared/session-config'
import { uniqueSlug } from '@shared/slugs'
import { shouldAutoWorkstream } from '@shared/workstream'
import { api } from './api'
import type { ComposerImage } from './images'
import type { GitStatusView, ServiceView, WorktreeView } from '@shared/api'
import type { ForgeStatusView } from '@shared/forge'

interface RoxyStore {
  ready: boolean
  settings: AppSettings | null
  providers: ConnectedProvider[]
  /** models.dev model lists per provider id (lazy-loaded + cached). */
  modelCatalog: Record<string, ModelInfo[]>
  chats: Chat[]
  activeChatId: string | null
  messages: Message[]
  /** Chats with an in-flight send, keyed by chat id. Survives switching chats. */
  sendingChats: Record<string, boolean>
  /** In-progress assistant parts per chat while a reply streams in. */
  streamingChats: Record<string, MessagePart[]>
  /**
   * The open session's mode, mirrored from its `chat.agentId` for synchronous
   * reads (the composer + the context meter re-render on every keystroke, and
   * a store lookup is cheaper than finding the chat each time). `selectChat`
   * loads it from the session; `setActiveAgent` writes both back.
   */
  activeAgentId: string
  /** Project instruction blocks (AGENTS.md etc.) cached per workspace path. */
  projectInstructions: Record<string, string[]>
  /** Workspace paths in the user's chosen sidebar order (top → bottom). */
  projectOrder: string[]
  loops: Loop[]
  /** Pending prompts queued on the active chat (FIFO). */
  queue: QueueItem[]
  /** Chats with a pending stop request, keyed by chat id. */
  stopChats: Record<string, boolean>
  /** Chats currently being compacted, keyed by chat id. */
  compactingChats: Record<string, boolean>
  /** Running background subagent tasks, keyed by parent session id (Phase 11). */
  runningTasks: Record<string, TaskUpdate[]>
  /**
   * Subagent sessions with a run in flight, by SUB chat id. Drives the live
   * bubble in a subagent's own chat view and its sidebar spinner — both of which
   * used to be impossible, since a subagent's work only ever streamed into its
   * parent's `task` card.
   */
  runningSubagents: Record<string, true>
  /** Remote Workspace sharing status — mirrors the main process's RemoteState. */
  remote: RemoteState
  /** Background processes for the active session (the Services panel). */
  services: ServiceView[]
  /** Is a `git` binary available at all? null until probed once. */
  gitAvailable: boolean | null
  /**
   * Git state per WORKTREE path (or project folder for sessions without one),
   * so N sessions sharing a worktree share one poll instead of N.
   */
  gitStatus: Record<string, GitStatusView>
  /**
   * Remote/PR state, keyed by the same worktree path as `gitStatus` so the two
   * always agree. Populated by the same poll - a separate one would double the
   * git spawns for a strictly worse result.
   */
  forgeStatus: Record<string, ForgeStatusView>
  /** Live worktrees per project folder, for the workstream menu. */
  worktrees: Record<string, WorktreeView[]>
  /** Branches per project folder, loaded lazily when the menu opens. */
  gitBranches: Record<string, string[]>
  /** Token-usage + cost dashboard (last 30 days); null until first fetched. */
  usageStats: UsageStats | null

  bootstrap: () => Promise<void>
  refreshChats: () => Promise<void>
  refreshLoops: () => Promise<void>
  refreshQueue: () => Promise<void>
  refreshProviders: () => Promise<void>
  /**
   * The config the OPEN session runs with: its own pinned values, falling back
   * to the global last-used ones. The single read path for the composer
   * pickers and the send path - never read `settings.activeModel` directly.
   */
  sessionConfig: () => SessionConfig
  /**
   * Change part of the open session's config.
   *
   * Writes TWICE, on purpose: the session row (so the change is scoped to this
   * session and survives a restart) and the matching global setting (so the
   * next NEW session inherits it). That is the whole feature - sessions are
   * independent, and new ones start from whatever you last picked.
   */
  setSessionConfig: (patch: SessionConfigPatch) => Promise<void>
  selectModel: (providerId: string, model: string) => Promise<void>
  ensureModels: (providerId: string) => Promise<void>
  setReasoningEffort: (level: ReasoningEffort) => Promise<void>
  setContextLimit: (limit: number | null) => Promise<void>
  setWebSearchApiKey: (key: string | null) => Promise<void>
  setAutoWorkstream: (enabled: boolean) => Promise<void>
  setBranchPrefix: (prefix: string) => Promise<void>
  selectChat: (id: string) => Promise<void>
  clearActive: () => void
  newSession: () => Promise<void>
  newSessionInProject: (workspacePath: string) => Promise<void>
  /**
   * Whether a new session in this folder should get its own workstream.
   * Resolves the setting against a live git probe (async: most folders are not
   * repos, and only git can say).
   */
  autoWorkstreamFor: (workspacePath: string | null) => Promise<boolean>
  createLoop: (input: CreateLoopInput) => Promise<void>
  setLoopEnabled: (id: string, enabled: boolean) => Promise<void>
  removeLoop: (id: string) => Promise<void>
  setActiveAgent: (id: string) => Promise<void>
  /** Load + cache a workspace's instruction files (AGENTS.md etc.) for sizing. */
  ensureProjectInstructions: (workspacePath: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  renameChat: (id: string, title: string) => Promise<void>
  /** Persist a project's session order (optimistic). `ids` = full project list, top-to-bottom. */
  reorderSessions: (workspacePath: string | null, ids: string[]) => Promise<void>
  /** Persist the project (workspace) order (optimistic). `paths` = full list, top → bottom. */
  reorderProjects: (paths: string[]) => Promise<void>
  submit: (content: string, images?: ComposerImage[]) => Promise<void>
  sendMessage: (content: string, chatId?: string, images?: ComposerImage[]) => Promise<void>
  drainQueue: (chatId: string) => Promise<void>
  removeQueued: (id: string) => Promise<void>
  moveQueued: (id: string, direction: 'up' | 'down') => Promise<void>
  /** Edit a queued prompt in place (text + images), keeping its queue position. */
  editQueued: (id: string, content: string, images?: ComposerImage[]) => Promise<void>
  /** Refresh the usage/cost dashboard (called on turn end + when the pill opens). */
  refreshUsage: () => Promise<void>
  stop: () => void
  /** Start sharing the active session to a phone via the roxy.gg relay. */
  startRemote: () => Promise<void>
  /** Stop sharing + revoke the room/token (Stop sharing). */
  stopRemote: () => Promise<void>
  /** Sync the current sharing status from main (e.g. after a window reload). */
  refreshRemote: () => Promise<void>
  compactConversation: (chatId?: string) => Promise<void>
  /** Reload the active session's background processes. */
  refreshServices: (sessionId: string) => Promise<void>
  /**
   * Refresh git status for a session's cwd. Cheap and idempotent — the strip
   * calls it on a timer and on window focus. Polling, not fs.watch: with N
   * worktrees watchers multiply, and fs.watch is unreliable on Windows.
   */
  refreshGitStatus: (chatId: string) => Promise<void>
  /** Push this session's branch to origin, then refresh its status. */
  pushBranch: (chatId: string) => Promise<{ ok: boolean; error?: string }>
  /** Load the worktrees + branches for a project (menu open). */
  refreshWorktrees: (workspacePath: string) => Promise<void>
  /**
   * Create a workstream and open a NEW SESSION in it. Never relocates the
   * current session — a workstream is a parallel line of work, not a move.
   */
  newWorkstream: (input: {
    workspacePath: string
    mode: 'new' | 'fromBranch' | 'attach'
    branch?: string
  }) => Promise<void>
  /** Handle a background subagent task state change (Phase 11). */
  handleTaskUpdate: (update: TaskUpdate) => Promise<void>
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let loopTickSubscribed = false
let llmDeltaSubscribed = false
let taskUpdateSubscribed = false
let remoteStateSubscribed = false
let remoteDeltaSubscribed = false
let subagentDeltaSubscribed = false
let chatsUpdatedSubscribed = false
/** Routes streamed completion events to the in-flight send for a request id. */
const deltaHandlers = new Map<string, (event: LlmEvent) => void>()
/** The active llm request id per chat, so stop() can abort the right stream. */
const chatRequests = new Map<string, string>()
/** Cross-render cache of models.dev lists so we fetch each provider once. */
const modelCatalogCache = new Map<string, ModelInfo[]>()
/** Set when a remote turn lands while a local send streams into the shared chat. */
const remoteMirror = { deferred: false }
/**
 * Live parts for the in-flight *phone-driven* turn per session, so the desktop
 * mirrors a remote reply token-by-token (the twin of a local send's `parts`).
 * A turn:idle frame clears the entry once the persisted reply takes over.
 */
const remoteTurns = new Map<string, PartsFold>()
/**
 * Live parts for each in-flight SUBAGENT run, keyed by its own chat id — the
 * third sibling of `parts` (local send) and `remoteTurns` (phone turn).
 *
 * Kept for every running subagent, not just the visible one: a delegate you
 * aren't watching keeps folding, so switching into its session mid-run shows the
 * whole transcript so far instead of resuming from whatever arrives next.
 */
const subagentTurns = new Map<string, PartsFold>()

/**
 * Record a config change as the new GLOBAL default - the template every new
 * session is stamped from.
 *
 * The session itself is written separately (`api.chats.setConfig`); this half is
 * what makes "the next session remembers what I last picked" true. Returns the
 * refreshed settings, or null when the patch touched nothing global.
 *
 * Best-effort by design: a session whose config was saved must not appear to
 * have failed because the template write did. The session row is what the
 * turn actually runs on.
 */
async function persistGlobalConfig(patch: SessionConfigPatch): Promise<AppSettings | null> {
  let latest: AppSettings | null = null
  try {
    if ('providerId' in patch && patch.providerId) {
      latest = await api.settings.setActiveProvider(patch.providerId, patch.model ?? null)
    }
    if ('agentId' in patch && patch.agentId) {
      latest = await api.settings.setActiveAgent(patch.agentId)
    }
    if ('reasoningEffort' in patch && patch.reasoningEffort) {
      latest = await api.settings.setReasoningEffort(patch.reasoningEffort)
    }
    if ('contextLimit' in patch) {
      latest = await api.settings.setContextLimit(patch.contextLimit ?? null)
    }
  } catch {
    // The session keeps its own copy either way; only the inherited default
    // for the *next* session is lost, which self-heals on the next change.
  }
  return latest
}

/**
 * Desktop live-mirror: reload the shared chat's transcript from disk after a
 * remote (phone) turn, but only if it's still the chat on screen, no local send
 * is streaming into it, and no *newer* remote rev has superseded this one — the
 * rev guard makes concurrent reloads resolve last-writer-wins instead of racing.
 */
async function mirrorSharedChat(sessionId: string, rev: number): Promise<void> {
  const messages = await api.messages.list(sessionId)
  const s = useRoxyStore.getState()
  if (s.activeChatId !== sessionId || s.remote.rev !== rev) return
  if (s.sendingChats[sessionId]) {
    // A local send began mid-reload — reconcile once it finishes (finishTurn).
    remoteMirror.deferred = true
    return
  }
  useRoxyStore.setState({ messages })
}

/**
 * Fold one phone-driven turn's streamed event (or turn boundary) into a live
 * parts list and, when that session is on screen, reflect it into `streamingChats`
 * so the desktop shows the reply token-by-token — the remote twin of a local
 * send's delta handler. A `turn:idle` clears the live parts; the persisted reply
 * (reconciled from disk by `mirrorSharedChat` on the state bump) then takes over,
 * so there's no gap between the live bubble and the saved message.
 */
function applyRemoteDelta(payload: RemoteDelta): void {
  const { sessionId } = payload
  const reflect = (parts: MessagePart[] | null): void => {
    if (useRoxyStore.getState().activeChatId !== sessionId) return
    // Never clobber a local send streaming into the same chat — its own handler
    // owns `streamingChats[sessionId]` until finishTurn reconciles.
    if (useRoxyStore.getState().sendingChats[sessionId]) return
    useRoxyStore.setState((s) => {
      const next = { ...s.streamingChats }
      if (parts === null) delete next[sessionId]
      else next[sessionId] = parts
      return { streamingChats: next }
    })
  }

  if (payload.kind === 'turn') {
    if (payload.state === 'running') {
      // Open an empty live bubble (a "thinking" indicator) the moment the turn
      // starts, so the desktop isn't blank while the first token is resolved.
      remoteTurns.set(sessionId, new PartsFold())
      reflect([])
    } else {
      remoteTurns.delete(sessionId)
      reflect(null)
    }
    return
  }

  // A stream event: fold it into this session's live parts through the SAME pure
  // fold the local send and the main process use, so remote mirroring can never
  // drift from — or silently drop an event type handled by — the local path.
  let turn = remoteTurns.get(sessionId)
  if (!turn) {
    turn = new PartsFold()
    remoteTurns.set(sessionId, turn)
  }
  reflect(turn.apply(payload.event))
}

/**
 * Apply a main-process session change: refetch the rows, and — when a worktree
 * just came into existence — prime the git status for its brand-new path.
 *
 * The priming is the non-obvious half. `gitStatus` is keyed by PATH, and until
 * now the session was keyed by its project folder; the worktree path has never
 * been polled, so it has no entry. `workstreamStripView` renders NOTHING without
 * a status, so a plain refetch would swap "(pending)" for an empty row that pops
 * back a few seconds later on the next poll tick — trading a stale strip for a
 * flickering one. Fetching the status for the new key first means the row goes
 * straight from pending to live, with no blank frame in between.
 */
async function applySessionsUpdated(payload: SessionsUpdated): Promise<void> {
  const store = useRoxyStore.getState()
  if (payload.reason === 'worktree' && payload.statusKey) {
    const key = payload.statusKey
    if (!store.gitStatus[key]) {
      try {
        const [status, forge] = await Promise.all([api.git.status(key), api.forge.status(key)])
        useRoxyStore.setState((s) => ({
          gitStatus: { ...s.gitStatus, [key]: status },
          forgeStatus: forge ? { ...s.forgeStatus, [key]: forge } : s.forgeStatus
        }))
      } catch {
        // Best-effort: the 5s poll picks it up. Must never block the refresh
        // below, which is what actually clears the stale "pending" label.
      }
    }
    // A new worktree is also a new row in the project's worktree list, which the
    // workstream menu reads. Cheap, and only on this rare event.
    const workspace = store.chats.find((c) => c.id === payload.sessionIds[0])?.workspacePath
    if (workspace) void store.refreshWorktrees(workspace)
  }
  await useRoxyStore.getState().refreshChats()
}

/**
 * Fold one SUBAGENT step (or run boundary) into that subagent's own live parts
 * and, when its session is on screen, reflect it into `streamingChats` — so
 * opening a delegate's chat shows it working in real time, exactly like a normal
 * session, instead of a lone prompt until the run ends.
 *
 * Deliberately keyed by the sub chat id rather than a requestId: a subagent run
 * (especially a background one) routinely outlives the request that launched it,
 * and after a window reload there is no request to key on at all.
 *
 * A `run: completed|error` frame drops the live parts; the subagent's persisted
 * assistant message — written just before that frame is sent — takes over, so
 * there's no gap between the live bubble and the saved transcript.
 */
function applySubagentDelta(payload: SubagentDelta): void {
  const { subChatId } = payload
  const reflect = (parts: MessagePart[] | null): void => {
    if (useRoxyStore.getState().activeChatId !== subChatId) return
    useRoxyStore.setState((s) => {
      const next = { ...s.streamingChats }
      if (parts === null) delete next[subChatId]
      else next[subChatId] = parts
      return { streamingChats: next }
    })
  }

  if (payload.kind === 'run') {
    if (payload.state === 'running') {
      // Open an empty live bubble the moment the run starts, so a viewer who is
      // already on the session gets the thinking indicator rather than a blank
      // pane while the delegate resolves its first token.
      subagentTurns.set(subChatId, new PartsFold())
      useRoxyStore.setState((s) => ({
        runningSubagents: { ...s.runningSubagents, [subChatId]: true }
      }))
      reflect([])
      return
    }
    subagentTurns.delete(subChatId)
    useRoxyStore.setState((s) => {
      const runningSubagents = { ...s.runningSubagents }
      delete runningSubagents[subChatId]
      return { runningSubagents }
    })
    reflect(null)
    // The run's transcript landed a moment ago — swap the live bubble for the
    // persisted message, and refresh the sidebar (a finished sub may now prune).
    void (async () => {
      if (useRoxyStore.getState().activeChatId === subChatId) {
        useRoxyStore.setState({ messages: await api.messages.list(subChatId) })
      }
      await useRoxyStore.getState().refreshChats()
    })()
    return
  }

  // A stream event: fold it through the SAME pure fold the main process and every
  // other live path use, so a subagent's view can never drift from — or silently
  // drop an event type handled by — the parent's `task` card.
  let turn = subagentTurns.get(subChatId)
  if (!turn) {
    turn = new PartsFold()
    subagentTurns.set(subChatId, turn)
  }
  reflect(turn.apply(payload.event))

  // A subagent's `change_session_metadata` writes to its OWN session (the tool
  // runs with the sub chat id), so its title, description, and task checklist all
  // live on that row. Reload the chat list when one lands, or the header strip
  // and the sidebar entry would sit stale until the run ends — and watching a
  // delegate tick off its own checklist is most of the point of opening it.
  const event = payload.event
  if (event.type === 'tool-end' && event.ok) {
    const card = turn.parts.find((p) => p.type === 'tool' && p.callId === event.callId)
    if (card?.type === 'tool' && card.tool === 'change_session_metadata') {
      void useRoxyStore.getState().refreshChats()
    }
  }
}

/**
 * Catch up a subagent session opened mid-run: pull the parts main has folded so
 * far and seed the local fold with them, so the live bubble starts complete and
 * subsequent deltas append rather than replacing a half-empty transcript.
 *
 * Seeding (not assigning) matters — the fold rebuilds its call-id index from the
 * snapshot, so an inherited running tool card still flips to done when its
 * `tool-end` arrives instead of spinning forever.
 */
async function hydrateSubagent(subChatId: string): Promise<void> {
  const parts = await api.subagents.snapshot(subChatId).catch(() => null)
  // The run may have finished (or the user navigated away) during the round trip;
  // its persisted message is then the truth and must not be overwritten.
  if (!parts || useRoxyStore.getState().activeChatId !== subChatId) return
  const fold = subagentTurns.get(subChatId) ?? new PartsFold()
  // Never rewind: deltas that arrived while the snapshot was in flight are
  // already folded locally and are strictly newer than what main sent back.
  if (fold.parts.length === 0) fold.seed(parts)
  subagentTurns.set(subChatId, fold)
  useRoxyStore.setState((s) => ({
    runningSubagents: { ...s.runningSubagents, [subChatId]: true },
    streamingChats: { ...s.streamingChats, [subChatId]: fold.parts }
  }))
}

export const useRoxyStore = create<RoxyStore>((set, get) => ({
  ready: false,
  settings: null,
  providers: [],
  modelCatalog: {},
  chats: [],
  activeChatId: null,
  messages: [],
  sendingChats: {},
  streamingChats: {},
  activeAgentId: DEFAULT_AGENT_ID,
  projectInstructions: {},
  projectOrder: [],
  loops: [],
  queue: [],
  stopChats: {},
  compactingChats: {},
  runningTasks: {},
  runningSubagents: {},
  remote: { phase: 'idle', guests: 0, rev: 0 },
  services: [],
  gitAvailable: null,
  gitStatus: {},
  forgeStatus: {},
  worktrees: {},
  gitBranches: {},
  usageStats: null,

  bootstrap: async () => {
    const [settings, providers, chats, loops, projectOrder] = await Promise.all([
      api.settings.getAll(),
      api.providers.listConnected(),
      api.chats.list(),
      api.loops.list(),
      api.projects.listOrder()
    ])
    set({ settings, providers, chats, loops, projectOrder, ready: true })
    // Warm the usage/cost dashboard for the titlebar pill (best-effort, async).
    void get().refreshUsage()

    if (!loopTickSubscribed) {
      loopTickSubscribed = true
      api.loops.onTick(async (loopId) => {
        const fresh = await api.loops.list()
        set({ loops: fresh })
        const loop = fresh.find((l) => l.id === loopId)
        if (!loop) return
        if (get().activeChatId === loop.chatId) {
          set({ messages: await api.messages.list(loop.chatId) })
        }
        // Real heartbeat: run the agent on the loop's prompt in its project each
        // beat — the "infinite prompting" session. Needs a connected provider.
        await get().refreshChats()
        const { settings, providers } = get()
        const provider =
          providers.find((p) => p.id === settings?.activeProviderId) ?? providers[0] ?? null
        if (!provider || !(provider.hasCredential || provider.auth === 'none')) return
        // Previous beat still running → queue this beat's prompt (at most one
        // pending) so the workflow's next step shows up as a queued item and
        // runs as soon as the current reply finishes, instead of being skipped.
        if (get().sendingChats[loop.chatId]) {
          const pending = await api.queue.list(loop.chatId)
          if (pending.length === 0) {
            await api.queue.add(loop.chatId, loop.prompt)
            if (get().activeChatId === loop.chatId) await get().refreshQueue()
          }
          return
        }
        await get().sendMessage(loop.prompt, loop.chatId)
      })
    }

    if (!llmDeltaSubscribed) {
      llmDeltaSubscribed = true
      api.llm.onDelta(({ requestId, event }) => deltaHandlers.get(requestId)?.(event))
    }

    // Session rows the MAIN process changed on its own. The big one is lazy
    // worktree materialization: a session's worktree, branch and dev port are
    // all written by main on the first turn, so without this push the strip
    // below the composer keeps insisting "(pending) / branch pending" for the
    // whole turn — minutes of the UI contradicting what is already on disk.
    if (!chatsUpdatedSubscribed) {
      chatsUpdatedSubscribed = true
      api.chats.onUpdated((payload) => void applySessionsUpdated(payload))
    }

    // Background subagent tasks (Phase 11) report state out-of-band — they can
    // finish long after the launching turn's request has ended, so this global
    // subscription (not the per-request delta handler) keeps the UI live: it
    // tracks the running-count badge and reloads the parent/sub transcript when a
    // detached task lands its report.
    if (!taskUpdateSubscribed) {
      taskUpdateSubscribed = true
      api.tasks.onUpdate((update) => {
        void get().handleTaskUpdate(update)
      })
    }

    // A subagent's own live stream. Separate from the requestId-keyed llm:delta
    // channel on purpose: a subagent run outlives the request that launched it
    // (a background one by design), and after a window reload there is no
    // request to route by — but its session id is still on screen in the sidebar.
    if (!subagentDeltaSubscribed) {
      subagentDeltaSubscribed = true
      api.subagents.onDelta((payload) => applySubagentDelta(payload))
      // A window that just (re)loaded missed every `run: running` frame, so
      // restore the in-flight set from main — otherwise a delegate that is very
      // much still working shows no spinner anywhere until it happens to emit.
      void api.subagents
        .listRunning()
        .then((running) => {
          if (running.length === 0) return
          set((s) => {
            const runningSubagents = { ...s.runningSubagents }
            for (const r of running) runningSubagents[r.subChatId] = true
            return { runningSubagents }
          })
          const active = get().activeChatId
          if (active && running.some((r) => r.subChatId === active)) void hydrateSubagent(active)
        })
        .catch(() => {
          // best-effort — a failed restore costs a spinner, never correctness
        })
    }

    // Remote Workspace: keep the sharing badge live and mirror remote activity.
    // The main process bumps RemoteState.rev whenever the shared session's
    // transcript changes (a phone prompt or reply landed), so we reload that
    // chat on-screen — the "one source of truth" desktop mirror.
    if (!remoteStateSubscribed) {
      remoteStateSubscribed = true
      api.remote.onState((state) => {
        const prevRev = get().remote.rev
        set({ remote: state })
        const shared = state.sessionId
        // Only mirror when the shared chat is on screen and it actually changed.
        if (!shared || shared !== get().activeChatId || state.rev === prevRev) return
        // The queue may have changed from the phone (a prompt was queued, removed,
        // or drained) — keep the desktop's queue view in sync with the shared one.
        void get().refreshQueue()
        if (get().sendingChats[shared]) {
          // Don't clobber an in-flight local stream — reconcile after it lands.
          remoteMirror.deferred = true
          return
        }
        void mirrorSharedChat(shared, state.rev)
      })
      // A share may already be live from before this window (re)loaded.
      void get().refreshRemote()
    }

    // Remote Workspace live stream: a phone-driven turn's tokens arrive here so
    // the desktop mirrors the reply as it streams (not just on turn end). Kept
    // separate from the state subscription because it fires far more often (once
    // per token) and folds into `streamingChats` rather than reloading from disk.
    if (!remoteDeltaSubscribed) {
      remoteDeltaSubscribed = true
      api.remote.onDelta((payload) => applyRemoteDelta(payload))
    }

    const firstSession = chats.find((c) => c.kind === 'main')
    if (!get().activeChatId && firstSession) {
      await get().selectChat(firstSession.id)
    }
  },

  refreshChats: async () => {
    // Project order can change when a session/loop is created or deleted, so
    // pull it in the same round trip — one set, so the sidebar re-renders once.
    const [chats, projectOrder] = await Promise.all([api.chats.list(), api.projects.listOrder()])
    set({ chats, projectOrder })
  },

  refreshLoops: async () => {
    set({ loops: await api.loops.list() })
  },

  refreshQueue: async () => {
    const chatId = get().activeChatId
    set({ queue: chatId ? await api.queue.list(chatId) : [] })
  },

  createLoop: async (input) => {
    const loop = await api.loops.create(input)
    await get().refreshLoops()
    await get().refreshChats()
    await get().selectChat(loop.chatId)
  },

  setLoopEnabled: async (id, enabled) => {
    await api.loops.setEnabled(id, enabled)
    await get().refreshLoops()
  },

  removeLoop: async (id) => {
    const loop = get().loops.find((l) => l.id === id)
    await api.loops.remove(id)
    await get().refreshLoops()
    await get().refreshChats()
    if (loop && get().activeChatId === loop.chatId) get().clearActive()
  },

  refreshProviders: async () => {
    const [providers, settings] = await Promise.all([
      api.providers.listConnected(),
      api.settings.getAll()
    ])
    set({ providers, settings })
  },

  startRemote: async () => {
    const sessionId = get().activeChatId
    if (!sessionId) return
    const cur = get().remote
    // Don't double-mint: a start is already in flight, or the workspace is already
    // shared (the phone can roam every session through the one live room, so we
    // never re-mint just because it moved to a different session than the active one).
    if (cur.phase === 'starting') return
    if (cur.phase === 'live' || cur.phase === 'offline') return
    // Clean 'starting' — never surface a previous share's stale url/pin/guests.
    set((s) => ({ remote: { phase: 'starting', sessionId, guests: 0, rev: s.remote.rev } }))
    try {
      set({ remote: await api.remote.start({ sessionId }) })
    } catch (err) {
      set((s) => ({
        remote: {
          ...s.remote,
          phase: 'error',
          error: err instanceof Error ? err.message : 'Failed to start sharing.'
        }
      }))
    }
  },

  stopRemote: async () => {
    set({ remote: await api.remote.stop() })
  },

  refreshServices: async (sessionId) => {
    if (!sessionId) {
      set({ services: [] })
      return
    }
    try {
      const services = await api.services.list(sessionId)
      // Guard against a stale response landing after the user switched away.
      if (get().activeChatId === sessionId) set({ services })
    } catch {
      // Best-effort — keep the last known list.
    }
  },

  refreshGitStatus: async (chatId) => {
    const chat = get().chats.find((c) => c.id === chatId)
    if (!chat) return
    // Sub-sessions inherit their parent's workstream — never poll them separately.
    if (chat.kind === 'sub') return
    const key = chat.worktreePath ?? chat.workspacePath
    if (!key) return
    // Probe for git once per app run; a machine without it hides the UI entirely.
    if (get().gitAvailable === null) {
      try {
        set({ gitAvailable: await api.git.available() })
      } catch {
        set({ gitAvailable: false })
      }
    }
    if (!get().gitAvailable) return
    try {
      // One round trip for both. `forge.status` is cheap by construction: it
      // returns local git state immediately and refreshes pull-request data in
      // the background, so putting it on the 5s poll costs no network traffic.
      const [status, forge] = await Promise.all([api.git.status(key), api.forge.status(key)])
      set((s) => ({
        gitStatus: { ...s.gitStatus, [key]: status },
        forgeStatus: forge ? { ...s.forgeStatus, [key]: forge } : s.forgeStatus
      }))
    } catch {
      // Best-effort: a transient git failure leaves the last known state.
    }
  },

  pushBranch: async (chatId) => {
    const chat = get().chats.find((c) => c.id === chatId)
    const key = chat?.worktreePath ?? chat?.workspacePath
    if (!key) return { ok: false, error: 'No workspace for this session.' }
    const r = await api.forge.push(key)
    // Refresh immediately so the chip moves off "local" the moment the push
    // lands, rather than on the next tick.
    if (r.ok) await get().refreshGitStatus(chatId)
    return r
  },

  refreshWorktrees: async (workspacePath) => {
    if (!workspacePath || !get().gitAvailable) return
    try {
      const [worktrees, branches] = await Promise.all([
        api.git.worktrees(workspacePath),
        api.git.branches(workspacePath)
      ])
      set((s) => ({
        worktrees: { ...s.worktrees, [workspacePath]: worktrees },
        gitBranches: { ...s.gitBranches, [workspacePath]: branches }
      }))
    } catch {
      // Menu just shows what it already had.
    }
  },

  newWorkstream: async ({ workspacePath, mode, branch }) => {
    // The worktree itself is created lazily on the session's first turn (so an
    // abandoned composer leaves nothing on disk) — here we only record the intent.
    const taken = get()
      .chats.filter((c) => c.kind === 'main' && c.workspacePath === workspacePath)
      .map((c) => c.title)
    const chat = await api.chats.create({
      title: branch?.trim() || uniqueSlug(taken),
      workspacePath,
      worktree: { mode, branch }
    })
    await get().refreshChats()
    await get().selectChat(chat.id)
  },

  refreshRemote: async () => {
    try {
      set({ remote: await api.remote.status() })
    } catch {
      // Status is best-effort — keep the current state if main isn't ready.
    }
  },

  sessionConfig: () => {
    const { chats, activeChatId, settings } = get()
    return resolveSessionConfig(
      chats.find((c) => c.id === activeChatId),
      settings
    )
  },

  setSessionConfig: async (patch) => {
    const chatId = get().activeChatId
    // Optimistic: the picker closes on click, so the trigger must already show
    // the new value - a round-trip of visible lag reads as a dropped click.
    // `undefined` is stripped so a partial patch can't blank a field the caller
    // never named (the DB layer keys off `in`; null explicitly means "clear").
    const applied = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined)
    ) as SessionConfigPatch
    if (chatId) {
      set((s) => ({
        chats: s.chats.map((c) => (c.id === chatId ? { ...c, ...applied } : c))
      }))
    }
    // Persist to the session, and remember it globally for the next new one.
    const [chat, settings] = await Promise.all([
      chatId ? api.chats.setConfig(chatId, patch) : Promise.resolve(null),
      persistGlobalConfig(patch)
    ])
    set((s) => ({
      ...(settings ? { settings } : {}),
      ...(chat ? { chats: s.chats.map((c) => (c.id === chat.id ? chat : c)) } : {})
    }))
  },

  selectModel: async (providerId, model) => {
    // Provider + model always move together (see resolveSessionConfig).
    await get().setSessionConfig({ providerId, model })
  },

  ensureModels: async (providerId) => {
    if (get().modelCatalog[providerId]) return
    const list = modelCatalogCache.get(providerId) ?? (await api.models.list(providerId))
    modelCatalogCache.set(providerId, list)
    set((s) => ({ modelCatalog: { ...s.modelCatalog, [providerId]: list } }))
  },

  setReasoningEffort: async (level) => {
    await get().setSessionConfig({ reasoningEffort: level })
  },

  setContextLimit: async (limit) => {
    await get().setSessionConfig({ contextLimit: limit })
  },

  setAutoWorkstream: async (enabled) => {
    const settings = await api.settings.setAutoWorkstream(enabled)
    set({ settings })
  },

  setBranchPrefix: async (prefix) => {
    const settings = await api.settings.setBranchPrefix(prefix)
    set({ settings })
  },

  setWebSearchApiKey: async (key) => {
    const settings = await api.settings.setWebSearchApiKey(key)
    set({ settings })
  },

  selectChat: async (id) => {
    // Per-chat send state survives switching — just swap which chat is shown.
    // Clear messages/queue first so the previous chat's content never flashes.
    //
    // The mode comes from the session being opened, NOT a reset to 'build':
    // config is per-session, so a session left in Plan mode is still in Plan
    // mode when you come back to it. The model/effort/context pickers read the
    // chat row directly via `resolveSessionConfig`, so they need no mirror here.
    const chat = get().chats.find((c) => c.id === id)
    set({
      activeChatId: id,
      messages: [],
      queue: [],
      activeAgentId: chat?.agentId ?? DEFAULT_AGENT_ID
    })
    const workspace = chat?.workspacePath
    if (workspace) void get().ensureProjectInstructions(workspace)
    // Tell main which sub session is on screen so the end-of-turn prune spares
    // it — a one-shot delegate you're reading shouldn't vanish mid-sentence.
    void api.subagents.setViewed(chat?.kind === 'sub' ? id : null).catch(() => {})
    // Opening a subagent mid-run: pull what it has already done so the live
    // bubble starts from the whole transcript, not from the next delta.
    if (chat?.kind === 'sub') void hydrateSubagent(id)
    const [messages, queue] = await Promise.all([api.messages.list(id), api.queue.list(id)])
    if (get().activeChatId === id) set({ messages, queue })
  },

  clearActive: () =>
    set({
      activeChatId: null,
      messages: [],
      queue: [],
      activeAgentId: DEFAULT_AGENT_ID
    }),

  setActiveAgent: async (id) => {
    // Mirror first so the picker updates instantly, then persist to the session
    // (+ the global template for the next new one).
    set({ activeAgentId: id })
    await get().setSessionConfig({ agentId: id })
  },

  ensureProjectInstructions: async (workspacePath) => {
    if (!workspacePath || get().projectInstructions[workspacePath]) return
    const blocks = await api.context.instructions(workspacePath).catch(() => [])
    set((s) => ({
      projectInstructions: { ...s.projectInstructions, [workspacePath]: blocks }
    }))
  },

  newSession: async () => {
    const path = await api.dialog.openWorkspace()
    if (!path) return
    await get().newSessionInProject(path)
  },

  newSessionInProject: async (workspacePath) => {
    // A project is its workspace folder. New sessions get a fun random three-word
    // slug (e.g. "Async Roxy Sage") instead of "Session N" — the agent renames it
    // properly on its first turn. Skip this project's live titles to avoid a dup.
    const taken = get()
      .chats.filter((c) => c.kind === 'main' && c.workspacePath === workspacePath)
      .map((c) => c.title)

    // In a git repo, a new session gets its own workstream by default: the
    // project folder is the checkout the user's editor is open in, so a second
    // session editing it concurrently corrupts both. Only the INTENT is stored
    // — the worktree is built lazily on the first turn, so this stays free for
    // a session that is opened and abandoned.
    const worktree = (await get().autoWorkstreamFor(workspacePath))
      ? ({ mode: 'new' } as const)
      : undefined

    const chat = await api.chats.create({ title: uniqueSlug(taken), workspacePath, worktree })
    await get().refreshChats()
    await get().selectChat(chat.id)
  },

  autoWorkstreamFor: async (workspacePath) => {
    if (!workspacePath) return false
    if (!(get().settings?.autoWorkstream ?? true)) return false

    // Probe git once per app run, exactly as refreshGitStatus does. Without
    // this the first session after launch would silently skip its workstream,
    // because gitAvailable is still null at that point.
    if (get().gitAvailable === null) {
      try {
        set({ gitAvailable: await api.git.available() })
      } catch {
        set({ gitAvailable: false })
      }
    }

    // Most folders are not repos, and asking git is the only way to know. This
    // runs once per new session, not per render.
    let status = get().gitStatus[workspacePath]
    if (!status && get().gitAvailable) {
      try {
        status = await api.git.status(workspacePath)
        set((s) => ({ gitStatus: { ...s.gitStatus, [workspacePath]: status! } }))
      } catch {
        return false
      }
    }

    return shouldAutoWorkstream({
      autoWorkstream: true,
      gitAvailable: get().gitAvailable,
      isRepo: status?.isRepo
    })
  },

  deleteChat: async (id) => {
    await api.chats.remove(id)
    await get().refreshChats()
    set((s) => {
      const sendingChats = { ...s.sendingChats }
      const streamingChats = { ...s.streamingChats }
      const stopChats = { ...s.stopChats }
      delete sendingChats[id]
      delete streamingChats[id]
      delete stopChats[id]
      return { sendingChats, streamingChats, stopChats }
    })
    if (get().activeChatId === id) get().clearActive()
  },

  renameChat: async (id, title) => {
    await api.chats.rename(id, title)
    await get().refreshChats()
  },

  reorderSessions: async (workspacePath, ids) => {
    // Optimistic: reorder this project's sessions in place (chats is one flat
    // list sorted by sortOrder DESC), so the drag feels instant; then persist
    // and refresh to pick up the authoritative sort keys.
    const inProject = new Set(ids)
    set((s) => {
      // Fill each of this project's slots (top-to-bottom) with the chat named by
      // the next id in ids. k MUST advance exactly once per slot: evaluating
      // ids[k++] inside a .find predicate bumped it per element scanned, which
      // mapped one chat into two slots -> a duplicate row that broke on delete.
      const byId = new Map(s.chats.map((c) => [c.id, c]))
      let k = 0
      const chats = s.chats.map((c) =>
        c.kind === 'main' && c.workspacePath === workspacePath && inProject.has(c.id)
          ? (byId.get(ids[k++]) ?? c)
          : c
      )
      return { chats }
    })
    await api.chats.reorder(workspacePath, ids)
    await get().refreshChats()
  },

  reorderProjects: async (paths) => {
    // Optimistic: show the new project order immediately, then persist and
    // refresh to pick up the authoritative order (mirrors reorderSessions).
    set({ projectOrder: paths })
    await api.projects.reorder(paths)
    await get().refreshChats()
  },

  submit: async (content, images) => {
    const chatId = get().activeChatId
    if (!chatId) return
    const text = content.trim()
    if (!text && (!images || images.length === 0)) return
    // This chat is busy → queue it (text + any images); otherwise send now.
    // "Busy" means a local send is streaming *or* a phone-driven turn is running
    // into this same session (`remoteTurns`) — so a desktop prompt lands in the
    // shared FIFO behind a phone turn instead of starting a second concurrent one.
    // A subagent still running in its own session counts as busy too: its turn
    // is driven from the main process, so a prompt sent now would start a SECOND
    // concurrent turn writing into the same transcript. Queue it instead — it
    // drains as a normal follow-up once the delegate reports.
    if (get().sendingChats[chatId] || remoteTurns.has(chatId) || subagentTurns.has(chatId)) {
      await api.queue.add(
        chatId,
        text,
        images?.map(({ dataUrl, mediaType, name }) => ({ dataUrl, mediaType, name }))
      )
      await get().refreshQueue()
      return
    }
    await get().sendMessage(text, undefined, images)
  },

  sendMessage: async (content, targetChatId, images) => {
    const chatId = targetChatId ?? get().activeChatId
    if (!chatId) return
    if (get().sendingChats[chatId]) return
    if (content.startsWith('!') && !content.slice(1).trim()) return
    const { settings } = get()

    // Make sure the workspace's instruction files are cached before we size the
    // window cut (the main process reads them fresh when it builds the prompt).
    const workspacePath = get().chats.find((c) => c.id === chatId)?.workspacePath
    if (workspacePath) await get().ensureProjectInstructions(workspacePath)

    // Send state is keyed by chat id, so switching chats (or running several
    // sessions at once) never crosses the streams or drops a reply.
    const setSending = (v: boolean): void =>
      set((s) => ({ sendingChats: { ...s.sendingChats, [chatId]: v } }))
    const setStreaming = (parts: MessagePart[] | null): void =>
      set((s) => {
        const next = { ...s.streamingChats }
        if (parts === null) delete next[chatId]
        else next[chatId] = parts
        return { streamingChats: next }
      })
    const clearStop = (): void =>
      set((s) => {
        const next = { ...s.stopChats }
        delete next[chatId]
        return { stopChats: next }
      })
    const isActive = (): boolean => get().activeChatId === chatId
    const chatExists = (): boolean => get().chats.some((c) => c.id === chatId)
    const stopped = (): boolean => !!get().stopChats[chatId]
    // Append a freshly-persisted message to the visible list — only when this
    // chat is on screen and it isn't already there (guards a load/append race).
    const appendIfActive = (m: Message): void => {
      if (!isActive()) return
      if (get().messages.some((x) => x.id === m.id)) return
      set({ messages: [...get().messages, m] })
    }

    // The assistant turn is an ordered list of parts so reasoning, tool calls,
    // and prose interleave through one render path instead of being grouped.
    let parts: MessagePart[] = []

    // Append a new text/reasoning part and reveal it token by token. Returns
    // false only if the chat was deleted mid-stream (caller bails immediately).
    const streamText = async (kind: 'text' | 'reasoning', full: string): Promise<boolean> => {
      const index = parts.length
      parts = [...parts, { type: kind, text: '' }]
      setStreaming(parts)
      let acc = ''
      for (const token of full.split(/(\s+)/)) {
        if (!chatExists()) {
          setStreaming(null)
          setSending(false)
          return false
        }
        if (stopped()) break
        acc += token
        parts = parts.map((p, i) => (i === index ? { type: kind, text: acc } : p))
        setStreaming(parts)
        await delay(12)
      }
      return true
    }

    // Persist the turn (always — even if the user navigated away) and clean up.
    const finishTurn = async (): Promise<void> => {
      // Capture the stop flag BEFORE clearStop() wipes it below — otherwise the
      // queue would drain even after the user hit Stop (the guard read `false`).
      const wasStopped = stopped()
      if (wasStopped) {
        parts = parts.map((p, i) =>
          i === parts.length - 1 && (p.type === 'text' || p.type === 'reasoning')
            ? { type: p.type, text: `${p.text.trimEnd()}\n\n_[stopped]_` }
            : p
        )
      }
      if (chatExists()) {
        const assistantMessage = await api.messages.add({
          chatId,
          role: 'assistant',
          content: partsToContent(parts),
          parts
        })
        appendIfActive(assistantMessage)
      }
      setStreaming(null)
      setSending(false)
      clearStop()
      // If a remote (phone) turn landed while this local send was streaming, we
      // deferred the mirror to avoid clobbering the stream — reconcile it now.
      if (remoteMirror.deferred && get().remote.sessionId === chatId) {
        remoteMirror.deferred = false
        void mirrorSharedChat(chatId, get().remote.rev)
      }
      await get().refreshChats()
      // A turn just recorded usage rows — refresh the cost dashboard so the
      // titlebar pill reflects the new spend without waiting for a manual open.
      void get().refreshUsage()
      // Completed subagent sessions get pruned in main — if we were viewing one
      // (now gone), fall back to this turn's chat so the pane isn't left empty.
      const active = get().activeChatId
      if (active && !get().chats.some((c) => c.id === active)) {
        await get().selectChat(chatId)
      }
      // Don't auto-run the next queued prompt when the user stopped this turn.
      if (!wasStopped) await get().drainQueue(chatId)
    }

    clearStop()
    setSending(true)

    // The user turn carries any pasted/dropped images as image parts ahead of
    // the text, so they persist, render as thumbnails, and reach the model.
    const userParts: MessagePart[] = [
      ...(images ?? []).map((img) => ({
        type: 'image' as const,
        dataUrl: img.dataUrl,
        mediaType: img.mediaType,
        name: img.name
      })),
      ...(content ? [{ type: 'text' as const, text: content }] : [])
    ]
    const userMessage = await api.messages.add({
      chatId,
      role: 'user',
      content,
      parts: userParts.length ? userParts : undefined
    })
    appendIfActive(userMessage)
    // Reveal the assistant bubble right away (empty → a cute "thinking"
    // indicator) so there's no empty gap while we wait for the first token.
    setStreaming(parts)

    // Command escape: "!<verb> ..." runs a tool and shows a tool card. Browser
    // verbs drive the Electron browser; anything else runs as a bash command.
    if (content.startsWith('!')) {
      const { tool, input, title } = parseToolCommand(content.slice(1).trim())
      parts = [{ type: 'tool', tool, state: 'running', title }]
      setStreaming(parts)
      const result = await api.tools.run(chatId, tool, input)
      parts = [
        {
          type: 'tool',
          tool,
          state: result.ok ? 'done' : 'error',
          title,
          output: result.output,
          image: result.image
        }
      ]
      setStreaming(parts)
      // A loop tool changed loop state — refresh the sidebar to reflect it.
      if (tool.startsWith('loop_')) await get().refreshLoops()
      await finishTurn()
      return
    }

    // Real model: a connected provider with a usable credential streams the reply.
    // Everything below resolves from THIS SESSION's pinned config (falling back
    // to the global last-used values), so a turn always runs on the model the
    // session shows - even if another session changed its picker mid-reply.
    const config = resolveSessionConfig(
      get().chats.find((c) => c.id === chatId),
      settings
    )
    const provider =
      get().providers.find((p) => p.id === config.providerId) ?? get().providers[0] ?? null
    if (provider && (provider.hasCredential || provider.auth === 'none')) {
      // Resolve the model's capabilities (reasoning support + context window) so
      // we only send reasoning params when valid and cut history to the budget.
      await get().ensureModels(provider.id)
      const catalog = get().modelCatalog[provider.id] ?? []
      // No model chosen? Take the provider's latest (tool-capable) model instead
      // of a hardcoded id that may not exist on this provider — the user never
      // has to type a model name for a connected provider to just work.
      // Only trust the session's model when it belongs to the provider we
      // actually resolved, so a stale pin can never cross providers.
      const model =
        (config.providerId === provider.id ? config.model : null) ||
        provider.defaultModel ||
        pickDefaultModel(catalog) ||
        (provider.id === 'github-copilot' ? 'gpt-4o' : 'gpt-4o-mini')
      const info = catalog.find((m) => m.id === model)
      const modelContext = info?.contextLimit ?? 128_000
      const contextBudget = contextBudgetFor(config.contextLimit, modelContext)
      const agentId = config.agentId
      // Auto-compact before the window overflows the model's *real* budget:
      // trigger once used tokens pass contextBudget minus the larger of the
      // reserved reply size or a safety buffer (mirrors opencode's
      // `context - max(output, buffer)` rather than a flat 80%). Compaction
      // summarizes older turns; buildChatMessages then sends summary + recent.
      if (!get().compactingChats[chatId]) {
        const used = await estimateUsedTokens(chatId, model, agentId)
        if (isOverflow(used, contextBudget, info?.outputLimit ?? 4096)) {
          await get().compactConversation(chatId)
        }
      }
      const requestId = crypto.randomUUID()
      const chatMessages = await buildChatMessages(
        chatId,
        contextBudget,
        info?.outputLimit ?? 4096,
        model,
        agentId
      )
      // Build parts live from the agent's event stream through the shared fold:
      // text grows the current text part, each tool call adds a card that flips
      // running→done/error, and a subagent's steps nest inside its `task` card.
      // Seeded with whatever the turn already rendered (a `!verb` card).
      const fold = new PartsFold()
      fold.parts = parts
      // Side effects that must fire when a specific tool starts/ends live here
      // rather than inside the fold, which stays pure.
      const findByCallId = (callId: string): MessagePart | undefined =>
        fold.parts.find((p) => p.type === 'tool' && p.callId === callId)
      deltaHandlers.set(requestId, (event) => {
        if (!chatExists()) return
        parts = fold.apply(event)
        if (event.type === 'tool-start') {
          // A `task` just spawned a subagent (its own `sub` session was created
          // in main) — surface it under the parent in the sidebar immediately.
          if (event.tool === 'task') void get().refreshChats()
        } else if (event.type === 'tool-end') {
          const ended = findByCallId(event.callId)
          if (event.ok && ended?.type === 'tool' && ended.tool.startsWith('loop_')) {
            // A loop_* tool just created/removed/toggled a loop — reflect it in
            // the sidebar right away instead of waiting for a manual refresh.
            void get().refreshLoops()
            void get().refreshChats()
          } else if (ended?.type === 'tool' && ended.tool === 'task') {
            // A subagent finished — its `sub` session now has its reply; refresh
            // the sidebar and reload it if the user is tapped into it.
            void (async () => {
              await get().refreshChats()
              const active = get().activeChatId
              if (active && get().chats.find((c) => c.id === active)?.kind === 'sub') {
                set({ messages: await api.messages.list(active) })
              }
            })()
          } else if (
            event.ok &&
            ended?.type === 'tool' &&
            ended.tool === 'change_session_metadata'
          ) {
            // The agent renamed / described / re-tasked its own session —
            // refresh so the sidebar title + the SessionInfo strip update live.
            void get().refreshChats()
          }
        }
        setStreaming(parts)
      })
      chatRequests.set(chatId, requestId)
      const result = await api.llm.start({
        requestId,
        sessionId: chatId,
        providerId: provider.id,
        model,
        messages: chatMessages,
        agentId,
        reasoning: info?.reasoning ?? false,
        reasoningEffort: config.reasoningEffort,
        contextLimit: contextBudget
      })
      deltaHandlers.delete(requestId)
      chatRequests.delete(chatId)
      if (!result.ok && !stopped()) {
        parts = [
          ...parts,
          { type: 'text', text: `_\u26a0 ${result.error ?? 'Model request failed.'}_` }
        ]
        setStreaming(parts)
      }
      await finishTurn()
      return
    }

    // Placeholder turn: stream a reasoning part, then a prose part, in order.
    if (!(await streamText('reasoning', buildReasoning(content)))) return
    if (!stopped()) {
      const reply = buildPlaceholderReply(content, get().providers, settings)
      if (!(await streamText('text', reply))) return
    }
    await finishTurn()
  },

  drainQueue: async (chatId) => {
    const items = await api.queue.list(chatId)
    if (items.length === 0) {
      if (get().activeChatId === chatId) set({ queue: [] })
      return
    }
    const next = items[0]
    await api.queue.remove(next.id)
    if (get().activeChatId === chatId) set({ queue: items.slice(1) })
    await get().sendMessage(
      next.content,
      chatId,
      next.images?.map((img) => ({ id: crypto.randomUUID(), ...img, name: img.name ?? 'image' }))
    )
  },

  removeQueued: async (id) => {
    await api.queue.remove(id)
    await get().refreshQueue()
  },

  moveQueued: async (id, direction) => {
    const chatId = get().activeChatId
    if (!chatId) return
    const items = get().queue
    const i = items.findIndex((q) => q.id === id)
    if (i < 0) return
    const j = direction === 'up' ? i - 1 : i + 1
    if (j < 0 || j >= items.length) return
    const reordered = items.slice()
    ;[reordered[i], reordered[j]] = [reordered[j], reordered[i]]
    set({ queue: reordered }) // optimistic — snappy reorder before the round-trip
    await api.queue.reorder(
      chatId,
      reordered.map((q) => q.id)
    )
    await get().refreshQueue()
  },

  editQueued: async (id, content, images) => {
    await api.queue.update(
      id,
      content,
      images?.map(({ dataUrl, mediaType, name }) => ({ dataUrl, mediaType, name }))
    )
    await get().refreshQueue()
  },

  refreshUsage: async () => {
    try {
      set({ usageStats: await api.usage.stats() })
    } catch {
      // best-effort — a usage fetch failure must never disrupt the UI
    }
  },

  stop: () => {
    const id = get().activeChatId
    if (!id) return
    set((s) => ({ stopChats: { ...s.stopChats, [id]: true } }))
    const requestId = chatRequests.get(id)
    if (requestId) void api.llm.abort(requestId)
  },

  compactConversation: async (targetChatId) => {
    const chatId = targetChatId ?? get().activeChatId
    if (!chatId || get().compactingChats[chatId]) return
    const { settings, providers } = get()
    // Compact with the SESSION's own model: compacting must not route a
    // session's history through whatever model another session has selected.
    const config = resolveSessionConfig(
      get().chats.find((c) => c.id === chatId),
      settings
    )
    const provider = providers.find((p) => p.id === config.providerId) ?? providers[0] ?? null
    if (!provider || !(provider.hasCredential || provider.auth === 'none')) return
    await get().ensureModels(provider.id)
    const model =
      (config.providerId === provider.id ? config.model : null) ||
      provider.defaultModel ||
      pickDefaultModel(get().modelCatalog[provider.id] ?? []) ||
      (provider.id === 'github-copilot' ? 'gpt-4o' : 'gpt-4o-mini')
    set((s) => ({ compactingChats: { ...s.compactingChats, [chatId]: true } }))
    try {
      await api.context.compact(chatId, provider.id, model)
      await get().refreshChats()
      if (get().activeChatId === chatId) set({ messages: await api.messages.list(chatId) })
    } catch (e) {
      console.error('Compaction failed:', e)
    } finally {
      set((s) => {
        const next = { ...s.compactingChats }
        delete next[chatId]
        return { compactingChats: next }
      })
    }
  },

  handleTaskUpdate: async (update) => {
    // Track the per-session running set for the badge: a `running` update adds
    // the job, a terminal one removes it.
    set((s) => {
      const current = s.runningTasks[update.sessionId] ?? []
      const without = current.filter((t) => t.jobId !== update.jobId)
      const nextForSession = update.state === 'running' ? [...without, update] : without
      const runningTasks = { ...s.runningTasks }
      if (nextForSession.length) runningTasks[update.sessionId] = nextForSession
      else delete runningTasks[update.sessionId]
      return { runningTasks }
    })

    // Keep the sidebar in sync (a sub-session appeared or, once done, may be
    // pruned on the next turn) and reload whichever transcript the user is on:
    // the parent gets the delivered report card; the sub session shows its work.
    await get().refreshChats()
    const active = get().activeChatId
    if (!active) return
    if (active === update.sessionId || active === update.subChatId) {
      set({ messages: await api.messages.list(active) })
    }
  }
}))

/**
 * The model-tuned system prompt for a chat, used for token estimation (the context
 * meter + the window-cut reservation). The authoritative prompt is built in the
 * main process at turn time (`agent.ts`); this mirror only needs to be the right
 * size, so it omits main-only facts (git status, platform) that add just a line.
 * Passing `agentId` folds in the agent's own prompt (e.g. Plan mode's reminder).
 */
export function buildSystemPrompt(
  chat: Chat | undefined,
  modelId?: string,
  agentId?: string
): string {
  const base = PROMPT_TEXT[selectPromptName(modelId)] ?? PROMPT_TEXT.default
  const environment = buildEnvironment({
    cwd: chat?.workspacePath || undefined,
    modelId,
    date: new Date().toDateString()
  })
  const agent = agentId ? getAgent(agentId) : undefined
  const agentPrompt = agent?.promptFile ? AGENT_PROMPT_TEXT[agent.promptFile] : undefined
  // Mirror the main process: project instructions (AGENTS.md etc.) then the agent
  // prompt. Read from the per-workspace cache filled by ensureProjectInstructions;
  // empty until loaded (the meter fills in once the IPC resolves).
  const workspace = chat?.workspacePath
  const instructions = workspace
    ? (useRoxyStore.getState().projectInstructions[workspace] ?? [])
    : []
  const extra = [...instructions, ...(agentPrompt ? [agentPrompt] : [])]
  return assembleSystemPrompt({
    base,
    environment,
    extra: extra.length ? extra : undefined,
    contextSummary: chat?.contextSummary ?? undefined
  })
}

/** Build chat-completion messages: workspace history within the context budget.
 *  The system prompt is prepended in the main process (see harness/agent.ts), so
 *  it's only estimated here to reserve room in the window cut. Tool calls/results
 *  are kept structured so multi-turn tool reasoning survives across turns. */
async function buildChatMessages(
  chatId: string,
  contextBudget = 128_000,
  outputReserve = 4096,
  modelId?: string,
  agentId?: string
): Promise<ChatMessage[]> {
  const chat = useRoxyStore.getState().chats.find((c) => c.id === chatId)
  const systemText = buildSystemPrompt(chat, modelId, agentId)
  const since = chat?.contextSummaryAt ?? 0
  // Each turn rebuilds into one or more chat messages; keeping them grouped means
  // the window cut below can never split an assistant's tool_calls from the
  // matching role:'tool' results (which would orphan them → provider 400s).
  const groups = (await api.messages.list(chatId))
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.createdAt > since)
    .map(reconstructTurn)
    .filter((g) => g.length > 0)

  // Prune older tool outputs to a head/tail preview *before* the window cut, so
  // more turns of reasoning survive within budget instead of whole turns being
  // dropped (Phase 9.2). Prune on the flattened list (recent-token aware), then
  // zip back into the groups so tool_calls stay paired with their results.
  const flatAll = groups.flat()
  const prunedFlat = pruneToolMessages(flatAll, { keepRecentTokens: KEEP_RECENT_TOKENS })
  let pk = 0
  const prunedGroups = groups.map((g) => g.map(() => prunedFlat[pk++]))

  // The "window cut": keep the most recent turns whose estimated tokens fit the
  // chosen context budget, reserving room for the system prompt + model output
  // (~4 chars/token; tool-call args included; images at a flat ~800 tokens each).
  const cap = Math.max(2000, contextBudget - outputReserve - Math.ceil(systemText.length / 4))
  const estimate = (m: ChatMessage): number =>
    Math.ceil((m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0)) / 4) +
    (m.images?.length ?? 0) * 800
  const groupTokens = (g: ChatMessage[]): number => g.reduce((n, m) => n + estimate(m), 0)
  const kept: ChatMessage[][] = []
  let used = 0
  for (let i = prunedGroups.length - 1; i >= 0; i--) {
    const tokens = groupTokens(prunedGroups[i])
    if (used + tokens > cap && kept.length > 0) break
    kept.unshift(prunedGroups[i])
    used += tokens
  }
  const flat = kept.flat()
  // Normalize the window's leading edge to a user message: when the budget cut
  // lands mid-history it can leave a dangling assistant turn (whose own user
  // prompt was trimmed) or an orphaned role:'tool' result at the front. Both are
  // invalid for Anthropic ("first message must be user") and orphan a tool_use
  // from its tool_result. The current user turn is always at the tail, so this
  // only ever trims stale boundary turns, never real recent context.
  while (flat.length && flat[0].role !== 'user') flat.shift()
  return flat
}

/** Rough estimate of tokens currently in a chat's live window (post-compaction). */
async function estimateUsedTokens(
  chatId: string,
  modelId?: string,
  agentId?: string
): Promise<number> {
  const chat = useRoxyStore.getState().chats.find((c) => c.id === chatId)
  const since = chat?.contextSummaryAt ?? 0
  const msgs = (await api.messages.list(chatId)).filter((m) => m.createdAt > since)
  let chars = buildSystemPrompt(chat, modelId, agentId).length
  let images = 0
  for (const m of msgs)
    for (const p of m.parts) {
      if (p.type === 'tool') {
        chars += Math.min((p.output ?? '').length, REPLAY_OUTPUT_CAP)
        if (p.input) chars += JSON.stringify(p.input).length
      } else if (p.type === 'image') images += 1
      else chars += p.text.length
    }
  return Math.ceil(chars / 4) + images * 800
}

function buildPlaceholderReply(
  prompt: string,
  providers: ConnectedProvider[],
  settings: AppSettings | null
): string {
  const active = providers.find((p) => p.id === settings?.activeProviderId) ?? providers[0] ?? null
  const providerName = active?.name ?? 'no provider yet'
  const model = settings?.activeModel
  const wire = active?.wire ?? 'openai-chat'

  return [
    `Hey — I'm **Roxy** 👋`,
    ``,
    `You're connected to **${providerName}**${model ? ` · \`${model}\`` : ''}. A live model isn't ` +
      `wired in yet (that's the next milestone), but here's how I'll answer — rendered with ` +
      `[Streamdown](https://streamdown.ai):`,
    ``,
    '```ts',
    `export function greet(name: string) {`,
    '  return `Hello, ${name}!`',
    `}`,
    '```',
    ``,
    `**On my roadmap**`,
    `- Drive the \`${wire}\` wire protocol`,
    `- Tool calling: Browser, GitHub CLI, Gmail, and more`,
    `- Stream real tokens straight from the model`,
    ``,
    `You said: _${prompt}_`
  ].join('\n')
}

/** A short placeholder "thinking" blurb shown as the reasoning part. */
function buildReasoning(prompt: string): string {
  const trimmed = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt
  return (
    `Reading "${trimmed}" and checking the active provider and model. ` +
    `No live model is wired in yet, so I'll stream a placeholder through the parts ` +
    `pipeline — reasoning first, then prose, with tool calls as inline cards.`
  )
}

/**
 * Map a `!<verb> ...` chat command to a tool call. Browser verbs drive the
 * Electron browser; everything else falls through to bash. Lets you test the
 * agent's tools by hand before the model loop is wired in.
 */
function parseToolCommand(raw: string): {
  tool: string
  input: Record<string, unknown>
  title: string
} {
  const space = raw.indexOf(' ')
  const verb = (space === -1 ? raw : raw.slice(0, space)).toLowerCase()
  const arg = space === -1 ? '' : raw.slice(space + 1).trim()
  switch (verb) {
    case 'open':
    case 'browse':
      return { tool: 'browser_open', input: { url: arg }, title: arg || '(no url)' }
    case 'shot':
    case 'screenshot':
      return { tool: 'browser_screenshot', input: {}, title: 'screenshot' }
    case 'read':
    case 'html':
    case 'dom':
      return {
        tool: 'browser_read',
        input: arg ? { selector: arg } : {},
        title: arg || 'page HTML'
      }
    case 'console':
    case 'errors':
      return { tool: 'browser_console', input: {}, title: 'console' }
    case 'closebrowser':
      return { tool: 'browser_close', input: {}, title: 'close browser' }
    case 'loops':
      return { tool: 'loop_list', input: {}, title: 'loops' }
    case 'loop': {
      const m = /^(on|off|enable|disable)\s+(.+)$/i.exec(arg)
      if (m) {
        const enable = /^(on|enable)$/i.test(m[1])
        const ref = m[2].trim()
        return {
          tool: enable ? 'loop_enable' : 'loop_disable',
          input: { loop: ref },
          title: `${m[1].toLowerCase()} ${ref}`
        }
      }
      return { tool: 'loop_list', input: {}, title: 'loops' }
    }
    default:
      return { tool: 'bash', input: { command: raw }, title: raw }
  }
}
