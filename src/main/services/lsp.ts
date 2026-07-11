/**
 * LSP service — the main-process half of Phase 12 (the process + document
 * lifecycle that the pure `shared/lsp.ts` can't own).
 *
 * What it does: keep a warm pool of language servers (one per project-root +
 * server), and after the agent edits a file, `didOpen`/`didChange` that file and
 * wait for the server's diagnostics to settle, then hand them back so the edit
 * tool can append a `<diagnostics>` block. The model sees its own type errors on
 * the very next turn — opencode's biggest correctness multiplier.
 *
 * Design choices vs opencode (leaner + safer for a desktop app):
 *   - Dependency-free: a hand-written JSON-RPC/stdio client (no LSP library).
 *   - Never downloads a server. We use only what's already installed — found on
 *     PATH or in the workspace's `node_modules/.bin`. If a file's server isn't
 *     present we silently return no diagnostics; an edit is NEVER blocked or
 *     broken by LSP.
 *   - Push-based diagnostics with a debounce + overall timeout (the big four
 *     servers — tsserver, pyright, gopls, rust-analyzer — all push). Pull-model
 *     diagnostics are a documented future enhancement.
 *
 * Modeled on opencode's `lsp/client.ts` + `lsp/lsp.ts` (MIT).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  RpcDecoder,
  encodeRpcMessage,
  fileUriToPath,
  languageIdForPath,
  pathToFileUri,
  renderDiagnosticsBlock,
  serverForPath,
  type LspDiagnostic,
  type LspServerDef,
  type RenderOptions
} from '../../shared/lsp'

/** ms to wait for the server to go quiet after its last push before resolving. */
const DIAGNOSTICS_DEBOUNCE_MS = 150
/** Overall ceiling on waiting for diagnostics after an edit. */
const DIAGNOSTICS_TIMEOUT_MS = 4_000
/** Ceiling on the `initialize` handshake before a server is declared broken. */
const INIT_TIMEOUT_MS = 10_000

/** A server def may carry extra env (used by tests to run a mock over node). */
interface ServerDef extends LspServerDef {
  env?: Record<string, string>
}

/** LSP is disabled entirely when ROXY_LSP=0 (kill switch). */
function lspEnabled(): boolean {
  return process.env.ROXY_LSP !== '0'
}

// ---------------------------------------------------------------------------
// which(): locate a server binary without ever downloading one.
// ---------------------------------------------------------------------------

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return existsSync(p) // on some setups .bin shims aren't +x but are runnable
  }
}

