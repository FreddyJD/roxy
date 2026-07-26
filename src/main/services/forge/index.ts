/**
 * Forge status: the single entry point the rest of the app uses to ask
 * "what is the state of this branch, locally AND on the server?".
 *
 * The design constraint that shapes everything here: the workstream strip polls
 * every 5 seconds, and a naive implementation would issue an API request per
 * poll per session — a rate-limit ban within minutes, plus a UI that stutters
 * whenever the network is slow.
 *
 * So this module is built around one rule: GIT IS SYNCHRONOUS, THE FORGE IS
 * NOT. A status call returns local git state immediately and serves forge data
 * from cache, refreshing it in the background at a much slower cadence. The
 * chip therefore never blocks, never flickers, and never depends on the network
 * to show what it already knows.
 */
import type {
  ForgeRemote,
  PullRequestView,
  BranchSync,
  ForgeStatusView,
  ForgeError,
  ForgeKind,
  ForgeHostView,
  SyncTarget
} from '../../../shared/forge'
import { branchLifecycle, parseRemote, detectHost } from '../../../shared/forge'
import * as git from '../git'
import * as repo from '../../db/repo'
import { listPullRequests } from './adapters'
import { getCredential } from './credentials'

export type { ForgeStatusView } from '../../../shared/forge'

/** How long a forge answer is reused. Far longer than the 5s UI poll. */
const PR_TTL_MS = 60_000
/** How long a failure is remembered, so a down forge isn't hammered. */
const ERROR_TTL_MS = 5 * 60 * 1000
/** Remote URL -> forge mapping never changes while the app runs. */
const remoteCache = new Map<string, ForgeRemote | null>()

interface Entry {
  pulls: PullRequestView[]
  error: ForgeError | null
  at: number
  inflight: Promise<void> | null
}

const cache = new Map<string, Entry>()

const keyFor = (remote: ForgeRemote, branch: string): string =>
  `${remote.kind}:${remote.host}:${remote.slug}:${branch}`

/**
 * Resolve a repo's `origin` to forge coordinates.
 *
 * Cached by cwd because it costs a git spawn and the answer is stable for the
 * life of the process — nobody changes their origin mid-session, and if they
 * do, restarting is a reasonable price for not spawning git on every poll.
 *
 * Falls back to the user's stored answer for domains auto-detection can't
 * classify, so a corporate `git.mycorp.com` is asked about once and then
 * behaves exactly like a recognised host.
 */
export async function resolveForge(cwd: string): Promise<ForgeRemote | null> {
  if (!cwd) return null
  const hit = remoteCache.get(cwd)
  if (hit !== undefined) return hit
  const url = await git.remoteUrl(cwd)
  const override = url ? overrideFor(url) : null
  const parsed = url ? parseRemote(url, override) : null
  remoteCache.set(cwd, parsed)
  return parsed
}

/** The user's stored "this domain runs X" answer, if any. */
function overrideFor(url: string): ForgeKind | null {
  const probe = detectHost(url)
  if (!probe || probe.kind) return null
  const stored = repo.getForgeHostKinds()[probe.host]
  return isForgeKind(stored) ? stored : null
}

const KINDS: ForgeKind[] = ['github', 'azure-devops', 'gitlab', 'bitbucket']
const isForgeKind = (v: unknown): v is ForgeKind =>
  typeof v === 'string' && (KINDS as string[]).includes(v)

/**
 * Branch status, local + remote.
 *
 * Returns immediately with whatever is cached; a stale or missing forge answer
 * schedules a background refresh and the next poll picks it up. `force` (from an
 * explicit user refresh) waits for the answer instead.
 */
