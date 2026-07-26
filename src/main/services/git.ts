/**
 * A thin, safe wrapper around the `git` binary — the foundation for
 * worktree-backed sessions (several agents working the same repo in parallel,
 * each in its own isolated checkout on its own branch).
 *
 * Design rules, all deliberate:
 *
 *  - NO npm dependency. `git` is already on the machine of anyone this feature
 *    is for, and a JS reimplementation would diverge from the real thing.
 *  - Every call is `spawn(git, [args])` with an argument ARRAY and
 *    `shell: false`. Branch names and paths are user data; interpolating them
 *    into a shell string would be a command-injection hole, and would break on
 *    Windows paths with spaces besides.
 *  - Nothing here throws into a caller. Git failures are normal (no remote,
 *    detached HEAD, offline, a branch checked out elsewhere) and must never take
 *    down a turn, so everything returns a typed result or null.
 *  - Commands are serialized per repository. Git takes an index/ref lock, and N
 *    concurrent sessions on one repo would otherwise race it.
 *
 * Git — not the database — stays the source of truth for worktrees and branches.
 * The DB only stores a pointer (`chats.worktree_path`).
 */
import { spawn } from 'node:child_process'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { slugToBranchSegment } from '../../shared/slugs'
import {
  DEFAULT_BRANCH_PREFIX,
  isPlaceholderBranch,
  normalizeBranchPrefix,
  placeholderBranchName
} from '../../shared/branch'
import * as repo from '../db/repo'

/** How long any single git command may run before it's killed. */
const GIT_TIMEOUT_MS = 30_000
/** `git fetch` talks to the network, so it gets a longer leash. */
const FETCH_TIMEOUT_MS = 60_000
/** Cap git's stdout so a pathological repo can't balloon memory. */
const MAX_GIT_OUTPUT = 2_000_000

/** Fallback prefix when settings haven't been read (tests, early startup). */
export const WORKTREE_BRANCH_PREFIX = DEFAULT_BRANCH_PREFIX

/**
 * The user's configured branch prefix, normalized.
 *
 * Read per call rather than cached: changing it in Settings has to affect the
 * very next workstream, and this is one indexed row.
 */
function branchPrefix(): string {
  try {
    return normalizeBranchPrefix(repo.getSettings().branchPrefix)
  } catch {
    // No settings yet (early startup, or a test without a DB) - fall back.
    return DEFAULT_BRANCH_PREFIX
  }
}
/** The git config key that remembers which branch a workstream should merge into. */
const BASE_CONFIG_SUFFIX = 'roxy-base'

/**
 * One canonical spelling for a path, so ours and git's always compare equal.
 *
 * Git prints fully-resolved forward-slash paths. Node hands back whatever the
 * caller had — which on Windows is routinely an 8.3 short name
 * (`C:\Users\FREDDY~1\...` from %TEMP%) or a different drive-letter case.
 * Comparing those two spellings as strings silently fails, which would make a
 * live worktree look orphaned and get pruned out from under a session.
 *
 * `realpathSync.native` is the one that expands short names on Windows; the
 * portable `realpathSync` does not. Falls back to `path.normalize` when the
 * path doesn't exist (a worktree we're about to create).
 */
export function canonicalPath(p: string): string {
  if (!p) return ''
  try {
    return path.normalize(realpathSync.native(p))
  } catch {
    return path.normalize(p)
  }
}

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

export interface WorktreeInfo {
  path: string
  /** Short branch name, or null when the worktree is on a detached HEAD. */
  branch: string | null
  head: string | null
  /** True for the repository's own main working tree (never removable). */
  isMain: boolean
}

