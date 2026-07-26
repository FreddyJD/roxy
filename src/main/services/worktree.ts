/**
 * Worktree lifecycle on top of `git.ts` — creating a session's isolated
 * checkout, and cleaning up ones nothing points at any more.
 *
 * The key policy lives here rather than in `git.ts`: a worktree is materialized
 * LAZILY, on a session's first turn. Creating it when the session is created
 * would litter the disk with directories for every composer someone opened and
 * abandoned. And because it happens on the turn path, failure must be soft — a
 * missing git binary, a locked index or an offline fetch degrades to "run in the
 * project folder", never to a turn that won't start.
 */
import {
  DEFAULT_BRANCH_PREFIX,
  branchNameError,
  isPlaceholderBranch,
  normalizeBranchPrefix
} from '../../shared/branch'
import { slugToBranchSegment } from '../../shared/slugs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as repo from '../db/repo'
import * as git from './git'
import { ensureDevPort } from './ports'
import { startBackground, killSessionBackground } from '../harness'
import { activeBackgroundSubChatIds, hasActiveBackgroundJobs } from './background-tasks'
import type { WorktreeIntent } from '../../shared/types'

/**
 * Optional per-project worktree config, read from `<project>/.roxy/worktree.json`
 * — the same convention as `.roxy/mcp.json` (see services/mcp.ts).
 *
 *   { "setup": "cp $ROXY_PROJECT_ROOT/.env . && pnpm install" }
 */
export interface WorktreeConfig {
  /** Shell command run in a NEW worktree, once, right after it's created. */
  setup?: string
}

/**
 * Read `.roxy/worktree.json`. Missing or malformed yields `{}` — a broken
 * config must degrade to "no setup script", never break worktree creation.
 */
export function loadWorktreeConfig(projectRoot: string): WorktreeConfig {
  if (!projectRoot) return {}
  const file = path.join(projectRoot, '.roxy', 'worktree.json')
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as WorktreeConfig
    if (!parsed || typeof parsed !== 'object') return {}
    return { setup: typeof parsed.setup === 'string' ? parsed.setup : undefined }
  } catch {
    return {}
  }
}

/**
 * Run the project's setup script in a freshly created worktree.
 *
 * A new worktree has an EMPTY node_modules and no .env — git only tracks what's
 * committed. There is deliberately no auto-copy and no symlink here:
 *   - copying node_modules costs gigabytes per session, and native modules are
 *     built per platform/arch anyway;
 *   - symlinking it to the main checkout would let one branch's `npm install`
 *     mutate every other session's dependencies, which destroys the isolation
 *     this whole feature exists to provide.
 * So the user declares what their project needs, and we run it.
 *
 * It goes through `startBackground` — the same path the `bash` tool uses — so
 * the install shows up in bash_list, streams its output, is owned by the
 * session, and is killed when the session is deleted. Never awaited: a
 * `pnpm install` takes minutes and must not hold up the turn.
 */
function runSetupScript(input: {
  chatId: string
  projectRoot: string
  worktreePath: string
  devPort: number | null
}): void {
  const { setup } = loadWorktreeConfig(input.projectRoot)
  if (!setup?.trim()) return
  try {
    startBackground(setup, input.worktreePath, repo.rootSessionId(input.chatId), {
      ROXY_PROJECT_ROOT: input.projectRoot,
      ROXY_WORKTREE_PATH: input.worktreePath,
      ...(input.devPort ? { ROXY_PORT: String(input.devPort), PORT: String(input.devPort) } : {})
    })
  } catch (e) {
    // A failing setup script must never block the turn.
    console.warn('[worktree] setup script failed to start:', e)
  }
}

export interface MaterializeResult {
  /** True when the session now has a worktree (created, attached, or already had one). */
  ok: boolean
  worktreePath?: string
  branch?: string
  /** Set when we fell back to the project folder; safe to show the user. */
  error?: string
}

/**
 * Give a session the worktree it asked for, if it asked for one.
 *
 * Called on the turn path, so it returns quickly when there's nothing to do
 * (the overwhelmingly common case: no pending intent). The intent is cleared
 * whatever happens — on success it's fulfilled, and on failure retrying it every
 * single turn would just stall each one behind another doomed git call.
 */
