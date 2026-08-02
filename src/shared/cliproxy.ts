/**
 * Shared contract for the CLIProxyAPI sidecar — the local process that lets a
 * user spend their *own* AI subscriptions from inside Roxy.
 *
 * Why a sidecar at all: these subscription tiers aren't reachable with an API
 * key. Codex speaks the Responses API behind an OAuth login bound to the
 * official Codex client id; Google's Gemini subscription sits behind its own
 * Google OAuth client and a Cloud Code endpoint. Both refresh their own tokens
 * and expect a specific request shape. Re-implementing all of that inside Roxy
 * would mean shipping (and chasing) someone else's undocumented protocol.
 * CLIProxyAPI already does it and exposes the result as a plain
 * OpenAI-compatible endpoint on 127.0.0.1, which is a shape Roxy already drives
 * everywhere else. So Roxy manages a process instead of a protocol.
 *
 * ONE process serves EVERY signed-in subscription. That is the fact that shapes
 * this module: a single install, a single port, a single `/v1/models` — but
 * per-upstream accounts, logins, and model lists. Anything keyed globally that
 * should have been keyed per upstream shows up as one provider claiming the
 * other's accounts or models.
 *
 * This module is isomorphic: types + pure helpers only, no Node or Electron.
 */

/** Provider id for the Codex-subscription provider backed by the sidecar. */
export const CODEX_PROVIDER_ID = 'codex-subscription'

/** Provider id for the Google/Gemini-subscription provider backed by the sidecar. */
export const GEMINI_PROVIDER_ID = 'gemini-subscription'

/** Provider id for the Claude/Anthropic-subscription provider backed by the sidecar. */
export const CLAUDE_PROVIDER_ID = 'claude-subscription'

/**
 * The upstreams Roxy can sign into through the sidecar.
 *
 * These are the sidecar's OWN provider keys, not Roxy provider ids: each names
 * a Management API login route and appears as the `type` on the auth files that
 * login writes. Keeping the two namespaces distinct matters, because one
 * process serves both and every per-account operation (sign out, disconnect,
 * model filtering) has to be told WHICH subscription it applies to.
 *
 * `antigravity` is Google's OAuth-backed Gemini subscription. It is deliberately
 * NOT the sidecar's `gemini` key: that one means a Generative Language API key,
 * which is the pay-per-token path this whole feature exists to avoid. The pinned
 * release also publishes no `gemini-auth-url` route — upstream ships Gemini CLI
 * as a separate native plugin, and loading third-party plugins would mean
 * turning on a plugin host we keep switched off on purpose (see the config
 * written by the main-process service). Antigravity is the only Gemini login the
 * pinned binary can perform on its own.
 */
export type CliProxyUpstream = 'codex' | 'antigravity' | 'claude'

/** Everything that differs between one sidecar-backed subscription and another. */
export interface CliProxyUpstreamSpec {
  /**
   * The sidecar's key for this upstream: the `type`/provider it stamps on an
   * auth file, and the filename prefix it writes. This is what identifies an
   * account as belonging to this subscription.
   */
  upstream: CliProxyUpstream
  /** The Roxy provider id it registers as. */
  providerId: string
  /**
   * Management API path that starts the OAuth flow.
   *
   * Deliberately independent of `upstream`, because for Claude the two disagree:
   * the route is `/anthropic-auth-url` while the credential it writes is typed
   * `claude` (`claude-<email>.json`). Deriving one from the other would work for
   * Codex, work for Antigravity, and silently break exactly one provider.
   */
  authUrlPath: string
  /**
   * Loopback port the sidecar opens for this provider's OAuth callback.
   *
   * Fixed by the redirect URI registered with the upstream, so it is not
   * negotiable. Checking it is free BEFORE opening a browser, and that check is
   * the difference between a clear error and a failure that only lands after the
   * user has already signed in and approved consent.
   */
  callbackPort: number
  /**
   * `owned_by` values on `/v1/models` that belong to this upstream.
   *
   * The sidecar serves every signed-in subscription from ONE `/v1/models`, so
   * without this a user signed into both would see Gemini models listed under
   * the ChatGPT provider and vice versa — and picking one would route the
   * request to a subscription that cannot serve it.
   */
  modelOwners: string[]
  /** What to call the account in UI copy ("your ChatGPT account"). */
  accountLabel: string
}

