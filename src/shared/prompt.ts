/**
 * Model-aware system-prompt assembly, mirroring opencode's `session/system.ts`
 * (github.com/sst/opencode, MIT). The tuned per-model prompt TEXT lives in
 * `resources/prompts/<name>.txt` and is supplied by `prompt-text.ts` (which does
 * the bundler `?raw` imports).
 *
 * This module is deliberately PURE string logic — it imports no assets — so it is
 * safe to pull into the main-process harness and the esbuild-bundled smoke test,
 * neither of which can process Vite's `?raw` imports.
 */

/** The tuned prompt families roxy vendors from opencode (one per model style). */
export type PromptName =
  | 'anthropic'
  | 'beast'
  | 'codex'
  | 'gpt'
  | 'gemini'
  | 'kimi'
  | 'trinity'
  | 'default'

/**
 * Pick the tuned system prompt for a model id, mirroring opencode's `provider()`
 * selector: gpt-4/o1/o3 get the "beast" prompt; other gpt (codex vs plain),
 * gemini, claude, trinity, and kimi models get their family prompt; everything
 * else falls back to the default prompt.
 */
export function selectPromptName(modelId: string | undefined): PromptName {
  const id = (modelId ?? '').toLowerCase()
  if (id.includes('gpt-4') || id.includes('o1') || id.includes('o3')) return 'beast'
  if (id.includes('gpt')) return id.includes('codex') ? 'codex' : 'gpt'
  if (id.includes('gemini')) return 'gemini'
  if (id.includes('claude')) return 'anthropic'
  if (id.includes('trinity')) return 'trinity'
  if (id.includes('kimi')) return 'kimi'
  return 'default'
}

/** Facts about the machine/session the model is running in (for the `<env>` block). */
export interface EnvironmentInfo {
  /** The session's working directory (workspace folder). */
  cwd?: string
  /** The repo/worktree root, when it differs from `cwd`. */
  worktree?: string
  /** Whether `cwd` sits inside a git repository. */
  isGitRepo?: boolean
  /** `process.platform` (e.g. "darwin", "win32", "linux"). */
  platform?: string
  /** The active model id (e.g. "claude-sonnet-4"). */
  modelId?: string
  /** The connected provider id (e.g. "github-copilot"). */
  providerId?: string
  /** A human date string, e.g. `new Date().toDateString()`. */
  date?: string
}

/**
 * Render the environment grounding opencode appends to every system prompt so the
 * model knows where it's running. Mirrors opencode's `system.ts` environment():
 * a natural-language model-identity sentence followed by an `<env>` block (cwd,
 * workspace root, git, platform, date). Only the fields that are provided are
 * emitted; an empty info object yields "".
 */
export function buildEnvironment(env: EnvironmentInfo): string {
  const sections: string[] = []

  // Model identity as a sentence (mirrors opencode) — models ground on this
  // phrasing better than a bare key/value line inside the env block.
  if (env.modelId) {
    const exactId = env.providerId ? `${env.providerId}/${env.modelId}` : env.modelId
    sections.push(
      `You are powered by the model named ${env.modelId}. The exact model ID is ${exactId}.`
    )
  }

  const inner: string[] = []
  if (env.cwd) inner.push(`  Working directory: ${env.cwd}`)
  if (env.worktree && env.worktree !== env.cwd) inner.push(`  Workspace root folder: ${env.worktree}`)
  if (env.isGitRepo !== undefined) inner.push(`  Is directory a git repo: ${env.isGitRepo ? 'yes' : 'no'}`)
  if (env.platform) inner.push(`  Platform: ${env.platform}`)
  if (env.date) inner.push(`  Today's date: ${env.date}`)
  if (inner.length > 0) {
    sections.push(
      [
        'Here is some useful information about the environment you are running in:',
        '<env>',
        ...inner,
        '</env>'
      ].join('\n')
    )
  }

  return sections.join('\n')
}

/** The pieces that make up a full system prompt, assembled in a stable order. */
export interface AssembleInput {
  /** The tuned per-model base prompt text. */
  base: string
  /** The rendered `<env>` block (see {@link buildEnvironment}). */
  environment?: string
  /** A compaction summary of earlier conversation, if the chat was compacted. */
  contextSummary?: string
  /** Extra sections (e.g. AGENTS.md instructions) appended after the base prompt. */
  extra?: string[]
}

/**
 * Roxy's commit co-author identity. Mirrors how GitHub Copilot attributes its
 * work with a `Co-authored-by` trailer, so commits Roxy helps write render as
 * "<you> and Roxy" on GitHub. This is the single source of truth for the
 * identity — change this one line to rebrand it.
 *
 * The address is the GitHub-provided noreply email for the dedicated
 * @roxy-commits account (`<id>+<login>@users.noreply.github.com`). Using that
 * exact form is what makes GitHub link the co-author to the profile and render
 * its avatar — the same trick Copilot's `223556219+Copilot@users.noreply.github.com`
 * trailer uses. (A branded address like `noreply@roxy.gg` would only show an
 * avatar if it were added and verified on the account first.) So the avatar that
 * appears is simply whatever profile picture is uploaded to @roxy-commits.
 */
export const ROXY_COAUTHOR_TRAILER =
  'Co-authored-by: Roxy <299891354+roxy-commits@users.noreply.github.com>'

/**
 * The system-prompt instruction that tells the model to append {@link
 * ROXY_COAUTHOR_TRAILER} to commits it authors — the same mechanism Copilot CLI
 * uses to co-author every commit. Kept as a standalone block so it reads clearly
 * in the assembled prompt and can be reused by the subagent prompt path. Phrased
 * conditionally ("When you create a git commit") so it never conflicts with the
 * tuned prompts that forbid committing unless the user asks.
 */
export const GIT_COMMIT_TRAILER_PROMPT = [
  '<git_commit_trailer>',
  'When you create a git commit, add the following Co-authored-by trailer at the end of the commit message so the work is attributed to Roxy, unless the user explicitly asks you not to:',
  '',
  ROXY_COAUTHOR_TRAILER,
  '</git_commit_trailer>'
].join('\n')

/** Join the base prompt, environment, any extra sections, and a compaction summary. */
export function assembleSystemPrompt(input: AssembleInput): string {
  const sections: (string | undefined)[] = [
    input.base,
    input.environment,
    ...(input.extra ?? []),
    // Attribute Roxy on every commit the model writes (mirrors Copilot). Placed
    // after the base/env/extra so it sits with the standing instructions, and
    // before the compaction summary so the summary stays last.
    GIT_COMMIT_TRAILER_PROMPT,
    input.contextSummary
      ? `Summary of the earlier conversation (compacted to save context):\n${input.contextSummary}`
      : undefined
  ]
  return sections
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .join('\n\n')
}
