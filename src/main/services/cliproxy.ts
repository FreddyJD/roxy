/**
 * CLIProxyAPI sidecar — lets a user spend their own ChatGPT/Codex subscription
 * inside Roxy.
 *
 * The shape of the thing: Roxy downloads a pinned CLIProxyAPI release into
 * userData, writes a config that binds it to 127.0.0.1 on a free port, spawns
 * it, and drives its Management API to run the Codex OAuth login. From then on
 * the sidecar is just an OpenAI-compatible endpoint at
 * http://127.0.0.1:<port>/v1 — a wire Roxy already speaks — and the provider row
 * for it looks like any other `openai-chat` provider.
 *
 * Three invariants shape everything below.
 *
 * 1. The user's OAuth tokens live in the sidecar's `auth-dir`, never in Roxy's
 *    `credentials` table. Roxy holds only the *local* API key it generated to
 *    talk to its own sidecar. If Roxy is uninstalled the tokens go with the
 *    auth-dir; nothing to leak from the database.
 *
 * 2. Nothing binds to a non-loopback address, and both the proxy port and the
 *    management key are generated per install. A CLIProxyAPI on 0.0.0.0 with a
 *    known key is an open relay to the user's paid subscription.
 *
 * 3. The version is PINNED and the download is checksum-verified. This process
 *    holds subscription credentials, so "whatever `latest` is today" is not an
 *    acceptable input, and neither is an unverified binary.
 *
 * Lifecycle is lazily driven: nothing is downloaded or spawned until someone
 * actually clicks Sign in, and `ensureRunning` is idempotent so every later
 * caller (a turn, a model list) just gets the already-running instance.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, net as electronNet } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import {
  CLIPROXY_VERSION,
  IDLE_CLIPROXY_STATE,
  checksumsUrl,
  releaseAsset,
  releaseAssetUrl,
  sha256For,
  type CliProxyAccount,
  type CliProxyLoginResult,
  type CliProxyLoginStart,
  type CliProxyState,
  type CliProxyStatus
} from '../../shared/cliproxy'

const execFileAsync = promisify(execFile)

/** Loopback-only. Never 0.0.0.0 — see invariant 2 in the module docblock. */
const HOST = '127.0.0.1'

/** Port window for the sidecar, above Roxy's per-session dev-server range (3100-3999). */
const PORT_RANGE_START = 8317
const PORT_RANGE_END = 8399

/**
 * sha256 of each pinned release asset, recorded when CLIPROXY_VERSION was set.
 *
 * Normally the digest comes from the release's checksums.txt. These exist for
 * the offline case: when github.com is unreachable, a manual install still has
 * something to verify against instead of being waved through.
 */
const PINNED_SHA256: Record<string, string> = {
  'CLIProxyAPI_7.2.112_windows_amd64.zip':
    'e2a59965f73e5e32c00cb711a09412f8a7898ca8c10a4e682bb963dafde764f4',
  'CLIProxyAPI_7.2.112_windows_aarch64.zip':
    '23225aecfcdd4c680e6c3eda8e74f9bee16457bd4249d6b30e9f70185e14b550',
  'CLIProxyAPI_7.2.112_darwin_aarch64.tar.gz':
    'd8e41dd24f7f1ab68ed57d1637a928a13e7d217268093aa7d2177cf95010feff',
  'CLIProxyAPI_7.2.112_darwin_amd64.tar.gz':
    'c9c1c36e7f134bb43e4155321d3c75037a4ba6c3173e8c6cfa70caff49903a55',
  'CLIProxyAPI_7.2.112_linux_amd64.tar.gz':
    'a64de846ac2920b82cfbdfac988a3ae4f637eae9d2ff2fe00e4022cd451ca6e7',
  'CLIProxyAPI_7.2.112_linux_aarch64.tar.gz':
    '254bb551ac71eb54720a6ee848ca8de559cdee5feb2dc1e44dbda59a03233220'
}

/**
 * Download attempts before giving up. A corrupt archive is usually transient
 * (network blip, antivirus), so one failure should not end the feature.
 */
const DOWNLOAD_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 750

/** How long to wait for the process to answer a health check before giving up. */
const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_INTERVAL_MS = 250

/** OAuth polling: the user has to sign in with a browser, so this is generous. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_POLL_MS = 1_000

/** Codex's OAuth callback listener, opened by the sidecar for the login flow. */
const CODEX_CALLBACK_PORT = 1455