/** The sidecar-backed subscriptions, keyed by Roxy provider id. */
export const CLIPROXY_UPSTREAMS: Record<string, CliProxyUpstreamSpec> = {
  [CODEX_PROVIDER_ID]: {
    upstream: 'codex',
    providerId: CODEX_PROVIDER_ID,
    authUrlPath: '/codex-auth-url',
    callbackPort: 1455,
    modelOwners: ['openai'],
    accountLabel: 'ChatGPT'
  },
  [GEMINI_PROVIDER_ID]: {
    upstream: 'antigravity',
    providerId: GEMINI_PROVIDER_ID,
    authUrlPath: '/antigravity-auth-url',
    callbackPort: 51121,
    // The catalog tags these models `antigravity`; `google` is accepted too so a
    // future relabel upstream doesn't silently empty the picker.
    modelOwners: ['antigravity', 'google'],
    accountLabel: 'Google'
  },
  [CLAUDE_PROVIDER_ID]: {
    // Note the split spelling: the login route is ANTHROPIC-named, but the
    // credential it writes is typed `claude`. Both are upstream's, and each is
    // used exactly where upstream uses it.
    upstream: 'claude',
    providerId: CLAUDE_PROVIDER_ID,
    authUrlPath: '/anthropic-auth-url',
    callbackPort: 54545,
    modelOwners: ['anthropic'],
    accountLabel: 'Claude'
  }
}

/** Every sidecar-backed provider id, for callers that must handle both. */
export const CLIPROXY_PROVIDER_IDS = Object.keys(CLIPROXY_UPSTREAMS)

/** Whether a provider id is served by the sidecar. */
export function isCliProxyProvider(providerId: string): boolean {
  return providerId in CLIPROXY_UPSTREAMS
}

/** The spec for a provider id, or undefined when it isn't sidecar-backed. */
export function upstreamFor(providerId: string): CliProxyUpstreamSpec | undefined {
  return CLIPROXY_UPSTREAMS[providerId]
}

/** The Roxy provider id for a sidecar upstream key, or undefined. */
export function providerIdForUpstream(upstream: string): string | undefined {
  return CLIPROXY_PROVIDER_IDS.find((id) => CLIPROXY_UPSTREAMS[id].upstream === upstream)
}

/**
 * The release the app pins. Upgrading is a deliberate, reviewed act: the sidecar
 * holds the user's OAuth tokens, so it is never auto-updated to whatever
 * `latest` happens to be on the day someone first clicks Sign in.
 */
export const CLIPROXY_VERSION = '7.2.112'

/** Where the pinned release assets come from. */
export const CLIPROXY_REPO = 'router-for-me/CLIProxyAPI'

/**
 * Lifecycle of the sidecar, as the renderer sees it.
 *
 *  not-installed → the binary hasn't been downloaded yet
 *  downloading   → fetching + verifying + extracting the release
 *  starting      → process spawned, not yet answering health checks
 *  running       → answering on its port; requests can flow
 *  stopped       → installed but not running (nothing needs it right now)
 *  error         → download/spawn/health failed; `error` explains
 */
export type CliProxyStatus =
  | 'not-installed'
  | 'downloading'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error'

/** One signed-in subscription account held by the sidecar. */
export interface CliProxyAccount {
  /** Auth filename on disk (`codex-user@example.com.json`) — the stable id. */
  file: string
  /** Which upstream it authenticates against (`codex`, `antigravity`, …). */
  type: string
  /** Account email, when the token file records one. */
  email?: string
}

/** Everything the renderer needs to render a subscription panel. */
export interface CliProxyState {
  status: CliProxyStatus
  /** Loopback port the proxy listens on, once it's up. */
  port: number | null
  /** 0–100 while `status === 'downloading'`. */
  progress: number
  /** Human-readable failure for the `error` status. */
  error?: string
  /**
   * Signed-in accounts across EVERY upstream (empty until someone completes a
   * login). Per-provider surfaces filter this with `accountsFor`, rather than
   * the service keeping one list per upstream: the sidecar reports them in a
   * single call, and splitting them here keeps a single source of truth.
   */
  accounts: CliProxyAccount[]
  /** Pinned release the local install corresponds to. */
  version: string
  /** Monotonic revision, so the renderer can drop out-of-order pushes. */
  rev: number
}

