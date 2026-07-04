/**
 * Background subagent registry — the always-on half of Phase 11's "make it WAYY
 * better than opencode" goal.
 *
 * A `task` launched with `background: true` runs detached: the parent turn gets
 * an immediate "started" result and keeps working (or ends) while the subagent
 * runs on its own. This registry is the source of truth for those detached jobs.
 * It:
 *   - hands each job its own AbortController (so the parent turn ending does NOT
 *     cancel it — the whole point of "background"), while still allowing an
 *     explicit cancel (session delete, app quit, or a user click),
 *   - broadcasts every state change to all open windows via `task:update`, so the
 *     UI updates live even after the launching request has finished,
 *   - tells `pruneSubchats` which `sub` sessions to keep (a job still running must
 *     not have its session swept out from under it).
 *
 * opencode gates background subagents behind an experimental flag and threads
 * results back through its Effect runtime; we make them first-class and deliver
 * the report by persisting a task card onto the parent session (see agent.ts),
 * which the next turn then sees as structured tool history.
 */
import { BrowserWindow } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { TaskUpdate } from '../../shared/api'

interface BackgroundJob extends TaskUpdate {
  controller: AbortController
}

const jobs = new Map<string, BackgroundJob>()
let seq = 0

/** Public view of a job (no AbortController) — what we broadcast + expose over IPC. */
function toUpdate(job: BackgroundJob): TaskUpdate {
  const { controller: _controller, ...info } = job
  void _controller
  return { ...info }
}

/** Push a job's current state to every open window (out-of-band, no requestId). */
function broadcast(job: BackgroundJob): void {
  const payload = toUpdate(job)
  for (const win of BrowserWindow.getAllWindows()) {
    // A window can be torn down (or its webContents crash) between the guard and
    // the send; a broadcast must never break job lifecycle, so swallow per-window
    // failures rather than let one bad window throw out of finish/register.
    try {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.taskUpdate, payload)
    } catch {
      // window went away mid-send — ignore
    }
  }
}

export interface RegisterInput {
  sessionId: string
  subChatId: string | null
  description: string
  subagentType: string
}

/**
 * Register a new detached job. Returns the job id and a fresh abort signal the
 * caller should thread into the subagent run. Broadcasts the `running` state.
 */
export function registerBackgroundJob(input: RegisterInput): {
  jobId: string
  signal: AbortSignal
} {
  const jobId = `bg_${Date.now().toString(36)}_${(seq++).toString(36)}`
  const controller = new AbortController()
  const job: BackgroundJob = {
    jobId,
    sessionId: input.sessionId,
    subChatId: input.subChatId,
    description: input.description,
    subagentType: input.subagentType,
    state: 'running',
    startedAt: Date.now(),
    controller
  }
  jobs.set(jobId, job)
  broadcast(job)
  return { jobId, signal: controller.signal }
}

/**
 * Mark a job finished, broadcast the terminal state, then drop it from the
 * registry (its result has already been delivered to the parent session, so the
 * `sub` session is free to be pruned on the next turn).
 */
export function finishBackgroundJob(jobId: string, state: 'completed' | 'error'): void {
  const job = jobs.get(jobId)
  if (!job) return
  job.state = state
  job.finishedAt = Date.now()
  // Always drop the job from the registry, even if the broadcast throws — a job
  // left behind here would keep its `sub` session pinned against pruning forever.
  try {
    broadcast(job)
  } finally {
    jobs.delete(jobId)
  }
}

/** The running background jobs for a session, as broadcast-shaped updates. */
export function listRunningBackgroundJobs(sessionId: string): TaskUpdate[] {
  const out: TaskUpdate[] = []
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId && job.state === 'running') out.push(toUpdate(job))
  }
  return out
}

/** `sub` session ids with a still-running background job — must survive pruning. */
export function activeBackgroundSubChatIds(): Set<string> {
  const ids = new Set<string>()
  for (const job of jobs.values()) {
    if (job.state === 'running' && job.subChatId) ids.add(job.subChatId)
  }
  return ids
}

/** Whether any background job is still running for a session. */
export function hasActiveBackgroundJobs(sessionId: string): boolean {
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId && job.state === 'running') return true
  }
  return false
}

/** Abort a single running background job (its run settles + delivers as `error`). */
export function cancelBackgroundJob(jobId: string): void {
  jobs.get(jobId)?.controller.abort()
}

/** Abort every background job for a session (used when its chat is deleted). */
export function cancelSessionBackgroundJobs(sessionId: string): void {
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId) job.controller.abort()
  }
}

/** Abort all background jobs (app shutdown). */
export function cancelAllBackgroundJobs(): void {
  for (const job of jobs.values()) job.controller.abort()
}

/** Test-only: clear the registry between smoke cases. */
export function _resetBackgroundJobs(): void {
  for (const job of jobs.values()) job.controller.abort()
  jobs.clear()
}
