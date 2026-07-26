/**
 * "Forge" = a git hosting platform (GitHub, Azure DevOps, GitLab, Bitbucket).
 * The term is borrowed from magit/forge; `remote` was already taken by the
 * roxy.gg phone-relay feature and reusing it would be a permanent source of
 * confusion in this codebase.
 *
 * This module is PURE — no Node, no Electron, no network. It holds the two
 * things that are easy to get subtly wrong and expensive to debug through a
 * network call:
 *
 *   1. Parsing a git remote URL into host coordinates. There are ~14 URL shapes
 *      across four vendors, and Azure DevOps alone has five.
 *   2. Deciding which of the eight lifecycle states a branch is in, given git's
 *      ahead/behind numbers and (maybe) a pull request.
 *
 * Both are unit-tested by `npm run smoke:shared`, so the network layer can stay
 * a thin, boring fetch.
 */

// ---------------------------------------------------------------------------
// Remote identity
// ---------------------------------------------------------------------------

export type ForgeKind = 'github' | 'azure-devops' | 'gitlab' | 'bitbucket'

/** Display names, for UI that shouldn't hardcode vendor spelling. */
export const FORGE_NAMES: Record<ForgeKind, string> = {
  github: 'GitHub',
  'azure-devops': 'Azure DevOps',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket'
}

/**
 * A parsed `origin`, resolved far enough to build API calls without guessing.
 *
 * `owner`/`repo` mean slightly different things per host (see the field docs);
 * that asymmetry is real and pretending otherwise would push the special cases
 * into every call site instead of keeping them here.
 */
export interface ForgeRemote {
  kind: ForgeKind
  /** The web host as written in the remote, e.g. `github.com`, `dev.azure.com`. */
  host: string
  /** False for GitHub Enterprise / self-hosted GitLab / Bitbucket Server. */
  cloud: boolean
  /**
   * GitHub: repo owner. Azure DevOps: organization. GitLab: the full namespace
   * path (`group/subgroup`). Bitbucket: workspace (cloud) or project key (server).
   */
  owner: string
  repo: string
  /** Azure DevOps only — the team project, which sits between org and repo. */
  project?: string
  /** Root for REST calls, no trailing slash. */
  apiBase: string
  /** Root for human-facing links, no trailing slash. */
  webBase: string
  /** Compact identity for UI, e.g. `FreddyJD/roxy` or `msft/Edge/browser`. */
  slug: string
}

/** Hosts we recognise as the vendor's own cloud. */
const CLOUD_HOSTS: Record<string, ForgeKind> = {
  'github.com': 'github',
  'www.github.com': 'github',
  'gist.github.com': 'github',
  'dev.azure.com': 'azure-devops',
  'ssh.dev.azure.com': 'azure-devops',
  'vs-ssh.visualstudio.com': 'azure-devops',
  'gitlab.com': 'gitlab',
  'www.gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'www.bitbucket.org': 'bitbucket'
}

/**
 * Split any git remote URL into `{ host, path }`, covering the four transports
 * git actually accepts.
 *
 * The scp-like form (`git@host:path`) is the one that trips up naive parsers:
 * it is NOT a URL, `new URL()` rejects it, and the colon is a separator rather
 * than a port. It's also the default clone form GitHub/GitLab/Bitbucket offer,
 * so it can't be treated as an edge case.
 */