export interface GitStatus {
  dirty: boolean
  /** Number of changed entries (staged, unstaged and untracked). */
  changed: number
  ahead: number
  behind: number
  branch: string | null
  /** True when the branch has an upstream to compare against. */
  hasUpstream: boolean
  /**
   * The upstream ref this branch is measured against, e.g. `origin/main`.
   *
   * Kept alongside `hasUpstream` because it is what a sync action has to NAME.
   * "Update from origin/main" is a promise the user can verify; "pull" is a
   * guess about which of possibly several remotes we meant.
   */
  upstream: string | null
}

/** The outcome of a fast-forward or a reset. */
export interface SyncResult {
  ok: boolean
  error?: string
  /** The ref we synced to (or would have), once we knew it. */
  upstream?: string
  /** False when the branch was already there and nothing moved. */
  updated?: boolean
  /** True when a reset parked uncommitted work in the stash first. */
  stashed?: boolean
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Serialize git per repository.
 *
 * Two sessions creating worktrees in the same repo at the same moment will race
 * git's index lock and one gets a confusing "Unable to create .git/index.lock"
 * failure. Each repo root owns a promise chain; commands queue behind it. Keyed
 * by the resolved repo root when we know it, else by cwd.
 */
const repoLocks = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve()
  // `.catch` keeps one failure from poisoning every queued command behind it.
  const next = prev.then(task, task)
  repoLocks.set(
    key,
    next.catch(() => undefined)
  )
  // Drop the entry once the chain drains, so the map doesn't grow forever.
  void next
    .catch(() => undefined)
    .finally(() => {
      if (repoLocks.get(key) === undefined) repoLocks.delete(key)
    })
  return next
}

/**
 * Run one git command. Never throws — a missing binary, a non-zero exit and a
 * timeout all come back as `{ ok: false }` with whatever stderr git produced.
 */
function execGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, {
        cwd: cwd || undefined,
        // shell:false is the point — args stay an array, so a branch name can
        // never be interpreted as shell syntax.
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          // Git must never stop for credentials or an editor: this runs headless
          // inside the app, and a prompt would hang the command until timeout.
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_EDITOR: 'true',
          GCM_INTERACTIVE: 'never'
        }
      })
    } catch (e) {
      resolve({
        ok: false,
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
        code: null
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (r: GitResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, stdout, stderr: `git timed out after ${timeoutMs}ms`, code: null })
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_GIT_OUTPUT) stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_GIT_OUTPUT) stderr += d.toString()
    })
    child.on('error', (e) => finish({ ok: false, stdout, stderr: e.message, code: null }))
    child.on('close', (code) => finish({ ok: code === 0, stdout, stderr, code: code ?? null }))
  })
}

/** Run a git command serialized against everything else touching this repo. */
function git(args: string[], cwd: string, timeoutMs?: number): Promise<GitResult> {
  return serialize(cwd, () => execGit(args, cwd, timeoutMs))
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

let gitAvailable: boolean | null = null

/**
 * Whether a usable `git` binary exists. Probed once and cached: worktree UI is
 * hidden entirely when this is false, so it's checked on a hot path.
 */
export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable
  const r = await execGit(['--version'], process.cwd(), 5_000)
  gitAvailable = r.ok && /git version/i.test(r.stdout)
  return gitAvailable
}

/** Test-only: forget the cached probe. */
export function _resetGitAvailability(): void {
  gitAvailable = null
}

// ---------------------------------------------------------------------------
// Repository queries
// ---------------------------------------------------------------------------

/** The repository root containing `cwd`, or null when it isn't in a repo. */
export async function repoRoot(cwd: string): Promise<string | null> {
  if (!cwd) return null
  const r = await git(['rev-parse', '--show-toplevel'], cwd)
  if (!r.ok) return null
  const out = r.stdout.trim()
  return out ? canonicalPath(out) : null
}

/** The checked-out branch, or null when detached / not a repo. */
export async function currentBranch(cwd: string): Promise<string | null> {
  if (!cwd) return null
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (!r.ok) return null
  const name = r.stdout.trim()
  return !name || name === 'HEAD' ? null : name
}

