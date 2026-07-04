/**
 * Remote Workspace — host side (desktop → roxy.gg relay).
 *
 * The desktop dials *out* to roxy.gg over a WebSocket and hosts the running
 * session for one or more phone **guests**. roxy.gg is a dumb pipe: it pairs a
 * guest (who entered the PIN) with this host and shuttles opaque JSON frames.
 * The desktop stays authoritative — a phone's prompt is run here through the
 * exact same `runSessionTurn` a local prompt uses, and every streamed event is
 * relayed back to the phone. Code and files never leave the machine.
 *
 * State is a single active share: the desktop mints one room and dials the relay
 * once, but the phone can roam the **entire workspace** — it lists every session
 * and switches between them freely, while the desktop's own active session stays
 * put. `start` mints + connects, `stop` tears down + revokes, and `remote:state`
 * pushes keep the desktop dialog live.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import WebSocket from 'ws'
import { CHANNELS } from '../../shared/ipc'
import type {
  ChatMessage,
  LlmEvent,
  ModelInfo,
  RemotePhase,
  RemoteState,
  RemoteStartInput
} from '../../shared/api'
import type { MessagePart, Message } from '../../shared/types'
import { reconstructTurn } from '../../shared/tool-history'
import { pruneToolMessages, KEEP_RECENT_TOKENS } from '../../shared/context'
import { DEFAULT_AGENT_ID } from '../../shared/agents'
import * as repo from '../db/repo'
import { listModels } from './models'
import { runSessionTurn } from './session-turn'
import { MAX_FRAME_BYTES, parseFrame, type HostFrame, type RemoteSessionInfo } from './remote-protocol'
/**
 * Relay base. Prod dials roxy.gg; a dev build defaults to the local roxy.gg
 * (localhost:3000). Override with `ROXY_REMOTE_BASE` (e.g. a staging URL).
 */
const HTTP_BASE = (
  process.env.ROXY_REMOTE_BASE || (is.dev ? 'http://localhost:3000' : 'https://roxy.gg')
).replace(/\/$/, '')

/** ws(s):// origin derived from the http(s):// base. */
const WS_BASE = HTTP_BASE.replace(/^http/, 'ws')

/** Reconnect backoff (ms) after an unexpected host-socket drop; then give up. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000]

/** Reserve for the system prompt (prepended inside runAgentTurn) in the window cut. */
const SYSTEM_RESERVE_TOKENS = 6_000

/** The mint response from `POST /api/remote/sessions`. */
interface MintResponse {
  brokerId: string
  hostToken: string
  guestToken: string
  url: string
  pin: string
  expiresAt: number
}

/** Everything about the one active share. */
interface Share {
  brokerId: string
  hostToken: string
  url: string
  pin: string
  expiresAt: number
  /** The session the phone is currently viewing + prompting (it can switch). */
  currentSessionId: string
  socket: WebSocket | null
  guests: number
  phase: RemotePhase
  error?: string
  /** Abort handles for in-flight remote turns, keyed by sessionId (one per session). */
  turns: Map<string, AbortController>
  /** Live parts accumulators for in-flight turns, so a guest that joins/switches
   *  mid-turn can be seeded with the reply-so-far (keyed by sessionId). */
  liveTurns: Map<string, PartsAccumulator>
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** True once we intentionally tear down, so `close` doesn't try to reconnect. */
  closing: boolean
  rev: number
}

let share: Share | null = null

// --- Public state ----------------------------------------------------------

const IDLE_STATE: RemoteState = { phase: 'idle', guests: 0, rev: 0 }

/** Project the internal share into the renderer-facing state. */
function toState(): RemoteState {
  if (!share) return { ...IDLE_STATE }
  return {
    phase: share.phase,
    brokerId: share.brokerId,
    url: share.url,
    pin: share.pin,
    sessionId: share.currentSessionId,
    guests: share.guests,
    expiresAt: share.expiresAt,
    error: share.error,
    rev: share.rev
  }
}

/** Push the current state to every open window (guarded against teardown). */
function broadcast(): void {
  const state = toState()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.remoteState, state)
  }
}

