/**
 * Pure MCP (Model Context Protocol) primitives — no Node/SDK imports, so this is
 * fully testable in smoke:shared. The transport + client lifecycle (built on the
 * official `@modelcontextprotocol/sdk`) lives in `src/main/services/mcp.ts`.
 *
 * What lives here:
 *  - Server config types + a defensive normalizer (parses untrusted JSON from the
 *    DB or a workspace `.roxy/mcp.json`).
 *  - Tool-name namespacing so every server's tools get a unique, provider-legal
 *    function name (`mcp__<server>__<tool>`), plus an `isMcpToolName` router check.
 *  - MCP tool-def → roxy tool schema conversion (JSON-Schema passthrough).
 *  - MCP tool-result (content blocks) → roxy `ToolResult` rendering.
 *  - The system-prompt blurb describing connected servers + their tools.
 */

import type { ToolResult } from './types'

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** A local MCP server spawned as a child process, spoken to over stdio. */
export interface McpLocalConfig {
  type: 'local'
  /** argv, e.g. ["npx","-y","@modelcontextprotocol/server-filesystem","/path"]. */
  command: string[]
  /** Working directory; relative paths resolve from the workspace at connect time. */
  cwd?: string
  /** Extra environment variables for the child process. */
  environment?: Record<string, string>
  /** ms budget for startup + each request (split by the service). */
  timeout?: number
}

/** A remote MCP server reached over HTTP (Streamable HTTP, with SSE fallback). */
export interface McpRemoteConfig {
  type: 'remote'
  url: string
  headers?: Record<string, string>
  timeout?: number
}

export type McpServerConfig = McpLocalConfig | McpRemoteConfig

/** A configured server as persisted (DB row / workspace-file entry). */
export interface McpServerRecord {
  id: string
  config: McpServerConfig
  enabled: boolean
}

// ---------------------------------------------------------------------------
// Config normalization (defensive — inputs come from JSON we didn't write)
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary JSON value into a valid `McpServerConfig`, or `null` when it
 * can't be made sense of. Transport is taken from `type` when present, else
 * inferred: a `url` → remote, a `command` → local.
 */
export function normalizeServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>

  const type =
    o.type === 'remote' || o.type === 'local'
      ? o.type
      : typeof o.url === 'string'
        ? 'remote'
        : Array.isArray(o.command) || typeof o.command === 'string'
          ? 'local'
          : null

  if (type === 'remote') {
    const url = typeof o.url === 'string' ? o.url.trim() : ''
    if (!url) return null
    const cfg: McpRemoteConfig = { type: 'remote', url }
    const headers = normalizeStringRecord(o.headers)
    if (headers) cfg.headers = headers
    const timeout = normalizeTimeout(o.timeout)
    if (timeout) cfg.timeout = timeout
    return cfg
  }

  if (type === 'local') {
    const command = normalizeCommand(o.command, o.args)
    if (!command.length) return null
    const cfg: McpLocalConfig = { type: 'local', command }
    if (typeof o.cwd === 'string' && o.cwd.trim()) cfg.cwd = o.cwd.trim()
    const environment = normalizeStringRecord(o.environment ?? o.env)
    if (environment) cfg.environment = environment
    const timeout = normalizeTimeout(o.timeout)
    if (timeout) cfg.timeout = timeout
    return cfg
  }

  return null
}

/** Parse a `{ "name": <config> }` map (DB blob or workspace file) into records. */
export function normalizeServerRecords(raw: unknown): McpServerRecord[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: McpServerRecord[] = []
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = id.trim()
    if (!name) continue
    const v = (value ?? {}) as Record<string, unknown>
    const config = normalizeServerConfig(v)
    if (!config) continue
    const enabled = v.disabled === true || v.enabled === false ? false : true
    out.push({ id: name, config, enabled })
  }
  return out
}

function normalizeCommand(command: unknown, args: unknown): string[] {
  if (Array.isArray(command)) {
    return command.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  if (typeof command === 'string' && command.trim()) {
    const argv = [command.trim()]
    if (Array.isArray(args)) for (const a of args) if (typeof a === 'string' && a) argv.push(a)
    return argv
  }
  return []
}

function normalizeStringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val)
  }
  return Object.keys(out).length ? out : undefined
}

