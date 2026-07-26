/**
 * Forge credentials — obtained by ASKING GIT, not by implementing OAuth.
 *
 * This is the whole trick of the feature, so it's worth stating plainly:
 *
 * Every developer who can `git push` to a private repo already has a working
 * credential on their machine, managed by a credential helper (Git Credential
 * Manager on Windows/macOS, libsecret/osxkeychain elsewhere). `git credential
 * fill` is git's own public interface for reading it. GCM handles the parts
 * that are genuinely hard — Entra ID / Microsoft Account sign-in, device-code
 * flows, MFA, conditional access, and, critically, SILENT REFRESH of the
 * short-lived Azure DevOps token that otherwise expires every few days.
 *
 * So Roxy asks git. The alternatives were considered and are worse:
 *
 *  - Register OAuth apps with 4 vendors: needs client secrets shipped in an
 *    open-source Electron binary (extractable), an admin-consent dance for
 *    Azure tenants that most corp users cannot self-approve, and a callback
 *    server. Months of work, and it still wouldn't survive a locked-down tenant.
 *  - Ask the user to paste a PAT: works, but it's the exact 7-day-expiry pain
 *    the user is trying to escape, times four hosts.
 *  - Shell out to `gh`/`az`/`glab`: three more binaries that may not be
 *    installed (none are on this machine), each with its own auth state.
 *
 * `git credential fill` needs none of that. It's already authenticated, it
 * refreshes itself, and it's the same credential the user's existing pushes
 * use, so if `git push` works then Roxy works.
 *
 * Safety rules, all deliberate:
 *  - GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never: a status poll must NEVER
 *    pop a login window or block on a hidden prompt. If there's no cached
 *    credential we return null and the UI degrades to git-only state.
 *  - Tokens are held in memory with a short TTL and never written to the DB.
 *    The OS keychain is already the system of record; copying secrets into
 *    roxy.db would only widen the blast radius.
 *  - Tokens are never logged, never sent to the renderer, and never included
 *    in tool output.
 */
import { spawn } from 'node:child_process'
import type { ForgeRemote } from '../../../shared/forge'

/** A credential lookup must not outlive a status poll. */
const CREDENTIAL_TIMEOUT_MS = 10_000

/**
 * How long a fetched credential is reused before re-asking git.
 *
 * Short on purpose. Azure DevOps tokens from GCM are typically ~1h, and the
 * cost of re-asking is one fast local process, so a stale token (which shows up
 * as a confusing 401) is a much worse trade than an occasional extra spawn.
 */
const CACHE_TTL_MS = 5 * 60 * 1000

export interface ForgeCredential {
  username: string
  /** The secret. NEVER log, persist, or send this over IPC. */
  password: string
}

interface CacheEntry {
  cred: ForgeCredential
  at: number
}

const cache = new Map<string, CacheEntry>()

/** Cache key: the credential scope, which is (protocol, host) — never the repo. */
function keyFor(host: string): string {
  return `https://${host}`
}

/**
 * Run `git credential <verb>` with a stdin document, returning stdout.
 *
 * Never throws and never blocks on a prompt: a missing helper, a locked
 * keychain and a cancelled dialog all come back as null.
 */
function runCredential(verb: 'fill' | 'reject', input: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['credential', verb], {
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          // The three switches that keep this non-interactive. Without them a
          // background poll can silently spawn a modal auth window behind the
          // app, or hang forever waiting on a terminal that doesn't exist.
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_ASKPASS: '',
          SSH_ASKPASS: ''
        }
      })
    } catch {
      resolve(null)
      return
    }

    let out = ''
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(null)
    }, CREDENTIAL_TIMEOUT_MS)

    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    // stderr is drained but discarded — it can contain credential-adjacent
    // chatter from helpers and has no diagnostic value worth that risk.
    child.stderr?.resume()
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))

    child.stdin?.on('error', () => finish(null))
    child.stdin?.end(input, 'utf8')
  })
}

/** Parse git's `key=value` credential document. */
function parseCredentialOutput(text: string): ForgeCredential | null {
  let username = ''
  let password = ''
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'username') username = value
    else if (key === 'password') password = value
  }
  if (!password) return null
  return { username: username || 'x-access-token', password }
}

/**
 * Get a credential for a forge HOST, or null if none is cached locally.
 *
 * Takes a bare host rather than a `ForgeRemote` because credential helpers key
 * on (protocol, host) and nothing else — and because Settings needs to probe a
 * host it hasn't classified yet, which has no `ForgeRemote` to pass.
 *
 * Null is a completely normal answer (fresh machine, SSH-only user, helper
 * disabled) and every caller must degrade rather than error.
 */
export async function getCredential(host: string): Promise<ForgeCredential | null> {
  const key = keyFor(host)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cred

  // Ask for the credential scoped to the host. We deliberately do NOT send the
  // repo path: helpers key by host, and a path makes some of them miss.
  const doc = `protocol=https\nhost=${host}\n\n`
  const out = await runCredential('fill', doc)
  if (!out) return null
  const cred = parseCredentialOutput(out)
  if (!cred) return null

  cache.set(key, { cred, at: Date.now() })
  return cred
}

/**
 * Drop a credential we've just seen rejected (401/403).
 *
 * Clears our cache and tells git's helper to forget it too, so the NEXT
 * interactive git operation the user runs re-authenticates properly instead of
 * silently replaying a dead token. This is what makes expiry self-healing:
 * Azure DevOps tokens die on a schedule, and without this the app would serve
 * a stale token from cache for the rest of its lifetime.
 */
export async function forgetCredential(host: string): Promise<void> {
  const key = keyFor(host)
  const entry = cache.get(key)
  cache.delete(key)
  if (!entry) return
  const doc =
    `protocol=https\nhost=${host}\n` +
    `username=${entry.cred.username}\npassword=${entry.cred.password}\n\n`
  await runCredential('reject', doc)
}

/** Test seam: drop every cached credential. */
export function _clearCredentialCache(): void {
  cache.clear()
}

/**
 * The `Authorization` header value for a host.
 *
 * The four vendors want three different schemes, and each is a real 401 if you
 * get it wrong:
 *  - Azure DevOps: HTTP Basic with an EMPTY username and the token as the
 *    password. Bearer works for Entra access tokens but NOT for the PATs GCM
 *    commonly returns, so Basic is the form that works for both.
 *  - GitHub: `Bearer <token>` for both PATs and OAuth tokens.
 *  - GitLab: Bearer for OAuth tokens; PATs (`glpat-`) must use the
 *    `PRIVATE-TOKEN` header instead — see `authHeaders`.
 *  - Bitbucket Cloud: Basic with the real username and an app password.
 */
export function authHeaders(remote: ForgeRemote, cred: ForgeCredential): Record<string, string> {
  const basic = (user: string, pass: string): string =>
    `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`

  switch (remote.kind) {
    case 'azure-devops':
      return { Authorization: basic('', cred.password) }
    case 'github':
      return { Authorization: `Bearer ${cred.password}` }
    case 'gitlab':
      // GitLab rejects personal access tokens sent as Bearer.
      return cred.password.startsWith('glpat-')
        ? { 'PRIVATE-TOKEN': cred.password }
        : { Authorization: `Bearer ${cred.password}` }
    case 'bitbucket':
      return { Authorization: basic(cred.username, cred.password) }
  }
}