/** Bump the revision + push. Called on any status change or shared-session activity. */
function bump(patch?: Partial<Pick<Share, 'phase' | 'error' | 'guests' | 'expiresAt'>>): void {
  if (!share) return
  if (patch) Object.assign(share, patch)
  share.rev += 1
  broadcast()
}

// --- Frame helpers ---------------------------------------------------------

/** Send a host frame to the guests via the relay (dropped if oversized/closed). */
function sendFrame(frame: HostFrame): void {
  const sock = share?.socket
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  const raw = JSON.stringify(frame)
  if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) return
  sock.send(raw)
}

/**
 * Share-bound frame send: a no-op if `active` is no longer the current share
 * (stopped/replaced mid-turn), so a stale turn can't leak frames into a new one.
 */
function sendFrameFor(active: Share, frame: HostFrame): void {
  if (share === active) sendFrame(frame)
}

/** Share-bound bump: only bumps if `active` is still the current share. */
function bumpFor(active: Share): void {
  if (share === active) bump()
}

/**
 * Send the transcript snapshot for `sessionId`, trimming the oldest messages
 * until it fits the relay's frame cap (a fresh phone still gets the recent, most
 * relevant history). Tagged with `sessionId` so the phone can drop a snapshot
 * for a session it already switched away from.
 */
function sendSnapshot(sessionId: string): void {
  const sock = share?.socket
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  const messages = repo.listMessages(sessionId)
  for (let start = 0; start < messages.length; start += 1) {
    const slice = messages.slice(start)
    const raw = JSON.stringify({ t: 'snapshot', sessionId, messages: slice })
    if (Buffer.byteLength(raw) <= MAX_FRAME_BYTES) {
      sock.send(raw)
      return
    }
    // A single trailing message that alone exceeds the cap: send a truncated
    // copy so the phone still gets a usable tail instead of an oversized (dropped) frame.
    if (slice.length === 1) {
      sock.send(JSON.stringify({ t: 'snapshot', sessionId, messages: [truncateMessage(slice[0])] }))
      return
    }
  }
  // No messages yet — send an empty snapshot so the phone leaves its loading state.
  sock.send(JSON.stringify({ t: 'snapshot', sessionId, messages: [] }))
}

/** Shrink one message so a snapshot of just it fits under the frame cap. */
function truncateMessage(m: Message): Message {
  // The serialized message carries the text twice (content + parts[].text), so
  // each copy gets half the frame, minus headroom for the JSON envelope/fields.
  const budget = Math.floor(MAX_FRAME_BYTES / 2) - 8_192
  let content = m.content
  if (Buffer.byteLength(content) > budget) {
    content = content.slice(0, budget) // ≤ budget UTF-16 units; tighten by bytes below
    while (content.length > 0 && Buffer.byteLength(content) > budget) {
      content = content.slice(0, Math.floor(content.length * 0.9))
    }
    content += '\n\n… (truncated)'
  }
  return { ...m, content, parts: [{ type: 'text', text: content }] }
}

/** Session title + workspace dir for the phone header. */
function sendMeta(sessionId: string): void {
  const chat = repo.getChat(sessionId)
  sendFrame({
    t: 'meta',
    sessionId,
    title: chat?.title,
    cwd: repo.getChatWorkspace(sessionId) ?? undefined
  })
}

/**
 * Mirror a session's pending prompt queue to the phone(s). The queue is the same
 * persisted `repo` queue the desktop uses, so both ends see one FIFO. Sent on
 * join/switch and whenever the queue changes (phone/desktop enqueue, dequeue, or
 * drain). Text-only — no image blobs cross the wire.
 */
function sendQueue(sessionId: string): void {
  sendFrame({
    t: 'queue',
    sessionId,
    items: repo.listQueue(sessionId).map((q) => ({ id: q.id, text: q.content }))
  })
}

/** Folder basename used to group sessions on the phone (mirrors the desktop sidebar). */
function projectName(workspacePath: string | null): string {
  if (!workspacePath) return '(no folder)'
  return workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath
}

