import { create } from 'zustand'
import { DEFAULT_AGENT_ID } from '@shared/agents'
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
import type { ChatMessage, CreateLoopInput, LlmEvent, ModelInfo } from '@shared/api'
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
  loops: Loop[]
  /** Pending prompts queued on the active chat (FIFO). */
  queue: QueueItem[]
  /** Chats with a pending stop request, keyed by chat id. */
  stopChats: Record<string, boolean>
  /** Chats currently being compacted, keyed by chat id. */
  compactingChats: Record<string, boolean>

  bootstrap: () => Promise<void>
  refreshChats: () => Promise<void>
  refreshLoops: () => Promise<void>
  refreshQueue: () => Promise<void>
  refreshProviders: () => Promise<void>
  selectModel: (providerId: string, model: string) => Promise<void>
  ensureModels: (providerId: string) => Promise<void>
  setReasoningEffort: (level: ReasoningEffort) => Promise<void>
  setContextLimit: (limit: number | null) => Promise<void>
  selectChat: (id: string) => Promise<void>
  clearActive: () => void
  newSession: () => Promise<void>
  newSessionInProject: (workspacePath: string) => Promise<void>
  createLoop: (input: CreateLoopInput) => Promise<void>
  setLoopEnabled: (id: string, enabled: boolean) => Promise<void>
  removeLoop: (id: string) => Promise<void>
  setActiveAgent: (id: string) => void
  deleteChat: (id: string) => Promise<void>
  renameChat: (id: string, title: string) => Promise<void>
  submit: (content: string, images?: ComposerImage[]) => Promise<void>
  sendMessage: (content: string, chatId?: string, images?: ComposerImage[]) => Promise<void>
  drainQueue: (chatId: string) => Promise<void>
  removeQueued: (id: string) => Promise<void>
  moveQueued: (id: string, direction: 'up' | 'down') => Promise<void>
  stop: () => void
  compactConversation: (chatId?: string) => Promise<void>
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let loopTickSubscribed = false
let llmDeltaSubscribed = false
/** Routes streamed completion events to the in-flight send for a request id. */
const deltaHandlers = new Map<string, (event: LlmEvent) => void>()
/** The active llm request id per chat, so stop() can abort the right stream. */
const chatRequests = new Map<string, string>()
/** Cross-render cache of models.dev lists so we fetch each provider once. */
const modelCatalogCache = new Map<string, ModelInfo[]>()

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
  loops: [],
  queue: [],
  stopChats: {},
  compactingChats: {},

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

  selectChat: async (id) => {
    // Per-chat send state survives switching — just swap which chat is shown.
    // Clear messages/queue first so the previous chat's content never flashes.
    set({ activeChatId: id, messages: [], queue: [], activeAgentId: DEFAULT_AGENT_ID })
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

  newSession: async () => {
    const path = await api.dialog.openWorkspace()
    if (!path) return
    await get().newSessionInProject(path)
  },

  newSessionInProject: async (workspacePath) => {
    // A project is its workspace folder; sessions under it are numbered.
    const count = get().chats.filter(
      (c) => c.kind === 'main' && c.workspacePath === workspacePath
    ).length
    const chat = await api.chats.create({ title: `Session ${count + 1}`, workspacePath })
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
      get().providers.find((p) => p.id === settings?.activeProviderId) ??
      get().providers[0] ??
      null
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
      // Auto-compact when the window is ~80% full so there's always headroom for
      // this turn (depends on context size). Compaction summarizes the older
      // turns; buildChatMessages then sends just the summary + recent messages.
      if (!get().compactingChats[chatId]) {
        const used = await estimateUsedTokens(chatId)
        if (used > contextBudget * 0.8) await get().compactConversation(chatId)
      }
      const requestId = crypto.randomUUID()
      const chatMessages = await buildChatMessages(chatId, contextBudget, info?.outputLimit ?? 4096)
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
          parts = [...parts, { type: 'tool', tool: event.tool, state: 'running', title: event.title }]
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
                    type: 'tool',
                    tool: p.tool,
                    title: p.title,
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
        reasoning: info?.reasoning ?? false,
        reasoningEffort: settings?.reasoningEffort ?? 'high',
        contextLimit: contextBudget
      })
      deltaHandlers.delete(requestId)
      chatRequests.delete(chatId)
      if (!result.ok && !stopped()) {
        parts = [...parts, { type: 'text', text: `_\u26a0 ${result.error ?? 'Model request failed.'}_` }]
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
  }
}))

