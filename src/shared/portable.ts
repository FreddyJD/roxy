/**
 * Portable config bundle — the pure, dependency-free format for exporting and
 * importing a user's *global* skills and MCP server configs so they can be moved
 * to another machine (a "backup" file). No Node/Electron here: file bytes are
 * carried as base64 strings the main-process service produces/consumes, and this
 * module only assembles, serializes, and defensively validates the JSON. Unit-
 * tested in smoke:shared; the disk/DB halves live in main/services/portable.ts.
 *
 * File shape (`*.roxy.json`):
 * {
 *   "kind": "roxy.config", "version": 1, "exportedAt": 1720000000000, "app": "0.0.38",
 *   "skills": [ { "name": "foo", "files": [ { "path": "SKILL.md", "dataBase64": "…" } ] } ],
 *   "mcpServers": [ { "id": "filesystem", "config": { … }, "enabled": true } ]
 * }
 */
import { normalizeServerConfig, type McpServerConfig } from './mcp'
import { sanitizeSkillName } from './skills'

/** Marks a file as a Roxy portable-config bundle (guards against importing junk). */
export const BUNDLE_KIND = 'roxy.config'
/** Bump when the on-disk shape changes incompatibly; parse accepts <= this. */
export const BUNDLE_VERSION = 1
/** Default filename offered by the save dialog. */
export const BUNDLE_FILENAME = 'roxy-config.roxy.json'

/** One file inside a skill folder (SKILL.md + any companions), bytes base64-encoded. */
export interface PortableSkillFile {
  /** Posix-style path relative to the skill folder, e.g. `SKILL.md` or `scripts/run.sh`. */
  path: string
  /** The file's raw bytes, base64-encoded (so binaries survive the round-trip). */
  dataBase64: string
}

/** A single skill packaged for transport: its name + every file in its folder. */
export interface PortableSkill {
  name: string
  files: PortableSkillFile[]
}

/** A configured MCP server packaged for transport (mirrors the DB record). */
export interface PortableMcpServer {
  id: string
  config: McpServerConfig
  enabled: boolean
}

/** The whole exportable bundle. */
export interface PortableBundle {
  kind: typeof BUNDLE_KIND
  version: number
  /** Epoch ms the bundle was written. */
  exportedAt: number
  /** The Roxy version that produced it (informational). */
  app?: string
  skills: PortableSkill[]
  mcpServers: PortableMcpServer[]
}

/** What to include when building a bundle. */
export interface BuildBundleInput {
  skills: PortableSkill[]
  mcpServers: PortableMcpServer[]
  app?: string
  /** Injectable clock for deterministic tests (defaults to Date.now()). */
  now?: number
}

/**
 * Assemble a bundle object from already-collected skills + MCP servers. Pure:
 * the caller (main service) is responsible for reading files/DB and base64-ing
 * bytes; here we only sanitize names/ids and drop entries that can't be trusted.
 */
export function buildBundle(input: BuildBundleInput): PortableBundle {
  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: input.now ?? Date.now(),
    app: input.app,
    skills: sanitizeSkills(input.skills),
    mcpServers: sanitizeMcpServers(input.mcpServers)
  }
}

/** Pretty-print a bundle to the JSON text written to disk. */
export function serializeBundle(bundle: PortableBundle): string {
  return JSON.stringify(bundle, null, 2) + '\n'
}

/** Outcome of parsing untrusted bundle text. Never throws. */
export type ParseBundleResult = { ok: true; bundle: PortableBundle } | { ok: false; error: string }

/**
 * Parse + validate untrusted JSON (from an imported file) into a normalized
 * bundle. Rejects the wrong `kind`/a newer `version`, coerces every skill name +
 * MCP config, and refuses any unsafe file path — so importing a hand-edited or
 * malicious file can't escape the skills directory. Never throws.
 */