/**
 * Build the workspace's session list for the phone switcher: every top-level
 * (`main`) session, most-recently-updated first, grouped by project on the phone.
 */
function buildSessionList(): RemoteSessionInfo[] {
  return repo
    .listChats()
    .filter((c) => c.kind === 'main')
    .map((c) => ({
      id: c.id,
      title: c.title,
      project: projectName(c.workspacePath),
      cwd: c.workspacePath ?? undefined,
      updatedAt: c.updatedAt,
      messageCount: repo.listMessages(c.id).length
    }))
}

/** Push the workspace session list + the current selection to the phone(s). */
function sendSessions(): void {
  if (!share) return
  sendFrame({ t: 'sessions', sessions: buildSessionList(), currentId: share.currentSessionId })
}

/**
 * Push a session's current turn state to the phone(s). If a turn is in flight we
 * include its accumulated parts so a guest that just joined/switched sees the
 * whole reply-so-far, not only the tail of subsequent deltas.
 */
function sendTurnState(sessionId: string): void {
  if (!share) return
  const acc = share.liveTurns.get(sessionId)
  if (acc) sendFrame({ t: 'turn', sessionId, state: 'running', parts: acc.parts })
  else sendFrame({ t: 'turn', sessionId, state: 'idle' })
}

/**
 * Switch the phone(s) to a different session. Only the phone view moves — the
 * desktop's own active session is untouched. We re-emit the list (to update the
 * highlighted current), then meta + snapshot + the target's live turn state.
 */
function switchSession(sessionId: string): void {
  const active = share
  if (!active) return
  if (!repo.getChat(sessionId)) {
    sendFrame({ t: 'error', message: 'That session no longer exists.' })
    return
  }
  active.currentSessionId = sessionId
  sendSessions()
  sendMeta(sessionId)
  sendSnapshot(sessionId)
  sendTurnState(sessionId)
  sendQueue(sessionId)
  // Surface the phone's current session to the desktop dialog + mirror logic.
  bump()
}

// --- Turn assembly (mirrors the renderer's buildChatMessages) --------------

/**
 * Rebuild the chat-completion history for a session within the context budget —
 * the main-process twin of the renderer's `buildChatMessages`. The real system
 * prompt (and any compaction summary) is prepended inside `runAgentTurn`, so it's
 * only reserved for here, not materialized.
 */
function buildRemoteMessages(
  sessionId: string,
  contextBudget: number,
  outputReserve: number
): ChatMessage[] {
  const chat = repo.getChat(sessionId)
  const since = chat?.contextSummaryAt ?? 0
  // Group each persisted turn so the window cut can never split an assistant's
  // tool_calls from the matching role:'tool' results (which would 400 providers).
  const groups = repo
    .listMessages(sessionId)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.createdAt > since)
    .map(reconstructTurn)
    .filter((g) => g.length > 0)

  // Prune older tool outputs to a head/tail preview before the cut, then zip back
  // into groups so tool_calls stay paired with their results.
  const flatAll = groups.flat()
  const prunedFlat = pruneToolMessages(flatAll, { keepRecentTokens: KEEP_RECENT_TOKENS })
  let pk = 0
  const prunedGroups = groups.map((g) => g.map(() => prunedFlat[pk++]))

  const cap = Math.max(2000, contextBudget - outputReserve - SYSTEM_RESERVE_TOKENS)
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
  // Normalize the leading edge to a user message (Anthropic requires it and a
  // dangling assistant/tool would orphan a tool_use). The current prompt is at
  // the tail, so this only trims stale boundary turns.
  while (flat.length && flat[0].role !== 'user') flat.shift()
  return flat
}

/**
 * Fold a turn's streamed events into ordered message parts — the main-process
 * twin of the renderer's live parts builder — so the assistant reply can be
 * persisted (and thus show on the desktop + survive into the next turn).
 */
class PartsAccumulator {
  readonly parts: MessagePart[] = []
  private readonly callIndex = new Map<string, number>()