/** The agentic system prompt for a chat (incl. workspace + any compaction summary). */
export function buildSystemPrompt(chat: Chat | undefined): string {
  const system: string[] = [
    'You are Roxy, an autonomous AI coding agent running inside a desktop app.',
    'You have tools to read, write, and edit files, run shell commands (bash), search the workspace (list/glob/grep), and drive a browser.',
    'When the user asks you to build, create, fix, or change something, USE THE TOOLS to actually do it — create the files and run the commands yourself. Do not just describe the steps; perform them, then give a short summary of what you did.',
    'For large, parallelizable, or research-heavy work, delegate focused sub-tasks to subagents with the `task` tool — `subagent_type: "general"` for full multi-step work, or `"explore"` for read-only search. Each subagent starts blank, so give it all the context it needs; then build on the report it returns. Spin up several when work splits cleanly (e.g. one page or area each).'
  ]
  if (chat?.workspacePath) {
    system.push(`The workspace folder is ${chat.workspacePath}. Tool paths are relative to it.`)
  }
  if (chat?.contextSummary) {
    system.push(
      `Summary of the earlier conversation (compacted to save context):\n${chat.contextSummary}`
    )
  }
  return system.join('\n\n')
}

/** Build chat-completion messages: an agentic system prompt + workspace + history. */
async function buildChatMessages(
  chatId: string,
  contextBudget = 128_000,
  outputReserve = 4096
): Promise<ChatMessage[]> {
  const chat = useRoxyStore.getState().chats.find((c) => c.id === chatId)
  const systemText = buildSystemPrompt(chat)
  const since = chat?.contextSummaryAt ?? 0
  const all = (await api.messages.list(chatId))
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.createdAt > since)
    .map((m) => {
      const content = m.parts
        .map((p) =>
          p.type === 'tool'
            ? p.output
              ? `\`\`\`\n${p.output}\n\`\`\``
              : ''
            : p.type === 'image' || p.type === 'reasoning'
              ? ''
              : p.text
        )
        .join('')
        .trim()
      const images = m.parts
        .filter((p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image')
        .map((p) => ({ dataUrl: p.dataUrl, mediaType: p.mediaType }))
      return {
        role: m.role as 'user' | 'assistant',
        content,
        ...(images.length ? { images } : {})
      }
    })
    .filter((m) => m.content.length > 0 || (m.images && m.images.length > 0))

  // The "window cut": keep the most recent turns whose estimated tokens fit the
  // chosen context budget, reserving room for the system prompt + model output
  // (~4 chars/token; images counted at a flat ~800 tokens each).
  const cap = Math.max(2000, contextBudget - outputReserve - Math.ceil(systemText.length / 4))
  const estimate = (m: { content: string; images?: { dataUrl: string }[] }): number =>
    Math.ceil(m.content.length / 4) + (m.images?.length ?? 0) * 800
  const kept: typeof all = []
  let used = 0
  for (let i = all.length - 1; i >= 0; i--) {
    const tokens = estimate(all[i])
    if (used + tokens > cap && kept.length > 0) break
    kept.unshift(all[i])
    used += tokens
  }
  return [{ role: 'system', content: systemText }, ...kept]
}

/** Rough estimate of tokens currently in a chat's live window (post-compaction). */
async function estimateUsedTokens(chatId: string): Promise<number> {
  const chat = useRoxyStore.getState().chats.find((c) => c.id === chatId)
  const since = chat?.contextSummaryAt ?? 0
  const msgs = (await api.messages.list(chatId)).filter((m) => m.createdAt > since)
  let chars = buildSystemPrompt(chat).length
  let images = 0
  for (const m of msgs)
    for (const p of m.parts) {
      if (p.type === 'tool') chars += (p.output ?? '').length
      else if (p.type === 'image') images += 1
      else chars += p.text.length
    }
  return Math.ceil(chars / 4) + images * 800
}

function buildPlaceholderReply(
  prompt: string,
  providers: ConnectedProvider[],
  settings: AppSettings | null
): string {
  const active =
    providers.find((p) => p.id === settings?.activeProviderId) ?? providers[0] ?? null
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
      return { tool: 'browser_read', input: arg ? { selector: arg } : {}, title: arg || 'page HTML' }
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