/**
 * Resolve `rev` to a commit sha in `cwd`, or null when it doesn't exist.
 *
 * The null is the point: callers use this to check that a ref they recorded
 * earlier (a fork's base commit, say) is still there, so a branch deleted in
 * the meantime degrades to a different base instead of a `fatal:` on the path
 * that was going to use it. Defaults to HEAD.
 */
export async function resolveCommit(cwd: string, rev = 'HEAD'): Promise<string | null> {
  if (!cwd) return null
  const r = await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], cwd)
  const sha = r.stdout.trim()
  return r.ok && sha ? sha : null
}

/**
 * Local branches plus remote-tracking branches, deduped and sorted.
 *
 * `origin/feature` collapses to `feature` so the picker shows one entry per
 * logical branch — checking out a remote-only branch by its short name is what
 * git does anyway (DWIM).
 */
export async function listBranches(cwd: string): Promise<string[]> {
  if (!cwd) return []
  const r = await git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'],
    cwd
  )
  if (!r.ok) return []
  const names = new Set<string>()
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // `origin/HEAD` is a symref pointing at the default branch, not a branch.
    if (line === 'origin/HEAD' || line.endsWith('/HEAD')) continue
    names.add(line.startsWith('origin/') ? line.slice('origin/'.length) : line)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * The MAIN working tree of the repo that owns `cwd`.
 *
 * `rev-parse --show-toplevel` inside a worktree returns the WORKTREE, not the
 * repo — so it's the wrong tool for "which of these is the real checkout" or
 * "where do I run a command that operates on this worktree". `--git-common-dir`
 * always points at the real `.git` directory, shared by every worktree; its
 * parent is the main working tree.
 */
async function mainWorktreeRoot(cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  const out = r.stdout.trim()
  if (r.ok && out) return canonicalPath(path.dirname(out))
  return repoRoot(cwd)
}

/**
 * Every worktree git knows about, with stale entries dropped.
 *
 * Git keeps administrative records for worktrees whose directory was deleted
 * behind its back, so each path is stat'd and only live ones are returned —
 * otherwise the branch picker offers to "attach" to a directory that's gone.
 */
export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  if (!root) return []
  const r = await git(['worktree', 'list', '--porcelain'], root)
  if (!r.ok) return []

  const entries: WorktreeInfo[] = []
  let cur: Partial<WorktreeInfo> & { path?: string } = {}
  const flush = (): void => {
    if (cur.path) {
      entries.push({
        path: canonicalPath(cur.path),
        branch: cur.branch ?? null,
        head: cur.head ?? null,
        isMain: false
      })
    }
    cur = {}
  }
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      cur.path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      // e.g. "branch refs/heads/fix-auth" -> "fix-auth"
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'detached') {
      cur.branch = null
    }
  }
  flush()

  // Flag the repo's own working tree by identity rather than by position: it's
  // the parent of the shared .git directory. Prune must never offer to delete it.
  const main = await mainWorktreeRoot(root)
  for (const e of entries) e.isMain = main !== null && e.path === main

  const live = await Promise.all(
    entries.map(async (e) => {
      try {
        const st = await fs.stat(e.path)
        return st.isDirectory() ? e : null
      } catch {
        return null // git still has a record, but the directory is gone
      }
    })
  )
  return live.filter((e): e is WorktreeInfo => e !== null)
}

/**
 * The repo's default branch — what a new workstream branches off.
 *
 * Tries origin/HEAD (what the remote says), then a local main/master, then
 * whatever is currently checked out. Null only when the repo has no commits.
 */
export async function defaultBranch(cwd: string): Promise<string | null> {
  if (!cwd) return null
  const sym = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)
  if (sym.ok) {
    const name = sym.stdout.trim().replace(/^origin\//, '')
    if (name) return name
  }
  for (const candidate of ['main', 'master']) {
    const r = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], cwd)
    if (r.ok && r.stdout.trim()) return candidate
  }
  return await currentBranch(cwd)
}