/** How long to wait for the sidecar to bind that port before calling it a failure. */
const CALLBACK_BIND_TIMEOUT_MS = 5_000

// ---- Paths -------------------------------------------------------------------

/** Root for everything this service owns, under Electron's userData. */
function root(): string {
  return join(app.getPath('userData'), 'cliproxy')
}

/** Where the extracted release for the pinned version lives. */
function installDir(): string {
  return join(root(), `v${CLIPROXY_VERSION}`)
}

/** The executable inside the install dir. */
function binPath(): string {
  return join(installDir(), process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api')
}

/** Generated config. Rewritten on every start (the port can move). */
function configPath(): string {
  return join(root(), 'config.yaml')
}

/**
 * OAuth token files. Deliberately OUTSIDE the versioned install dir so that
 * upgrading the pinned version doesn't sign the user out.
 */
function authDir(): string {
  return join(root(), 'auths')
}

/** Local secrets (proxy api-key + management key), generated once per install. */
function secretsPath(): string {
  return join(root(), 'secrets.json')
}

// ---- State -------------------------------------------------------------------

interface Secrets {
  /** Bearer key Roxy sends to its own sidecar on /v1 requests. */
  apiKey: string
  /** Key for the sidecar's Management API (login flows, auth file listing). */
  managementKey: string
}

let state: CliProxyState = { ...IDLE_CLIPROXY_STATE }
let child: ChildProcess | null = null
let secrets: Secrets | null = null
/** Serializes start/stop/install so a double-click can't spawn two processes. */
let lifecycle: Promise<unknown> = Promise.resolve()
/** Set during an intentional stop so the `exit` handler doesn't report a crash. */
let stopping = false

/** Push the current state to every open window. */
function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.cliproxyState, state)
  }
}

/** Patch + bump the revision + push. Every state change goes through here. */
function update(patch: Partial<Omit<CliProxyState, 'rev'>>): void {
  state = { ...state, ...patch, rev: state.rev + 1 }
  broadcast()
}

/** Move to a status, clearing any stale error unless one is supplied. */
function setStatus(status: CliProxyStatus, error?: string): void {
  update({ status, error })
}

/** Run lifecycle ops one at a time (see `lifecycle`). */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn)
  lifecycle = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// ---- Install -----------------------------------------------------------------

/** Whether the pinned release is already extracted and executable. */
async function isInstalled(): Promise<boolean> {
  try {
    await fsp.access(binPath())
    return true
  } catch {
    return false
  }
}

/**
 * Fetch through Chromium's network stack instead of Node's.
 *
 * Node's global `fetch` knows nothing about the machine's proxy configuration or
 * the enterprise root certificates in the OS trust store. On a corporate network,
 * a VPN, or behind TLS inspection, that is the difference between a working
 * download and a mangled one — which is precisely the failure this whole code
 * path keeps tripping over.
 *
 * Electron's `net` module uses Chromium, so it picks up system proxy settings
 * (including PAC scripts) and the OS certificate store for free.
 */
async function netFetch(url: string): Promise<Response> {
  // net.fetch is only usable once the app is ready; every caller here is well
  // past that, but guard rather than throw a confusing internal error.
  if (!app.isReady()) return fetch(url)
  return electronNet.fetch(url)
}

/**
 * Fetch a URL, falling back to the other network stack when the first fails.
 *
 * Neither stack is strictly better. Chromium handles proxies and enterprise
 * roots; Node's is unaffected by Chromium's own policy quirks. Trying both turns
 * "this environment is unsupported" into "one of them worked", which for a
 * download that is otherwise a dead end is worth the extra round trip.
 */
async function fetchWithFallback(url: string): Promise<Response> {
  try {
    const res = await netFetch(url)
    if (res.ok) return res
    // A non-2xx from Chromium may be an intercepting proxy; Node might see past
    // it. Fall through rather than accept the failure.
    const viaNode = await fetch(url)
    return viaNode.ok ? viaNode : res
  } catch {
    return fetch(url)
  }
}

/**
 * Download + verify + extract the pinned release, retrying a bad download.
 *
 * Retrying matters more than it looks. What this guards against is a corrupt
 * archive, and a corrupt archive is exactly what a flaky network, a proxy that
 * closes early, or an antivirus scanner touching the temp file produces. Those
 * are transient by nature, so dead-ending on the first one — with a raw
 * `ZIP decompression failed (-5)` from tar, no less — turns a retryable blip
 * into "this feature is broken".
 */
