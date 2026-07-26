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
import * as repo from '../db/repo'
import * as git from './git'
import type { WorktreeIntent } from '../../shared/types'

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

  const result = await createForWorkspace(workspace, intent)
  // Clear the intent either way: fulfilled, or failed and falling back.
  repo.setChatWorktreePending(chatId, null)
  if (!result.ok || !result.worktreePath) return result

  repo.setChatWorktree(chatId, {
    worktreePath: result.worktreePath,
    branch: result.branch ?? null
  })
  return result
}

/** Resolve the repo, pick a branch, and create/attach the worktree. */
async function createForWorkspace(
  workspace: string,
  intent: WorktreeIntent
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
      const branch = intent.branch?.trim() || git.temporaryBranchName()
      const r = await git.createWorktree({ repoRoot: root, branch })
      if (!r.ok || !r.worktree) return { ok: false, error: r.error ?? 'Could not create the worktree.' }
      return { ok: true, worktreePath: r.worktree.path, branch: r.worktree.branch ?? branch }
    }

    // fromBranch / attach both target an existing branch; attachWorktree
    // already reuses an existing worktree when the branch is checked out
    // elsewhere, which is what git itself refuses to do.
    const branch = intent.branch?.trim()
    if (!branch) return { ok: false, error: 'No branch was given for the worktree.' }
    const r = await git.attachWorktree({ repoRoot: root, branch })
    if (!r.ok || !r.worktree) return { ok: false, error: r.error ?? 'Could not check out the branch.' }
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
 * Remove a session's worktree, if it owns one no other session shares.
 *
 * Never blocks session deletion: a worktree still in use, or one git refuses to
 * remove (a live dev server holding a handle on Windows), is reported and left
 * alone rather than raising.
 */
export async function removeWorktreeForChat(
  chatId: string,
  opts: { force?: boolean } = {}
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const chat = repo.getChat(chatId)
  const target = chat?.worktreePath
  if (!target) return { ok: true, removed: false }
  // Shared with another session (T3's mistake was auto-removing these).
  const others = repo.chatsUsingWorktree(target).filter((c) => c.id !== chatId)
  if (others.length) return { ok: true, removed: false }
  const r = await git.removeWorktree(target, { force: opts.force ?? true })
  return { ok: r.ok, removed: r.ok, error: r.error }
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