/** Fetch from a remote (default `origin`). Fails harmlessly when offline. */
export async function fetchOrigin(cwd: string, remote = 'origin'): Promise<GitResult> {
  return git(['fetch', '--quiet', remote], cwd, FETCH_TIMEOUT_MS)
}

/**
 * The remote a branch tracks, e.g. `origin`.
 *
 * Read from config rather than split off the front of `origin/main`: a remote
 * name may itself contain a slash, and guessing wrong means fetching the wrong
 * server and then "updating" from a stale ref — a silent wrong answer, which is
 * the worst kind for a sync button.
 */
export async function upstreamRemote(cwd: string, branch: string): Promise<string | null> {
  if (!cwd || !branch) return null
  const r = await git(['config', '--get', `branch.${branch}.remote`], cwd)
  const name = r.stdout.trim()
  return r.ok && name ? name : null
}

/** Whether the repo has an `origin` remote configured. */
export async function hasOrigin(cwd: string): Promise<boolean> {
  const r = await git(['remote'], cwd)
  return r.ok && r.stdout.split('\n').some((l) => l.trim() === 'origin')
}

/**
 * The fetch URL of a remote (default `origin`) - the input to forge detection.
 *
 * Uses `remote get-url` rather than parsing `git remote -v`, whose output
 * carries a `(fetch)`/`(push)` suffix that has to be stripped. This form also
 * honours `insteadOf` rewrites the same way git itself does, so a corporate
 * `url.<base>.insteadOf` rule resolves to the URL actually in use.
 */
export async function remoteUrl(cwd: string, name = 'origin'): Promise<string | null> {
  if (!cwd) return null
  const r = await git(['remote', 'get-url', name], cwd)
  const out = r.stdout.trim().split('\n')[0]?.trim()
  return r.ok && out ? out : null
}

/**
 * Push a branch to origin, optionally setting upstream.
 *
 * Deliberately NOT forced, and deliberately not offering `--force-with-lease`:
 * this is reachable from a one-click chip, and a single click that can destroy
 * a colleague's commits is not an acceptable thing to build. A rejected push
 * surfaces git's own error and the user resolves it deliberately.
 *
 * Takes the network timeout, since a push talks to the remote.
 */
export async function pushBranch(
  cwd: string,
  branch: string,
  opts: { setUpstream?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  if (!cwd || !branch) return { ok: false, error: 'push: missing cwd or branch' }
  const args = ['push']
  if (opts.setUpstream) args.push('--set-upstream')
  args.push('origin', branch)
  const r = await git(args, cwd, FETCH_TIMEOUT_MS)
  return r.ok ? { ok: true } : { ok: false, error: cleanGitError(r, 'Push failed') }
}
/**
 * Working-tree status: dirty flag, changed-entry count, and ahead/behind vs the
 * upstream. Uses `--porcelain=v2 --branch`, whose header lines carry the branch
 * and ahead/behind without a second command.
 */
export async function status(cwd: string): Promise<GitStatus | null> {
  if (!cwd) return null
  const r = await git(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], cwd)
  if (!r.ok) return null

  let branch: string | null = null
  let ahead = 0
  let behind = 0
  let upstream: string | null = null
  let changed = 0
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trimEnd()
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length).trim()
      branch = v === '(detached)' ? null : v
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (!line.startsWith('#')) {
      changed++
    }
  }
  return { dirty: changed > 0, changed, ahead, behind, branch, hasUpstream: !!upstream, upstream }
}

// ---------------------------------------------------------------------------
// Getting back in sync with the remote
// ---------------------------------------------------------------------------

