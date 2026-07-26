/**
 * Live transcripts for running subagent (`sub`) sessions.
 *
 * A subagent's steps used to exist in exactly two places: forwarded into the
 * PARENT turn's stream as `tool-child` events (which is why the launching
 * session shows the delegate working live), and persisted to the sub session's
 * own row — once, at the very end. Opening the sub session mid-run therefore
 * showed nothing but the seeded prompt: no streamed event ever carried the sub
 * session's id, so the renderer had nothing to key a live bubble on.
 *
 * This registry is the missing half. Each run registers here, folds its own
 * events into its own `PartsFold`, and broadcasts them tagged with the SUB
 * session id. Two consumers, one source:
 *
 *   - `subagent:delta` — the live feed, for a window already on that session.
 *   - `subagent:snapshot` — the catch-up read, for a window that opens the
 *     session halfway through a run. Without it a late viewer would see only
 *     the tail of the transcript.
 *
 * The parent's `tool-child` forwarding is untouched and still authoritative for
 * the `task` card; this is a second tap on the same event stream, not a
 * replacement. Keeping them separate is deliberate: the parent card is a capped
 * *summary* (see CHILD_OUTPUT_CAP), while the sub session is the full-fidelity
 * view, and neither should be able to distort the other.
 *
 * Broadcast, not point-to-point, for the same reason background tasks are: a run
 * routinely outlives the request that launched it, so there is no requestId to
 * route by — and after a window reload, no request at all.
 */
import { BrowserWindow } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { LlmChildEvent, SubagentDelta, SubagentRunView } from '../../shared/api'
import type { MessagePart } from '../../shared/types'
import { PartsFold } from '../../shared/parts'

interface Run {
  subChatId: string
  parentChatId: string | null
  description: string
  subagentType: string
  background: boolean
  startedAt: number
  fold: PartsFold
}

/** Sub chat id —> its in-flight run. Only ever holds RUNNING subagents. */
const runs = new Map<string, Run>()

/**
 * The sub session the user currently has open, if any.
 *
 * Sub sessions are pruned at the end of the parent turn so one-shot delegates
 * don't pile up in the sidebar. That sweep predates their transcripts being
 * watchable: now that you can open one and follow it live, pruning the very
 * session someone is reading deletes content out from under them. The renderer
 * reports what's on screen; the sweep spares it.
 *
 * Not a Set: exactly one session is on screen at a time, so a single value makes
 * a stale "still viewing" entry impossible.
 */
let viewedSubChatId: string | null = null

/** Push a payload to every open window (out-of-band — no requestId to route by). */
function broadcast(payload: SubagentDelta): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // A window can be torn down between the guard and the send. A broadcast must
    // never break a subagent run, so per-window failures are swallowed.
    try {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.subagentDelta, payload)
    } catch {
      // window went away mid-send — ignore
    }
  }
}

export interface StartRunInput {
  subChatId: string
  parentChatId: string | null
  description: string
  subagentType: string
  background: boolean
}

/**
 * Announce a subagent run and open its live transcript. Returns an `emit` the
 * caller feeds every child event, plus `finish` to close the run.
 *
 * A handle rather than free functions keyed by id: the harness then cannot emit
 * into a run it didn't start, and a finished run can't be resurrected by a late
 * event that raced its own `finish`.
 */
export function startSubagentRun(input: StartRunInput): {
  emit: (event: LlmChildEvent) => void
  finish: (state: 'completed' | 'error') => void
} {
  const run: Run = {
    subChatId: input.subChatId,
    parentChatId: input.parentChatId,
    description: input.description,
    subagentType: input.subagentType,
    background: input.background,
    startedAt: Date.now(),
    fold: new PartsFold()
  }
  runs.set(input.subChatId, run)
  broadcast({ subChatId: run.subChatId, kind: 'run', state: 'running' })

  // Closed over rather than read off the map: `endSubagentRuns` can drop this
  // run (its session was deleted) while the loop is still emitting, and a stray
  // event must not silently re-register a dead run by writing back to the map.
  let closed = false
  return {
    emit: (event) => {
      if (closed) return
      run.fold.apply(event)
      broadcast({ subChatId: run.subChatId, kind: 'event', event })
    },
    finish: (state) => {
      if (closed) return
      closed = true
      // Drop the run BEFORE announcing the end: the renderer reloads the sub
      // session's persisted transcript on this frame, and a snapshot fetched
      // during that reload must not hand back the now-superseded live parts.
      runs.delete(run.subChatId)
      broadcast({ subChatId: run.subChatId, kind: 'run', state })
    }
  }
}

/**
 * The live parts of a running subagent, for a window that opened its session
 * mid-run. Null when nothing is running for that id — either it never was, or it
 * already finished and its persisted message is the truth.
 */
export function subagentSnapshot(subChatId: string): MessagePart[] | null {
  return runs.get(subChatId)?.fold.parts ?? null
}

/** Every subagent currently running, so a fresh window can restore its spinners. */
export function listRunningSubagents(): SubagentRunView[] {
  return [...runs.values()].map((r) => ({
    subChatId: r.subChatId,
    parentChatId: r.parentChatId,
    description: r.description,
    subagentType: r.subagentType,
    background: r.background,
    startedAt: r.startedAt
  }))
}

/**
 * Close out every live run belonging to a deleted session — the session itself
 * when it's a sub, plus every delegate it spawned when it's a parent.
 *
 * The run's *work* is stopped elsewhere (a background job by its controller, a
 * foreground one by the parent turn dying with it). This only clears the
 * registry, so a gone session can't pin an entry that keeps broadcasting to a
 * chat view nobody can open, or hold a sibling against pruning forever.
 */
export function endSubagentRuns(chatId: string): void {
  for (const run of [...runs.values()]) {
    if (run.subChatId !== chatId && run.parentChatId !== chatId) continue
    runs.delete(run.subChatId)
    broadcast({ subChatId: run.subChatId, kind: 'run', state: 'error' })
  }
  if (viewedSubChatId === chatId) viewedSubChatId = null
}

/** Renderer -> main: which chat is on screen (null when it isn't a sub session). */
export function setViewedSubChat(chatId: string | null): void {
  viewedSubChatId = chatId
}

/** Sub session ids that must survive a prune: anything running, plus what's on screen. */
export function protectedSubChatIds(): Set<string> {
  const ids = new Set(runs.keys())
  if (viewedSubChatId) ids.add(viewedSubChatId)
  return ids
}

/** Test-only: clear the registry between smoke cases. */
export function _resetSubagentRuns(): void {
  runs.clear()
  viewedSubChatId = null
}
