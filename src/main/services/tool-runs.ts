/**
 * Registry of tool calls that are executing RIGHT NOW, so one of them can be
 * cancelled on its own.
 *
 * Stop was all-or-nothing before this. A turn that fired `bash npm test` on a
 * wedged suite, or a `webfetch` at a host that never answers, left exactly one
 * lever: kill the entire turn — throwing away the model's reasoning and every
 * other tool result alongside the one call you actually wanted gone. This is the
 * missing granularity, and it's deliberately the same shape as the subagent
 * registry next door (`subagent-stream.ts`): a map from a public id to a
 * `cancel`, an explicit `cancelled` flag so the harness can tell "the user did
 * this" from "it failed", and a handle-based API so a finished run can't be
 * resurrected by a late call.
 *
 * Keyed by the model's tool-call id, which is the id a tool card already carries
 * to the renderer and the only one that names a single call inside a turn.
 *
 * Not persisted and not broadcast: unlike a subagent run, a tool call cannot
 * outlive the turn that started it, so the requestId-keyed `llm:delta` stream
 * the card already rides is enough to reflect the outcome. The renderer only
 * ever needs to ASK (an invoke), never to be told out-of-band.
 */

interface ToolRun {
  callId: string
  tool: string
  /** The session whose turn is running this call — scopes a session-wide sweep. */
  sessionId: string
  /** Aborts this call's own signal, leaving the rest of the turn alone. */
  cancel: () => void
  /**
   * Set ONLY by `cancelToolCall` — i.e. the user cancelled this ONE call and the
   * turn is still running.
   *
   * Deliberately not set by the session-wide sweep, which aborts the identical
   * signal: the harness swaps in a "you cancelled this, carry on with the rest
   * of your work" result when it sees this flag, and that sentence is a lie in a
   * transcript whose whole turn just stopped. A full Stop leaves the flag false
   * and the tool's own `TOOL_ABORTED` wording stands.
   */
  cancelled: boolean
  startedAt: number
}

/** Call id -> the in-flight call. Only ever holds RUNNING calls. */
const runs = new Map<string, ToolRun>()

export interface StartToolRunInput {
  callId: string
  tool: string
  sessionId: string
  cancel: () => void
}

/**
 * Register a running tool call. Returns `end` to deregister it, plus
 * `wasCancelled` so the caller can classify its own outcome AFTER the work
 * unwinds but BEFORE the entry is dropped.
 *
 * A handle rather than free functions keyed by id, for the same reason
 * `startSubagentRun` is one: the caller can only end the run it started, and an
 * `end` that races a cancel can't reopen anything.
 */
export function startToolRun(input: StartToolRunInput): {
  end: () => void
  wasCancelled: () => boolean
} {
  const run: ToolRun = {
    callId: input.callId,
    tool: input.tool,
    sessionId: input.sessionId,
    cancel: input.cancel,
    cancelled: false,
    startedAt: Date.now()
  }
  // Last writer wins on a duplicate id. Providers do occasionally repeat a
  // tool-call id across steps of one turn, and the newer call is the live one —
  // the alternative (refusing to register) would silently make it uncancellable.
  runs.set(input.callId, run)
  let ended = false
  return {
    end: () => {
      if (ended) return
      ended = true
      // Only drop OUR entry: a later call that reused this id has already
      // replaced us in the map and must keep its own cancellability.
      if (runs.get(input.callId) === run) runs.delete(input.callId)
    },
    wasCancelled: () => run.cancelled
  }
}

/**
 * Cancel one running tool call by its id.
 *
 * Aborting is all this does — the call tears itself down through its normal exit
 * path (the tool observes the signal, returns a cancelled result, the harness
 * emits `tool-end` and feeds the model a result for that call id). That matters
 * more here than anywhere else: the provider REQUIRES a `role:'tool'` result for
 * every `tool_calls` entry, so a cancel that skipped the normal path would leave
 * a dangling call and 400 the next request.
 *
 * Returns false when nothing was running for that id.
 */
export function cancelToolCall(callId: string): boolean {
  const run = runs.get(callId)
  if (!run) return false
  run.cancelled = true
  try {
    run.cancel()
  } catch {
    // A cancel must never throw back into the IPC handler.
  }
  return true
}

/** Whether a call was cancelled by the user (vs. failing or finishing on its own). */
export function wasToolCallCancelled(callId: string): boolean {
  return runs.get(callId)?.cancelled === true
}

/**
 * Abort every tool call a session has in flight — part of a session-wide Stop.
 *
 * Note what this does NOT do: set `cancelled`. That flag means "the user
 * cancelled this single call and the turn continues", which is exactly what a
 * Stop is not. See the field's doc comment.
 */
export function cancelToolCallsFor(sessionId: string): void {
  for (const run of [...runs.values()]) {
    if (run.sessionId !== sessionId) continue
    try {
      run.cancel()
    } catch {
      // never let one bad cancel break the sweep
    }
  }
}

/** Test-only: clear the registry between smoke cases. */
export function _resetToolRuns(): void {
  runs.clear()
}