/**
 * Fast-forward the checked-out branch onto its upstream.
 *
 * Explicitly NOT `git pull`. `pull` is two operations wearing one name, and
 * which ones depend on `pull.rebase`, `pull.ff` and the user's global config —
 * so the same button would merge on one machine, rebase on another, and open an
 * editor on a third. This does exactly one thing on every machine:
 *
 *   fetch, then move the branch pointer forward IF that is all it takes.
 *
 * `--ff-only` is the entire safety model. When the branch has local commits the
 * upstream doesn't, git refuses and nothing is touched: no merge commit, no
 * half-finished rebase with conflict markers in a tree an agent is editing, no
 * state the user has to know git to get out of. They get told to reset (which
 * stashes) or to resolve it themselves, deliberately.
 */
export async function pullFastForward(cwd: string): Promise<SyncResult> {
  if (!cwd) return { ok: false, error: 'pull: missing cwd' }
  const st = await status(cwd)
  if (!st?.branch) return { ok: false, error: 'Not on a branch (detached HEAD).' }
  if (!st.upstream) return { ok: false, error: `"${st.branch}" has no upstream to pull from.` }

  // Fetch first so "behind" is measured against what the server has NOW, not
  // whatever the last poll happened to see.
  const remote = (await upstreamRemote(cwd, st.branch)) ?? 'origin'
  const fetched = await fetchOrigin(cwd, remote)
  if (!fetched.ok) return { ok: false, error: cleanGitError(fetched, `Could not reach ${remote}`) }

  const after = await status(cwd)
  if ((after?.behind ?? 0) === 0) {
    return { ok: true, upstream: st.upstream, updated: false }
  }

  // A dirty tree is fine for a fast-forward as long as no incoming file
  // collides with a local edit — git checks that itself and refuses if so, and
  // its refusal names the files, which is better than any pre-flight we could
  // write here.
  const r = await git(['merge', '--ff-only', st.upstream], cwd, FETCH_TIMEOUT_MS)
  if (!r.ok)
    return { ok: false, error: cleanGitError(r, 'Could not fast-forward'), upstream: st.upstream }
  return { ok: true, upstream: st.upstream, updated: true }
}

/**
 * Hard-reset the branch onto a ref, parking any local work in a stash first.
 *
 * This is the "just give me what's on the server" escape hatch, and it is
 * destructive by definition — so the one thing it guarantees is that nothing is
 * unrecoverable. Uncommitted changes go to the stash BEFORE the reset, with a
 * message naming Roxy and the branch, so `git stash list` shows exactly what
 * happened and `git stash pop` undoes it.
 *
 * `--include-untracked` matters more than it looks: an agent's brand-new files
 * are untracked, and a plain stash would leave them behind to be wiped by the
 * clean step or to collide with incoming files.
 *
 * Local COMMITS are not stashed — they don't need to be. They stay in the reflog
 * and the caller is told the sha to get back to.
 */
