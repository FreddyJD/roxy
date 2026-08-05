/**
 * Anonymous usage tracking.
 *
 * WHAT IT SENDS: a random UUID minted once at install, an event name, and the
 * coarse build facts (platform, arch, app version, stable/dev). No account, no
 * IP, no file paths, no prompt text, no model or provider, no repo names. The
 * server HMACs the id before storing it, so a row can't be mapped back to the
 * id this client holds.
 *
 * WHY IT'S SHAPED LIKE THIS:
 *  - **Never blocks the app.** Every call is fire-and-forget and every failure
 *    is swallowed. Analytics must not be able to break, slow, or crash a launch.
 *  - **Queued and batched.** Events accumulate and flush on a timer, so a user
 *    on a plane doesn't lose their session and we don't make one HTTP request
 *    per action.
 *  - **Idempotent.** Each event carries a `clientId`; the server dedupes on it,
 *    so re-sending a failed batch can't inflate the numbers.
 *  - **Opt-out is real.** `setTrackingEnabled(false)` stops collection *and*
 *    drops anything already queued.
 *
 * The install id and the opt-out live in their own JSON file, NOT in the
 * settings table: a factory reset (`repo.resetAll`) wipes settings, and someone
 * who opted out must stay opted out across one. It also means tracking has no
 * dependency on the database being open or mid-migration.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** Production ingest endpoint. Read per-request so tests can point it at a stub. */
function endpoint(): string {
  return process.env.ROXY_TRACK_ENDPOINT || 'https://roxy.gg/track'
}

/** Events the server accepts. Anything else is dropped server-side. */
export type TrackEvent =
  /** App launched. The DAU heartbeat — sent exactly once per process start. */
  | 'app_open'
  /** A turn was submitted to the agent. The "real usage" signal. */
  | 'prompt'
  /** An agent turn finished. Carries `{ ok, durationMs }`. */
  | 'turn_end'
  /** Keeps a long-running session counted as active on later days. */
  | 'heartbeat'
  /** Remote Workspace paired with a phone. */
  | 'remote_pair'
  /** The app updated itself (first launch on a new version). */
  | 'update'
  /** Clean shutdown. */
  | 'app_close'

/** Only scalars — the server rejects nested objects and arrays anyway. */
type Props = Record<string, string | number | boolean>

interface QueuedEvent {
  name: TrackEvent
  clientId: string
  ts: number
  props?: Props
}

interface StoredState {
  deviceId?: string
  enabled?: boolean
  /** Last version that reported an `app_open`, so we can detect an update. */
  appVersion?: string
}

const FLUSH_INTERVAL_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 30 * 60_000
/** The server caps a batch at 50; stay under it. */
const MAX_QUEUE = 40
const REQUEST_TIMEOUT_MS = 8_000

let queue: QueuedEvent[] = []
let deviceId: string | null = null
let enabled = true
let flushTimer: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
/** `ROXY_TRACK_DISABLE=1` — a hard machine-level kill the toggle can't undo. */
let forcedOff = false

/** Where the install id lives. Persisting it is what makes retention possible. */
function stateFilePath(): string {
  return join(app.getPath('userData'), 'install-id.json')
}

function readState(): StoredState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFilePath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as StoredState
  } catch {
    /* first run, or unreadable — treat as empty */
  }
  return {}
}

/** Best-effort persist. A read-only profile must not break anything. */
function writeState(next: StoredState): void {
  try {
    writeFileSync(stateFilePath(), JSON.stringify(next), 'utf8')
  } catch {
    /* non-fatal — the id just won't survive this launch */
  }
}

/** Turn tracking on/off and persist the choice. Wired to the Settings toggle. */
export function setTrackingEnabled(next: boolean): boolean {
  if (forcedOff) return false
  if (next === enabled) return enabled
  enabled = next

  if (!next) {
    // Opting out has to be immediate: drop the queue, stop the timers, and let
    // go of the id in memory. Nothing further is collected or sent.
    queue = []
    stopTimers()
    persist()
    deviceId = null
    return enabled
  }

  // Opting back in. Reuse the stored id if there is one so this doesn't look
  // like a brand-new install, and mint one otherwise.
  const state = readState()
  deviceId =
    typeof state.deviceId === 'string' && state.deviceId.length >= 8 ? state.deviceId : randomUUID()
  persist()
  startTimers()
  return enabled
}