export function splitRemoteUrl(raw: string): { host: string; path: string; user?: string } | null {
  const url = (raw ?? '').trim()
  if (!url) return null

  // scp-like: [user@]host:path (no scheme, and the part before ':' has no '/')
  const scp = /^(?:([^@/\s]+)@)?([^@/:\s]+):(?!\/)(.+)$/.exec(url)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return { user: scp[1], host: scp[2].toLowerCase(), path: stripPath(scp[3]) }
  }

  // ssh:// | git:// | http(s):// | file://
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]+)@)?([^/?#]+)(\/[^?#]*)?/i.exec(url)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  if (scheme === 'file') return null
  // Strip an inline port: dev.azure.com:8080 -> dev.azure.com. IPv6 in a git
  // remote is vanishingly rare; treat a bracketed host as opaque.
  const rawHost = m[3]
  const host = rawHost.startsWith('[') ? rawHost.toLowerCase() : rawHost.split(':')[0].toLowerCase()
  return { user: m[2] ? decodeURIComponent(m[2]) : undefined, host, path: stripPath(m[4] ?? '') }
}

/** Normalise a remote path: no leading/trailing slash, no `.git` suffix. */
function stripPath(p: string): string {
  return p
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
}

/**
 * Identify the vendor from the host, falling back to a name-shaped guess for
 * self-hosted installs (`gitlab.acme.com`, `github.acme.com`).
 *
 * Returns null for a host with no vendor hint (`git.mycorp.com`) rather than
 * guessing. A wrong guess fires authenticated requests at an unrelated server,
 * which is a far worse failure than asking the user once — see `detectHost`,
 * which turns that null into a "pick your host" prompt.
 */
export function forgeKindForHost(host: string): ForgeKind | null {
  const h = host.toLowerCase()
  const cloud = CLOUD_HOSTS[h]
  if (cloud) return cloud
  // Legacy Azure DevOps: {org}.visualstudio.com
  if (h.endsWith('.visualstudio.com')) return 'azure-devops'
  const label = h.split('.')[0]
  if (label === 'github' || h.includes('github.')) return 'github'
  if (label === 'gitlab' || h.includes('gitlab.')) return 'gitlab'
  if (label === 'bitbucket' || h.includes('bitbucket.')) return 'bitbucket'
  if (h.includes('azure.') || h.includes('tfs.')) return 'azure-devops'
  return null
}

/**
 * What a remote URL is, before we know how to talk to it.
 *
 * The three outcomes are genuinely different and the UI treats each one
 * differently, which is why this is separate from `parseRemote`:
 *
 *  - `null`          not a hosted repo at all (local path, file://, junk).
 *                    Show nothing; there is no server to ask.
 *  - `kind: null`    a real host we don't recognise (`git.mycorp.com`).
 *                    Ask the user which software it runs — once, then remember.
 *  - `kind` set      recognised. Proceed silently.
 *
 * Collapsing the last two into "unsupported" is the tempting shortcut and it's
 * wrong: self-hosted GitLab and Bitbucket behind a corporate domain are the
 * single most common case in exactly the enterprises this feature is for.
 */
export interface HostProbe {
  host: string
  /** Null when the domain carries no vendor hint and the user must choose. */
  kind: ForgeKind | null
}

export function detectHost(raw: string): HostProbe | null {
  const split = splitRemoteUrl(raw)
  if (!split) return null
  // A host with no path can't be a repo; treat it as unusable rather than
  // prompting the user to classify something we can't address anyway.
  if (!split.path) return null
  return { host: split.host, kind: forgeKindForHost(split.host) }
}

/**
 * Parse a remote URL into forge coordinates, or null when it isn't a hosted
 * repo we can talk to.
 *
 * `kindOverride` is the user's stored answer for an unrecognised domain. It is
 * only ever consulted when auto-detection fails, so a saved override can never
 * silently mis-route a well-known host if the user once guessed wrong.
 *
 * Never throws: a malformed remote is a normal thing to find in a repo and must
 * not take down a status refresh.
 */
export function parseRemote(raw: string, kindOverride?: ForgeKind | null): ForgeRemote | null {
  const split = splitRemoteUrl(raw)
  if (!split) return null
  const kind = forgeKindForHost(split.host) ?? kindOverride ?? null
  if (!kind) return null
  const segs = split.path.split('/').filter(Boolean)
  if (segs.length === 0) return null

  switch (kind) {
    case 'github':
      return parseGitHub(split.host, segs)
    case 'azure-devops':
      return parseAzureDevOps(split.host, segs, split.user)
    case 'gitlab':
      return parseGitLab(split.host, segs)
    case 'bitbucket':
      return parseBitbucket(split.host, segs)
  }
}

function parseGitHub(host: string, segs: string[]): ForgeRemote | null {
  if (segs.length < 2) return null
  const cloud = host === 'github.com' || host === 'www.github.com'
  const [owner, repo] = segs
  // Enterprise mounts its API under /api/v3 on the same host; cloud has a
  // dedicated api. subdomain. Getting this wrong 404s every request.
  const webBase = `https://${cloud ? 'github.com' : host}`
  return {
    kind: 'github',
    host,
    cloud,
    owner,
    repo,
    apiBase: cloud ? 'https://api.github.com' : `${webBase}/api/v3`,
    webBase,
    slug: `${owner}/${repo}`
  }
}

/**
 * Azure DevOps, which has by far the messiest URL space:
 *
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}@dev.azure.com/{org}/{project}/_git/{repo}   (git's own default)
 *   https://dev.azure.com/{org}/_git/{repo}                   (project == repo)
 *   https://{org}.visualstudio.com/{project}/_git/{repo}      (legacy)
 *   https://{org}.visualstudio.com/DefaultCollection/{project}/_git/{repo}
 *   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}           (ssh, no _git)
 */
function parseAzureDevOps(host: string, segs: string[], user?: string): ForgeRemote | null {
  const legacy = host.endsWith('.visualstudio.com')
  let org: string | undefined
  let parts = [...segs]

  if (legacy) {
    org = host.split('.')[0]
  } else if (parts[0] === 'v3') {
    // ssh.dev.azure.com:v3/{org}/{project}/{repo}
    parts = parts.slice(1)
    org = parts.shift()
  } else {
    org = parts.shift()
  }
  if (!org) return null

  // Legacy collection segment carries no information we need.
  if (parts[0]?.toLowerCase() === 'defaultcollection') parts = parts.slice(1)

  const gitAt = parts.indexOf('_git')
  let project: string
  let repo: string
  if (gitAt >= 0) {
    repo = parts[gitAt + 1] ?? ''
    // `/_git/{repo}` with nothing before it means the project shares the repo's
    // name — the shorthand the Azure portal hands out for single-repo projects.
    project = gitAt === 0 ? repo : parts.slice(0, gitAt).join('/')
  } else {
    // SSH form has no `_git` marker: {project}/{repo}, or just {repo}.
    repo = parts[parts.length - 1] ?? ''
    project = parts.length > 1 ? parts.slice(0, -1).join('/') : repo
  }
  if (!repo) return null

  // `{org}@dev.azure.com` — the org in the userinfo wins only if we somehow
  // didn't get one from the path.
  if (!org && user) org = user

  const webBase = legacy ? `https://${host}` : `https://dev.azure.com/${org}`
  return {
    kind: 'azure-devops',
    host,
    cloud: host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || legacy,
    owner: org,
    project,
    repo,
    apiBase: webBase,
    webBase,
    slug: `${org}/${project}/${repo}`
  }
}

/**
 * GitLab allows arbitrarily nested groups, so the namespace is "everything but
 * the last segment" rather than a fixed `owner`. The API addresses a project by
 * the URL-encoded full path, which is assembled by the caller.
 */
function parseGitLab(host: string, segs: string[]): ForgeRemote | null {
  if (segs.length < 2) return null
  // Self-hosted GitLab is often mounted under a path prefix; `/-/` is GitLab's
  // route separator and never part of a project path.
  const dash = segs.indexOf('-')
  const parts = dash > 0 ? segs.slice(0, dash) : segs
  if (parts.length < 2) return null
  const repo = parts[parts.length - 1]
  const owner = parts.slice(0, -1).join('/')
  const cloud = host === 'gitlab.com' || host === 'www.gitlab.com'
  const webBase = `https://${cloud ? 'gitlab.com' : host}`
  return {
    kind: 'gitlab',
    host,
    cloud,
    owner,
    repo,
    apiBase: `${webBase}/api/v4`,
    webBase,
    slug: `${owner}/${repo}`
  }
}

/**
 * Bitbucket Cloud is `{workspace}/{repo}`. Bitbucket Server/Data Center is
 * `/scm/{PROJECT}/{repo}` with a completely different REST API (1.0 vs 2.0),
 * so it's flagged via `cloud:false` and the adapter refuses it rather than
 * firing Cloud-shaped requests at it.
 */
function parseBitbucket(host: string, segs: string[]): ForgeRemote | null {
  const cloud = host === 'bitbucket.org' || host === 'www.bitbucket.org'
  let parts = segs
  const scm = segs.indexOf('scm')
  if (!cloud && scm >= 0) parts = segs.slice(scm + 1)
  if (parts.length < 2) return null
  const [owner, repo] = parts
  const webBase = `https://${cloud ? 'bitbucket.org' : host}`
  return {
    kind: 'bitbucket',
    host,
    cloud,
    owner,
    repo,
    apiBase: cloud ? 'https://api.bitbucket.org/2.0' : `${webBase}/rest/api/1.0`,
    webBase,
    slug: `${owner}/${repo}`
  }
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/** Normalised across all four hosts, which disagree on nearly every name. */
export type PullState = 'open' | 'draft' | 'merged' | 'closed'

/** CI rollup. `null` when the host wasn't asked or reports nothing. */
export type ChecksState = 'pending' | 'passing' | 'failing'

export type ReviewState = 'approved' | 'changes_requested' | 'review_required'

export interface PullRequestView {
  /** The user-visible number (`#42`), not an opaque id. */
  number: number
  title: string
  state: PullState
  /** Permalink to the PR/MR in the browser. */
  url: string
  sourceBranch: string
  targetBranch: string
  author: string | null
  createdAt: number
  updatedAt: number
  checks: ChecksState | null
  review: ReviewState | null
}

/** What the strip needs about a branch, before a PR is known. */
export interface BranchSync {
  /** Commits on this branch not on its upstream. */
  ahead: number
  /** Commits on the upstream not on this branch. */
  behind: number
  /** Whether the branch has an upstream at all. */
  hasUpstream: boolean
  /** Uncommitted working-tree changes. */
  dirty: boolean
}

/**
 * What a "get back in sync" action would do, resolved to concrete nouns.
 *
 * Every field here exists to let the UI write a sentence instead of a verb.
 * "Update from origin/main" and "Reset to origin/main, stashing 4 changes" are
 * checkable claims; "Pull" and "Reset" are things the user has to take on
 * faith — and one of them can throw away an afternoon.
 */
export interface SyncTarget {
  /** The upstream ref, e.g. `origin/main`. */
  upstream: string
  /** Commits the upstream has that this branch doesn't. */
  behind: number
  /** Commits this branch has that the upstream doesn't. */
  ahead: number
  /** Uncommitted entries a reset would stash first. */
  changed: number
  /**
   * Whether a fast-forward can succeed. False once the branch has commits of
   * its own: git would have to merge or rebase, and the chip refuses to pick
   * one on the user's behalf.
   */
  canFastForward: boolean
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Where a branch sits on the road from "just created" to "merged".
 *
 * `unpublished` and `ahead` are answerable from git alone; everything from
 * `open` on requires the forge. That split matters: the first two must render
 * instantly and offline, so the UI never blocks on a network call to show
 * something it already knows.
 */
export type LifecyclePhase =
  | 'unpublished'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'synced'
  | 'draft'
  | 'open'
  | 'merged'
  | 'closed'

export type LifecycleTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface LifecycleView {
  phase: LifecyclePhase
  /** Terse chip text: `local`, `↑3`, `pushed`, `#42`, `merged`. */
  label: string
  tone: LifecycleTone
  /** Full sentence for the tooltip. */
  title: string
  /** True once the forge has been consulted and a PR exists. */
  pr: PullRequestView | null
  /** The single most useful next action, or null when there isn't one. */
  action: LifecycleAction | null
}

export type LifecycleAction = 'push' | 'pull' | 'open-pr' | 'view-pr'

/**
 * The state machine. Deliberately ordered most-settled first: a merged PR is
 * the truth about a branch even if the local copy is stale and looks "ahead",
 * and showing `↑2` on a merged branch is exactly the kind of lie that makes
 * people stop trusting a status indicator.
 */
export function branchLifecycle(input: {
  sync: BranchSync
  pr: PullRequestView | null
  /** Null while the forge lookup is in flight or unavailable. */
  forgeKnown: boolean
}): LifecycleView {
  const { sync, pr } = input

  if (pr) {
    switch (pr.state) {
      case 'merged':
        return {
          phase: 'merged',
          label: 'merged',
          tone: 'success',
          title: `#${pr.number} merged into ${pr.targetBranch}`,
          pr,
          action: 'view-pr'
        }
      case 'closed':
        return {
          phase: 'closed',
          label: 'closed',
          tone: 'neutral',
          // Azure DevOps calls this "abandoned"; the tooltip stays vendor-neutral
          // because the chip is shared across all four.
          title: `#${pr.number} closed without merging`,
          pr,
          action: 'view-pr'
        }
      case 'draft':
        return {
          phase: 'draft',
          label: `#${pr.number} draft`,
          tone: 'neutral',
          title: `Draft #${pr.number} → ${pr.targetBranch}`,
          pr,
          action: 'view-pr'
        }
      case 'open':
        return {
          phase: 'open',
          label: `#${pr.number}`,
          tone: toneForChecks(pr.checks, pr.review),
          title: openTitle(pr),
          pr,
          action: 'view-pr'
        }
    }
  }

  // No PR (or the forge hasn't answered yet) — fall back to what git knows.
  if (!sync.hasUpstream) {
    return {
      phase: 'unpublished',
      label: 'local',
      tone: 'neutral',
      title: 'Not pushed yet',
      pr: null,
      action: 'push'
    }
  }
  // Diverged FIRST: both counts are non-zero, and either single-sided answer is
  // a lie that ends in a failed command. Offering "push" here produces git's
  // non-fast-forward rejection; offering an update produces its own refusal. So
  // the honest chip offers neither and says what happened - choosing merge or
  // rebase on the user's behalf is not this button's call to make.
  if (sync.ahead > 0 && sync.behind > 0) {
    return {
      phase: 'diverged',
      label: `↑${sync.ahead} ↓${sync.behind}`,
      tone: 'warning',
      title: `Diverged: ${sync.ahead} to push, ${sync.behind} to pull`,
      pr: null,
      action: null
    }
  }
  if (sync.ahead > 0) {
    return {
      phase: 'ahead',
      label: `↑${sync.ahead}`,
      tone: 'info',
      title: `${sync.ahead} commit${sync.ahead === 1 ? '' : 's'} to push`,
      pr: null,
      action: 'push'
    }
  }
  if (sync.behind > 0) {
    return {
      phase: 'behind',
      label: `↓${sync.behind}`,
      tone: 'warning',
      title: `${sync.behind} commit${sync.behind === 1 ? '' : 's'} behind upstream`,
      pr: null,
      action: 'pull'
    }
  }
  return {
    phase: 'synced',
    label: 'pushed',
    tone: 'neutral',
    title: input.forgeKnown ? 'Pushed — no pull request yet' : 'Pushed',
    pr: null,
    // Only offer "open a PR" once we actually know none exists; offering it
    // while the lookup is pending produces a button that vanishes under the
    // cursor.
    action: input.forgeKnown ? 'open-pr' : null
  }
}

/**
 * An open PR's colour comes from whatever is blocking it. Failing CI outranks
 * review state because it's actionable by the author right now, while a pending
 * review is someone else's turn.
 */
function toneForChecks(checks: ChecksState | null, review: ReviewState | null): LifecycleTone {
  if (checks === 'failing') return 'danger'
  if (review === 'changes_requested') return 'warning'
  if (checks === 'pending') return 'info'
  if (checks === 'passing' && review === 'approved') return 'success'
  return 'info'
}

function openTitle(pr: PullRequestView): string {
  const bits = [`#${pr.number} → ${pr.targetBranch}`]
  if (pr.checks === 'failing') bits.push('checks failing')
  else if (pr.checks === 'pending') bits.push('checks running')
  else if (pr.checks === 'passing') bits.push('checks passing')
  if (pr.review === 'approved') bits.push('approved')
  else if (pr.review === 'changes_requested') bits.push('changes requested')
  return bits.join(' · ')
}

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/** Why a forge lookup failed. `auth` is the one the UI acts on. */
export interface ForgeError {
  reason: 'auth' | 'network' | 'unsupported' | 'not-found'
  message: string
}

/**
 * A git host Roxy has seen, and whether it can currently talk to it.
 *
 * Note what is NOT here: a token, a way to set one, or any notion of signing
 * in. Roxy does not own these credentials — git's credential helper does. This
 * is a read-only VIEW of what the helper already holds, which is why the
 * Settings row is a status line and not a login form.
 *
 * This is also why GitHub can legitimately appear twice in Settings: once here
 * as a code host, and once under Providers as the vendor of Copilot. They are
 * unrelated accounts with unrelated tokens and unrelated scopes, and merging
 * them would mean signing into Copilot silently granted repo access.
 */
export interface ForgeHostView {
  host: string
  /** Null for an unrecognised domain the user hasn't classified yet. */
  kind: ForgeKind | null
  /** True when `git credential fill` returns something for this host. */
  connected: boolean
  /** The account name the helper reports, when it has one. */
  username: string | null
  /** Repos in Roxy's known projects that live on this host. */
  repos: string[]
}

/**
 * Everything the UI knows about a branch's remote life, in one object.
 *
 * Lives in `shared` (not in the main-process service) because the renderer
 * imports it, and `shared` must never depend on `main` — that import would drag
 * Electron and `node:child_process` into the browser bundle.
 */
export interface ForgeStatusView {
  /** Null when there's no remote, or the host isn't one we recognise. */
  remote: {
    kind: ForgeKind
    host: string
    slug: string
    webBase: string
  } | null
  /** The lifecycle chip — always present, even with no forge and no network. */
  lifecycle: LifecycleView
  /** The pull request for this branch, when the forge knows of one. */
  pull: PullRequestView | null
  /**
   * What an update-or-reset would do, or null when there is no upstream to sync
   * with. Resolved in the main process so the UI never has to guess a ref name
   * or infer whether a fast-forward is possible.
   */
  syncTarget: SyncTarget | null
  /** Set when the last lookup failed. Advisory: the chip still renders. */
  error: ForgeError | null
  /** True while a background refresh is in flight. */
  refreshing: boolean
  /**
   * Set when the remote points at a host we couldn't classify. The UI shows a
   * one-time "which of these does `git.mycorp.com` run?" prompt; answering it
   * stores an override and this goes away for good.
   */
  unknownHost: string | null
}

/** Compact "3 minutes ago"-style age, for PR tooltips and the detail panel. */
export function relativeAge(then: number, now: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}
