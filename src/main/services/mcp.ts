/**
 * MCP (Model Context Protocol) client service — connects external tool servers
 * and exposes their tools to the agent loop. Built on the official
 * `@modelcontextprotocol/sdk`, which handles the transports (stdio + Streamable
 * HTTP, with an SSE fallback) and protocol negotiation for us.
 *
 * Design (mirrors the LSP service's warm-pool + graceful-degradation shape):
 *  - A process-wide pool keyed by server id. Connections are lazy (established on
 *    first `ensureMcpConnected`) and warm (reused across turns).
 *  - Nothing here ever throws into the agent loop: a server that fails to spawn,
 *    times out, or returns garbage degrades to "no tools" / an error ToolResult —
 *    it never breaks a turn. A `ROXY_MCP=0` env var disables the whole subsystem.
 *  - The pure protocol-independent logic (naming, schema conversion, result
 *    rendering, prompt blurb) lives in `src/shared/mcp.ts` and is unit-tested in
 *    smoke:shared; this file is exercised end-to-end against a mock server in
 *    smoke:app.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ToolResult } from '../../shared/types'
import {
  MAX_TOOL_NAME,
  MCP_TOOL_PREFIX,
  describeMcpForPrompt,
  isMcpToolName,
  mcpToolToSchema,
  normalizeServerRecords,
  qualifyToolName,
  renderMcpContent,
  type McpLocalConfig,
  type McpRemoteConfig,
  type McpServerRecord,
  type McpServerSummary,
  type RoxyToolSchema
} from '../../shared/mcp'

const CLIENT_INFO = { name: 'roxy', version: '0.0.13' }
/** ms to establish + initialize a server before giving up (per-server override wins). */
const DEFAULT_STARTUP_TIMEOUT = 15_000
/** ms budget for a single `tools/call` (tool work can be genuinely slow). */
const DEFAULT_REQUEST_TIMEOUT = 120_000

/** Kill switch: set ROXY_MCP=0 to disable all MCP connections. */
function mcpDisabled(): boolean {
  return process.env.ROXY_MCP === '0'
}

// ---------------------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------------------

interface McpToolInfo {
  /** The provider-legal, namespaced function name (`mcp__server__tool`). */
  qualifiedName: string
  /** The raw tool name the server knows it by. */
  toolName: string
  serverId: string
  schema: RoxyToolSchema
}

interface McpConnection {
  id: string
  client: Client | null
  status: 'connected' | 'error'
  error?: string
  tools: McpToolInfo[]
}

/** Warm pool: server id → connection (connected or errored/cached). */
const connections = new Map<string, McpConnection>()
/** In-flight connects, so concurrent `ensureMcpConnected` calls don't double-spawn. */
const connecting = new Map<string, Promise<McpConnection>>()
/** qualifiedName → tool info, for O(1) dispatch routing. */
const toolIndex = new Map<string, McpToolInfo>()

// ---------------------------------------------------------------------------
// Transport construction
// ---------------------------------------------------------------------------

function makeStdioTransport(cfg: McpLocalConfig, workspaceCwd: string): Transport {
  const [command, ...args] = cfg.command
  const cwd = cfg.cwd ? path.resolve(workspaceCwd || process.cwd(), cfg.cwd) : workspaceCwd || undefined
  return new StdioClientTransport({
    command,
    args,
    cwd,
    // Merge the SDK's safe base env (includes PATH so `npx`/`uvx` resolve) with
    // the server's configured vars.
    env: { ...getDefaultEnvironment(), ...(cfg.environment ?? {}) },
    // Don't let a chatty server pollute our stderr; we surface failures via status.
    stderr: 'ignore'
  })
}

/** Ordered transport attempts for a record (remote tries Streamable HTTP, then SSE). */
function transportFactories(rec: McpServerRecord, workspaceCwd: string): Array<() => Transport> {
  if (rec.config.type === 'local') {
    const cfg = rec.config
    return [() => makeStdioTransport(cfg, workspaceCwd)]
  }
  const cfg = rec.config as McpRemoteConfig
  const url = new URL(cfg.url)
  const init = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined
  return [
    () => new StreamableHTTPClientTransport(url, init),
    () => new SSEClientTransport(url, init)
  ]
}

function startupTimeout(rec: McpServerRecord): number {
  return rec.config.timeout ?? DEFAULT_STARTUP_TIMEOUT
}
function requestTimeout(rec: McpServerRecord): number {
  return rec.config.timeout ?? DEFAULT_REQUEST_TIMEOUT
}

// ---------------------------------------------------------------------------
// Connect + tool discovery
// ---------------------------------------------------------------------------

