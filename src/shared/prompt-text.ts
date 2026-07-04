/**
 * The tuned per-model prompt TEXT, inlined at build time via Vite's `?raw`
 * imports. Roxy is a fork of opencode; these are Roxy's rebranded and modified
 * copies of opencode's prompts (MIT — see `resources/prompts/ATTRIBUTION.txt`).
 *
 * IMPORTANT: this module uses `?raw` imports, so it may ONLY be imported from
 * bundles that Vite processes — the renderer, and the main entry (`main/index.ts`),
 * which injects the text into the harness via `setPromptText()`. Do NOT import it
 * from `harness/agent.ts` or anything the esbuild smoke test bundles; those must
 * use the pure `prompt.ts` and receive the text by injection.
 */
import type { PromptName } from './prompt'
import ANTHROPIC from '../../resources/prompts/anthropic.txt?raw'
import BEAST from '../../resources/prompts/beast.txt?raw'
import CODEX from '../../resources/prompts/codex.txt?raw'
import GPT from '../../resources/prompts/gpt.txt?raw'
import GEMINI from '../../resources/prompts/gemini.txt?raw'
import KIMI from '../../resources/prompts/kimi.txt?raw'
import TRINITY from '../../resources/prompts/trinity.txt?raw'
import DEFAULT from '../../resources/prompts/default.txt?raw'
import PLAN from '../../resources/prompts/plan.txt?raw'
import AGENT_EXPLORE from '../../resources/prompts/agent-explore.txt?raw'
import AGENT_COMPACTION from '../../resources/prompts/agent-compaction.txt?raw'

/** Every tuned prompt family keyed by {@link PromptName}. */
export const PROMPT_TEXT: Record<PromptName, string> = {
  anthropic: ANTHROPIC,
  beast: BEAST,
  codex: CODEX,
  gpt: GPT,
  gemini: GEMINI,
  kimi: KIMI,
  trinity: TRINITY,
  default: DEFAULT
}

/**
 * Agent-specific prompt text keyed by `AgentDef.promptFile`. These layer on top of
 * (Plan) or replace (subagents) the model prompt when an agent overrides it.
 */
export const AGENT_PROMPT_TEXT: Record<string, string> = {
  'plan.txt': PLAN,
  'agent-explore.txt': AGENT_EXPLORE,
  'agent-compaction.txt': AGENT_COMPACTION
}

/** The base prompt text for a family, falling back to the default prompt. */
export function promptTextFor(name: PromptName): string {
  return PROMPT_TEXT[name] ?? PROMPT_TEXT.default
}