export async function forgeStatus(
  cwd: string,
  opts: { force?: boolean } = {}
): Promise<ForgeStatusView> {
  const st = await git.status(cwd)
  const branch = st?.branch ?? null
  const sync: BranchSync = {
    ahead: st?.ahead ?? 0,
    behind: st?.behind ?? 0,
    hasUpstream: st?.hasUpstream ?? false,
    dirty: st?.dirty ?? false
  }

  // Computed from the status we already have - no extra git spawn, so it rides
  // the 5s poll for free. Null when there is no upstream: with nothing to sync
  // against, the panel must not offer to sync.
  const syncTarget: SyncTarget | null = st?.upstream
    ? {
        upstream: st.upstream,
        behind: st.behind,
        ahead: st.ahead,
        changed: st.changed,
        // Deliberately NOT `behind > 0`. That count comes from the last fetch,
        // and nothing fetches on a timer (background network churn per session
        // per 5s is not a trade worth making) - so "0 behind" really means "0
        // behind as of whenever we last looked", which may be hours ago.
        // Greying the button out on that number would disable it in precisely
        // the moment the user wants to check for new commits, which is the
        // dead end this whole panel exists to remove.
        //
        // `ahead === 0` is the honest predicate: with no local commits, the
        // action can only no-op or fast-forward - it cannot fail. So it stays
        // clickable, fetches, and answers "Already up to date" or updates.
        canFastForward: st.ahead === 0
      }
    : null

  const remote = await resolveForge(cwd)
  // Distinguish "no remote at all" from "a real host we can't classify". The
  // second is a question we can ask the user once; the first isn't.
  let unknownHost: string | null = null
  if (!remote) {
    const url = await git.remoteUrl(cwd)
    const probe = url ? detectHost(url) : null
    if (probe && !probe.kind) unknownHost = probe.host
  }

  // No remote, no branch, or an unpushed branch: git alone is the whole truth,
  // and asking the forge about a branch it has never seen is a guaranteed empty
  // round trip. Skipping it is what keeps a brand-new workstream instant.
  if (!remote || !branch || !sync.hasUpstream) {
    return {
      remote: remote && summarize(remote),
      lifecycle: branchLifecycle({ sync, pr: null, forgeKnown: false }),
      pull: null,
      syncTarget,
      error: null,
      refreshing: false,
      unknownHost
    }
  }

  const key = keyFor(remote, branch)
  const entry = cache.get(key)
  const ttl = entry?.error ? ERROR_TTL_MS : PR_TTL_MS
  const fresh = entry && Date.now() - entry.at < ttl

  if (!fresh && opts.force) {
    await refresh(key, remote, branch)
  } else if (!fresh) {
    // Fire and forget: this call returns cached (or empty) data now, and the
    // next poll — 5s later — renders the result. That's what makes the network
    // invisible to the user.
    void refresh(key, remote, branch)
  }

  const current = cache.get(key)
  const pull = current?.pulls[0] ?? null
  return {
    remote: summarize(remote),
    lifecycle: branchLifecycle({
      sync,
      pr: pull,
      // Only claim the forge is "known" once a lookup has actually succeeded;
      // otherwise the chip would offer "open a PR" before it knows there isn't
      // one, and the button would vanish under the cursor a second later.
      forgeKnown: !!current && !current.error
    }),
    pull,
    syncTarget,
    error: current?.error ?? null,
    refreshing: !!current?.inflight,
    unknownHost: null
  }
}

/** Deduped background refresh: N sessions on one branch share one request. */
function refresh(key: string, remote: ForgeRemote, branch: string): Promise<void> {
  const existing = cache.get(key)
  if (existing?.inflight) return existing.inflight

  const base: Entry = existing ?? { pulls: [], error: null, at: 0, inflight: null }
  const job = listPullRequests(remote, branch)
    .then((r) => {
      cache.set(key, {
        // Keep the last good answer on failure rather than blanking the chip:
        // a transient network blip should not make a merged PR look unmerged.
        pulls: r.error ? base.pulls : r.pulls,
        error: r.error,
        at: Date.now(),
        inflight: null
      })
    })
    .catch(() => {
      cache.set(key, { ...base, at: Date.now(), inflight: null })
    })

  cache.set(key, { ...base, inflight: job })
  return job
}

function summarize(remote: ForgeRemote): ForgeStatusView['remote'] {
  return { kind: remote.kind, host: remote.host, slug: remote.slug, webBase: remote.webBase }
}

