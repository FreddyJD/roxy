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
import { createWriteStream } from 'node:fs'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow } from 'electron'
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

/** How long to wait for the process to answer a health check before giving up. */
const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_INTERVAL_MS = 250

/** OAuth polling: the user has to sign in with a browser, so this is generous. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_POLL_MS = 1_000

/** Codex's OAuth callback listener, opened by the sidecar for the login flow. */
const CODEX_CALLBACK_PORT = 1455

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
 * Download + verify + extract the pinned release.
 *
 * The asset is streamed to a temp file, hashed, and compared against the
 * release's `checksums.txt` BEFORE anything is extracted or executed. A missing
 * checksum entry aborts: unverifiable is treated as failed, not as fine.
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

  const staging = await fsp.mkdtemp(join(tmpdir(), 'roxy-cliproxy-'))
  const archive = join(staging, asset)
  try {
    // 1. Expected digest first, so a bad download is caught rather than run.
    const sumsRes = await fetch(checksumsUrl())
    if (!sumsRes.ok) throw new Error(`Couldn't fetch checksums (${sumsRes.status}).`)
    const expected = sha256For(await sumsRes.text(), asset)
    if (!expected) throw new Error(`The release doesn't list a checksum for ${asset}.`)

    // 2. Stream the asset down, reporting progress as it goes.
    const res = await fetch(releaseAssetUrl(asset))
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`)
    const total = Number(res.headers.get('content-length') || 0)
    let received = 0
    const hash = createHash('sha256')
    const out = createWriteStream(archive)
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.length
      if (total > 0) {
        // Cap at 99: the last percent is extraction, so the bar doesn't sit at
        // 100 while the archive is still being unpacked.
        const pct = Math.min(99, Math.floor((received / total) * 100))
        if (pct !== state.progress) update({ progress: pct })
      }
    })
    await pipeline(source, out)

    // 3. Verify before extracting. This is the gate that matters.
    const actual = hash.digest('hex')
    if (actual !== expected) {
      throw new Error('Checksum mismatch — the download was corrupted or tampered with.')
    }

    // 4. Extract into a temp dir, then swap it into place, so an interrupted
    //    extraction can never leave a half-populated install that looks valid.
    const extracted = join(staging, 'x')
    await fsp.mkdir(extracted, { recursive: true })
    await extract(archive, extracted)

    const dest = installDir()
    await fsp.rm(dest, { recursive: true, force: true })
    await fsp.mkdir(join(dest, '..'), { recursive: true })
    await fsp.rename(extracted, dest)

    // 5. The tar/zip bit is not preserved everywhere; make it executable.
    if (process.platform !== 'win32') {
      await fsp.chmod(binPath(), 0o755).catch(() => undefined)
    }
    update({ progress: 100 })
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Unpack a release archive. `tar` handles both .tar.gz and .zip and ships with
 * every platform we target (Windows has had bsdtar in System32 since 1803), so
 * this needs no archive dependency in the bundle.
 */
async function extract(archive: string, dest: string): Promise<void> {
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  await execFileAsync(tar, ['-xf', archive, '-C', dest])
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
  const body = await management<{ status?: string; url?: string; state?: string; error?: string }>(
    '/codex-auth-url'
  )
  if (!body.url || !body.state) throw new Error(body.error || 'Sign-in could not be started.')
  return { url: body.url, state: body.state }
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

/** Kill the sidecar on app quit. Best-effort and synchronous — quit won't wait. */
export function shutdownCliProxy(): void {
  killChild()
}