export async function materializePendingWorktree(chatId: string): Promise<MaterializeResult> {
  const chat = repo.getChat(chatId)
  if (!chat) return { ok: false }
  const intent = chat.worktreePending
  if (!intent) return { ok: false }
  // Sub-sessions run in their parent's tree and must never own a worktree.
  if (chat.kind === 'sub') {
    repo.setChatWorktreePending(chatId, null)
    return { ok: false }
  }
  // Already has one — the intent is stale (e.g. two turns raced).
  if (chat.worktreePath) {
    repo.setChatWorktreePending(chatId, null)
    return { ok: true, worktreePath: chat.worktreePath, branch: chat.branch ?? undefined }
  }

  const workspace = chat.workspacePath
  if (!workspace) {
    repo.setChatWorktreePending(chatId, null)
    return { ok: false }
  }

  const result = await createForWorkspace(workspace, intent, chat.title)
  // Clear the intent either way: fulfilled, or failed and falling back.
  repo.setChatWorktreePending(chatId, null)
  if (!result.ok || !result.worktreePath) return result

  repo.setChatWorktree(chatId, {
    worktreePath: result.worktreePath,
    branch: result.branch ?? null
  })

  // Give the session its own dev port before the setup script runs, so an
  // install that builds against a port sees the right one. Allocation failure
  // (range exhausted) is not fatal — the session just has no reserved port.
  const devPort = await ensureDevPort(chatId)

  // Fire-and-forget: installs take minutes, and the turn starts now.
  runSetupScript({
    chatId,
    projectRoot: workspace,
    worktreePath: result.worktreePath,
    devPort
  })

  return result
}

