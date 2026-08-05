/**
 * Per-session inference config — the model, mode, thinking effort, and context
 * budget a single session runs with.
 *
 * The rule, in one line: **a session owns its config; the global settings are
 * only the template new sessions are stamped from.**
 *
 * Every session (a `chats` row) carries its own provider/model/agent/effort/
 * context columns, seeded from `AppSettings` at create time. Changing a picker
 * writes BOTH the open session's row and the global default, so:
 *
 *   - switching model in session A never touches session B, and
 *   - the NEXT new session starts from whatever you last chose.
 *
 * Seeding is a snapshot, deliberately: editing a picker later must not
 * retroactively rewrite sessions you already tuned. Sessions created before this
 * existed have NULL columns and fall back to the globals here, so upgrading
 * changes nothing until you touch a picker.
 *
 * This module is the SINGLE resolver. Three call sites used to duplicate this
 * logic (the renderer's send path, its compaction path, and the main process's
 * phone-driven turn) and drifted; they all route through `resolveSessionConfig`
 * now so they cannot disagree about which model a session is on.
 *
 * Isomorphic: types and pure functions only, no Node/Electron/browser imports.
 */
import { DEFAULT_AGENT_ID } from './agents'
import type { AppSettings, Chat, ReasoningEffort } from './types'

/** The fully-resolved inference config for one session. */
export interface SessionConfig {
  providerId: string | null
  model: string | null
  /** Primary agent (mode) id, e.g. 'build' or 'plan'. Never null. */
  agentId: string
  reasoningEffort: ReasoningEffort
  /** Context budget in tokens; null = use the model's own default. */
  contextLimit: number | null
}

/** A partial config update — only the keys present are written. */
export type SessionConfigPatch = Partial<SessionConfig>

/** The subset of a Chat this resolver reads (so callers can pass a row or a Chat). */
export type SessionConfigSource = Pick<
  Chat,
  'providerId' | 'model' | 'agentId' | 'reasoningEffort' | 'contextLimit'
>

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'

/** The full ladder, weakest to strongest — the order the picker renders. */
export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Narrow a chosen effort to one the model will actually accept.
 *
 * Providers disagree about the ladder: OpenAI-compatible endpoints classically
 * know low/medium/high, Copilot takes the whole Low->Max range, and a gateway
 * like roxy.gg reports a PER-MODEL list (
easoningEfforts) where a model may
 * expose only ['high']. Sending an unsupported level is a 400, so a session
 * left on Max must degrade to the nearest supported level rather than fail.
 *
 * "Nearest" is deliberately downward-first: too much thinking costs money the
 * user did not ask for, too little only costs quality. We fall back to the
 * strongest supported level only when nothing weaker exists.
 */
export function clampReasoningEffort(
  effort: ReasoningEffort,
  supported: ReasoningEffort[] | undefined
): ReasoningEffort {
  if (!supported || supported.length === 0) return effort
  const allowed = REASONING_EFFORTS.filter((e) => supported.includes(e))
  if (allowed.length === 0) return effort
  if (allowed.includes(effort)) return effort
  const want = REASONING_EFFORTS.indexOf(effort)
  const weaker = allowed.filter((e) => REASONING_EFFORTS.indexOf(e) < want)
  return weaker.length ? weaker[weaker.length - 1] : allowed[0]
}

/** Narrow an untrusted string (DB column, IPC payload) to a ReasoningEffort. */
export function parseReasoningEffort(v: unknown): ReasoningEffort | null {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max' ? v : null
}

/**
 * Resolve what a session actually runs with: its own columns first, then the
 * global defaults, then hardcoded fallbacks.
 *
 * `providerId` and `model` resolve as an ATOMIC PAIR, keyed off the provider.
 * Falling back field-by-field could pair one provider with another's model id
 * (anthropic + `gpt-4o`), which 404s the turn. A session either pins both or
 * inherits both.
 */
export function resolveSessionConfig(
  chat: SessionConfigSource | null | undefined,
  settings: AppSettings | null | undefined
): SessionConfig {
  // The provider pins the pair: a session with no provider of its own inherits
  // the global provider AND the global model together.
  const pinned = chat?.providerId ? chat : null
  return {
    providerId: pinned ? pinned.providerId : (settings?.activeProviderId ?? null),
    model: pinned ? pinned.model : (settings?.activeModel ?? null),
    agentId: chat?.agentId ?? DEFAULT_AGENT_ID,
    reasoningEffort: chat?.reasoningEffort ?? settings?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    contextLimit: chat?.contextLimit ?? settings?.contextLimit ?? null
  }
}

/**
 * The config a brand-new session is stamped with — i.e. "whatever the user last
 * chose". Called by `createChat`; `agentId` is included so a session opened
 * right after you switch to Plan stays in Plan.
 */
export function seedSessionConfig(settings: AppSettings | null | undefined): SessionConfig {
  return {
    providerId: settings?.activeProviderId ?? null,
    model: settings?.activeModel ?? null,
    agentId: settings?.activeAgentId ?? DEFAULT_AGENT_ID,
    reasoningEffort: settings?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    contextLimit: settings?.contextLimit ?? null
  }
}

/**
 * The window a model can actually use.
 *
 * models.dev reports Claude's *base* 200K, but the model (and VS Code's Copilot
 * client) expose 1M — Anthropic via the `context-1m` beta, Copilot server-side.
 * Raise the ceiling for those large reasoning models so the picker offers what
 * they can really do. Shared so the picker, the meter, and the turn's budget
 * math all agree on the maximum.
 */
export function effectiveContextMax(info: { reasoning?: boolean; contextLimit?: number }): number {
  const base = info.contextLimit ?? 0
  if (info.reasoning && base >= 180_000 && base <= 264_000) return 1_000_000
  return base
}

/**
 * The token budget a turn should build its window to, given the session's chosen
 * limit and the model's real ceiling. Defaults to 200K (or the model max, if
 * smaller) when the session has no explicit choice.
 */
export function contextBudgetFor(chosen: number | null, modelContext: number): number {
  return Math.min(chosen ?? Math.min(modelContext, 200_000), modelContext)
}