/** Find `command` as an absolute path, or in `<root>/node_modules/.bin`, or on PATH. */
function which(command: string, root: string): string | null {
  if (path.isAbsolute(command)) return isExecutable(command) ? command : null
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  const dirs = [
    path.join(root, 'node_modules', '.bin'),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  ]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

/** Walk up from a file for the nearest dir containing a root marker (fallback: file's dir). */
function findRoot(absFile: string, markers: string[]): string {
  let dir = path.dirname(absFile)
  const seen: string[] = []
  for (;;) {
    seen.push(dir)
    for (const marker of markers) {
      if (existsSync(path.join(dir, marker))) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return seen[0] // no marker found — the file's own directory
}

// ---------------------------------------------------------------------------
// Canonical key for a document across the didOpen/didChange -> publishDiagnostics
// round-trip. A server echoes back a file:// URI, and fileUriToPath yields forward
// slashes even on Windows (C:/a/b), while the paths we open with are native
// (C:\a\b). Keying published/listeners off the raw path would never match on
// Windows, silently dropping every diagnostic -- so both sides go through here.
function docKey(p: string): string {
  let out = p.replace(/\\/g, '/')
  if (process.platform === 'win32') out = out.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':')
  return out
}

// LspClient: one language-server process + its document/diagnostic state.
// ---------------------------------------------------------------------------

interface PublishedDiagnostics {
  at: number
  version?: number
  diagnostics: LspDiagnostic[]
}

class LspClient {
  private child: ChildProcessWithoutNullStreams
  private decoder = new RpcDecoder()
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  /** Open documents and their current version (didOpen=1, then +1 per change). */
  private docs = new Map<string, { version: number }>()
  /** Latest diagnostics pushed by the server, keyed by absolute path. */
  private published = new Map<string, PublishedDiagnostics>()
  /** Waiters notified whenever a fresh publishDiagnostics arrives. */
  private diagnosticListeners = new Set<(path: string) => void>()
  /** Per-path serialization so concurrent touch+wait can't interleave versions. */
  private locks = new Map<string, Promise<unknown>>()
  private disposed = false

  private constructor(
    readonly def: ServerDef,
    readonly root: string,
    bin: string
  ) {
    this.child = spawn(bin, def.args, {
      cwd: root,
      env: { ...process.env, ...def.env },
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    this.child.stderr.on('data', () => {}) // drain stderr so the pipe never blocks
    this.child.on('exit', () => this.onExit())
    this.child.on('error', () => this.onExit())
  }

  /** Spawn + handshake a server for `root`; rejects (→ broken) on any failure. */
  static async start(def: ServerDef, root: string, bin: string): Promise<LspClient> {
    const client = new LspClient(def, root, bin)
    try {
      await client.initialize()
    } catch (e) {
      // A failed/timed-out handshake must never leave the child running: the
      // client is not returned or pooled, so this is our only chance to kill it.
      client.dispose()
      throw e
    }
    return client
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch {
      return
    }
    for (const msg of messages) this.handleMessage(msg as Record<string, unknown>)
  }

  private onExit(): void {
    if (this.disposed) return
    this.disposed = true
    const err = new Error('language server exited')
    for (const { reject } of this.pending.values()) reject(err)
    this.pending.clear()
    // Evict ourselves from the warm pool so the next edit re-spawns a fresh
    // server rather than reusing this dead one (which would silently yield no
    // diagnostics for this root for the rest of the session). Guarded so a
    // concurrent replacement isn't clobbered. dispose()-initiated exits return
    // early above, so this only runs for unexpected crashes.
    const key = clientKey(this.root, this.def.id)
    if (clients.get(key) === this) clients.delete(key)
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = msg.id as number | string | undefined
    const method = msg.method as string | undefined
    if (method && id != null) {
      // Server→client request: reply so the server doesn't stall. We don't
      // implement these features, so a permissive null/[]-shaped reply is fine.
      this.reply(id, method === 'workspace/configuration' ? this.configReply(msg.params) : null)
      return
    }
    if (method) {
      // Notification.
      if (method === 'textDocument/publishDiagnostics') this.onPublishDiagnostics(msg.params)
      return
    }
    if (id != null) {
      // Response to one of our requests.
      const waiter = this.pending.get(id as number)
      if (!waiter) return
      this.pending.delete(id as number)
      if ('error' in msg && msg.error) {
        const e = msg.error as { message?: string }
        waiter.reject(new Error(e.message ?? 'LSP error'))
      } else {
        waiter.resolve((msg as { result?: unknown }).result)
      }
    }
  }

  /** `workspace/configuration` wants one value per requested section; give defaults. */
  private configReply(params: unknown): unknown[] {
    const items = (params as { items?: unknown[] } | undefined)?.items ?? []
    return items.map(() => null)
  }

  private onPublishDiagnostics(params: unknown): void {
    const p = params as { uri?: string; version?: number; diagnostics?: LspDiagnostic[] } | undefined
    if (!p?.uri) return
    const filePath = docKey(fileUriToPath(p.uri))
    this.published.set(filePath, {
      at: Date.now(),
      version: typeof p.version === 'number' ? p.version : undefined,
      diagnostics: Array.isArray(p.diagnostics) ? p.diagnostics : []
    })
    for (const listener of [...this.diagnosticListeners]) listener(filePath)
  }

  private write(msg: unknown): void {
    if (this.disposed || !this.child.stdin.writable) return
    this.child.stdin.write(encodeRpcMessage(msg))
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private reply(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('client disposed'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToFileUri(this.root)
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
        clientInfo: { name: 'roxy', version: '0.0.0' },
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { relatedInformation: true, versionSupport: true }
          }
        },
        initializationOptions: {}
      },
      INIT_TIMEOUT_MS
    )
    this.notify('initialized', {})
  }

  /**
   * Ensure `absPath` is open (didOpen) or re-synced (didChange with full text),
   * then wait for the server's diagnostics for it to settle. Serialized per path.
   */
  async diagnostics(absPath: string, timeoutMs = DIAGNOSTICS_TIMEOUT_MS): Promise<LspDiagnostic[]> {
    const prior = this.locks.get(absPath) ?? Promise.resolve()
    const run = prior.then(() => this.touchAndWait(absPath, timeoutMs)).catch(() => [] as LspDiagnostic[])
    this.locks.set(
      absPath,
      run.catch(() => undefined)
    )
    return run
  }

  private async touchAndWait(absPath: string, timeoutMs: number): Promise<LspDiagnostic[]> {
    if (this.disposed) return []
    let text: string
    try {
      text = readFileSync(absPath, 'utf8')
    } catch {
      return [] // file vanished / unreadable — nothing to diagnose
    }
    const uri = pathToFileUri(absPath)
    const sentAt = Date.now()
    const existing = this.docs.get(absPath)
    let version: number
    if (!existing) {
      version = 1
      this.docs.set(absPath, { version })
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdForPath(absPath), version, text }
      })
    } else {
      version = existing.version + 1
      existing.version = version
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }] // full-document sync (always spec-valid)
      })
    }
    await this.waitForFreshDiagnostics(docKey(absPath), version, sentAt, timeoutMs)
    return this.published.get(docKey(absPath))?.diagnostics ?? []
  }

  /** Resolve once a publishDiagnostics for `path` newer than `sentAt` has settled. */
  private waitForFreshDiagnostics(
    filePath: string,
    version: number,
    sentAt: number,
    timeoutMs: number
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false
      let debounce: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (done) return
        done = true
        if (debounce) clearTimeout(debounce)
        clearTimeout(timeout)
        this.diagnosticListeners.delete(listener)
        resolve()
      }
      const consider = (): void => {
        const hit = this.published.get(filePath)
        if (!hit) return
        // Reject a stale push: older than our change, and not our version.
        const fresh = hit.at >= sentAt || hit.version === version
        if (!fresh) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(finish, Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
      }
      const listener = (p: string): void => {
        if (p === filePath) consider()
      }
      const timeout = setTimeout(finish, timeoutMs)
      this.diagnosticListeners.add(listener)
      consider() // a qualifying push may already be cached (warm server)
    })
  }

  dispose(): void {
    if (this.disposed) {
      try {
        this.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      return
    }
    this.disposed = true
    try {
      this.notify('shutdown', undefined)
      this.notify('exit', undefined)
    } catch {
      /* pipe may be closed */
    }
    const child = this.child
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 500).unref?.()
  }
}