  apply(event: LlmEvent): void {
    if (event.type === 'text') {
      const last = this.parts[this.parts.length - 1]
      if (last && last.type === 'text') last.text += event.delta
      else this.parts.push({ type: 'text', text: event.delta })
    } else if (event.type === 'reasoning') {
      const last = this.parts[this.parts.length - 1]
      if (last && last.type === 'reasoning') last.text += event.delta
      else this.parts.push({ type: 'reasoning', text: event.delta })
    } else if (event.type === 'tool-start') {
      this.callIndex.set(event.callId, this.parts.length)
      this.parts.push({
        type: 'tool',
        tool: event.tool,
        state: 'running',
        title: event.title,
        callId: event.callId,
        input: event.input
      })
    } else if (event.type === 'tool-delta') {
      const idx = this.callIndex.get(event.callId)
      const part = idx !== undefined ? this.parts[idx] : undefined
      if (part?.type === 'tool') part.output = (part.output ?? '') + event.chunk
    } else if (event.type === 'tool-end') {
      const idx = this.callIndex.get(event.callId)
      const part = idx !== undefined ? this.parts[idx] : undefined
      if (part?.type === 'tool') {
        part.state = event.ok ? 'done' : 'error'
        part.output = event.output
        part.image = event.image
        part.diff = event.diff
      }
    }
  }
}

/** Collapse parts into a plain-text preview for the message `content` column. */
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

// --- The crux: run a guest's prompt exactly like a local one ---------------

/**
 * Handle a prompt typed on the phone. Mirrors the desktop's `submit`: if a turn
 * is already running for this session — or prompts are already queued — append
 * it to the shared FIFO instead of starting a second turn. Otherwise run it now.
 * The queue is the same persisted `repo` queue the desktop uses, so the pending
 * list stays identical on both ends.
 */
async function handlePrompt(sessionId: string, text: string): Promise<void> {
  const active = share
  if (!active || !text.trim()) return
  if (!repo.getChat(sessionId)) {
    sendFrame({ t: 'error', message: 'That session no longer exists.' })
    return
  }
  // A turn is already running for this session → queue it (FIFO), mirror the
  // updated queue to the phone(s), and nudge the desktop so its queue view
  // refreshes too. Draining happens automatically when the current turn ends.
  // (Matches the desktop's single gate: queue only while a turn is in flight.)
  if (active.turns.has(sessionId)) {
    repo.enqueue(sessionId, text.trim())
    sendQueue(sessionId)
    bumpFor(active)
    return
  }
  await runTurn(active, sessionId, text.trim(), false)
}

/**
 * Run one turn for a guest's prompt, exactly like a local one, then drain the
 * next queued prompt (if any). Called by `handlePrompt` for a fresh prompt and
 * by `drainRemoteQueue` for each dequeued one — neither re-checks the busy guard,
 * so a drained prompt actually runs rather than re-queuing behind itself.
 *
 * `announce` is true for a drained queue item: the phone never echoed it (it only
 * had it in the pending list), so the host sends the user text on `turn:running`
 * for the phone to show its bubble. A direct phone send echoes locally, so it's
 * false there to avoid a double bubble.
 */