/**
 * The URL that opens a "create pull request" form pre-filled for this branch.
 *
 * Every vendor spells this differently and none of them document it as an API;
 * these are the forms their own web UIs use. Returns null rather than a
 * best-guess URL when the base branch is unknown, since a wrong compare URL
 * silently targets the wrong branch — worse than no link.
 */
export async function createPullUrl(cwd: string): Promise<string | null> {
  const remote = await resolveForge(cwd)
  const branch = await git.currentBranch(cwd)
  if (!remote || !branch) return null
  const base = (await git.baseBranchFor(cwd, branch)) ?? (await git.defaultBranch(cwd))
  if (!base) return null
  const b = encodeURIComponent(branch)

  switch (remote.kind) {
    case 'github':
      return `${remote.webBase}/${remote.owner}/${remote.repo}/compare/${encodeURIComponent(base)}...${b}?expand=1`
    case 'azure-devops': {
      const project = encodeURIComponent(remote.project ?? remote.repo)
      return (
        `${remote.webBase}/${project}/_git/${encodeURIComponent(remote.repo)}/pullrequestcreate` +
        `?sourceRef=${b}&targetRef=${encodeURIComponent(base)}`
      )
    }
    case 'gitlab':
      return (
        `${remote.webBase}/${remote.owner}/${remote.repo}/-/merge_requests/new` +
        `?merge_request%5Bsource_branch%5D=${b}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`
      )
    case 'bitbucket':
      return (
        `${remote.webBase}/${remote.owner}/${remote.repo}/pull-requests/new` +
        `?source=${b}&dest=${encodeURIComponent(base)}`
      )
  }
}

/** Drop all caches — used after a push, when the remote state just changed. */
export function invalidate(): void {
  cache.clear()
}

/**
 * The git hosts this user's projects actually use, and whether git already has
 * a credential for each.
 *
 * Deliberately derived from the projects on disk rather than a stored list of
 * "connected accounts": there is no account to connect. Settings shows what is
 * true right now, so a token that expired overnight shows as disconnected
 * without Roxy having to track its lifetime.
 */
export async function listHosts(): Promise<ForgeHostView[]> {
  if (!(await git.isGitAvailable())) return []
  const overrides = repo.getForgeHostKinds()
  const byHost = new Map<string, ForgeHostView>()

  for (const path of repo.listProjectOrder()) {
    const url = await git.remoteUrl(path)
    if (!url) continue
    const probe = detectHost(url)
    if (!probe) continue
    const stored = overrides[probe.host]
    const kind = probe.kind ?? (isForgeKind(stored) ? stored : null)

    let entry = byHost.get(probe.host)
    if (!entry) {
      entry = { host: probe.host, kind, connected: false, username: null, repos: [] }
      byHost.set(probe.host, entry)
    }
    // A repo we can't name is still worth counting toward the host, so the row
    // appears and the user can classify it.
    const parsed = kind ? parseRemote(url, kind) : null
    if (parsed && !entry.repos.includes(parsed.slug)) entry.repos.push(parsed.slug)
  }

  // Probe credentials in parallel — each is a local process, and doing them
  // serially makes Settings visibly slow on a machine with several hosts.
  await Promise.all(
    [...byHost.values()].map(async (entry) => {
      if (!entry.kind) return
      const cred = await getCredential(entry.host)
      if (cred) {
        entry.connected = true
        // `x-access-token` is a placeholder the helper uses when there's no
        // real account name; showing it to the user would be noise.
        entry.username = cred.username === 'x-access-token' ? null : cred.username
      }
    })
  )

  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host))
}

/**
 * Record which software an unrecognised host runs.
 *
 * Clears the remote cache because every cwd that resolved to "unknown" must be
 * re-resolved — otherwise the answer wouldn't take effect until restart.
 */
export function setHostKind(host: string, kind: ForgeKind | null): void {
  repo.setForgeHostKind(host, kind)
  remoteCache.clear()
  cache.clear()
}

/** Test seam. */
export function _clearForgeCaches(): void {
  cache.clear()
  remoteCache.clear()
}
