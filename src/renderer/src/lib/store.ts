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
  ReasoningEffort
} from '@shared/types'
import type {
  ChatMessage,
  CreateLoopInput,
  LlmEvent,
  ModelInfo,
  RemoteState,
  TaskUpdate
} from '@shared/api'
import { selectPromptName, buildEnvironment, assembleSystemPrompt } from '@shared/prompt'
import { PROMPT_TEXT, AGENT_PROMPT_TEXT } from '@shared/prompt-text'
import { reconstructTurn, REPLAY_OUTPUT_CAP } from '@shared/tool-history'
import { isOverflow, pruneToolMessages, KEEP_RECENT_TOKENS } from '@shared/context'
import { uniqueSlug } from '@shared/slugs'
import { api } from './api'
import type { ComposerImage } from './images'

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
  /** Active agent (mode) for the open session. */
  activeAgentId: string
  /** Project instruction blocks (AGENTS.md etc.) cached per workspace path. */
  projectInstructions: Record<string, string[]>
  loops: Loop[]
  /** Pending prompts queued on the active chat (FIFO). */
  queue: QueueItem[]
  /** Chats with a pending stop request, keyed by chat id. */
  stopChats: Record<string, boolean>
  /** Chats currently being compacted, keyed by chat id. */
  compactingChats: Record<string, boolean>
  /** Running background subagent tasks, keyed by parent session id (Phase 11). */
  runningTasks: Record<string, TaskUpdate[]>
  /** Remote Workspace sharing status — mirrors the main process's RemoteState. */
  remote: RemoteState

  bootstrap: () => Promise<void>
  refreshChats: () => Promise<void>
  refreshLoops: () => Promise<void>
  refreshQueue: () => Promise<void>
  refreshProviders: () => Promise<void>
  selectModel: (providerId: string, model: string) => Promise<void>
  ensureModels: (providerId: string) => Promise<void>
  setReasoningEffort: (level: ReasoningEffort) => Promise<void>
  setContextLimit: (limit: number | null) => Promise<void>
  setWebSearchApiKey: (key: string | null) => Promise<void>
  selectChat: (id: string) => Promise<void>
  clearActive: () => void
  newSession: () => Promise<void>
  newSessionInProject: (workspacePath: string) => Promise<void>
  createLoop: (input: CreateLoopInput) => Promise<void>
  setLoopEnabled: (id: string, enabled: boolean) => Promise<void>
  removeLoop: (id: string) => Promise<void>
  setActiveAgent: (id: string) => void
  /** Load + cache a workspace's instruction files (AGENTS.md etc.) for sizing. */
  ensureProjectInstructions: (workspacePath: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  renameChat: (id: string, title: string) => Promise<void>
  /** Persist a project's session order (optimistic). `ids` = full project list, top-to-bottom. */
  reorderSessions: (workspacePath: string | null, ids: string[]) => Promise<void>
  submit: (content: string, images?: ComposerImage[]) => Promise<void>
  sendMessage: (content: string, chatId?: string, images?: ComposerImage[]) => Promise<void>
  drainQueue: (chatId: string) => Promise<void>
  removeQueued: (id: string) => Promise<void>
  moveQueued: (id: string, direction: 'up' | 'down') => Promise<void>
  stop: () => void
  /** Start sharing the active session to a phone via the roxy.gg relay. */
  startRemote: () => Promise<void>
  /** Stop sharing + revoke the room/token (Stop sharing). */
  stopRemote: () => Promise<void>
  /** Sync the current sharing status from main (e.g. after a window reload). */
  refreshRemote: () => Promise<void>
  compactConversation: (chatId?: string) => Promise<void>
  /** Handle a background subagent task state change (Phase 11). */
  handleTaskUpdate: (update: TaskUpdate) => Promise<void>
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let loopTickSubscribed = false
let llmDeltaSubscribed = false
let taskUpdateSubscribed = false
let remoteStateSubscribed = false
/** Routes streamed completion events to the in-flight send for a request id. */
const deltaHandlers = new Map<string, (event: LlmEvent) => void>()
/** The active llm request id per chat, so stop() can abort the right stream. */
const chatRequests = new Map<string, string>()
/** Cross-render cache of models.dev lists so we fetch each provider once. */
const modelCatalogCache = new Map<string, ModelInfo[]>()
/** Set when a remote turn lands while a local send streams into the shared chat. */
const remoteMirror = { deferred: false }

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
  loops: [],
  queue: [],
  stopChats: {},
  compactingChats: {},
  runningTasks: {},
  remote: { phase: 'idle', guests: 0, rev: 0 },

  bootstrap: async () => {
    const [settings, providers, chats, loops] = await Promise.all([
      api.settings.getAll(),
      api.providers.listConnected(),
      api.chats.list(),
      api.loops.list()
    ])
    set({ settings, providers, chats, loops, ready: true })

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

    const firstSession = chats.find((c) => c.kind === 'main')
    if (!get().activeChatId && firstSession) {
      await get().selectChat(firstSession.id)
    }
  },

  refreshChats: async () => {
    set({ chats: await api.chats.list() })
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

  refreshRemote: async () => {
    try {
      set({ remote: await api.remote.status() })
    } catch {
      // Status is best-effort — keep the current state if main isn't ready.
    }
  },

  selectModel: async (providerId, model) => {
    const settings = await api.settings.setActiveProvider(providerId, model)
    set({ settings })
  },

  ensureModels: async (providerId) => {
    if (get().modelCatalog[providerId]) return
    const list = modelCatalogCache.get(providerId) ?? (await api.models.list(providerId))
    modelCatalogCache.set(providerId, list)
    set((s) => ({ modelCatalog: { ...s.modelCatalog, [providerId]: list } }))
  },

  setReasoningEffort: async (level) => {
    const settings = await api.settings.setReasoningEffort(level)
    set({ settings })
  },

  setContextLimit: async (limit) => {
    const settings = await api.settings.setContextLimit(limit)
    set({ settings })
  },

  setWebSearchApiKey: async (key) => {
    const settings = await api.settings.setWebSearchApiKey(key)
    set({ settings })
  },

  selectChat: async (id) => {
    // Per-chat send state survives switching — just swap which chat is shown.
    // Clear messages/queue first so the previous chat's content never flashes.
    set({ activeChatId: id, messages: [], queue: [], activeAgentId: DEFAULT_AGENT_ID })
    const workspace = get().chats.find((c) => c.id === id)?.workspacePath
    if (workspace) void get().ensureProjectInstructions(workspace)
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

  setActiveAgent: (id) => set({ activeAgentId: id }),

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
    const chat = await api.chats.create({ title: uniqueSlug(taken), workspacePath })
    await get().refreshChats()
    await get().selectChat(chat.id)
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
    const bySlot = [...ids]
    set((s) => {
      let k = 0
      const chats = s.chats.map((c) =>
        c.kind === 'main' && c.workspacePath === workspacePath && inProject.has(c.id)
          ? (s.chats.find((x) => x.id === bySlot[k++]) ?? c)
          : c
      )
      return { chats }
    })
    await api.chats.reorder(workspacePath, ids)
    await get().refreshChats()
  },

  submit: async (content, images) => {
    const chatId = get().activeChatId
    if (!chatId) return
    const text = content.trim()
    if (!text && (!images || images.length === 0)) return
    // This chat is busy → queue it (text + any images); otherwise send now.
    if (get().sendingChats[chatId]) {
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
    const provider =
      get().providers.find((p) => p.id === settings?.activeProviderId) ?? get().providers[0] ?? null
    if (provider && (provider.hasCredential || provider.auth === 'none')) {
      const model =
        settings?.activeModel ||
        provider.defaultModel ||
        (provider.id === 'github-copilot' ? 'gpt-4o' : 'gpt-4o-mini')
      // Resolve the model's capabilities (reasoning support + context window) so
      // we only send reasoning params when valid and cut history to the budget.
      await get().ensureModels(provider.id)
      const info = get().modelCatalog[provider.id]?.find((m) => m.id === model)
      const modelContext = info?.contextLimit ?? 128_000
      const contextBudget = Math.min(
        settings?.contextLimit ?? Math.min(modelContext, 200_000),
        modelContext
      )
      // Auto-compact before the window overflows the model's *real* budget:
      // trigger once used tokens pass contextBudget minus the larger of the
      // reserved reply size or a safety buffer (mirrors opencode's
      // `context - max(output, buffer)` rather than a flat 80%). Compaction
      // summarizes older turns; buildChatMessages then sends summary + recent.
      if (!get().compactingChats[chatId]) {
        const used = await estimateUsedTokens(chatId, model, get().activeAgentId)
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
        get().activeAgentId
      )
      // Build parts live from the agent's event stream: text grows the current
      // text part; each tool call adds a card that flips running→done/error.
      const callIndex = new Map<string, number>()
      deltaHandlers.set(requestId, (event) => {
        if (!chatExists()) return
        if (event.type === 'text') {
          const last = parts[parts.length - 1]
          if (last && last.type === 'text') {
            const text = last.text + event.delta
            parts = parts.map((p, i) => (i === parts.length - 1 ? { type: 'text', text } : p))
          } else {
            parts = [...parts, { type: 'text', text: event.delta }]
          }
        } else if (event.type === 'reasoning') {
          // The model's live thinking tokens — grow the current reasoning part so
          // the "Thinking…" block fills in instead of just spinning.
          const last = parts[parts.length - 1]
          if (last && last.type === 'reasoning') {
            const text = last.text + event.delta
            parts = parts.map((p, i) => (i === parts.length - 1 ? { type: 'reasoning', text } : p))
          } else {
            parts = [...parts, { type: 'reasoning', text: event.delta }]
          }
        } else if (event.type === 'tool-start') {
          callIndex.set(event.callId, parts.length)
          parts = [
            ...parts,
            {
              type: 'tool',
              tool: event.tool,
              state: 'running',
              title: event.title,
              callId: event.callId,
              input: event.input
            }
          ]
          // A `task` just spawned a subagent (its own `sub` session was created
          // in main) — surface it under the parent in the sidebar immediately.
          if (event.tool === 'task') void get().refreshChats()
        } else if (event.type === 'tool-delta') {
          const idx = callIndex.get(event.callId)
          if (idx !== undefined) {
            parts = parts.map((p, i) =>
              i === idx && p.type === 'tool' ? { ...p, output: (p.output ?? '') + event.chunk } : p
            )
          }
        } else if (event.type === 'tool-end') {
          const idx = callIndex.get(event.callId)
          if (idx !== undefined) {
            const ended = parts[idx]
            parts = parts.map((p, i) =>
              i === idx && p.type === 'tool'
                ? {
                    ...p,
                    state: event.ok ? 'done' : 'error',
                    output: event.output,
                    image: event.image,
                    diff: event.diff
                  }
                : p
            )
            // A loop_* tool just created/removed/toggled a loop — reflect it in
            // the sidebar right away instead of waiting for a manual refresh.
            if (event.ok && ended?.type === 'tool' && ended.tool.startsWith('loop_')) {
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
        agentId: get().activeAgentId,
        reasoning: info?.reasoning ?? false,
        reasoningEffort: settings?.reasoningEffort ?? 'high',
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
    const provider =
      providers.find((p) => p.id === settings?.activeProviderId) ?? providers[0] ?? null
    if (!provider || !(provider.hasCredential || provider.auth === 'none')) return
    const model =
      settings?.activeModel ||
      provider.defaultModel ||
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

/** Collapse a turn's parts into a plain-text preview for the `content` column. */
function partsToContent(parts: MessagePart[]): string {
  let text = ''
  let reasoning = ''
  let toolOutput = ''
  for (const part of parts) {
    if (part.type === 'text') text += part.text
    else if (part.type === 'reasoning') reasoning += part.text
    else if (part.type === 'tool' && part.output) toolOutput = part.output
  }
  return (text.trim() || reasoning.trim() || toolOutput).trim()
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
