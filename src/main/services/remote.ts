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
 * State is a single active share (the "entire workspace" is shared through one
 * session at a time). `start` mints + connects, `stop` tears down + revokes, and
 * `remote:state` pushes keep the desktop dialog live.
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
import { MAX_FRAME_BYTES, parseFrame, type HostFrame } from './remote-protocol'

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
  sessionId: string
  socket: WebSocket | null
  guests: number
  phase: RemotePhase
  error?: string
  /** Abort handle for the in-flight remote turn, if any. */
  turnController: AbortController | null
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
    sessionId: share.sessionId,
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
 * Send the transcript snapshot, trimming the oldest messages until it fits the
 * relay's frame cap (a fresh phone still gets the recent, most relevant history).
 */
function sendSnapshot(sessionId: string): void {
  const sock = share?.socket
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  const messages = repo.listMessages(sessionId)
  for (let start = 0; start < messages.length; start += 1) {
    const slice = messages.slice(start)
    const raw = JSON.stringify({ t: 'snapshot', messages: slice })
    if (Buffer.byteLength(raw) <= MAX_FRAME_BYTES) {
      sock.send(raw)
      return
    }
    // A single trailing message that alone exceeds the cap: send a truncated
    // copy so the phone still gets a usable tail instead of an oversized (dropped) frame.
    if (slice.length === 1) {
      sock.send(JSON.stringify({ t: 'snapshot', messages: [truncateMessage(slice[0])] }))
      return
    }
  }
  // No messages yet — send an empty snapshot so the phone leaves its loading state.
  sock.send(JSON.stringify({ t: 'snapshot', messages: [] }))
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
  sendFrame({ t: 'meta', title: chat?.title, cwd: repo.getChatWorkspace(sessionId) ?? undefined })
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

async function handlePrompt(text: string): Promise<void> {
  const active = share
  if (!active || !text.trim()) return
  // Serialize turns: claim the slot synchronously so two quick prompts can't
  // start concurrent turns on the same session (mirrors the renderer's guard).
  if (active.turnController) {
    sendFrame({ t: 'error', message: 'A turn is already running — wait for it to finish.' })
    return
  }
  const controller = new AbortController()
  active.turnController = controller
  const sessionId = active.sessionId

  try {
    // Persist the user's message as if typed locally, then nudge the desktop.
    repo.addMessage({ chatId: sessionId, role: 'user', content: text })
    bumpFor(active)
    sendFrameFor(active, { t: 'turn', state: 'running' })

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

    const acc = new PartsAccumulator()

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
        sendFrameFor(active, { t: 'delta', event })
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
    if (active.turnController === controller) active.turnController = null
    sendFrameFor(active, { t: 'turn', state: 'idle' })
  }
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
      // A phone entered the PIN and paired — send it the current transcript.
      share.guests = typeof frame.guests === 'number' ? frame.guests : share.guests
      sendMeta(share.sessionId)
      sendSnapshot(share.sessionId)
      sendFrame({ t: 'turn', state: share.turnController ? 'running' : 'idle' })
      bump()
      break
    }
    case 'guest-left': {
      share.guests = typeof frame.guests === 'number' ? frame.guests : Math.max(0, share.guests - 1)
      bump()
      break
    }
    case 'prompt': {
      if (typeof frame.text === 'string') void handlePrompt(frame.text)
      break
    }
    case 'abort': {
      share.turnController?.abort()
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
  active.turnController?.abort()
  active.turnController = null
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
  const sessionId = input.sessionId
  if (!repo.getChat(sessionId)) {
    return { ...IDLE_STATE, phase: 'error', error: 'That session no longer exists.' }
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
    sessionId,
    socket: null,
    guests: 0,
    phase: 'starting',
    turnController: null,
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
