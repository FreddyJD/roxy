/**
 * The four forge adapters: one `listPullRequests` per vendor, each normalising
 * a different API into the same `PullRequestView`.
 *
 * Everything here is read-only and best-effort. A forge being down, slow, or
 * refusing our token is an ordinary condition — it must degrade to "no PR
 * info", never throw into a status poll.
 *
 * The vendors disagree on essentially every detail, and the mapping notes below
 * are the expensive-to-rediscover parts:
 *
 *   state     GitHub open/closed + merged_at   ADO active/completed/abandoned
 *   draft     GitHub `draft:true`              ADO `isDraft`, GitLab WIP title
 *   branch    GitHub short name                ADO `refs/heads/x` fully-qualified
 *   number    GitHub `number`                  ADO `pullRequestId`, GitLab `iid`
 *   review    GitHub reviews API (extra call)  ADO reviewer votes (inline)
 */
import type {
  ForgeRemote,
  PullRequestView,
  PullState,
  ReviewState,
  ForgeError
} from '../../../shared/forge'
import { authHeaders, forgetCredential, getCredential } from './credentials'

/** A forge lookup is a background nicety; it must not hang a poll. */
const REQUEST_TIMEOUT_MS = 15_000
/** Enough to find the branch's PR without paging a busy monorepo forever. */
const PAGE_SIZE = 50

export interface ForgeResult {
  pulls: PullRequestView[]
  error: ForgeError | null
}

const ok = (pulls: PullRequestView[]): ForgeResult => ({ pulls, error: null })
const fail = (reason: ForgeError['reason'], message: string): ForgeResult => ({
  pulls: [],
  error: { reason, message }
})

/**
 * One authenticated GET returning parsed JSON, or a typed failure.
 *
 * A 401/403 forgets the credential so the next call re-reads a refreshed one
 * from the helper instead of replaying a token that just died — the mechanism
 * that makes short-lived Azure DevOps tokens a non-event.
 */
async function getJson<T>(
  url: string,
  remote: ForgeRemote,
  extraHeaders: Record<string, string> = {}
): Promise<{ data: T } | { error: ForgeError }> {
  const cred = await getCredential(remote.host)
  if (!cred) {
    return {
      error: {
        reason: 'auth',
        message: `No stored credential for ${remote.host}. Sign in once with git (a push or pull is enough) and Roxy will pick it up.`
      }
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Roxy',
        ...authHeaders(remote, cred),
        ...extraHeaders
      },
      signal: controller.signal
    })

    if (res.status === 401 || res.status === 403) {
      await forgetCredential(remote.host)
      return {
        error: {
          reason: 'auth',
          message: `${remote.host} rejected the stored credential — it has probably expired. Run any git command against the repo to refresh it.`
        }
      }
    }
    if (res.status === 404) {
      return { error: { reason: 'not-found', message: `Repository not found on ${remote.host}.` } }
    }
    if (!res.ok) {
      return { error: { reason: 'network', message: `${remote.host} returned ${res.status}.` } }
    }

    // Azure DevOps answers an unauthenticated API request with a 203 + an HTML
    // sign-in page rather than a 401. Parsing that as JSON throws a confusing
    // syntax error, so it's caught here and reported as what it actually is.
    const text = await res.text()
    if (/^\s*</.test(text)) {
      await forgetCredential(remote.host)
      return {
        error: {
          reason: 'auth',
          message: `${remote.host} returned a sign-in page instead of data — the credential is not valid for this organization.`
        }
      }
    }
    return { data: JSON.parse(text) as T }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      error: {
        reason: 'network',
        message: /abort/i.test(msg) ? `${remote.host} timed out.` : msg
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** `refs/heads/feature/x` → `feature/x`. Azure DevOps fully-qualifies refs. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0)

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

interface GhPull {
  number: number
  title: string
  state: 'open' | 'closed'
  draft?: boolean
  merged_at: string | null
  html_url: string
  created_at: string
  updated_at: string
  user?: { login?: string } | null
  head: { ref: string }
  base: { ref: string }
}

