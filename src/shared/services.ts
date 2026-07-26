/**
 * Pure presentation logic for the Services panel — extracted from the component
 * so the rules can be unit-tested without a renderer (`npm run smoke:shared`).
 *
 * The panel shows raw process facts (`status`, `exitCode`) but a person reads it
 * for an OUTCOME, and translating between the two is where the bugs are. Both of
 * the ones this module exists to prevent shipped once:
 *
 *   - a worktree's `npm ci` that succeeded rendered as "1 stopped", which reads
 *     as a failure for the single most common row in the panel;
 *   - stopping a service on purpose rendered as a failure, because `taskkill /f`
 *     necessarily exits non-zero.
 */
import type { ServiceView } from './api'

/** The subset of a service these rules need — keeps them testable with literals. */
export type ServiceOutcome = Pick<ServiceView, 'status' | 'exitCode' | 'state'>

/**
 * Did this process actually FAIL, as opposed to merely finish or be stopped?
 *
 * The exit code alone cannot answer this. Stopping or restarting a service kills
 * it — via `taskkill /t /f` on Windows, SIGTERM elsewhere — so a deliberate stop
 * essentially always reports a non-zero code. `killed` is therefore classified
 * by intent, not by code: the user asked for it, so it is not an error.
 */
export function isServiceFailure(s: ServiceOutcome): boolean {
  if (s.status === 'error') return true
  if (s.status === 'killed') return false
  return s.exitCode != null && s.exitCode !== 0
}

/**
 * The per-row status label, in outcome terms rather than process terms.
 *
 * `exited (exit 0)` — the raw `state` that `bash_list` shows the model — is
 * precise and unhelpful here: "exited" is exactly the word you don't want after
 * waiting on an install that in fact succeeded. Running keeps the raw label
 * because its elapsed-time suffix is the useful part.
 */
export function serviceStatusLabel(s: ServiceOutcome): string {
  if (s.status === 'running') return s.state
  if (s.status === 'killed') return 'stopped'
  if (s.status === 'error') return 'failed'
  if (s.exitCode === 0) return 'done'
  return s.exitCode == null ? 'failed' : `failed (exit ${s.exitCode})`
}

/**
 * The collapsed header's one-line story.
 *
 * Collapsed is the panel's default and, for most people, the only state they
 * read — so this line has to carry the outcome on its own. Ordered live-first,
 * then broken; "done" is only worth saying once nothing is still running.
 */
export function servicesSummary(services: ServiceOutcome[]): string {
  const running = services.filter((s) => s.status === 'running').length
  const failed = services.filter(isServiceFailure).length
  const settled = services.length - running - failed
  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (settled > 0 && running === 0) parts.push(`${settled} done`)
  return parts.join(' · ') || `${services.length} done`
}
