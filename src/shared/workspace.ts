/**
 * Pure path math for worktree-backed sessions — no DB, no Node, no Electron, so
 * it can be unit-tested directly (`npm run smoke:shared`).
 *
 * The DB-backed resolver that actually gets used lives in
 * `main/services/workspace.ts`; this file holds the one non-obvious rule it
 * depends on, so the rule can be tested without a database.
 */

/** Minimal `path` surface, injected so this module stays platform-agnostic. */
export interface PathOps {
  relative(from: string, to: string): string
  join(...parts: string[]): string
  isAbsolute(p: string): boolean
}

/**
 * Where a session runs, given its project folder and (optional) worktree.
 *
 * The subtlety: a Roxy project is any folder the user picked, which may be a
 * SUBFOLDER of the repo (`~/repo/apps/web`). A worktree is a checkout of the
 * whole repo, so pointing the session at the worktree root would silently move
 * the agent out of the folder it was opened in. The relative path from the repo
 * root to the project folder is preserved:
 *
 *   workspace  ~/repo/apps/web
 *   repoRoot   ~/repo
 *   worktree   ~/.roxy/worktrees/repo/fix-auth
 *   result     ~/.roxy/worktrees/repo/fix-auth/apps/web
 *
 * Falls back to `workspacePath` whenever the mapping can't be trusted: no
 * worktree, no repo root, or a workspace that isn't actually inside the repo.
 */
export function resolveWorktreeCwd(
  workspacePath: string,
  worktreePath: string | null | undefined,
  repoRoot: string | null | undefined,
  p: PathOps
): string {
  if (!workspacePath) return ''
  if (!worktreePath) return workspacePath
  if (!repoRoot) return workspacePath
  const rel = p.relative(repoRoot, workspacePath)
  // '' means the project IS the repo root — use the worktree as-is.
  if (!rel) return worktreePath
  // Escaping ('..') or absolute means workspacePath isn't under repoRoot; the
  // mapping would be nonsense, so stay put rather than guess.
  if (rel.startsWith('..') || p.isAbsolute(rel)) return workspacePath
  return p.join(worktreePath, rel)
}