/** Resolve the repo, pick a branch, and create/attach the worktree. */
async function createForWorkspace(
  workspace: string,
  intent: WorktreeIntent,
  title: string
): Promise<MaterializeResult> {
  if (!(await git.isGitAvailable())) {
    return { ok: false, error: 'Git isn’t installed, so this session runs in the project folder.' }
  }
  const root = await git.repoRoot(workspace)
  if (!root) {
    return { ok: false, error: 'This folder isn’t a git repository, so the session runs in place.' }
  }

  try {
    if (intent.mode === 'new') {
      // Name the branch after the session, so `roxy/legacy-ogre-apprentice`
      // shows up in `git branch` and on the PR instead of `roxy/6fdc60b8`.
      const branch = intent.branch?.trim() || (await git.branchNameForTitle(root, title))
      const r = await git.createWorktree({ repoRoot: root, branch })
      if (!r.ok || !r.worktree)
        return { ok: false, error: r.error ?? 'Could not create the worktree.' }
      return { ok: true, worktreePath: r.worktree.path, branch: r.worktree.branch ?? branch }
    }

    // fromBranch / attach both target an existing branch; attachWorktree
    // already reuses an existing worktree when the branch is checked out
    // elsewhere, which is what git itself refuses to do.
    const branch = intent.branch?.trim()
    if (!branch) return { ok: false, error: 'No branch was given for the worktree.' }
    const r = await git.attachWorktree({ repoRoot: root, branch })
    if (!r.ok || !r.worktree)
      return { ok: false, error: r.error ?? 'Could not check out the branch.' }
    return { ok: true, worktreePath: r.worktree.path, branch: r.worktree.branch ?? branch }
  } catch (e) {
    // git.ts doesn't throw, but a caller bug here must still not break a turn.
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface PruneCandidate {
  path: string
  branch: string | null
}

export interface PruneResult {
  ok: boolean
  /** Worktrees no session points at. */
  candidates: PruneCandidate[]
  removed: string[]
  failed: { path: string; error: string }[]
  error?: string
}

/**
 * Find (and optionally remove) worktrees under `workspace`'s repo that no
 * session points at any more.
 *
 * Roxy's own cleanup on session delete can always be escaped — a crash between
 * creating a worktree and saving its path, a session deleted from the phone, a
 * DB reset. Without a prune command those directories accumulate silently, so
 * this exists from day one rather than being added after the complaints.
 *
 * `dryRun` (the default) only reports, so the UI can confirm before deleting.
 */
export async function pruneWorktrees(
  workspace: string,
  opts: { dryRun?: boolean; force?: boolean } = {}
): Promise<PruneResult> {
  const empty: PruneResult = { ok: false, candidates: [], removed: [], failed: [] }
  if (!(await git.isGitAvailable())) return { ...empty, error: 'Git isn’t installed.' }
  const root = await git.repoRoot(workspace)
  if (!root) return { ...empty, error: 'This folder isn’t a git repository.' }

  const worktrees = await git.listWorktrees(root)
  // Normalized so a case/separator difference doesn't make a live worktree look
  // orphaned and get deleted out from under a session.
  const claimed = new Set(repo.listWorktreePaths().map(normalizePath))
  const candidates = worktrees
    .filter((w) => !w.isMain && !claimed.has(normalizePath(w.path)))
    .map((w) => ({ path: w.path, branch: w.branch }))

  if (opts.dryRun !== false) return { ok: true, candidates, removed: [], failed: [] }

  const removed: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const c of candidates) {
    const r = await git.removeWorktree(c.path, { force: opts.force })
    if (r.ok) removed.push(c.path)
    else failed.push({ path: c.path, error: r.error ?? 'Unknown error' })
  }
  return { ok: true, candidates, removed, failed }
}

/**
 * Rename the branch a session's workstream sits on.
 *
 * Renaming is safe while the branch is checked out: git rewrites the worktree's
 * HEAD in place, so the directory, its node_modules and any uncommitted work
 * are untouched. The DB pointer is updated to match; the worktree PATH is
 * deliberately left alone, because moving a live directory would invalidate
 * every running dev server and open file handle in it for a cosmetic gain.
 */
export async function renameWorkstreamBranch(
  chatId: string,
  to: string
): Promise<{ ok: boolean; branch?: string; error?: string }> {
  const chat = repo.getChat(chatId)
  if (!chat) return { ok: false, error: 'Session not found.' }

  // A sub-session shares its parent's tree; renaming from there would move the
  // parent's branch out from under it.
  const owner = chat.kind === 'sub' && chat.parentId ? repo.getChat(chat.parentId) : chat
  if (!owner?.worktreePath) return { ok: false, error: 'This session has no workstream.' }

  const next = to.trim()
  const problem = branchNameError(next)
  if (problem) return { ok: false, error: problem }

  const from = owner.branch ?? (await git.currentBranch(owner.worktreePath))
  if (!from) return { ok: false, error: 'Could not determine the current branch.' }
  if (from === next) return { ok: true, branch: next }

  // Once a branch is pushed, renaming it locally strands the remote under the
  // old name (git only moves the local ref) and any open PR with it. Refuse
  // rather than quietly desynchronize the two.
  if (await git.hasUpstreamBranch(owner.worktreePath, from)) {
    return {
      ok: false,
      error: `"${from}" has already been pushed - rename it on the remote instead.`
    }
  }

  // Run from the worktree itself: it is the path we are certain exists, and git
  // resolves the common repo from there.
  const r = await git.renameBranch(owner.worktreePath, from, next)
  if (!r.ok) return { ok: false, error: r.error }

  repo.setChatWorktree(owner.id, { branch: next })
  return { ok: true, branch: next }
}

/**
 * Rename a session's branch to match a NEW session title, when that is safe.
 *
 * Called when the agent retitles a session (`change_session_metadata`), so a
 * session that starts on a random slug and becomes "Fix auth token refresh"
 * does not keep a branch named after the slug forever.
 *
 * Best-effort and silent by design: this rides along with a metadata update the
 * model asked for, so a refusal must never fail that update. Every skip is a
 * deliberate rule rather than a fallback:
 *
 *   - the branch is not one WE generated -> someone named it on purpose;
 *   - it has been pushed -> the remote, and any open PR, would be stranded;
 *   - the new title yields nothing usable, or the name is already taken.
 */
export async function syncBranchToTitle(
  chatId: string,
  title: string
): Promise<{ renamed: boolean; branch?: string }> {
  try {
    const chat = repo.getChat(chatId)
    if (!chat?.worktreePath || !chat.branch) return { renamed: false }

    // Only ever reclaim a name we generated. A branch the user (or the agent,
    // earlier) chose deliberately is not ours to rewrite.
    if (!isPlaceholderBranch(chat.branch, branchPrefixSetting())) return { renamed: false }
    if (await git.hasUpstreamBranch(chat.worktreePath, chat.branch)) return { renamed: false }

    // An unusable title (emoji-only, say) makes branchNameForTitle fall back to
    // hex; swapping one generated name for another is churn, not information.
    if (!slugToBranchSegment(title)) return { renamed: false }

    const next = await git.branchNameForTitle(chat.worktreePath, title)
    if (!next || next === chat.branch) return { renamed: false }

    const r = await git.renameBranch(chat.worktreePath, chat.branch, next)
    if (!r.ok) return { renamed: false }

    repo.setChatWorktree(chat.id, { branch: next })
    return { renamed: true, branch: next }
  } catch {
    // A metadata update must never fail because a branch rename did.
    return { renamed: false }
  }
}

/** The configured branch prefix, for deciding what counts as auto-generated. */
function branchPrefixSetting(): string {
  try {
    return normalizeBranchPrefix(repo.getSettings().branchPrefix)
  } catch {
    return DEFAULT_BRANCH_PREFIX
  }
}

/**
 * Remove a session's worktree, if it owns one no other session shares.
 *
 * ORDERING IS LOAD-BEARING on Windows: a dev server still running in the
 * worktree holds open handles inside node_modules/.next, and `git worktree
 * remove` then fails with a lock error. So the session's background processes
 * are killed FIRST and the kill is awaited (process teardown is not
 * synchronous — taskkill /t needs a moment to reap the tree) before git is
 * asked to delete the directory.
 *
 * Never blocks session deletion: a shared worktree, a still-running background
 * subagent, or a git refusal are all reported and left alone rather than
 * raising. Whatever survives is swept up later by `pruneWorktrees`.
 *
 * UNCOMMITTED WORK IS NEVER DISCARDED. `force` defaults to false so git's own
 * refusal to delete a dirty tree is respected: the directory stays, the session
 * goes, and `pruneWorktrees` lists it later. This matters far more now that
 * sessions get a workstream by DEFAULT -- deleting a session used to throw away
 * a chat log, and would otherwise now throw away the code too, with no
 * confirmation and no reflog entry to recover from.
 */
export async function removeWorktreeForChat(
  chatId: string,
  opts: { force?: boolean } = {}
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const chat = repo.getChat(chatId)
  const target = chat?.worktreePath
  if (!target) return { ok: true, removed: false }

  // Shared with another session — never auto-remove (T3's mistake).
  const others = repo.chatsUsingWorktree(target).filter((c) => c.id !== chatId)
  if (others.length) return { ok: true, removed: false }

  // A detached background subagent deliberately outlives the turn that launched
  // it (see services/background-tasks.ts). Deleting the tree out from under one
  // turns every tool call it makes into an ENOENT, so leave it be.
  const busy = activeBackgroundSubChatIds()
  const subIds = repo.listSubchats(chatId).map((c) => c.id)
  if (hasActiveBackgroundJobs(chatId) || subIds.some((id) => busy.has(id))) {
    return {
      ok: false,
      removed: false,
      error: 'A background task is still running in this worktree, so it was left in place.'
    }
  }

  // Stop dev servers/watchers before git touches the directory. Awaited: the
  // kill has to have actually happened, not merely been requested.
  await stopSessionProcesses(chatId)

  const r = await git.removeWorktree(target, { force: opts.force ?? false })
  if (!r.ok) {
    return {
      ok: false,
      removed: false,
      error: r.error ?? 'The workstream has uncommitted changes, so its folder was left in place.'
    }
  }
  return { ok: true, removed: true }
}

/**
 * Kill a session's background processes and give the OS a moment to release
 * their file handles.
 *
 * On Windows the process tree is torn down asynchronously by `taskkill /t`, so
 * returning the instant kill() is called would race `git worktree remove`
 * straight back into the lock error this exists to avoid.
 */
async function stopSessionProcesses(chatId: string): Promise<void> {
  const killed = killSessionBackground(repo.rootSessionId(chatId))
  if (killed > 0) await new Promise((r) => setTimeout(r, 300))
}

/**
 * One spelling for path comparison: fully resolved (git's form, not an 8.3 short
 * name), then lowercased on Windows where the filesystem is case-insensitive.
 * Getting this wrong makes a live worktree look orphaned — and prune deletes it.
 */
function normalizePath(p: string): string {
  const trimmed = git.canonicalPath(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}