export async function resetToUpstream(cwd: string): Promise<SyncResult> {
  if (!cwd) return { ok: false, error: 'reset: missing cwd' }
  const st = await status(cwd)
  if (!st?.branch) return { ok: false, error: 'Not on a branch (detached HEAD).' }
  if (!st.upstream) return { ok: false, error: `"${st.branch}" has no upstream to reset to.` }

  const remote = (await upstreamRemote(cwd, st.branch)) ?? 'origin'
  const fetched = await fetchOrigin(cwd, remote)
  if (!fetched.ok) return { ok: false, error: cleanGitError(fetched, `Could not reach ${remote}`) }

  // Resolve the target BEFORE touching anything, so a typo'd or vanished
  // upstream fails while the tree is still intact.
  const target = await git(['rev-parse', '--verify', '--quiet', `${st.upstream}^{commit}`], cwd)
  if (!target.ok || !target.stdout.trim()) {
    return { ok: false, error: `Could not resolve ${st.upstream}.`, upstream: st.upstream }
  }

  let stashed = false
  if (st.dirty) {
    const label = `roxy: before reset of ${st.branch}`
    const stash = await git(['stash', 'push', '--include-untracked', '-m', label], cwd)
    // Refuse rather than reset anyway: the whole promise of this button is that
    // the work is recoverable, and a failed stash breaks exactly that.
    if (!stash.ok) {
      return {
        ok: false,
        error: cleanGitError(stash, 'Could not stash your changes, so nothing was reset'),
        upstream: st.upstream
      }
    }
    // `stash push` exits 0 with "No local changes to save" when everything that
    // looked dirty was ignored - claiming a stash exists then would send the
    // user to `git stash pop` for something that isn't there.
    stashed = !/no local changes/i.test(stash.stdout + stash.stderr)
  }

  const r = await git(['reset', '--hard', target.stdout.trim()], cwd)
  if (!r.ok) {
    return { ok: false, error: cleanGitError(r, 'Reset failed'), upstream: st.upstream, stashed }
  }
  return { ok: true, upstream: st.upstream, updated: true, stashed }
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

/**
 * A fresh placeholder branch name, e.g. `roxy/a1b2c3d4`.
 *
 * The prefix is a user setting (some people want `wip/`, their initials, or
 * nothing at all), so it is read here rather than baked in as a constant.
 */
export function temporaryBranchName(prefix?: string): string {
  const hex = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return placeholderBranchName(prefix ?? branchPrefix(), hex)
}

/**
 * The branch name for a session titled `title`, guaranteed not to collide.
 *
 * Sessions are already named "Legacy Ogre Apprentice", so the branch reads
 * `roxy/legacy-ogre-apprentice` rather than `roxy/6fdc60b8` — the name means
 * something in `git branch`, in a PR list, and to whoever reviews it.
 *
 * The uniqueness loop matters more than it looks: a branch OUTLIVES its
 * worktree (`git worktree remove` leaves the branch behind), so deleting a
 * session and creating another that draws the same random title is not rare —
 * and `worktree add -b` on an existing branch is a hard failure on the turn
 * path.
 */
export async function branchNameForTitle(root: string, title: string): Promise<string> {
  const segment = slugToBranchSegment(title)
  // Nothing usable survived (an emoji- or CJK-only title): fall back to hex
  // rather than inventing a name.
  if (!segment) return temporaryBranchName()

  const prefix = branchPrefix()
  const base = prefix ? prefix + '/' + segment : segment
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : base + '-' + (i + 1)
    const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], root)
    if (!exists.ok || !exists.stdout.trim()) return candidate
  }
  return temporaryBranchName()
}

/**
 * Whether a branch is still an auto-generated placeholder.
 *
 * Renaming a workstream's branch MUST only ever touch placeholders — clobbering
 * a name the user chose (or one that came from origin) would be data loss, so
 * this is an exact shape rather than a prefix check.
 */
export function isTemporaryBranch(name: string | null | undefined, prefix?: string): boolean {
  return isPlaceholderBranch(name, prefix ?? branchPrefix())
}

/**
 * Rename a branch, and move the workstream's recorded PR base with it.
 *
 * Safe while the branch is checked out in a worktree: git rewrites the
 * worktree's HEAD in place, so the directory and any uncommitted work are
 * untouched. Run from the MAIN repo — a worktree can rename its own branch, but
 * the main tree is the one caller we always have a path to.
 */