// ---------------------------------------------------------------------------
// Pool: warm clients keyed by (root, serverId); broken + unavailable caches.
// ---------------------------------------------------------------------------

const clients = new Map<string, LspClient>()
const broken = new Set<string>()
/** (root, serverId) → binary path (or null when confirmed missing), per session. */
const availability = new Map<string, string | null>()
/** Extra servers registered at runtime (tests inject a mock here). */
const extraServers: ServerDef[] = []

function clientKey(root: string, serverId: string): string {
  return `${root}\0${serverId}`
}

function serverDefFor(absPath: string): ServerDef | undefined {
  for (const s of extraServers) {
    if (s.extensions.includes(extLower(absPath))) return s
  }
  return serverForPath(absPath) as ServerDef | undefined
}

function extLower(p: string): string {
  const dot = p.lastIndexOf('.')
  return dot > 0 ? p.slice(dot).toLowerCase() : ''
}

/** Get (or lazily spawn) the warm client for a file, or undefined if unavailable. */
async function getClient(absPath: string): Promise<LspClient | undefined> {
  const def = serverDefFor(absPath)
  if (!def) return undefined

  const root = findRoot(absPath, def.rootMarkers)
  const key = clientKey(root, def.id)
  if (broken.has(key)) return undefined

  // Availability is cached per (root, serverId) — `which` probes this root's
  // node_modules/.bin, so a different root may resolve a different binary.
  let bin = availability.get(key)
  if (bin === undefined) {
    bin = which(def.command, root)
    availability.set(key, bin)
  }
  if (!bin) return undefined

  const existing = clients.get(key)
  if (existing) return existing

  try {
    const client = await LspClient.start(def, root, bin)
    clients.set(key, client)
    return client
  } catch {
    broken.add(key) // spawn/handshake failed — don't retry this root
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Public API (what the harness/tools call).
// ---------------------------------------------------------------------------

/** Raw diagnostics for a file after touching it, or [] when no server applies. */
export async function diagnostics(
  absPath: string,
  timeoutMs?: number
): Promise<LspDiagnostic[]> {
  if (!lspEnabled()) return []
  try {
    const client = await getClient(absPath)
    if (!client) return []
    return await client.diagnostics(absPath, timeoutMs)
  } catch {
    return []
  }
}

/**
 * The `<diagnostics>` block to append to an edit/write tool result, or '' when
 * there's nothing to surface (no server, no errors, or LSP disabled). Never
 * throws — diagnostics must not be able to break an edit.
 */
export async function diagnosticsBlock(
  absPath: string,
  cwd: string,
  opts: RenderOptions & { timeoutMs?: number } = {}
): Promise<string> {
  if (!lspEnabled()) return ''
  try {
    if (!serverDefFor(absPath)) return '' // fast path: unsupported file type
    const diags = await diagnostics(absPath, opts.timeoutMs)
    if (diags.length === 0) return ''
    const rel = path.relative(cwd, absPath) || path.basename(absPath)
    return renderDiagnosticsBlock(rel, diags, opts)
  } catch {
    return ''
  }
}

/** Shut every warm server down (app quit). */
export function shutdownAllLsp(): void {
  for (const client of clients.values()) client.dispose()
  clients.clear()
  broken.clear()
}

/** The id of the language server configured for a file's type, if any. */
export function configuredServerId(absPath: string): string | undefined {
  return serverDefFor(absPath)?.id
}

/** Test-only: register a custom server (e.g. a mock LSP over `process.execPath`). */
export function _registerServerForTests(def: ServerDef): void {
  extraServers.push(def)
}

/** Test-only: tear down all clients + caches between smoke cases. */
export function _resetLspForTests(): void {
  shutdownAllLsp()
  availability.clear()
  extraServers.length = 0
}