async function runTurn(active: Share, sessionId: string, text: string, announce: boolean): Promise<void> {
  // Serialize turns *per session*: claim the slot synchronously so two quick
  // prompts can't start concurrent turns on the same session (mirrors the
  // renderer's guard). Different sessions can still run independently.
  if (active.turns.has(sessionId)) {
    // A turn slipped in first — fall back to queuing so nothing is lost.
    repo.enqueue(sessionId, text)
    sendQueue(sessionId)
    bumpFor(active)
    return
  }
  const controller = new AbortController()
  active.turns.set(sessionId, controller)
  // Register the live accumulator up-front so a guest that joins/switches during
  // this turn (even mid provider-resolution) is seeded with the reply-so-far.
  const acc = new PartsAccumulator()
  active.liveTurns.set(sessionId, acc)

  try {
    // Persist the user's message as if typed locally, then nudge the desktop.
    repo.addMessage({ chatId: sessionId, role: 'user', content: text })
    bumpFor(active)
    // Announce the prompt text for a drained queue item so the phone shows its
    // bubble (a direct send already echoed it locally). `sendQueue` above already
    // removed it from the pending list, so it moves cleanly from queue → turn.
    sendFrameFor(active, { t: 'turn', sessionId, state: 'running', userText: announce ? text : undefined })

    // Reproduce the renderer's provider/model/budget resolution in the main process.
    const settings = repo.getSettings()
    const providers = repo.listConnectedProviders()
    const provider =
      providers.find((p) => p.id === settings.activeProviderId) ?? providers[0] ?? null
    if (!provider) {
      sendFrameFor(active, { t: 'error', message: 'No provider is connected on the desktop.' })
      return
    }
    const model =
      settings.activeModel ||
      provider.defaultModel ||
      (provider.id === 'github-copilot' ? 'gpt-4o' : 'gpt-4o-mini')
    let info: ModelInfo | undefined
    try {
      info = (await listModels(provider.id)).find((m) => m.id === model)
    } catch {
      // Offline model catalog — fall back to conservative defaults below.
    }
    const modelContext = info?.contextLimit ?? 128_000
    const contextBudget = Math.min(
      settings.contextLimit ?? Math.min(modelContext, 200_000),
      modelContext
    )
    const messages = buildRemoteMessages(sessionId, contextBudget, info?.outputLimit ?? 4096)

    const result = await runSessionTurn(
      {
        requestId: randomUUID(),
        sessionId,
        providerId: provider.id,
        model,
        messages,
        agentId: DEFAULT_AGENT_ID,
        reasoning: info?.reasoning ?? false,
        reasoningEffort: settings.reasoningEffort ?? 'high',
        contextLimit: contextBudget
      },
      (event) => {
        acc.apply(event)
        sendFrameFor(active, { t: 'delta', sessionId, event })
      },
      controller.signal
    )

    // Persist the assistant reply (mirrors the renderer's post-stream persistence)
    // so the desktop transcript updates and the next turn keeps the context.
    const parts = acc.parts
    if (!result.ok && !controller.signal.aborted) {
      parts.push({ type: 'text', text: `_\u26a0 ${result.error ?? 'Model request failed.'}_` })
    }
    if (parts.length) {
      repo.addMessage({ chatId: sessionId, role: 'assistant', content: partsToContent(parts), parts })
    }
    bumpFor(active)
  } finally {
    // Always release the turn slot (even on an unexpected throw) so future
    // prompts aren't permanently rejected; only clear if we still own it.
    if (active.turns.get(sessionId) === controller) active.turns.delete(sessionId)
    if (active.liveTurns.get(sessionId) === acc) active.liveTurns.delete(sessionId)
    sendFrameFor(active, { t: 'turn', sessionId, state: 'idle' })
    // A turn stopped by the user shouldn't auto-run the backlog — a phone abort
    // leaves the queued prompts in place (the phone can drain them with a fresh
    // send, mirroring the desktop's Stop). Otherwise drain the next queued prompt.
    if (!controller.signal.aborted) void drainRemoteQueue(active, sessionId)
  }
}

/**
 * Run the next pending prompt for a session, chaining until the queue is empty.
 * Each dequeued prompt runs through `runTurn`, which drains again when it ends —
 * so the whole backlog streams to the phone one turn at a time. A no-op if the
 * share was replaced, a turn is already running, or the queue is empty.
 */
async function drainRemoteQueue(active: Share, sessionId: string): Promise<void> {
  if (share !== active || active.turns.has(sessionId)) return
  const items = repo.listQueue(sessionId)
  if (items.length === 0) {
    sendQueue(sessionId)
    return
  }
  const next = items[0]
  repo.removeQueueItem(next.id)
  sendQueue(sessionId)
  bumpFor(active)
  await runTurn(active, sessionId, next.content, true)
}