async function install(): Promise<void> {
  const asset = releaseAsset(process.platform, process.arch)
  if (!asset) {
    throw new Error(
      `CLIProxyAPI publishes no build for ${process.platform}/${process.arch}. ` +
        'Codex sign-in is unavailable on this platform.'
    )
  }

  update({ status: 'downloading', progress: 0, error: undefined })

  // Fetched once: it describes the pinned release, so it cannot change between
  // attempts.
  const sumsRes = await fetchWithFallback(checksumsUrl())
  if (!sumsRes.ok) throw new Error(`Couldn't fetch checksums (${sumsRes.status}).`)
  const expected = sha256For(await sumsRes.text(), asset)
  if (!expected) throw new Error(`The release doesn't list a checksum for ${asset}.`)

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      await downloadAndExtract(asset, expected)
      return
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      // A platform or permission problem repeats identically; only integrity
      // and transport failures are worth another round trip.
      if (!isRetryable(lastError) || attempt === DOWNLOAD_ATTEMPTS) throw lastError
      update({ progress: 0 })
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt))
    }
  }
  throw lastError ?? new Error('Download failed.')
}

/** Whether another attempt could plausibly succeed. */
function isRetryable(error: Error): boolean {
  return /corrupt|truncat|checksum|stopped early|download failed|decompress|network|fetch|socket|ECONN|ETIMEDOUT/i.test(
    error.message
  )
}