/** A started OAuth login: the URL to open plus the state token to poll on. */
export interface CliProxyLoginStart {
  url: string
  state: string
}

/** Terminal outcome of a login attempt. */
export interface CliProxyLoginResult {
  ok: boolean
  error?: string
  accounts: CliProxyAccount[]
}

/** The idle state, before anything has been installed or started. */
export const IDLE_CLIPROXY_STATE: CliProxyState = {
  status: 'not-installed',
  port: null,
  progress: 0,
  accounts: [],
  version: CLIPROXY_VERSION,
  rev: 0
}

/**
 * The accounts belonging to one provider.
 *
 * Matching is on the auth file's `type`, which the sidecar sets to the upstream
 * key. The filename prefix is used only as a fallback, for the auth-dir-scan
 * response shape that reports no type at all.
 */
export function accountsFor(state: CliProxyState, providerId: string): CliProxyAccount[] {
  const spec = upstreamFor(providerId)
  if (!spec) return []
  return state.accounts.filter(
    (a) => a.type === spec.upstream || a.file.startsWith(`${spec.upstream}-`)
  )
}

/**
 * Release asset name for a platform/arch pair, or null when upstream publishes
 * no build for it. Mirrors the naming used by the project's release workflow:
 *   CLIProxyAPI_<version>_<os>_<arch>.<tar.gz|zip>
 *
 * Kept here (not in the main process) so the smoke tests can assert the mapping
 * without booting Electron — a wrong asset name is a 404 the user only discovers
 * mid-download.
 */
export function releaseAsset(
  platform: NodeJS.Platform,
  arch: string,
  version = CLIPROXY_VERSION
): string | null {
  const os =
    platform === 'win32'
      ? 'windows'
      : platform === 'darwin'
        ? 'darwin'
        : platform === 'linux'
          ? 'linux'
          : platform === 'freebsd'
            ? 'freebsd'
            : null
  if (!os) return null
  // Upstream labels 64-bit ARM `aarch64` (not Node's `arm64`); everything else
  // we support is `amd64`.
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'amd64' : null
  if (!cpu) return null
  // macOS ships no ARM/amd split beyond these two, and FreeBSD publishes only a
  // no-plugin build for aarch64 — which we don't ship, so treat it as absent.
  if (os === 'freebsd' && cpu === 'aarch64') return null
  const ext = os === 'windows' ? 'zip' : 'tar.gz'
  return `CLIProxyAPI_${version}_${os}_${cpu}.${ext}`
}

/** Download URL for a release asset on the pinned tag. */
export function releaseAssetUrl(asset: string, version = CLIPROXY_VERSION): string {
  return `https://github.com/${CLIPROXY_REPO}/releases/download/v${version}/${asset}`
}

/** URL of the release's `checksums.txt`, used to verify the downloaded asset. */
export function checksumsUrl(version = CLIPROXY_VERSION): string {
  return `https://github.com/${CLIPROXY_REPO}/releases/download/v${version}/checksums.txt`
}

/**
 * Pull one asset's expected sha256 out of a `checksums.txt` body (the standard
 * `<hex>  <filename>` format). Returns null when the file doesn't list it, which
 * the caller must treat as "cannot verify" rather than "verified".
 */
export function sha256For(checksums: string, asset: string): string | null {
  for (const line of checksums.split('\n')) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i)
    if (m && m[2].trim() === asset) return m[1].toLowerCase()
  }
  return null
}

/**
 * Whether the sidecar can serve requests for a provider right now.
 *
 * `starting` is deliberately excluded: the port is bound but the proxy may not
 * have loaded its credentials yet, and a request sent into that window fails in
 * a way that looks like a broken login rather than a race.
 *
 * The account check is per-provider. A running proxy with only a ChatGPT login
 * cannot serve Gemini, so a global "any account" test would report the Gemini
 * provider as usable and route a request that is guaranteed to fail.
 */
export function isUsable(state: CliProxyState, providerId = CODEX_PROVIDER_ID): boolean {
  return (
    state.status === 'running' && state.port !== null && accountsFor(state, providerId).length > 0
  )
}