/**
 * Re-broadcast the shared queue to the phone(s) after a *desktop-side* change
 * (the renderer added/removed/reordered a queued prompt). Called from the queue
 * IPC handlers so both ends stay in sync regardless of who edited the queue.
 */
export function notifyQueueChanged(): void {
  if (share) sendQueue(share.currentSessionId)
}

// --- Socket lifecycle ------------------------------------------------------

function connect(): void {
  const active = share
  if (!active) return
  const socket = new WebSocket(`${WS_BASE}/api/remote/ws?token=${encodeURIComponent(active.hostToken)}`)
  active.socket = socket

  socket.on('open', () => {
    if (share !== active) return
    active.reconnectAttempts = 0
    bump({ phase: 'live', error: undefined })
    // Sync the authoritative guest count / expiry from the relay after (re)connect.
    void refreshStatus()
  })

  socket.on('message', (data: WebSocket.RawData) => {
    if (share !== active) return
    onFrame(data.toString())
  })

  socket.on('close', () => {
    if (share !== active) return
    active.socket = null
    if (active.closing) return
    scheduleReconnect()
  })

  // Swallow socket errors — a following `close` drives reconnect/teardown.
  socket.on('error', () => undefined)
}

function scheduleReconnect(): void {
  const active = share
  if (!active || active.closing) return
  const delay = RECONNECT_DELAYS_MS[active.reconnectAttempts]
  if (delay === undefined) {
    bump({ phase: 'error', error: 'Lost connection to the relay.' })
    return
  }
  active.reconnectAttempts += 1
  bump({ phase: 'offline' })
  active.reconnectTimer = setTimeout(() => {
    if (share === active && !active.closing) connect()
  }, delay)
}

function onFrame(raw: string): void {
  const frame = parseFrame(raw)
  if (!frame || typeof frame.t !== 'string' || !share) return
  switch (frame.t) {
    case 'guest-joined': {
      // A phone entered the PIN and paired — send it the workspace session list
      // plus the current session's transcript + live turn state.
      share.guests = typeof frame.guests === 'number' ? frame.guests : share.guests
      const current = share.currentSessionId
      sendSessions()
      sendMeta(current)
      sendSnapshot(current)
      sendTurnState(current)
      sendQueue(current)
      bump()
      break
    }
    case 'guest-left': {
      share.guests = typeof frame.guests === 'number' ? frame.guests : Math.max(0, share.guests - 1)
      bump()
      break
    }
    case 'list': {
      // Phone asked for a fresh workspace session list (opened the switcher).
      sendSessions()
      break
    }
    case 'switch': {
      // Phone tapped a different session in the switcher.
      if (typeof frame.sessionId === 'string') switchSession(frame.sessionId)
      break
    }
    case 'prompt': {
      // Prompts run against whatever session the phone is currently viewing.
      if (typeof frame.text === 'string') void handlePrompt(share.currentSessionId, frame.text)
      break
    }
    case 'abort': {
      share.turns.get(share.currentSessionId)?.abort()
      break
    }
    case 'dequeue': {
      // Phone tapped × on a queued prompt — drop it from the shared queue and
      // re-broadcast so both ends update. `bump` refreshes the desktop's view.
      if (typeof frame.id === 'string') {
        repo.removeQueueItem(frame.id)
        sendQueue(share.currentSessionId)
        bump()
      }
      break
    }
    case 'bye': {
      // The relay tore the room down (expiry, PIN lockout, or capacity). Keep
      // the share in a terminal `error` phase so the dialog can explain why;
      // Start/Stop clears it.
      const reason = typeof frame.reason === 'string' ? frame.reason : 'Session ended.'
      teardown()
      bump({ phase: 'error', error: reason })
      break
    }
    default:
      break
  }
}

async function refreshStatus(): Promise<void> {
  const active = share
  if (!active) return
  try {
    const res = await fetch(`${HTTP_BASE}/api/remote/sessions/${active.brokerId}`)
    if (!res.ok) return
    const status = (await res.json()) as { guests?: number; expiresAt?: number }
    if (share !== active) return
    if (typeof status.guests === 'number') active.guests = status.guests
    if (typeof status.expiresAt === 'number') active.expiresAt = status.expiresAt
    broadcast()
  } catch {
    // Best-effort — deltas/counts still flow over the socket.
  }
}