/** Connect a single server and discover its tools. Never throws → errored connection. */
async function connectOne(rec: McpServerRecord, workspaceCwd: string): Promise<McpConnection> {
  const attempts = transportFactories(rec, workspaceCwd)
  let lastErr: unknown
  for (const make of attempts) {
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    try {
      const transport = make()
      await client.connect(transport, { timeout: startupTimeout(rec) })
      const tools = await discoverTools(client, rec)
      // No global side effects here: `getConnection` commits (indexes tools + wires
      // onclose) only if this connection isn't disposed/superseded while in flight,
      // so a mid-connect dispose can't leave orphaned toolIndex entries.
      return { id: rec.id, client, status: 'connected', tools }
    } catch (e) {
      lastErr = e
      try {
        await client.close()
      } catch {
        /* ignore */
      }
    }
  }
  return { id: rec.id, client: null, status: 'error', error: errMsg(lastErr), tools: [] }
}

/** List a server's tools (following `nextCursor` pagination), namespaced + deduped. */
async function discoverTools(client: Client, rec: McpServerRecord): Promise<McpToolInfo[]> {
  const infos: McpToolInfo[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const res = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: requestTimeout(rec)
    })
    for (const t of res.tools ?? []) {
      if (!t || typeof t.name !== 'string' || !t.name) continue
      const qualified = uniqueName(qualifyToolName(rec.id, t.name), seen)
      seen.add(qualified)
      infos.push({
        qualifiedName: qualified,
        toolName: t.name,
        serverId: rec.id,
        schema: mcpToolToSchema(qualified, t.description, t.inputSchema)
      })
    }
    cursor = res.nextCursor
  } while (cursor)
  return infos
}

/** Ensure a name is unique within a server by appending a counter (staying ≤ limit). */
function uniqueName(name: string, seen: Set<string>): string {
  if (!seen.has(name)) return name
  for (let i = 1; ; i++) {
    const suffix = `_${i}`
    const candidate = name.slice(0, MAX_TOOL_NAME - suffix.length) + suffix
    if (!seen.has(candidate)) return candidate
  }
}

function indexTools(conn: McpConnection): void {
  // Drop any stale tools this server previously registered, then re-index.
  for (const [key, info] of toolIndex) if (info.serverId === conn.id) toolIndex.delete(key)
  for (const t of conn.tools) toolIndex.set(t.qualifiedName, t)
}

/** A server's transport closed unexpectedly: prune its tools and mark it errored. */
function onTransportClosed(id: string, client: Client): void {
  const conn = connections.get(id)
  if (!conn || conn.client !== client) return // superseded by a newer connection
  for (const [key, info] of toolIndex) if (info.serverId === id) toolIndex.delete(key)
  conn.status = 'error'
  conn.error = conn.error ?? 'The MCP server disconnected.'
  conn.client = null
  conn.tools = []
}

/** Get the warm connection for a record, connecting (once) if needed. */
function getConnection(rec: McpServerRecord, workspaceCwd: string): Promise<McpConnection> {
  const cached = connections.get(rec.id)
  if (cached) return Promise.resolve(cached) // connected or cached-errored (no per-turn retry storm)
  const inflight = connecting.get(rec.id)
  if (inflight) return inflight
  const p: Promise<McpConnection> = connectOne(rec, workspaceCwd).then((conn) => {
    // If we were disposed or superseded by a newer connect while this one was in
    // flight, don't resurrect the pool entry — just release this child process.
    // Whoever superseded us already owns `connections`/`toolIndex`; leave them be.
    // (connectOne wrote no global state, so there's nothing else to unwind.)
    if (connecting.get(rec.id) !== p) {
      if (conn.client) void conn.client.close().catch(() => {})
      return conn
    }
    connections.set(rec.id, conn)
    // Commit global routing state only now that we own the pool slot. Wiring onclose
    // here (not in connectOne) means a discarded in-flight connect never touches it.
    if (conn.status === 'connected' && conn.client) {
      indexTools(conn)
      const client = conn.client
      client.onclose = (): void => onTransportClosed(rec.id, client)
    }
    connecting.delete(rec.id)
    return conn
  })
  connecting.set(rec.id, p)
  return p
}

// ---------------------------------------------------------------------------
// Public API (agent loop + IPC)
// ---------------------------------------------------------------------------

/**
 * Connect every enabled record that isn't already in the pool. Idempotent and
 * warm: already-connected servers are reused; already-errored ones are left as-is
 * (call `reconnectMcpServer` to retry a specific one). Never throws.
 */
export async function ensureMcpConnected(
  records: McpServerRecord[],
  workspaceCwd: string
): Promise<void> {
  if (mcpDisabled()) return
  const enabled = records.filter((r) => r.enabled)
  await Promise.all(
    enabled.map((r) =>
      getConnection(r, workspaceCwd).catch(() => {
        /* getConnection already degrades to an errored connection */
      })
    )
  )
}

/**
 * Tool schemas from currently-connected servers, for the agent's tool list.
 * Pass the turn's record ids to scope the result to just this workspace's servers
 * (the pool is process-global, but a workspace's `.roxy/mcp.json` servers must not
 * leak into a different workspace's chat).
 */
