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
import { setLabel as setBrowserLabel } from './browser'
import path from 'node:path'

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
  const cwd = repo.getChatWorkspace(input.sessionId) ?? ''
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
    // don't linger in the sidebar after the work is done. Sub-sessions with a
    // still-running background task are kept (Phase 11) until it reports back.
    repo.pruneSubchats(input.sessionId, activeBackgroundSubChatIds())
    return { ok: true }
  } catch (e) {
    if (signal.aborted) return { ok: false, error: 'Stopped.' }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