/** Close the socket + clear timers for the active share (no server revoke). */
function teardown(): void {
  const active = share
  if (!active) return
  active.closing = true
  if (active.reconnectTimer) {
    clearTimeout(active.reconnectTimer)
    active.reconnectTimer = null
  }
  for (const controller of active.turns.values()) controller.abort()
  active.turns.clear()
  active.liveTurns.clear()
  const sock = active.socket
  active.socket = null
  if (sock) {
    sock.removeAllListeners()
    // `ws` can still emit 'error' while closing (esp. a CONNECTING socket); keep
    // a no-op handler attached so Node doesn't throw on an unhandled 'error'.
    sock.on('error', () => undefined)
    try {
      sock.close()
    } catch {
      sock.terminate()
    }
  }
}

/** Revoke the room on roxy.gg (host-token gated; idempotent). Best-effort. */
async function revoke(brokerId: string, hostToken: string): Promise<void> {
  try {
    await fetch(`${HTTP_BASE}/api/remote/sessions/${brokerId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${hostToken}` }
    })
  } catch {
    // The relay also reaps the room when the host socket drops + on TTL expiry.
  }
}

// --- Public API (called from IPC handlers) ---------------------------------

/**
 * Serialize lifecycle ops (start/stop) through a single chain so a double-click
 * or reentrant IPC can't mint two rooms and leak an orphan host socket.
 */
let lifecycle: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn)
  lifecycle = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Mint a room + open the host relay socket for a session. Returns the state. */
export function start(input: RemoteStartInput): Promise<RemoteState> {
  return enqueue(() => startInternal(input))
}

/** Tear down the active share + revoke its tokens (Stop sharing). Idempotent. */
export function stop(): Promise<RemoteState> {
  return enqueue(() => stopInternal())
}

async function startInternal(input: RemoteStartInput): Promise<RemoteState> {
  // Seed the phone's initial session with the desktop's active chat; if that's
  // gone (or none was passed), fall back to the most-recently-updated session so
  // the phone always opens onto something real and can switch from there.
  let sessionId = input.sessionId
  if (!sessionId || !repo.getChat(sessionId)) {
    const fallback = repo.listChats().find((c) => c.kind === 'main')
    if (!fallback) {
      return { ...IDLE_STATE, phase: 'error', error: 'Open a session first, then share your workspace.' }
    }
    sessionId = fallback.id
  }
  // Only one active share — stop any previous one first (internal, already serialized).
  if (share) await stopInternal()

  let mint: MintResponse
  try {
    const res = await fetch(`${HTTP_BASE}/api/remote/sessions`, { method: 'POST' })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(detail || `relay responded ${res.status}`)
    }
    mint = (await res.json()) as MintResponse
  } catch (e) {
    return {
      ...IDLE_STATE,
      phase: 'error',
      error: `Couldn't start sharing: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  share = {
    brokerId: mint.brokerId,
    hostToken: mint.hostToken,
    url: mint.url,
    pin: mint.pin,
    expiresAt: mint.expiresAt,
    currentSessionId: sessionId,
    socket: null,
    guests: 0,
    phase: 'starting',
    turns: new Map(),
    liveTurns: new Map(),
    reconnectAttempts: 0,
    reconnectTimer: null,
    closing: false,
    rev: 1
  }
  connect()
  broadcast()
  return toState()
}

async function stopInternal(): Promise<RemoteState> {
  const active = share
  if (!active) return { ...IDLE_STATE }
  const { brokerId, hostToken } = active
  teardown()
  share = null
  broadcast()
  await revoke(brokerId, hostToken)
  return { ...IDLE_STATE }
}

/** Current sharing status. */
export function status(): RemoteState {
  return toState()
}

/** Close the host socket on app quit (best-effort; the relay reaps on drop). */
export function shutdownRemote(): void {
  teardown()
  share = null
}
