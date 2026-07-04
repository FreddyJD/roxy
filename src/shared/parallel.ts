/**
 * Subagent parallelism primitives — the pure, dependency-free half of Phase 11.
 *
 * Roxy's agent loop owns its own tool dispatch (unlike opencode, which hands
 * concurrency to the Vercel AI SDK), so we run a turn's `task` calls ourselves —
 * concurrently, but through a *bounded* pool so a model that emits a dozen
 * subagents at once can't thrash the machine. opencode runs tools with
 * `concurrency: "unbounded"` and hides background subagents behind an
 * experimental flag; we do bounded parallelism and make background tasks a
 * first-class, always-on capability.
 *
 * Everything here is pure (no Node/Electron/Buffer) so it runs in the harness,
 * the renderer, and the smoke:shared pure-Node harness alike.
 */

/** Max subagents allowed to run at once in a single turn (bounded pool). */
export const MAX_PARALLEL_SUBAGENTS = 4

/** A tool call as accumulated from the model stream (id + name + raw JSON args). */
export interface PlannedCall {
  id: string
  name: string
  args: string
}

/** The parsed shape of a `task` tool call's arguments. */
export interface TaskInput {
  description: string
  prompt: string
  subagentType: string
  /** Run detached: return immediately, report back on completion. */
  background: boolean
  /** Resume a prior subagent session instead of starting fresh (optional). */
  taskId?: string
}

/**
 * Split a turn's tool calls into `task` delegations (run concurrently) and
 * everything else (kept sequential to avoid filesystem races on write/edit).
 * Order within each bucket is preserved so results can be zipped back.
 */
export function partitionToolCalls<T extends { name: string }>(
  calls: T[]
): { tasks: T[]; others: T[] } {
  const tasks: T[] = []
  const others: T[] = []
  for (const c of calls) {
    if (c.name === 'task') tasks.push(c)
    else others.push(c)
  }
  return { tasks, others }
}

/** Coerce an unknown JSON value to a trimmed string, or '' when absent. */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Parse a `task` call's raw JSON arguments into a normalized `TaskInput`,
 * tolerating malformed JSON and missing fields (defaults to the `general`
 * subagent, foreground). `background` accepts a real boolean or the strings
 * "true"/"1" (models sometimes stringify booleans).
 */
export function parseTaskInput(rawArgs: string): TaskInput {
  let obj: Record<string, unknown> = {}
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {}
    if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>
  } catch {
    obj = {}
  }
  const description = asString(obj.description).trim() || 'subtask'
  const prompt = asString(obj.prompt)
  const subagentType = asString(obj.subagent_type).trim() || 'general'
  const bg = obj.background
  const background = bg === true || bg === 'true' || bg === '1'
  const taskIdRaw = asString(obj.task_id).trim()
  return {
    description,
    prompt,
    subagentType,
    background,
    taskId: taskIdRaw || undefined
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, returning
 * results in the SAME order as the input (not completion order). A rejected
 * `fn` rejects the whole batch (after in-flight work settles is *not*
 * guaranteed — callers that need every result should have `fn` never throw).
 *
 * This is the bounded worker pool behind parallel subagents: it keeps the
 * machine from being swamped when a model fans out many `task` calls, while
 * still overlapping their (mostly network-bound) work.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length
  const results = new Array<R>(n)
  if (n === 0) return results
  const cap = Math.max(1, Math.min(limit, n))
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= n) return
      results[i] = await fn(items[i], i)
    }
  }
  const workers: Promise<void>[] = []
  for (let w = 0; w < cap; w++) workers.push(worker())
  await Promise.all(workers)
  return results
}

/**
 * Wrap a subagent's result so the parent model sees the delegation collapse into
 * one tool result. Mirrors opencode's `renderOutput` (task_result / task_error).
 */
export function renderTaskResult(
  subagent: string,
  state: 'completed' | 'error',
  text: string,
  summary?: string
): string {
  const tag = state === 'error' ? 'task_error' : 'task_result'
  return [
    `<task subagent="${subagent}" state="${state}">`,
    ...(summary ? [`<summary>${summary}</summary>`] : []),
    `<${tag}>`,
    text,
    `</${tag}>`,
    '</task>'
  ].join('\n')
}

/** The immediate result a background `task` returns so the parent keeps working. */
export function renderBackgroundStarted(subagent: string, description: string): string {
  return renderTaskResult(
    subagent,
    'completed',
    [
      `The "${description}" task is now running in the background. You'll be notified automatically when it finishes.`,
      "DO NOT poll it, ask it for status, sleep, or duplicate its work — don't touch the same files or topic it's working on.",
      'Continue with other, non-overlapping work, or briefly tell the user what you launched and end your turn.'
    ].join('\n'),
    'Background task started'
  )
}