/** Write the current id + opt-out, keeping whatever else is in the file. */
function persist(): void {
  const state = readState()
  writeState({ ...state, deviceId: deviceId ?? state.deviceId, enabled })
}

export function isTrackingEnabled(): boolean {
  return enabled
}

/**
 * Record an event. Cheap, synchronous, and safe to call from anywhere — it only
 * appends to an in-memory queue.
 */
export function track(name: TrackEvent, props?: Props): void {
  if (!enabled || !deviceId) return
  if (queue.length >= MAX_QUEUE) return // shed rather than grow without bound
  queue.push({ name, clientId: randomUUID(), ts: Date.now(), props })
}

/**
 * Send whatever is queued.
 *
 * On failure the batch goes BACK on the queue: each event keeps its original
 * `clientId`, so the server dedupes the retry and the counts stay honest.
 */
export async function flush(): Promise<void> {
  if (!enabled || !deviceId || queue.length === 0) return

  const batch = queue
  queue = []

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        platform: process.platform,
        arch: process.arch,
        appVersion: app.getVersion(),
        channel: app.isPackaged ? 'stable' : 'dev',
        events: batch
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    // 4xx means we sent something malformed — retrying won't fix it, so drop
    // the batch instead of looping forever. 5xx and network errors are worth a
    // retry, since the events are idempotent.
    if (!res.ok && res.status >= 500) throw new Error(`status ${res.status}`)
  } catch {
    // Requeue, oldest first, without letting the backlog grow unbounded.
    queue = [...batch, ...queue].slice(0, MAX_QUEUE)
  }
}

/**
 * Call once from the main process after `app.whenReady()`.
 *
 * Set `ROXY_TRACK_DISABLE=1` to opt a whole machine out without touching the
 * stored preference — handy for CI, smoke runs, and contributors who don't want
 * their dev builds counted.
 */
export function initTracking(): void {
  if (process.env.ROXY_TRACK_DISABLE === '1') {
    forcedOff = true
    enabled = false
    return
  }

  const state = readState()
  if (state.enabled === false) enabled = false
  // Someone who opted out gets no id at all — not a stored one we promise never
  // to send. There is nothing to leak if it was never generated.
  if (!enabled) return

  const existing =
    typeof state.deviceId === 'string' && state.deviceId.length >= 8 ? state.deviceId : null
  deviceId = existing ?? randomUUID()

  const version = app.getVersion()
  // A different version than last launch means an update landed and restarted
  // into this build. Only meaningful once we've seen a previous launch — a
  // fresh install is an install, not an update.
  const updated = Boolean(state.appVersion) && state.appVersion !== version
  if (!existing || state.appVersion !== version) {
    writeState({ ...state, deviceId, enabled, appVersion: version })
  }

  // The DAU heartbeat.
  track('app_open')
  if (updated) track('update')
  void flush()

  startTimers()
}

/** Idempotent: start the flush + heartbeat timers if they aren't already up. */
function startTimers(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
  // Someone who leaves Roxy open for days is active on every one of those days.
  heartbeatTimer = setInterval(() => track('heartbeat'), HEARTBEAT_INTERVAL_MS)
  // Don't hold the event loop open on quit.
  flushTimer.unref?.()
  heartbeatTimer.unref?.()
}

function stopTimers(): void {
  if (flushTimer) clearInterval(flushTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  flushTimer = null
  heartbeatTimer = null
}

/**
 * Stop the timers and make a last attempt to drain the queue. Called from the
 * app's quit path; the flush is genuinely best-effort, since Electron won't
 * wait on a promise there.
 */
export function shutdownTracking(): void {
  stopTimers()
  track('app_close')
  void flush()
}

/** Test-only: drop all module state so each case starts from a known point. */
export function _resetTracking(): void {
  stopTimers()
  queue = []
  deviceId = null
  enabled = true
  forcedOff = false
}

/** Test-only: how many events are waiting to be sent. */
export function _queueDepth(): number {
  return queue.length
}
