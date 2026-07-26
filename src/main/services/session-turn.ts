/**
 * The shared core of a session turn — extracted from the `llm:start` IPC handler
 * so the local (renderer-driven) path and the remote (phone-driven) path run the
 * *exact same* code with no drift.
 *
 * It resolves the session's workspace, runs one agent turn, prunes the turn's
 * one-shot subagents, and maps errors/aborts to a stable `LlmResult`. Emitting
 * events and persisting messages are the caller's job: the local path streams to
 * the renderer (which persists), while the remote host also fans out to the phone
 * and persists on the desktop's behalf.
 */
import type { LlmEvent, LlmResult, LlmStartInput } from '../../shared/api'
import * as repo from '../db/repo'
import { runAgentTurn } from '../harness'
import { activeBackgroundSubChatIds } from './background-tasks'
import { protectedSubChatIds } from './subagent-stream'
import { setLabel as setBrowserLabel } from './browser'
import { sessionCwd } from './workspace'
import { materializePendingWorktree } from './worktree'
import path from 'node:path'

/**
 * Resolve a session's working directory, degrading to '' rather than throwing.
 *
 * Same reasoning as the materialize guard above: cwd resolution reads the DB and
 * touches the filesystem, and a turn that can't resolve a worktree should still
 * run — just without one.
 */
function safeSessionCwd(sessionId: string): string {
  try {
    return sessionCwd(sessionId)
  } catch (e) {
    console.warn('[worktree] cwd resolution failed; falling back:', e)
    try {
      return repo.getChatWorkspace(sessionId) ?? ''
    } catch {
      return ''
    }
  }
}

/**
 * Sub sessions that must survive the end-of-turn prune: any with a detached
 * background job still running, any still streaming, and the one on screen.
 */
function keepSubchats(): Set<string> {
  const keep = protectedSubChatIds()
  for (const id of activeBackgroundSubChatIds()) keep.add(id)
  return keep
}

/**
 * Run one agent turn for a session. `emit` receives every streamed `LlmEvent`;
 * `signal` aborts the in-flight turn. Returns `{ ok: true }` on success, or
 * `{ ok: false, error }` on failure (a caller-triggered abort reports "Stopped.").
 */
export async function runSessionTurn(
  input: LlmStartInput,
  emit: (event: LlmEvent) => void,
  signal: AbortSignal
): Promise<LlmResult> {
  // If this session asked for a worktree, build it now — on the first turn,
  // not at create time, so an abandoned composer leaves nothing on disk.
  //
  // Wrapped because this MUST NOT be able to stop a turn. Everything inside is
  // best-effort infrastructure (git, the filesystem, a schema that might be
  // mid-upgrade); if any of it throws, the right outcome is a session that runs
  // in its project folder, not a chat that refuses to answer.
  try {
    const materialized = await materializePendingWorktree(input.sessionId)
    if (materialized.error) emit({ type: 'text', delta: `_${materialized.error}_\n\n` })
  } catch (e) {
    console.warn('[worktree] materialize failed; running in the project folder:', e)
  }
  // Where this session's tools run — its worktree when it has one, else the
  // project folder. The single resolver; never read workspace_path directly.
  const cwd = safeSessionCwd(input.sessionId)
  // Name this session's browser window after its project so concurrent windows
  // are tellable apart (a no-op until/unless the agent opens the browser).
  if (cwd) setBrowserLabel(input.sessionId, path.basename(cwd))
  try {
    await runAgentTurn({
      providerId: input.providerId,
      model: input.model,
      messages: input.messages,
      agentId: input.agentId,
      reasoning: input.reasoning,
      reasoningEffort: input.reasoningEffort,
      contextLimit: input.contextLimit,
      cwd,
      chatId: input.sessionId,
      signal,
      emit
    })
    // The turn's subagents are one-shot — drop any with nothing queued so they
    // don't linger in the sidebar after the work is done. Spared: sub sessions
    // with a still-running background task (Phase 11), one still streaming, and
    // whichever one the user currently has open (pruning a transcript out from
    // under someone reading it is the one thing this sweep must never do).
    repo.pruneSubchats(input.sessionId, keepSubchats())
    return { ok: true }
  } catch (e) {
    if (signal.aborted) return { ok: false, error: 'Stopped.' }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