/** One download + verify + extract attempt. */
async function downloadAndExtract(asset: string, expected: string): Promise<void> {
  const staging = await fsp.mkdtemp(join(tmpdir(), 'roxy-cliproxy-'))
  const archive = join(staging, asset)
  try {
    const res = await fetchWithFallback(releaseAssetUrl(asset))
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`)
    const total = Number(res.headers.get('content-length') || 0)
    let received = 0
    const out = createWriteStream(archive)
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (total > 0) {
        // Cap at 99: the last percent is extraction, so the bar doesn't sit at
        // 100 while the archive is still being unpacked.
        const pct = Math.min(99, Math.floor((received / total) * 100))
        if (pct !== state.progress) update({ progress: pct })
      }
    })
    await pipeline(source, out)

    // Verify the FILE ON DISK, not the bytes that streamed past on the way in.
    //
    // Hashing the stream was a real bug: it attests to what was RECEIVED, while
    // tar extracts what was WRITTEN. Anything that corrupts the file after the
    // socket — a short write, a full disk, a scanner rewriting the temp file —
    // sails straight through a stream hash and then explodes inside tar as
    // "ZIP decompression failed (-5)", which reads like a broken release rather
    // than a broken download. Hash what we are about to execute.
    const written = (await fsp.stat(archive)).size
    const actual = await sha256OfFile(archive)
    if (actual !== expected) {
      throw new Error(await describeBadDownload(archive, written, total, received))
    }

    // Extract into a temp dir, then swap it into place, so an interrupted
    // extraction can never leave a half-populated install that looks valid.
    const extracted = join(staging, 'x')
    await fsp.mkdir(extracted, { recursive: true })
    await extract(archive, extracted)

    // The archive verified, so a missing binary here means the release layout
    // changed — worth saying plainly instead of failing later at spawn time.
    const staged = join(
      extracted,
      process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'
    )
    try {
      await fsp.access(staged)
    } catch {
      throw new Error("The release didn't contain the expected cli-proxy-api binary.")
    }

    const dest = installDir()
    await fsp.rm(dest, { recursive: true, force: true })
    await fsp.mkdir(join(dest, '..'), { recursive: true })
    await fsp.rename(extracted, dest)

    // The tar/zip executable bit is not preserved everywhere; set it.
    if (process.platform !== 'win32') {
      await fsp.chmod(binPath(), 0o755).catch(() => undefined)
    }
    update({ progress: 100 })
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Explain a failed integrity check by INSPECTING the file, rather than asserting
 * a cause we never checked.
 *
 * The first version of this message blamed "network or antivirus" unconditionally.
 * That was a guess dressed as a diagnosis: it sent people to disable their AV for
 * what is usually a captive portal or a TLS-inspecting proxy handing back an HTML
 * error page. The bytes on disk already say which it was, so read them.
 */
// Exported for the integration test: the whole point of this function is the
// message it produces, so that message needs to be assertable.
export async function describeBadDownload(
  archive: string,
  written: number,
  total: number,
  received: number
): Promise<string> {
  const head = Buffer.alloc(512)
  let sniffed = 0
  try {
    const fh = await fsp.open(archive, 'r')
    try {
      sniffed = (await fh.read(head, 0, head.length, 0)).bytesRead
    } finally {
      await fh.close()
    }
  } catch {
    // Unreadable is itself informative, but not worth failing over here.
  }
  const text = head.subarray(0, sniffed).toString('utf8')

  // An intercepting proxy or captive portal returns a page, not an archive.
  if (/^\s*(<!doctype|<html|\{|<\?xml)/i.test(text)) {
    return (
      'The download returned a web page instead of the release file. A proxy, VPN, or ' +
      'network sign-in page is intercepting the request to github.com.'
    )
  }

  // Archives have stable magic bytes; a wrong one means substituted content.
  const isZip = head[0] === 0x50 && head[1] === 0x4b
  const isGzip = head[0] === 0x1f && head[1] === 0x8b
  const wantsZip = archive.endsWith('.zip')
  if (sniffed > 0 && ((wantsZip && !isZip) || (!wantsZip && !isGzip))) {
    return (
      'The downloaded file is not a valid archive — something replaced its contents ' +
      'in transit (usually a proxy or content filter).'
    )
  }

  // Order matters here: these overlap, and the most specific cause has to be
  // tested first or it can never be reported.
  //
  // A short write (we received N bytes but only M reached the file) is the one
  // case that genuinely implicates local software - antivirus holding the handle,
  // or a full disk. Check it before the length comparison, which would otherwise
  // absorb it and blame the network.
  if (written !== received) {
    return (
      `The file was damaged while being written (${received} bytes downloaded, ${written} on disk). ` +
      'Antivirus software or a full disk is the usual cause.'
    )
  }

  // The transfer itself ended early.
  if (total > 0 && written !== total) {
    return `The download stopped early (${written} of ${total} bytes). This is usually a network drop.`
  }

  // No content-length to compare against - typically a proxy that re-chunked the
  // response. Say exactly that rather than asserting a cause we cannot see.
  if (total === 0) {
    return (
      `The download is incomplete or damaged (${written} bytes received, and the server ` +
      'sent no length to check against). This usually means a proxy altered the response.'
    )
  }

  // Full length, correct shape, wrong hash: genuinely different bytes.
  return (
    'The downloaded file failed its integrity check. The bytes arrived intact but do not ' +
    'match the published checksum, so it was modified in transit.'
  )
}

/** sha256 of a file's actual contents on disk. */
async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * Unpack a release archive. `tar` handles both .tar.gz and .zip and ships with
 * every platform we target (Windows has had bsdtar in System32 since 1803), so
 * this needs no archive dependency in the bundle.
 *
 * Failures are rewritten before they escape. The checksum has already passed by
 * the time we get here, so a tar error means either the archive was damaged
 * between verify and read, or this machine's tar is unusable — and the user
 * should be told that, not shown a raw
 * `ZIP decompression failed (-5): Unknown error` dump with a temp path in it.
 */
// Exported so the integration test can assert the message a corrupt archive
// produces; not part of the service's public surface.
export async function extract(archive: string, dest: string): Promise<void> {
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  try {
    await execFileAsync(tar, ['-xf', archive, '-C', dest])
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    if (/ENOENT/i.test(detail)) {
      throw new Error(
        `Couldn't run ${tar}, which is needed to unpack the download. ` +
          'On Windows it ships with the OS (build 17063 and later).'
      )
    }
    // Deliberately worded as "corrupt": that is what a post-checksum tar
    // failure means, and it tells install() this is worth retrying.
    throw new Error('The downloaded archive is corrupt and could not be unpacked.')
  }
}

// ---- Config ------------------------------------------------------------------