export function mcpToolSchemas(ids?: Set<string>): RoxyToolSchema[] {
  const out: RoxyToolSchema[] = []
  for (const conn of connections.values()) {
    if (conn.status !== 'connected') continue
    if (ids && !ids.has(conn.id)) continue
    for (const t of conn.tools) out.push(t.schema)
  }
  return out
}

/** Route + run an MCP tool call, rendering the result. Never throws. */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const info = toolIndex.get(name)
  if (!info) return { ok: false, output: `Unknown MCP tool: ${name}` }
  const conn = connections.get(info.serverId)
  if (!conn || conn.status !== 'connected' || !conn.client) {
    return { ok: false, output: `MCP server "${info.serverId}" is not connected.` }
  }
  try {
    const res = await conn.client.callTool(
      { name: info.toolName, arguments: args ?? {} },
      undefined,
      { timeout: DEFAULT_REQUEST_TIMEOUT }
    )
    return renderMcpContent(res.content, res.isError === true)
  } catch (e) {
    return { ok: false, output: `MCP tool "${name}" failed: ${errMsg(e)}` }
  }
}

/** Whether a tool name should be dispatched to the MCP pool (re-exported for tools.ts). */
export const isMcpTool = isMcpToolName

/** A human-friendly `server · tool` label for a namespaced MCP tool name (for UI cards). */
export function mcpToolTitle(name: string): string {
  const info = toolIndex.get(name)
  if (info) return `${info.serverId} · ${info.toolName}`
  return name.startsWith(`${MCP_TOOL_PREFIX}__`) ? name.slice(MCP_TOOL_PREFIX.length + 2).replace(/__/g, ' · ') : name
}

/** Per-server status snapshot (for the settings UI + prompt blurb). Optionally scoped. */
export function mcpServerSummaries(ids?: Set<string>): McpServerSummary[] {
  const out: McpServerSummary[] = []
  for (const conn of connections.values()) {
    if (ids && !ids.has(conn.id)) continue
    out.push({
      id: conn.id,
      status: conn.status,
      tools: conn.tools.map((t) => t.toolName),
      error: conn.error
    })
  }
  return out
}

/** The system-prompt blurb describing connected servers, or undefined when none. */
export function mcpInstructions(ids?: Set<string>): string | undefined {
  return describeMcpForPrompt(mcpServerSummaries(ids))
}

/** Force a fresh connection attempt for one server (used by the UI's reconnect). */
export async function reconnectMcpServer(
  rec: McpServerRecord,
  workspaceCwd: string
): Promise<McpServerSummary> {
  await disposeConnection(rec.id)
  if (!rec.enabled || mcpDisabled()) {
    return { id: rec.id, status: 'disabled', tools: [] }
  }
  const conn = await getConnection(rec, workspaceCwd)
  return { id: conn.id, status: conn.status, tools: conn.tools.map((t) => t.toolName), error: conn.error }
}

/** Close + forget one server's connection (e.g. it was deleted or disabled). */
export async function disposeConnection(id: string): Promise<void> {
  connecting.delete(id)
  const conn = connections.get(id)
  connections.delete(id)
  for (const [key, info] of toolIndex) if (info.serverId === id) toolIndex.delete(key)
  if (conn?.client) {
    conn.client.onclose = undefined
    try {
      await conn.client.close()
    } catch {
      /* already gone */
    }
  }
}

/** Close every connection (called on app quit). */
export async function shutdownAllMcp(): Promise<void> {
  // Include in-flight connects: disposing clears their `connecting` entry so the
  // pending promise self-tears-down (closes its child) instead of resurrecting.
  const ids = new Set([...connections.keys(), ...connecting.keys()])
  await Promise.all([...ids].map((id) => disposeConnection(id)))
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Workspace config source (project-portable, opencode/Claude-Desktop style)
// ---------------------------------------------------------------------------

/**
 * Read project-scoped MCP servers from a workspace config file. Supports the
 * common shapes: `{ "mcpServers": {...} }` (Claude Desktop), `{ "servers": {...} }`,
 * or a bare `{ name: config }` map. Missing/invalid files yield `[]` (never throws).
 */
export function loadWorkspaceMcpServers(cwd: string): McpServerRecord[] {
  if (!cwd) return []
  for (const rel of ['.roxy/mcp.json', '.mcp.json']) {
    const file = path.join(cwd, rel)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const servers =
        parsed && typeof parsed === 'object'
          ? (parsed.mcpServers ?? parsed.servers ?? parsed)
          : parsed
      return normalizeServerRecords(servers)
    } catch {
      return []
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Tear down all connections + caches between smoke cases. */
export async function _resetMcpForTests(): Promise<void> {
  await shutdownAllMcp()
  connections.clear()
  connecting.clear()
  toolIndex.clear()
}