export async function renameBranch(
  repoRoot: string,
  from: string,
  to: string
): Promise<{ ok: boolean; error?: string }> {
  if (!repoRoot || !from || !to) return { ok: false, error: 'renameBranch: missing argument' }
  if (from === to) return { ok: true }

  const valid = await git(['check-ref-format', '--branch', to], repoRoot)
  if (!valid.ok) return { ok: false, error: `"${to}" is not a valid branch name.` }

  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${to}`], repoRoot)
  if (exists.ok && exists.stdout.trim()) {
    return { ok: false, error: `A branch named "${to}" already exists.` }
  }

  // -m, never -M: forcing would clobber a branch that a race just created.
  const r = await git(['branch', '-m', from, to], repoRoot)
  if (!r.ok) return { ok: false, error: cleanGitError(r, `Could not rename "${from}"`) }
  return { ok: true }
}

/** Filesystem-safe directory segment for a branch (`feat/x` -> `feat-x`). */
function branchToDirName(branch: string): string {
  return branch.replace(/[/\\]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Where a worktree for `branch` lives: under the app's data dir, never inside
 * the repo. A worktree inside the repo would be walked by file watchers, picked
 * up by glob/grep (the IGNORE list in harness/tools.ts doesn't know about it),
 * and would show up as an untracked directory in git status.
 */
export function worktreePathFor(root: string, branch: string): string {
  const base = app.getPath('userData')
  return path.join(base, 'worktrees', path.basename(root), branchToDirName(branch))
}

/** Ensure the path is free, appending -2, -3, … if a directory already exists. */
async function uniquePath(desired: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? desired : `${desired}-${i + 1}`
    try {
      await fs.stat(candidate)
    } catch {
      return candidate // doesn't exist — take it
    }
  }
  return `${desired}-${Date.now()}`
}

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

export interface CreateWorktreeInput {
  repoRoot: string
  /** The NEW branch to create. */
  branch: string
  /** Commit-ish to branch from. Omitted -> freshly-fetched origin/<default>. */
  baseRef?: string
  /** Explicit directory. Omitted -> the standard userData location. */
  path?: string
  /** The branch this work will eventually merge into (recorded in git config). */
  baseBranch?: string
}

export interface WorktreeResult {
  ok: boolean
  worktree?: WorktreeInfo
  /** True when an existing worktree was reused rather than created. */
  attached?: boolean
  error?: string
}

/**
 * Create a worktree on a NEW branch.
 *
 * Branches off freshly-fetched `origin/<default>` rather than the local ref, so
 * a workstream doesn't start from whatever stale commit the user's local main
 * happens to sit on — that's the difference between a clean PR and one full of
 * unrelated diffs. Falls back to the local ref when there's no origin or the
 * fetch fails (offline is normal, and must still work).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<WorktreeResult> {
  const { repoRoot: root, branch } = input
  if (!root || !branch) return { ok: false, error: 'createWorktree: missing repoRoot or branch' }

  // Reuse rather than fail: git refuses to check a branch out twice, so if this
  // branch already lives in a worktree, hand that one back.
  const existing = (await listWorktrees(root)).find((w) => w.branch === branch)
  if (existing) return { ok: true, worktree: existing, attached: true }

  let baseRef = input.baseRef
  const base = input.baseBranch ?? (await defaultBranch(root))
  if (!baseRef) {
    if (base && (await hasOrigin(root))) {
      await fetchOrigin(root) // best-effort; offline just means a local base
      const remote = await git(
        ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`],
        root
      )
      if (remote.ok && remote.stdout.trim()) baseRef = remote.stdout.trim()
    }
    if (!baseRef && base) {
      const local = await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], root)
      if (local.ok && local.stdout.trim()) baseRef = local.stdout.trim()
    }
    if (!baseRef) baseRef = 'HEAD'
  }

  const target = await uniquePath(input.path ?? worktreePathFor(root, branch))
  const add = await git(['worktree', 'add', '-b', branch, target, baseRef], root)
  if (!add.ok) {
    return { ok: false, error: cleanGitError(add, `Could not create a worktree for "${branch}"`) }
  }

  // Remember the PR base in git config rather than the DB: it survives a DB
  // reset, travels with the repo, and is exactly what `gh pr create --base`
  // wants later.
  if (base) {
    await git(['config', `branch.${branch}.${BASE_CONFIG_SUFFIX}`, base], root)
  }

  return {
    ok: true,
    worktree: { path: canonicalPath(target), branch, head: null, isMain: false }
  }
}

/**
 * Create a worktree for a branch that ALREADY exists (local or origin-only).
 * Attaches to the existing worktree when the branch is checked out elsewhere.
 */
