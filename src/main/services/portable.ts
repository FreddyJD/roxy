/**
 * Portable config service — the main-process half of export/import. Reads the
 * user's global skills (from the skills service) + MCP server configs (from the
 * DB) into a `PortableBundle`, and applies an imported bundle back onto disk/DB.
 * The pure format/validation lives in `src/shared/portable.ts`; this file only
 * bridges it to the filesystem + SQLite. Never throws into IPC — every path
 * returns a structured result.
 */
import { app } from 'electron'
import * as repo from '../db/repo'
import { exportGlobalSkills, importGlobalSkills } from './skills'
import {
  buildBundle,
  serializeBundle,
  parseBundle,
  summarizeBundle,
  type PortableBundle,
  type PortableMcpServer
} from '../../shared/portable'

/** Everything the export dialog needs: the file text + a summary for the toast. */
export interface ExportResult {
  /** The serialized bundle JSON to write to the chosen path. */
  text: string
  skills: number
  mcpServers: number
  summary: string
}

/** Build a portable bundle from this machine's global skills + MCP servers. */
export async function buildExport(): Promise<ExportResult> {
  const skills = await exportGlobalSkills()
  const mcpServers: PortableMcpServer[] = repo
    .listMcpServers()
    .map((r) => ({ id: r.id, config: r.config, enabled: r.enabled }))
  const bundle = buildBundle({ skills, mcpServers, app: safeAppVersion() })
  return {
    text: serializeBundle(bundle),
    skills: bundle.skills.length,
    mcpServers: bundle.mcpServers.length,
    summary: summarizeBundle(bundle)
  }
}

/** Outcome of importing a bundle file. */
export interface ImportResult {
  ok: boolean
  /** Global skills written (with whether each replaced an existing one). */
  skills: { name: string; replaced: boolean }[]
  /** MCP servers written (with whether each replaced an existing one). */
  mcpServers: { id: string; replaced: boolean }[]
  /** Entries found but not applied, with a reason. */
  skipped: { name: string; reason: string }[]
  /** A friendly summary line for the UI, e.g. "Imported 3 skills, 2 MCP servers." */
  summary: string
  error?: string
}

/**
 * Parse + apply an imported bundle's JSON text: write its global skills to disk
 * and upsert its MCP servers into the DB. Existing skills/servers with the same
 * name/id are overwritten (an update), matching the "restore onto this machine"
 * intent. Never throws — a bad file or a partial failure is reported.
 */
export async function applyImport(text: string): Promise<ImportResult> {
  const parsed = parseBundle(text)
  if (!parsed.ok) {
    return { ok: false, skills: [], mcpServers: [], skipped: [], summary: '', error: parsed.error }
  }
  const bundle: PortableBundle = parsed.bundle

  // Skills first (filesystem), then MCP (DB) — independent, so a failure in one
  // doesn't strand the other.
  const skillRes = await importGlobalSkills(bundle.skills)

  const mcpServers: { id: string; replaced: boolean }[] = []
  const existingIds = new Set(repo.listMcpServers().map((r) => r.id))
  for (const s of bundle.mcpServers) {
    try {
      repo.upsertMcpServer({ id: s.id, config: s.config, enabled: s.enabled })
      mcpServers.push({ id: s.id, replaced: existingIds.has(s.id) })
    } catch (e) {
      skillRes.skipped.push({ name: s.id, reason: (e as Error).message })
    }
  }

  const skills = skillRes.installed.map(({ name, replaced }) => ({ name, replaced }))
  const summary = summarizeApplied(skills.length, mcpServers.length)
  return {
    ok: skills.length > 0 || mcpServers.length > 0,
    skills,
    mcpServers,
    skipped: skillRes.skipped,
    summary,
    error:
      skills.length || mcpServers.length
        ? undefined
        : 'Nothing was imported. The bundle may be empty or unreadable.'
  }
}

function summarizeApplied(skills: number, mcp: number): string {
  const parts: string[] = []
  if (skills) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`)
  if (mcp) parts.push(`${mcp} MCP server${mcp === 1 ? '' : 's'}`)
  return parts.length ? `Imported ${parts.join(' and ')}.` : 'Nothing to import.'
}

function safeAppVersion(): string | undefined {
  try {
    return app.getVersion()
  } catch {
    return undefined
  }
}