export function parseBundle(raw: string): ParseBundleResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'Not a valid JSON file.' }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: 'Not a Roxy config bundle.' }
  }
  const o = json as Record<string, unknown>
  if (o.kind !== BUNDLE_KIND) {
    return { ok: false, error: 'This file is not a Roxy config bundle (wrong "kind").' }
  }
  const version = typeof o.version === 'number' ? o.version : 0
  if (version < 1 || version > BUNDLE_VERSION) {
    return { ok: false, error: `Unsupported bundle version ${version}. Update Roxy and try again.` }
  }
  const skills = sanitizeSkills(Array.isArray(o.skills) ? (o.skills as unknown[]) : [])
  const mcpServers = sanitizeMcpServers(
    Array.isArray(o.mcpServers) ? (o.mcpServers as unknown[]) : []
  )
  if (!skills.length && !mcpServers.length) {
    return { ok: false, error: 'The bundle contains no skills or MCP servers.' }
  }
  return {
    ok: true,
    bundle: {
      kind: BUNDLE_KIND,
      version: BUNDLE_VERSION,
      exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : Date.now(),
      app: typeof o.app === 'string' ? o.app : undefined,
      skills,
      mcpServers
    }
  }
}

/** Human-readable one-liner for confirmation UI, e.g. "3 skills, 2 MCP servers". */
export function summarizeBundle(bundle: Pick<PortableBundle, 'skills' | 'mcpServers'>): string {
  const parts: string[] = []
  const s = bundle.skills.length
  const m = bundle.mcpServers.length
  if (s) parts.push(`${s} skill${s === 1 ? '' : 's'}`)
  if (m) parts.push(`${m} MCP server${m === 1 ? '' : 's'}`)
  return parts.length ? parts.join(', ') : 'nothing'
}

// ---------------------------------------------------------------------------
// Validation helpers (shared by build + parse)
// ---------------------------------------------------------------------------

/**
 * A file path is safe to write under a skill folder iff it's a relative,
 * forward-slashed path that stays inside the folder: no absolute paths, no `..`
 * segments, no leading slash, no Windows drive letter or backslashes.
 */
export function isSafeSkillFilePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false
  if (p.includes('\\')) return false // must be posix-style
  if (p.startsWith('/')) return false // no absolute
  if (/^[a-zA-Z]:/.test(p)) return false // no Windows drive
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false
  return true
}

/** Coerce an untrusted skill list: valid name + at least one safe SKILL.md file. */
function sanitizeSkills(raw: unknown[]): PortableSkill[] {
  const out: PortableSkill[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const name = sanitizeSkillName(typeof e.name === 'string' ? e.name : '')
    if (!name || seen.has(name.toLowerCase())) continue
    const files = sanitizeSkillFiles(e.files)
    // A skill is meaningless without its SKILL.md.
    if (!files.some((f) => f.path.toLowerCase() === 'skill.md')) continue
    seen.add(name.toLowerCase())
    out.push({ name, files })
  }
  return out
}

function sanitizeSkillFiles(raw: unknown): PortableSkillFile[] {
  if (!Array.isArray(raw)) return []
  const out: PortableSkillFile[] = []
  const seen = new Set<string>()
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue
    const o = f as Record<string, unknown>
    if (!isSafeSkillFilePath(o.path)) continue
    if (typeof o.dataBase64 !== 'string') continue
    if (seen.has(o.path)) continue
    seen.add(o.path)
    out.push({ path: o.path, dataBase64: o.dataBase64 })
  }
  return out
}

/** Coerce an untrusted MCP list: non-empty id + a config the normalizer accepts. */
function sanitizeMcpServers(raw: unknown[]): PortableMcpServer[] {
  const out: PortableMcpServer[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    if (!id || seen.has(id)) continue
    const config = normalizeServerConfig(e.config)
    if (!config) continue
    seen.add(id)
    out.push({ id, config, enabled: e.enabled === false ? false : true })
  }
  return out
}