/** Load (or generate once) the local api key + management key. */
async function loadSecrets(): Promise<Secrets> {
  if (secrets) return secrets
  try {
    const parsed = JSON.parse(await fsp.readFile(secretsPath(), 'utf8')) as Partial<Secrets>
    if (parsed.apiKey && parsed.managementKey) {
      secrets = { apiKey: parsed.apiKey, managementKey: parsed.managementKey }
      return secrets
    }
  } catch {
    // Missing or corrupt — fall through and mint a fresh pair.
  }
  secrets = {
    apiKey: `roxy-${randomBytes(24).toString('hex')}`,
    managementKey: `roxy-mgmt-${randomBytes(24).toString('hex')}`
  }
  await fsp.mkdir(root(), { recursive: true })
  await fsp.writeFile(secretsPath(), JSON.stringify(secrets), { mode: 0o600 })
  return secrets
}

/** Quote a scalar for the YAML we generate (paths on Windows contain backslashes). */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Write the config the sidecar runs with. Regenerated on every start because the
 * port is chosen fresh each time.
 *
 * Note the deliberate omissions: no remote management, no control panel, no
 * usage telemetry, no plugins. This instance exists to serve one desktop app on
 * loopback, so every feature that opens a second door stays shut.
 */
async function writeConfig(port: number): Promise<void> {
  const { apiKey, managementKey } = await loadSecrets()
  // The sidecar bcrypt-hashes a plaintext management key in place on startup, so
  // this file is rewritten with a hash after first run — expected, not a problem.
  const yaml = [
    '# Generated by Roxy. Edits are overwritten on every start.',
    `host: ${yamlString(HOST)}`,
    `port: ${port}`,
    `auth-dir: ${yamlString(authDir())}`,
    'api-keys:',
    `  - ${yamlString(apiKey)}`,
    'remote-management:',
    '  allow-remote: false',
    `  secret-key: ${yamlString(managementKey)}`,
    '  disable-control-panel: true',
    '  disable-auto-update-panel: true',
    'debug: false',
    'logging-to-file: false',
    'usage-statistics-enabled: false',
    'plugins:',
    '  enabled: false',
    ''
  ].join('\n')
  await fsp.mkdir(root(), { recursive: true })
  await fsp.mkdir(authDir(), { recursive: true })
  await fsp.writeFile(configPath(), yaml, 'utf8')
}

// ---- Ports -------------------------------------------------------------------

/** Whether a TCP port is free right now, tested by actually binding it. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ port, host: HOST, exclusive: true })
  })
}

/** First free port in the sidecar's range. */
async function pickPort(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error('No free port available for the Codex proxy.')
}

// ---- HTTP helpers ------------------------------------------------------------

/** Base URL of the running sidecar's OpenAI-compatible API. */
export function baseUrl(): string | null {
  return state.port ? `http://${HOST}:${state.port}/v1` : null
}

/** The local bearer key Roxy uses against its own sidecar. */
export async function localApiKey(): Promise<string> {
  return (await loadSecrets()).apiKey
}

/** Call the Management API. Throws with the server's message on a non-2xx. */
async function management<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!state.port) throw new Error('The Codex proxy is not running.')
  const { managementKey } = await loadSecrets()
  const res = await fetch(`http://${HOST}:${state.port}/v0/management${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${managementKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Management request failed (${res.status}). ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

/** Poll `/v1/models` until the process answers, or time out. */
async function waitForHealth(port: number): Promise<void> {
  const { apiKey } = await loadSecrets()
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastError = 'no response'
  while (Date.now() < deadline) {
    // A dead child means the port will never answer — fail now with its reason
    // rather than burning the full timeout.
    if (!child || child.exitCode !== null) {
      throw new Error(`The Codex proxy exited during startup. ${lastError}`)
    }
    try {
      const res = await fetch(`http://${HOST}:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  throw new Error(`The Codex proxy didn't become ready in time (${lastError}).`)
}

// ---- Accounts ----------------------------------------------------------------

interface AuthFileEntry {
  name?: string
  /** Present when the runtime auth manager answers. */
  provider?: string
  /** Present in the auth-dir-scan fallback. */
  type?: string
  email?: string
  /** The runtime manager also reports health; a disabled credential can't serve. */
  disabled?: boolean
  unavailable?: boolean
}

/**
 * Signed-in accounts, read from the sidecar's auth-file listing.
 *
 * The response shape depends on whether the runtime auth manager is up: it
 * reports `provider` plus health flags, while the auth-dir-scan fallback reports
 * only `type`. Both are accepted rather than assuming one, because the fallback
 * is what answers when the manager is still coming up.
 *
 * Best-effort: a failure means "we can't tell", which must not knock a working
 * proxy into an error state - so the previous list is kept.
 */