function normalizeTimeout(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

// ---------------------------------------------------------------------------
// Tool-name namespacing
// ---------------------------------------------------------------------------

/** Prefix that marks a tool as coming from an MCP server (used for dispatch routing). */
export const MCP_TOOL_PREFIX = 'mcp'
const SEP = '__'
/** OpenAI/Anthropic/Gemini all cap function names at 64 chars, `[a-zA-Z0-9_-]`. */
export const MAX_TOOL_NAME = 64

/** Replace any char a provider would reject in a function name with `_`. */
export function sanitizeNamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Build a provider-legal, collision-resistant function name for a server's tool.
 * Overlong names are truncated with a short deterministic hash suffix so distinct
 * long names stay distinct.
 */
export function qualifyToolName(serverId: string, toolName: string): string {
  const base = `${MCP_TOOL_PREFIX}${SEP}${sanitizeNamePart(serverId)}${SEP}${sanitizeNamePart(toolName)}`
  if (base.length <= MAX_TOOL_NAME) return base
  const hash = shortHash(base)
  return `${base.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`
}

/** Whether a tool name refers to an MCP tool (so `runTool` routes it to the pool). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX + SEP)
}

/** djb2 → base36, ~6 chars. Pure and dependency-free (names only, not security). */
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// ---------------------------------------------------------------------------
// Schema conversion (MCP tool def → roxy function schema)
// ---------------------------------------------------------------------------

export interface RoxyToolSchema {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

/**
 * Convert an MCP tool definition into the OpenAI-style function schema roxy sends
 * to every provider. `inputSchema` is already JSON Schema; we only guarantee it
 * declares an object so strict providers accept it.
 */
export function mcpToolToSchema(
  qualifiedName: string,
  description: string | undefined,
  inputSchema: unknown
): RoxyToolSchema {
  return {
    type: 'function',
    function: {
      name: qualifiedName,
      description: description?.trim() || `MCP tool "${qualifiedName}".`,
      parameters: sanitizeJsonSchema(inputSchema)
    }
  }
}

/** Ensure a JSON-Schema value is an object schema with a `properties` map. */
function sanitizeJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const o = { ...(schema as Record<string, unknown>) }
    o.type = 'object'
    if (!o.properties || typeof o.properties !== 'object' || Array.isArray(o.properties)) {
      o.properties = {}
    }
    return o
  }
  return { type: 'object', properties: {} }
}

// ---------------------------------------------------------------------------
// Result rendering (MCP CallTool content blocks → roxy ToolResult)
// ---------------------------------------------------------------------------

interface McpContentBlock {
  type?: string
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
}

/**
 * Flatten an MCP `tools/call` result into a roxy `ToolResult`. Text blocks are
 * joined; the first image block becomes the inline `image` (data URL); resources
 * contribute their inline text or a URI pointer. `isError` maps to `ok:false`.
 */
export function renderMcpContent(content: unknown, isError: boolean | undefined): ToolResult {
  const blocks = Array.isArray(content) ? (content as McpContentBlock[]) : []
  const parts: string[] = []
  let image: string | undefined

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'image' && typeof b.data === 'string') {
      const mime = typeof b.mimeType === 'string' && b.mimeType ? b.mimeType : 'image/png'
      if (!image) image = `data:${mime};base64,${b.data}`
      parts.push(`[image: ${mime}]`)
    } else if (b.type === 'audio' && typeof b.data === 'string') {
      parts.push(`[audio: ${b.mimeType || 'audio'}]`)
    } else if (b.type === 'resource' && b.resource && typeof b.resource === 'object') {
      const r = b.resource
      if (typeof r.text === 'string' && r.text) parts.push(r.text)
      else if (typeof r.uri === 'string' && r.uri) parts.push(`[resource: ${r.uri}]`)
    } else if (typeof b.text === 'string') {
      parts.push(b.text)
    }
  }

  const joined = parts.join('\n').trim()
  const output = joined || (isError ? 'The MCP tool reported an error with no message.' : '(no output)')
  const result: ToolResult = { ok: !isError, output }
  if (image) result.image = image
  return result
}

// ---------------------------------------------------------------------------
// System-prompt description of connected servers
// ---------------------------------------------------------------------------

export interface McpServerSummary {
  id: string
  status: 'connected' | 'error' | 'disabled'
  /** Unqualified tool display names exposed by the server. */
  tools: string[]
  error?: string
}

/**
 * A short blurb listing connected MCP servers + their tools, injected into the
 * system prompt so the model knows the tools exist and how they're namespaced.
 * Returns `undefined` when nothing is connected (so no empty section is added).
 */
export function describeMcpForPrompt(servers: McpServerSummary[]): string | undefined {
  const connected = servers.filter((s) => s.status === 'connected')
  if (!connected.length) return undefined
  const lines = [
    'External MCP (Model Context Protocol) servers are connected; their tools are available to you alongside the built-in tools. Each is namespaced as `mcp__<server>__<tool>`:'
  ]
  for (const s of connected) {
    lines.push(`- ${s.id}: ${s.tools.length ? s.tools.join(', ') : '(no tools exposed)'}`)
  }
  return lines.join('\n')
}
