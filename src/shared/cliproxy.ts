/**
 * Shared contract for the CLIProxyAPI sidecar — the local process that lets a
 * user spend their *own* ChatGPT/Codex subscription from inside Roxy.
 *
 * Why a sidecar at all: Codex's subscription tier isn't reachable with an API
 * key. It speaks the Responses API behind an OAuth login bound to the official
 * Codex client id, refreshes its own tokens, and expects a specific request
 * shape. Re-implementing all of that inside Roxy would mean shipping (and
 * chasing) someone else's undocumented protocol. CLIProxyAPI already does it and
 * exposes the result as a plain OpenAI-compatible endpoint on 127.0.0.1, which
 * is a shape Roxy already drives everywhere else. So Roxy manages a process
 * instead of a protocol.
 *
 * This module is isomorphic: types + pure helpers only, no Node or Electron.
 */

/** Provider id for the Codex-subscription provider backed by the sidecar. */
export const CODEX_PROVIDER_ID = 'codex-subscription'

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
  /** Which upstream it authenticates against (`codex`, `claude`, …). */
  type: string
  /** Account email, when the token file records one. */
  email?: string
}

/** Everything the renderer needs to render the Codex panel. */
export interface CliProxyState {
  status: CliProxyStatus
  /** Loopback port the proxy listens on, once it's up. */
  port: number | null
  /** 0–100 while `status === 'downloading'`. */
  progress: number
  /** Human-readable failure for the `error` status. */
  error?: string
  /** Signed-in accounts (empty until someone completes a login). */
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
 * Whether the sidecar can serve requests right now. `starting` is deliberately
 * excluded: the port is bound but the proxy may not have loaded its credentials
 * yet, and a request sent into that window fails in a way that looks like a
 * broken login rather than a race.
 */
export function isUsable(state: CliProxyState): boolean {
  return state.status === 'running' && state.port !== null && state.accounts.length > 0
}