async function readAccounts(): Promise<CliProxyAccount[]> {
  try {
    const body = await management<{ files?: (AuthFileEntry | string)[] }>('/auth-files')
    return (
      (body.files ?? [])
        .map((f) =>
          typeof f === 'string'
            ? { file: f, type: f.split('-')[0] ?? 'unknown', usable: true }
            : {
                file: f.name ?? '',
                type: f.provider ?? f.type ?? 'unknown',
                email: f.email,
                usable: !f.disabled && !f.unavailable
              }
        )
        // A credential the proxy marked disabled/unavailable cannot serve a
        // request, so listing it as signed in would promise something that fails.
        .filter((a) => a.file && a.usable)
        .map(({ file, type, email }) => ({ file, type, ...(email ? { email } : {}) }))
    )
  } catch {
    return state.accounts
  }
}

/** Re-read the account list and publish it. */
async function refreshAccounts(): Promise<CliProxyAccount[]> {
  const accounts = await readAccounts()
  update({ accounts })
  return accounts
}

// ---- Lifecycle ---------------------------------------------------------------

/**
 * Ensure the sidecar is installed and running, and return its base URL.
 *
 * Idempotent: an already-running instance is returned untouched, so this is safe
 * to call on every turn. Serialized through `enqueue` so concurrent callers
 * share one startup rather than racing two processes onto the same port.
 */
export function ensureRunning(): Promise<string> {
  // Fast path OUTSIDE the queue. The agent loop resolves the endpoint before
  // every model call, and a long install holds the lifecycle chain for ~30s -
  // queueing an already-satisfied request behind it would stall calls that
  // needed nothing. Checked again inside the queue, where it is authoritative.
  if (isLive()) return Promise.resolve(`http://${HOST}:${state.port}/v1`)
  return enqueue(async () => {
    if (isLive()) return `http://${HOST}:${state.port}/v1`
    try {
      if (!(await isInstalled())) await install()

      const port = await pickPort()
      await writeConfig(port)

      stopping = false
      const proc = spawn(binPath(), ['-config', configPath()], {
        cwd: installDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Don't hand the child a console window on Windows, and don't let it
        // outlive the app in its own process group.
        windowsHide: true
      })
      child = proc

      // Keep only the tail of stderr: enough to explain a crash, not enough to
      // grow without bound over a long session.
      let stderrTail = ''
      proc.stderr?.on('data', (b: Buffer) => {
        stderrTail = (stderrTail + b.toString()).slice(-4000)
      })
      proc.stdout?.resume()

      proc.on('exit', (code) => {
        if (child !== proc) return
        child = null
        if (stopping) return
        // Unexpected death: surface it instead of leaving the UI claiming
        // "running" against a port nothing is listening on.
        update({
          status: 'error',
          port: null,
          error: `The Codex proxy stopped unexpectedly (exit ${code ?? 'unknown'}). ${stderrTail.slice(-300)}`
        })
      })

      proc.on('error', (err) => {
        if (child !== proc) return
        child = null
        update({
          status: 'error',
          port: null,
          error: `Couldn't start the Codex proxy: ${err.message}`
        })
      })

      update({ status: 'starting', port, error: undefined })
      await waitForHealth(port)
      setStatus('running')
      await refreshAccounts()
      return `http://${HOST}:${port}/v1`
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      killChild()
      update({ status: 'error', port: null, error: message })
      throw e
    }
  })
}

/** Whether a healthy child is serving on a known port right now. */
function isLive(): boolean {
  return (
    state.status === 'running' && state.port !== null && child !== null && child.exitCode === null
  )
}

/** Kill the child process without touching the published state. */
function killChild(): void {
  const proc = child
  if (!proc) return
  stopping = true
  child = null
  try {
    proc.kill()
  } catch {
    // Already gone.
  }
}

/** Stop the sidecar. Idempotent; leaves the install and tokens in place. */
export function stop(): Promise<CliProxyState> {
  return enqueue(async () => {
    killChild()
    update({
      status: (await isInstalled()) ? 'stopped' : 'not-installed',
      port: null,
      error: undefined
    })
    return state
  })
}

/**
 * Current state, reconciled with what's actually on disk. Called on app start so
 * a fresh launch reports `stopped` (installed, not running) rather than the
 * `not-installed` default.
 */