export async function attachWorktree(input: {
  repoRoot: string
  branch: string
  path?: string
}): Promise<WorktreeResult> {
  const { repoRoot: root, branch } = input
  if (!root || !branch) return { ok: false, error: 'attachWorktree: missing repoRoot or branch' }

  const existing = (await listWorktrees(root)).find((w) => w.branch === branch)
  if (existing) return { ok: true, worktree: existing, attached: true }

  const target = await uniquePath(input.path ?? worktreePathFor(root, branch))
  const localRef = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)
  const args =
    localRef.ok && localRef.stdout.trim()
      ? ['worktree', 'add', target, branch]
      : // origin-only: create a local branch tracking the remote one
        ['worktree', 'add', '-b', branch, target, `origin/${branch}`]

  const add = await git(args, root)
  if (!add.ok) {
    return { ok: false, error: cleanGitError(add, `Could not check out "${branch}"`) }
  }
  return {
    ok: true,
    worktree: { path: canonicalPath(target), branch, head: null, isMain: false }
  }
}

/**
 * Remove a worktree and prune git's record of it.
 *
 * Two Windows-specific hazards, both handled here:
 *  - The command must run from the MAIN working tree. Running it with the
 *    worktree as cwd means our own process holds that directory open, and
 *    Windows refuses to delete it ("Permission denied") — on POSIX the same
 *    command happens to succeed, so this only ever fails on Windows.
 *  - It still fails if any OTHER process holds a handle inside (a dev server in
 *    node_modules/.next is the usual culprit), so callers must stop a session's
 *    background processes FIRST.
 */
export async function removeWorktree(
  worktreePath: string,
  opts: { force?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  if (!worktreePath) return { ok: false, error: 'removeWorktree: missing path' }
  const root = (await mainWorktreeRoot(worktreePath)) ?? worktreePath
  const args = ['worktree', 'remove']
  if (opts.force) args.push('--force')
  args.push(worktreePath)
  const r = await git(args, root)
  if (!r.ok) {
    // The directory may already be gone; prune git's stale record either way.
    await git(['worktree', 'prune'], root)
    try {
      await fs.stat(worktreePath)
    } catch {
      return { ok: true } // nothing left on disk — treat as removed
    }
    return { ok: false, error: cleanGitError(r, 'Could not remove the worktree') }
  }
  await git(['worktree', 'prune'], root)
  return { ok: true }
}

/**
 * Has this branch ever been pushed?
 *
 * Renaming a pushed branch is a trap: git renames only the LOCAL ref, so the
 * remote keeps the old name and the renamed branch still tracks it. The next
 * push either recreates the old branch or updates it under a name nobody
 * recognizes, and an open PR points at a branch that no longer exists locally.
 * So the rename paths refuse once a branch has an upstream.
 *
 * Reads config rather than `rev-parse @{upstream}` so it works for any branch,
 * not just the one currently checked out.
 */
export async function hasUpstreamBranch(cwd: string, branch: string): Promise<boolean> {
  if (!cwd || !branch) return false
  const r = await git(['config', '--get', `branch.${branch}.remote`], cwd)
  return r.ok && !!r.stdout.trim()
}

/** The branch a workstream should merge into, as recorded at creation. */
export async function baseBranchFor(cwd: string, branch: string): Promise<string | null> {
  const r = await git(['config', '--get', `branch.${branch}.${BASE_CONFIG_SUFFIX}`], cwd)
  const v = r.stdout.trim()
  return r.ok && v ? v : null
}

/** Turn a git failure into one readable line for the UI. */
function cleanGitError(r: GitResult, fallback: string): string {
  const text = (r.stderr || r.stdout).trim()
  if (!text) return fallback
  const first = text
    .split('\n')
    .map((l) => l.replace(/^fatal:\s*/i, '').trim())
    .find((l) => l.length > 0)
  return first ? `${fallback}: ${first}` : fallback
}