async function githubPulls(remote: ForgeRemote, branch: string): Promise<ForgeResult> {
  // `head` must be `owner:branch`. Filtering server-side is what keeps this to
  // a single request on repos with thousands of open PRs.
  const head = encodeURIComponent(`${remote.owner}:${branch}`)
  const url =
    `${remote.apiBase}/repos/${enc(remote.owner)}/${enc(remote.repo)}/pulls` +
    `?state=all&head=${head}&per_page=${PAGE_SIZE}&sort=updated&direction=desc`

  const res = await getJson<GhPull[]>(url, remote, { Accept: 'application/vnd.github+json' })
  if ('error' in res) return { pulls: [], error: res.error }
  if (!Array.isArray(res.data)) return ok([])

  return ok(
    res.data.map((p) => ({
      number: p.number,
      title: p.title,
      // `merged_at` is the ONLY reliable merged signal — GitHub reports merged
      // PRs as `state:"closed"`, so checking state alone mislabels every one.
      state: (p.merged_at
        ? 'merged'
        : p.state === 'closed'
          ? 'closed'
          : p.draft
            ? 'draft'
            : 'open') as PullState,
      url: p.html_url,
      sourceBranch: shortRef(p.head.ref),
      targetBranch: shortRef(p.base.ref),
      author: p.user?.login ?? null,
      createdAt: ms(p.created_at),
      updatedAt: ms(p.updated_at),
      // Checks and reviews each cost another round trip per PR; the strip is
      // polled, so they're fetched lazily by the detail panel instead.
      checks: null,
      review: null
    }))
  )
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

interface AdoPull {
  pullRequestId: number
  title: string
  status: 'active' | 'completed' | 'abandoned' | 'notSet'
  isDraft?: boolean
  createdBy?: { displayName?: string; uniqueName?: string } | null
  creationDate: string
  closedDate?: string | null
  sourceRefName: string
  targetRefName: string
  repository?: { name?: string; project?: { name?: string } } | null
  reviewers?: { vote?: number; isRequired?: boolean }[] | null
}

async function azurePulls(remote: ForgeRemote, branch: string): Promise<ForgeResult> {
  const project = remote.project ?? remote.repo
  // searchCriteria.status=all is required: the default is `active`, which would
  // silently hide every merged and abandoned PR — the exact states the user
  // asked to see.
  const url =
    `${remote.apiBase}/${enc(project)}/_apis/git/repositories/${enc(remote.repo)}/pullrequests` +
    `?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}` +
    `&searchCriteria.status=all&$top=${PAGE_SIZE}&api-version=7.1`

  const res = await getJson<{ value?: AdoPull[] }>(url, remote)
  if ('error' in res) return { pulls: [], error: res.error }
  const list = res.data?.value
  if (!Array.isArray(list)) return ok([])

  return ok(
    list.map((p) => {
      const source = shortRef(p.sourceRefName)
      return {
        number: p.pullRequestId,
        title: p.title,
        state: (p.status === 'completed'
          ? 'merged'
          : p.status === 'abandoned'
            ? 'closed'
            : p.isDraft
              ? 'draft'
              : 'open') as PullState,
        // ADO's `url` field is an internal API link the docs mark "used
        // internally"; the browsable URL has to be composed by hand.
        url: `${remote.webBase}/${encodeURIComponent(project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${p.pullRequestId}`,
        sourceBranch: source,
        targetBranch: shortRef(p.targetRefName),
        author: p.createdBy?.displayName ?? p.createdBy?.uniqueName ?? null,
        createdAt: ms(p.creationDate),
        updatedAt: ms(p.closedDate) || ms(p.creationDate),
        checks: null,
        // Votes come inline here, so review state is free — no extra request.
        review: adoReview(p.reviewers)
      }
    })
  )
}

/**
 * ADO vote scale: 10 approved, 5 approved-with-suggestions, 0 no vote,
 * -5 waiting for author, -10 rejected. Any negative vote blocks, so it wins
 * over any number of approvals.
 */
function adoReview(reviewers: AdoPull['reviewers']): ReviewState | null {
  if (!reviewers?.length) return null
  let approved = false
  for (const r of reviewers) {
    const v = r.vote ?? 0
    if (v < 0) return 'changes_requested'
    if (v > 0) approved = true
  }
  return approved ? 'approved' : 'review_required'
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

interface GlMerge {
  iid: number
  title: string
  state: 'opened' | 'closed' | 'merged' | 'locked'
  draft?: boolean
  work_in_progress?: boolean
  web_url: string
  source_branch: string
  target_branch: string
  author?: { username?: string } | null
  created_at: string
  updated_at: string
  detailed_merge_status?: string
}

async function gitlabPulls(remote: ForgeRemote, branch: string): Promise<ForgeResult> {
  // GitLab addresses a project by its URL-encoded full path, so the slashes in
  // a nested group path must be percent-encoded too — hence encodeURIComponent
  // on the whole thing rather than per segment.
  const id = encodeURIComponent(`${remote.owner}/${remote.repo}`)
  const url =
    `${remote.apiBase}/projects/${id}/merge_requests` +
    `?source_branch=${encodeURIComponent(branch)}&state=all&per_page=${PAGE_SIZE}&order_by=updated_at`

  const res = await getJson<GlMerge[]>(url, remote)
  if ('error' in res) return { pulls: [], error: res.error }
  if (!Array.isArray(res.data)) return ok([])

  return ok(
    res.data.map((m) => ({
      number: m.iid,
      title: m.title,
      state: (m.state === 'merged'
        ? 'merged'
        : m.state === 'closed'
          ? 'closed'
          : m.draft || m.work_in_progress
            ? 'draft'
            : 'open') as PullState,
      url: m.web_url,
      sourceBranch: m.source_branch,
      targetBranch: m.target_branch,
      author: m.author?.username ?? null,
      createdAt: ms(m.created_at),
      updatedAt: ms(m.updated_at),
      checks: null,
      review: null
    }))
  )
}

// ---------------------------------------------------------------------------
// Bitbucket
// ---------------------------------------------------------------------------

interface BbPull {
  id: number
  title: string
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED'
  draft?: boolean
  links?: { html?: { href?: string } }
  source?: { branch?: { name?: string } }
  destination?: { branch?: { name?: string } }
  author?: { nickname?: string; display_name?: string } | null
  created_on: string
  updated_on: string
}

async function bitbucketPulls(remote: ForgeRemote, branch: string): Promise<ForgeResult> {
  // Bitbucket Server/Data Center speaks a different API (1.0) with different
  // shapes. Rather than half-support it and produce wrong answers, it's
  // declared unsupported until someone can test against a real instance.
  if (!remote.cloud) {
    return fail('unsupported', 'Bitbucket Server is not supported yet — only Bitbucket Cloud.')
  }
  // Bitbucket has no source_branch filter, so it takes a BBQL `q` expression.
  const q = encodeURIComponent(`source.branch.name="${branch.replace(/"/g, '\\"')}"`)
  const url =
    `${remote.apiBase}/repositories/${enc(remote.owner)}/${enc(remote.repo)}/pullrequests` +
    `?q=${q}&state=OPEN&state=MERGED&state=DECLINED&pagelen=${PAGE_SIZE}`

  const res = await getJson<{ values?: BbPull[] }>(url, remote)
  if ('error' in res) return { pulls: [], error: res.error }
  const list = res.data?.values
  if (!Array.isArray(list)) return ok([])

  return ok(
    list.map((p) => ({
      number: p.id,
      title: p.title,
      state: (p.state === 'MERGED'
        ? 'merged'
        : p.state === 'DECLINED' || p.state === 'SUPERSEDED'
          ? 'closed'
          : p.draft
            ? 'draft'
            : 'open') as PullState,
      url:
        p.links?.html?.href ??
        `${remote.webBase}/${remote.owner}/${remote.repo}/pull-requests/${p.id}`,
      sourceBranch: p.source?.branch?.name ?? branch,
      targetBranch: p.destination?.branch?.name ?? '',
      author: p.author?.nickname ?? p.author?.display_name ?? null,
      createdAt: ms(p.created_on),
      updatedAt: ms(p.updated_on),
      checks: null,
      review: null
    }))
  )
}

const enc = encodeURIComponent

// ---------------------------------------------------------------------------

/**
 * Pull requests whose SOURCE is `branch`, newest-relevant first.
 *
 * Sorted so the caller can take `[0]` as "the" PR: an open PR outranks a merged
 * one (a reopened/second PR on the same branch is what the user is working on),
 * and ties break on recency.
 */
export async function listPullRequests(remote: ForgeRemote, branch: string): Promise<ForgeResult> {
  if (!branch) return ok([])
  let result: ForgeResult
  switch (remote.kind) {
    case 'github':
      result = await githubPulls(remote, branch)
      break
    case 'azure-devops':
      result = await azurePulls(remote, branch)
      break
    case 'gitlab':
      result = await gitlabPulls(remote, branch)
      break
    case 'bitbucket':
      result = await bitbucketPulls(remote, branch)
      break
  }
  result.pulls.sort(rankPulls)
  return result
}

const STATE_RANK: Record<PullState, number> = { open: 0, draft: 1, merged: 2, closed: 3 }

export function rankPulls(a: PullRequestView, b: PullRequestView): number {
  const d = STATE_RANK[a.state] - STATE_RANK[b.state]
  return d !== 0 ? d : b.updatedAt - a.updatedAt
}