export async function status(): Promise<CliProxyState> {
  if (state.status === 'not-installed' && (await isInstalled())) {
    update({ status: 'stopped' })
  }
  return state
}

// ---- Login -------------------------------------------------------------------

/**
 * Begin the Codex OAuth login. Boots the sidecar if needed, then asks it for an
 * authorization URL; the caller opens that URL in the user's browser.
 *
 * The sidecar itself listens on :1455 for the OAuth callback — that's the
 * redirect URI registered for the official Codex client, so it isn't negotiable.
 * We check it's free first, because the failure otherwise happens *after* the
 * user has signed in, which is the worst possible moment to discover it.
 */
export async function startLogin(): Promise<CliProxyLoginStart> {
  await ensureRunning()
  if (!(await isPortFree(CODEX_CALLBACK_PORT))) {
    throw new Error(
      `Port ${CODEX_CALLBACK_PORT} is already in use, and the Codex sign-in redirect requires it. ` +
        'Close any running Codex CLI or proxy and try again.'
    )
  }

  // `is_webui=true` is what makes the sidecar OPEN the callback listener on
  // :1455 and wait for the browser to come back.
  //
  // Without it the endpoint still returns a perfectly valid authorization URL,
  // but nothing ever binds the port - that mode expects the CALLER to host the
  // redirect, which is right for its own terminal flow and wrong for ours. The
  // failure lands at the worst possible moment: the user signs in, approves
  // consent, and only then gets ERR_CONNECTION_REFUSED, with the authorization
  // code stranded in the address bar.
  const body = await management<{ status?: string; url?: string; state?: string; error?: string }>(
    '/codex-auth-url?is_webui=true'
  )
  if (!body.url || !body.state) throw new Error(body.error || 'Sign-in could not be started.')

  // Confirm the listener is actually up before sending anyone to the browser.
  // The endpoint returning 200 is not evidence that the port got bound, and this
  // is the last moment we can fail cheaply.
  if (!(await waitForCallbackListener())) {
    throw new Error(
      'The sign-in listener could not start. Something may be blocking port ' +
        `${CODEX_CALLBACK_PORT} on this machine.`
    )
  }
  return { url: body.url, state: body.state }
}

/**
 * Wait for the sidecar to bind the OAuth callback port.
 *
 * It binds asynchronously after the auth-url call returns, so a naive check
 * races it. Polling briefly turns "signed in, then refused" into a clear error
 * raised before the browser is ever opened.
 *
 * This CONNECTS rather than reusing isPortFree, which tests availability by
 * binding. Binding here would be actively harmful: polling every 100ms while the
 * sidecar is trying to bind the same port means we eventually win the race and
 * take it ourselves, causing the exact failure this function exists to detect.
 */
function waitForCallbackListener(): Promise<boolean> {
  const deadline = Date.now() + CALLBACK_BIND_TIMEOUT_MS
  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = new net.Socket()
      const done = (ok: boolean): void => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(500)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
      socket.connect(CODEX_CALLBACK_PORT, HOST)
    })

  return (async () => {
    while (Date.now() < deadline) {
      if (await attempt()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  })()
}

/**
 * Poll until the OAuth flow completes, then refresh the account list.
 *
 * `wait` means the browser hasn't come back yet. The sidecar deletes the state
 * once it reaches a terminal status, and answers `ok` for an unknown state — so
 * a poll that arrives after completion still reads as success rather than as a
 * mysterious failure.
 */
export async function pollLogin(loginState: string): Promise<CliProxyLoginResult> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    let body: { status?: string; error?: string }
    try {
      body = await management(`/get-auth-status?state=${encodeURIComponent(loginState)}`)
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        accounts: state.accounts
      }
    }
    if (body.status === 'ok') {
      return { ok: true, accounts: await refreshAccounts() }
    }
    if (body.status === 'error') {
      return { ok: false, error: body.error || 'Sign-in failed.', accounts: state.accounts }
    }
    await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
  }
  return { ok: false, error: 'Timed out waiting for sign-in.', accounts: state.accounts }
}

/** Sign an account out by deleting its token file from the sidecar's auth-dir. */
export async function signOut(file: string): Promise<CliProxyAccount[]> {
  await management(`/auth-files?name=${encodeURIComponent(file)}`, { method: 'DELETE' })
  return refreshAccounts()
}

/**
 * Fully disconnect: forget every signed-in account, then stop the proxy.
 *
 * "Disconnect" wipes the stored credential for every other provider in Settings,
 * so it has to mean the same thing here. If it only dropped the provider row,
 * someone disconnecting to remove their ChatGPT account from the app would have
 * left the tokens sitting in auth-dir - the opposite of what they asked for.
 *
 * Deleting requires the Management API, so the proxy is briefly started if it
 * isn't already. Every step is best-effort: the caller drops the provider row
 * regardless, because a failure here must not leave a row that cannot be removed.
 */
export async function disconnect(): Promise<void> {
  try {
    await ensureRunning()
    await management('/auth-files?all=true', { method: 'DELETE' })
  } catch {
    // Couldn't reach the proxy - the auth-dir wipe below is the backstop.
  }
  await stop()
  // Belt and braces. The API call above is the clean path (it also drops the
  // credentials from the running process), but "disconnect" must not silently
  // leave subscription tokens on disk just because the proxy wouldn't start.
  await fsp.rm(authDir(), { recursive: true, force: true }).catch(() => undefined)
  update({ accounts: [] })
}

/**
 * The models the sidecar currently exposes (i.e. what the signed-in
 * subscription actually grants). Returns [] when it isn't running, so the
 * caller degrades to an empty picker instead of throwing.
 */
export async function listProxyModels(): Promise<{ id: string; name?: string }[]> {
  if (state.status !== 'running' || !state.port) return []
  try {
    const { apiKey } = await loadSecrets()
    const res = await fetch(`http://${HOST}:${state.port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: { id: string; display_name?: string }[] }
    return (body.data ?? []).map((m) => ({ id: m.id, name: m.display_name }))
  } catch {
    return []
  }
}

/**
 * Install from a file the user already has, bypassing the download entirely.
 *
 * The escape hatch. Some networks cannot be fixed from inside the app: a proxy
 * that rewrites binaries, a filter that blocks github.com outright, an
 * air-gapped machine. Retries and a second network stack do not help there, and
 * without this the feature is simply unavailable — with no way out.
 *
 * The archive still has to match the pinned release's checksum. A local file is
 * a different delivery route, not a reason to run unverified code.
 */
export async function installFromFile(archivePath: string): Promise<CliProxyState> {
  return enqueue(async () => {
    const asset = releaseAsset(process.platform, process.arch)
    if (!asset) throw new Error('Codex sign-in is unavailable on this platform.')

    update({ status: 'downloading', progress: 50, error: undefined })
    try {
      const sumsRes = await fetchWithFallback(checksumsUrl())
      let expected: string | null = null
      if (sumsRes.ok) expected = sha256For(await sumsRes.text(), asset)

      // The checksums file lives on the same host that may be blocked. Fall back
      // to the digest recorded at pin time so an offline install still verifies.
      const want = expected ?? PINNED_SHA256[asset]
      if (!want) {
        throw new Error("Couldn't determine the expected checksum for this platform.")
      }

      const actual = await sha256OfFile(archivePath)
      if (actual !== want) {
        throw new Error(
          `That file doesn't match the expected ${asset} for v${CLIPROXY_VERSION}. ` +
            'Download it from the CLIProxyAPI releases page and try again.'
        )
      }

      const staging = await fsp.mkdtemp(join(tmpdir(), 'roxy-cliproxy-local-'))
      try {
        const extracted = join(staging, 'x')
        await fsp.mkdir(extracted, { recursive: true })
        await extract(archivePath, extracted)

        const staged = join(
          extracted,
          process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'
        )
        try {
          await fsp.access(staged)
        } catch {
          throw new Error("That archive didn't contain the expected cli-proxy-api binary.")
        }

        const dest = installDir()
        await fsp.rm(dest, { recursive: true, force: true })
        await fsp.mkdir(join(dest, '..'), { recursive: true })
        await fsp.rename(extracted, dest)
        if (process.platform !== 'win32') {
          await fsp.chmod(binPath(), 0o755).catch(() => undefined)
        }
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }

      update({ status: 'stopped', progress: 100 })
      return state
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      update({ status: 'not-installed', progress: 0, error: message })
      throw e
    }
  })
}

/** Kill the sidecar on app quit. Best-effort and synchronous — quit won't wait. */
export function shutdownCliProxy(): void {
  killChild()
}
