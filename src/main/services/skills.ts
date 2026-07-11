/**
 * Skills runtime service — discovers `SKILL.md` files on disk and lets the agent
 * load one on demand via the `skill` tool. Mirrors opencode's `skill/` runtime
 * (github.com/sst/opencode, MIT): a skill is a markdown file whose frontmatter
 * names + describes it, and whose body is a specialized instruction set the model
 * pulls into context only when a task matches.
 *
 * Design (mirrors the MCP/LSP services' cache + graceful-degradation shape):
 *  - Discovery scans a fixed set of roots — the workspace (walking up from cwd)
 *    and the user's home — for `*.md` / `**​/SKILL.md`, parses frontmatter, and
 *    de-dupes by name (a project skill outranks a global one; nearest dir wins).
 *  - Results are cached per workspace so only the first turn pays the scan; the
 *    Settings UI can force a `refreshSkills()`.
 *  - Nothing here throws into the agent loop: an unreadable file, a bad glob, or a
 *    missing skill degrades to "no skills" / an error ToolResult. `ROXY_SKILLS=0`
 *    disables the whole subsystem.
 *  - The pure parsing/formatting/rendering lives in `src/shared/skills.ts` and is
 *    unit-tested in smoke:shared; this file is exercised against a fixture skills
 *    tree in smoke:app.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { glob } from 'tinyglobby'
import type { ToolResult } from '../../shared/types'
import {
  SKILL_FILE_SAMPLE_LIMIT,
  describeSkillsForPrompt,
  isValidSkillName,
  parseSkillFrontmatter,
  renderSkillContent,
  resolveSkillSource,
  sanitizeSkillName,
  serializeSkillMarkdown,
  type SkillInfo,
  type SkillSource
} from '../../shared/skills'
import { isSafeSkillFilePath, type PortableSkill, type PortableSkillFile } from '../../shared/portable'

/** Relative skill-root directories searched under each workspace ancestor. */
const WORKSPACE_SKILL_DIRS = ['.roxy/skills', '.claude/skills', '.agents/skills']
/** Absolute skill-root directories searched under the user's home. */
function globalSkillDirs(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.roxy', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.config', 'roxy', 'skills')
  ]
}

/** Glob patterns matched within each root: a bare `<name>.md` or a folder's `SKILL.md`. */
const SKILL_GLOBS = ['*.md', '**/SKILL.md']
/** How far up the tree to walk from cwd looking for workspace skill roots. */
const MAX_WALK_UP = 64

/** Kill switch: set ROXY_SKILLS=0 to disable skill discovery + the `skill` tool. */
function skillsDisabled(): boolean {
  return process.env.ROXY_SKILLS === '0'
}

/** Per-workspace discovery cache (skills rarely change mid-session; warmed lazily). */
const cache = new Map<string, SkillInfo[]>()

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Ancestor dirs from `cwd` up to a git root (or the filesystem root), nearest first. */
async function ancestorDirs(cwd: string): Promise<string[]> {
  const dirs: string[] = []
  let cur = path.resolve(cwd)
  let gitRoot: string | undefined
  for (let i = 0; i < MAX_WALK_UP; i++) {
    dirs.push(cur)
    if (!gitRoot && (await isDir(path.join(cur, '.git')))) gitRoot = cur
    if (gitRoot && cur === gitRoot) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return dirs
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The ordered list of skill roots for a workspace: project roots first (nearest
 * ancestor → farthest), then the global roots. Order matters — the first source
 * to claim a given skill name wins, so a project skill overrides a global one.
 */
async function skillRoots(cwd: string): Promise<{ dir: string; source: SkillInfo['source'] }[]> {
  const roots: { dir: string; source: SkillInfo['source'] }[] = []
  const seen = new Set<string>()
  const add = (dir: string, source: SkillInfo['source']): void => {
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) return
    seen.add(resolved)
    roots.push({ dir: resolved, source })
  }
  if (cwd) {
    for (const anc of await ancestorDirs(cwd)) {
      for (const rel of WORKSPACE_SKILL_DIRS) add(path.join(anc, rel), 'workspace')
    }
  }
  for (const g of globalSkillDirs()) add(g, 'global')
  return roots
}

/** Resolve a skill's name from its frontmatter, falling back to its path. */
function resolveName(frontmatterName: string | undefined, file: string, root: string): string | undefined {
  const fromMatter = frontmatterName?.trim()
  if (fromMatter) return fromMatter
  const base = path.basename(file)
  if (base.toLowerCase() === 'skill.md') {
    // A folder-based skill: use the containing folder's name (…/skills/<name>/SKILL.md).
    const folder = path.dirname(file)
    if (path.resolve(folder) === path.resolve(root)) return undefined // SKILL.md sitting directly in the root — ambiguous, skip
    return path.basename(folder)
  }
  // A single-file skill: …/skills/<name>.md
  return base.replace(/\.md$/i, '')
}

/** Read + parse every skill under one root. Never throws. */
async function loadRoot(root: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
  if (!(await isDir(root))) return []
  let files: string[]
  try {
    // followSymbolicLinks:false so a symlink inside a skill root (e.g. a malicious
    // checked-out repo linking `.roxy/skills/x -> /`) can't make discovery walk the
    // whole filesystem on the first-turn scan.
    files = await glob(SKILL_GLOBS, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false
    })
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const file of files.sort()) {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const { data, body } = parseSkillFrontmatter(raw)
    const name = resolveName(data.name, file, root)
    if (!name) continue
    out.push({
      name,
      description: data.description?.trim() || undefined,
      location: file,
      content: body,
      source
    })
  }
  return out
}

/** Discover (and cache) the skills available to a workspace. Never throws. */
async function discover(cwd: string): Promise<SkillInfo[]> {
  if (skillsDisabled()) return []
  const key = cwd ? path.resolve(cwd) : '<none>'
  const cached = cache.get(key)
  if (cached) return cached

  const byName = new Map<string, SkillInfo>()
  for (const { dir, source } of await skillRoots(cwd)) {
    for (const skill of await loadRoot(dir, source)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill) // first source wins (workspace/nearest)
    }
  }
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  cache.set(key, list)
  return list
}

// ---------------------------------------------------------------------------
// Public API (agent loop + IPC)
// ---------------------------------------------------------------------------

/** The skills available to a workspace turn (metadata only — no bodies re-read). */
export async function listSkills(cwd: string): Promise<SkillInfo[]> {
  return discover(cwd)
}

/** The system-prompt block advertising the workspace's skills, or undefined when none. */
export async function skillInstructions(cwd: string): Promise<string | undefined> {
  return describeSkillsForPrompt(await discover(cwd))
}

/**
 * The `skill` tool: load one discovered skill by name, returning its instructions
 * plus a sampled list of the companion files that ship alongside it. Never throws.
 */
export async function loadSkill(name: string, cwd: string): Promise<ToolResult> {
  if (skillsDisabled()) return { ok: false, output: 'Skills are disabled (ROXY_SKILLS=0).' }
  const wanted = (name ?? '').trim()
  if (!wanted) return { ok: false, output: 'The skill tool needs a `name`.' }

  const skills = await discover(cwd)
  const skill =
    skills.find((s) => s.name === wanted) ??
    skills.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
  if (!skill) {
    const available = skills.map((s) => s.name).join(', ') || 'none'
    return { ok: false, output: `Unknown skill "${wanted}". Available skills: ${available}.` }
  }

  const directory = path.dirname(skill.location)
  const files = await sampleSkillFiles(directory, skill.location)
  return { ok: true, output: renderSkillContent(skill, directory, files) }
}

// ---------------------------------------------------------------------------
// Authoring (create / edit / remove SKILL.md on disk)
// ---------------------------------------------------------------------------

/** Where a skill is written for a given scope — the highest-priority discovery root. */
export type SkillScope = 'workspace' | 'global'

export interface WriteSkillInput {
  name: string
  description?: string
  body?: string
  scope?: SkillScope
}

export interface WriteSkillResult {
  ok: boolean
  location?: string
  created?: boolean
  error?: string
}

/**
 * The root a NEW skill is written under: the first (highest-priority) discovery
 * root for the scope — `<cwd>/.roxy/skills` (workspace) or `~/.roxy/skills`
 * (global) — so a freshly written skill is immediately discoverable.
 */
function primarySkillRoot(scope: SkillScope, cwd: string): string {
  if (scope === 'global') return path.join(os.homedir(), '.roxy', 'skills')
  return path.join(path.resolve(cwd), '.roxy', 'skills')
}

/**
 * Create or edit a skill's `SKILL.md` on disk (canonical folder form
 * `<root>/.roxy/skills/<name>/SKILL.md` for new skills; edits rewrite the file
 * wherever it already lives). On edit, a missing description/body is preserved
 * from the existing file. Busts the discovery cache so the change is visible on
 * the next scan. Never throws — returns a structured result.
 */
export async function writeSkill(
  input: WriteSkillInput,
  cwd: string,
  opts: { mode: 'create' | 'edit' }
): Promise<WriteSkillResult> {
  if (skillsDisabled()) return { ok: false, error: 'Skills are disabled (ROXY_SKILLS=0).' }
  const name = (input.name ?? '').trim()
  if (!isValidSkillName(name)) {
    return {
      ok: false,
      error: `Invalid skill name "${name}". Use letters, digits, dot, dash, or underscore — no spaces or slashes.`
    }
  }
  const scope: SkillScope = input.scope === 'global' ? 'global' : 'workspace'
  if (scope === 'workspace' && !cwd) {
    return { ok: false, error: 'No workspace folder available; use scope "global" to write to ~/.roxy/skills.' }
  }

  const existing = (await discover(cwd)).find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (opts.mode === 'create' && existing) {
    return {
      ok: false,
      error: `A skill named "${existing.name}" already exists (${existing.location}). Use action "edit" to change it.`
    }
  }
  if (opts.mode === 'edit' && !existing) {
    return { ok: false, error: `No skill named "${name}" to edit. Use action "create" to add it.` }
  }

  // Edit rewrites the file where the skill already lives; create writes the
  // canonical folder form under the chosen scope's root.
  const target =
    existing && opts.mode === 'edit'
      ? existing.location
      : path.join(primarySkillRoot(scope, cwd), name, 'SKILL.md')

  // Merge: keep whatever the caller left unspecified on an edit.
  const description = input.description !== undefined ? input.description : existing?.description
  const body = input.body !== undefined ? input.body : (existing?.content ?? '')
  const markdown = serializeSkillMarkdown(name, description, body)

  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, markdown, 'utf8')
  } catch (e) {
    return { ok: false, error: `Failed to write skill: ${(e as Error).message}` }
  }
  refreshSkills() // clear all cache keys — a write can affect the '<none>'/home/workspace views
  return { ok: true, location: target, created: !existing }
}

export interface DeleteSkillResult {
  ok: boolean
  removed: boolean
  location?: string
  error?: string
}

/**
 * Delete a discovered skill: remove its whole folder for a folder-skill
 * (`<name>/SKILL.md`), or the single file for a bare `<name>.md`. Busts the
 * discovery cache. Never throws — a missing skill is a graceful no-op.
 */
export async function deleteSkill(name: string, cwd: string): Promise<DeleteSkillResult> {
  if (skillsDisabled()) return { ok: false, removed: false, error: 'Skills are disabled (ROXY_SKILLS=0).' }
  const wanted = (name ?? '').trim()
  if (!wanted) return { ok: false, removed: false, error: 'Provide the skill name to remove.' }

  const skills = await discover(cwd)
  const skill =
    skills.find((s) => s.name === wanted) ?? skills.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
  if (!skill) return { ok: true, removed: false, error: `No skill named "${wanted}".` }

  try {
    // A folder skill's SKILL.md always sits in a `<name>/` subfolder of a skills
    // root (discovery skips a SKILL.md sitting directly in the root), so removing
    // its parent dir removes exactly the skill and nothing above it.
    if (path.basename(skill.location).toLowerCase() === 'skill.md') {
      await fs.rm(path.dirname(skill.location), { recursive: true, force: true })
    } else {
      await fs.rm(skill.location, { force: true })
    }
  } catch (e) {
    return { ok: false, removed: false, location: skill.location, error: `Failed to remove skill: ${(e as Error).message}` }
  }
  refreshSkills()
  return { ok: true, removed: true, location: skill.location }
}

/**
 * List up to SKILL_FILE_SAMPLE_LIMIT companion files shipping alongside a folder
 * skill's SKILL.md, as paths relative to the skill directory. Hardened against a
 * malicious skill dir: symlinks are not followed (so the glob can't fan out across
 * the filesystem and stall the turn), and each file's real path is verified to stay
 * inside the skill directory (so a symlinked entry can't leak an out-of-dir path
 * into the model's context). Never throws — a bad dir degrades to no file list.
 */
async function sampleSkillFiles(directory: string, skillFile: string): Promise<string[]> {
  if (path.basename(skillFile).toLowerCase() !== 'skill.md') return []
  let found: string[]
  try {
    found = await glob('**/*', {
      cwd: directory,
      absolute: true,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false
    })
  } catch {
    return []
  }
  // Resolve the base once (the skill dir itself may be reached via a symlink) so the
  // containment check compares real paths on both sides.
  let baseReal: string
  try {
    baseReal = await fs.realpath(directory)
  } catch {
    baseReal = path.resolve(directory)
  }
  const skillReal = path.resolve(skillFile)
  const out: string[] = []
  for (const f of found.sort()) {
    if (path.resolve(f) === skillReal) continue
    let real: string
    try {
      real = await fs.realpath(f)
    } catch {
      continue
    }
    const rel = path.relative(baseReal, real)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue // escaped the skill dir
    // Show the logical in-dir path, not the resolved target — posix-style so the
    // model always sees `scripts/run.sh` (path.relative yields `\` on Windows).
    out.push(path.relative(directory, f).split(/[\\/]/).join('/'))
    if (out.length >= SKILL_FILE_SAMPLE_LIMIT) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Portable export / import (back up a machine's global skills to another)
// ---------------------------------------------------------------------------

const EXPORT_MAX_FILE_BYTES = 1_000_000 // 1 MB per file
const EXPORT_MAX_TOTAL_BYTES = 16_000_000 // 16 MB across all skills

/** Read a file, returning null if it's missing or exceeds the per-file cap. */
async function readCapped(abs: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile() || stat.size > EXPORT_MAX_FILE_BYTES) return null
    return await fs.readFile(abs)
  } catch {
    return null
  }
}

/**
 * Collect every GLOBAL skill as a portable bundle entry — the skill's folder
 * files (SKILL.md + companions), base64-encoded so binaries survive the trip.
 * A bare `<name>.md` skill is emitted as a one-file `{ SKILL.md }` folder so it
 * re-imports in canonical form. Only the user's global roots are exported (the
 * Settings/Skills UI is global-scoped); workspace skills live with their repo.
 * Bounded by per-file/total caps so a huge tree can't blow up the bundle. Never
 * throws — an unreadable skill is skipped.
 */
export async function exportGlobalSkills(): Promise<PortableSkill[]> {
  if (skillsDisabled()) return []
  const out: PortableSkill[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  for (const root of globalSkillDirs()) {
    for (const skill of await loadRoot(root, 'global')) {
      const name = sanitizeSkillName(skill.name)
      if (!name || seen.has(name.toLowerCase())) continue

      const isFolder = path.basename(skill.location).toLowerCase() === 'skill.md'
      const files: PortableSkillFile[] = []
      if (isFolder) {
        const dir = path.dirname(skill.location)
        const rels = ['SKILL.md', ...(await sampleSkillFiles(dir, skill.location))]
        for (const rel of rels) {
          if (!isSafeSkillFilePath(rel)) continue
          const bytes = await readCapped(path.join(dir, rel))
          if (!bytes) continue
          if (totalBytes + bytes.length > EXPORT_MAX_TOTAL_BYTES) break
          totalBytes += bytes.length
          files.push({ path: rel, dataBase64: bytes.toString('base64') })
        }
      } else {
        const bytes = await readCapped(skill.location)
        if (bytes && totalBytes + bytes.length <= EXPORT_MAX_TOTAL_BYTES) {
          totalBytes += bytes.length
          files.push({ path: 'SKILL.md', dataBase64: bytes.toString('base64') })
        }
      }

      if (!files.some((f) => f.path.toLowerCase() === 'skill.md')) continue
      seen.add(name.toLowerCase())
      out.push({ name, files })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** One skill written during an import. */
export interface ImportedSkillRef {
  name: string
  location: string
  replaced: boolean
}

/**
 * Write portable skills from an imported bundle into the user's GLOBAL skills
 * root (`~/.roxy/skills/<name>/SKILL.md` + companions). Each skill's folder is
 * replaced wholesale (a clean install/update, matching remote install). Refuses
 * any path that escapes the skill folder. Busts the discovery cache. Never
 * throws — a bad skill is recorded as skipped.
 */
export async function importGlobalSkills(
  skills: PortableSkill[]
): Promise<{ installed: ImportedSkillRef[]; skipped: { name: string; reason: string }[] }> {
  const installed: ImportedSkillRef[] = []
  const skipped: { name: string; reason: string }[] = []
  if (skillsDisabled()) {
    return { installed, skipped: skills.map((s) => ({ name: s.name, reason: 'skills disabled' })) }
  }

  const root = primarySkillRoot('global', '')
  for (const skill of skills) {
    const name = sanitizeSkillName(skill.name)
    if (!name) {
      skipped.push({ name: skill.name, reason: 'invalid name' })
      continue
    }
    if (!skill.files.some((f) => f.path.toLowerCase() === 'skill.md')) {
      skipped.push({ name, reason: 'no SKILL.md' })
      continue
    }
    const targetDir = path.join(root, name)
    const replaced = await isDir(targetDir)
    try {
      await fs.rm(targetDir, { recursive: true, force: true }) // fresh install / clean update
      for (const f of skill.files) {
        if (!isSafeSkillFilePath(f.path)) continue
        await writeUnder(targetDir, f.path, Buffer.from(f.dataBase64, 'base64'))
      }
      installed.push({ name, location: path.join(targetDir, 'SKILL.md'), replaced })
    } catch (e) {
      skipped.push({ name, reason: (e as Error).message })
    }
  }
  if (installed.length) refreshSkills()
  return { installed, skipped }
}

/** Drop the discovery cache (all workspaces, or just one) so the next scan is fresh. */
export function refreshSkills(cwd?: string): void {
  if (cwd) cache.delete(path.resolve(cwd))
  else cache.clear()
}

/** Read one discovered skill in full (including its body) — for the Skills page editor. */
export async function readSkill(name: string, cwd: string): Promise<SkillInfo | undefined> {
  const wanted = (name ?? '').trim()
  if (!wanted) return undefined
  const skills = await discover(cwd)
  return (
    skills.find((s) => s.name === wanted) ?? skills.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
  )
}

// ---------------------------------------------------------------------------
// Remote install (like `npx skills add <src>`)
// ---------------------------------------------------------------------------

/** A skill that landed on disk during an install. */
export interface InstalledSkillRef {
  name: string
  location: string
  scope: SkillScope
}

/** Result of installing from a remote source. Never thrown — always returned. */
export interface InstallSkillResult {
  ok: boolean
  installed: InstalledSkillRef[]
  skipped?: { name: string; reason: string }[]
  error?: string
}

export interface InstallSkillOptions {
  scope?: SkillScope
  cwd?: string
  /** Injectable fetch (defaults to the global). Lets smoke drive it network-free. */
  fetchImpl?: typeof fetch
  /** GitHub token to lift the 60/hr anon rate limit (else GITHUB_TOKEN / GH_TOKEN). */
  token?: string
  signal?: AbortSignal
}

const GITHUB_API = 'https://api.github.com'
const INSTALL_MAX_SKILLS = 25 // a repo install won't pull more than this many skills
const INSTALL_MAX_FILES_PER_SKILL = 40 // companion files fetched per skill
const INSTALL_MAX_FILE_BYTES = 1_000_000 // 1 MB per file
const INSTALL_MAX_TOTAL_BYTES = 8_000_000 // 8 MB across the whole install
const INSTALL_MAX_LIST_CALLS = 80 // directory listings per install (loop/API guard)
const INSTALL_FIND_DEPTH = 2 // how deep to hunt for `<dir>/SKILL.md` (covers skills/<name>/)
const INSTALL_TIMEOUT_MS = 30_000

interface GhEntry {
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  name: string
  path: string
  size?: number
  download_url?: string | null
}

/** Mutable per-install context: the source repo + budgets that bound the work. */
interface InstallCtx {
  fetchImpl: typeof fetch
  owner: string
  repo: string
  token?: string
  signal?: AbortSignal
  bytes: number
  listCalls: number
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function ghHeaders(token?: string): Record<string, string> {
  const t = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'roxy-skills-installer',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (t) h.Authorization = `Bearer ${t}`
  return h
}

/** fetch() with a hard timeout that also honors an external abort signal. */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  external?: AbortSignal
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), INSTALL_TIMEOUT_MS)
  const onAbort = (): void => ctrl.abort()
  if (external) {
    if (external.aborted) ctrl.abort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }
}

/** Encode a repo-relative path for the GitHub contents API (keep the slashes). */
function encodeGhPath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

/** List a directory (or fetch a single file's metadata) via the contents API. */
async function ghList(ctx: InstallCtx, dirPath: string, ref?: string): Promise<GhEntry[]> {
  if (ctx.listCalls >= INSTALL_MAX_LIST_CALLS) return []
  ctx.listCalls++
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const url = `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/contents/${encodeGhPath(dirPath)}${q}`
  const res = await fetchWithTimeout(ctx.fetchImpl, url, { headers: ghHeaders(ctx.token) }, ctx.signal)
  if (!res.ok) throw new HttpError(res.status, `GitHub ${res.status} for ${dirPath || '/'}`)
  const json = (await res.json()) as GhEntry | GhEntry[]
  return Array.isArray(json) ? json : [json]
}

/** Download raw file bytes (dir entries carry a `download_url`), enforcing caps. */
async function ghBytes(ctx: InstallCtx, url: string, declaredSize?: number): Promise<Buffer | null> {
  if (declaredSize != null && declaredSize > INSTALL_MAX_FILE_BYTES) return null
  if (ctx.bytes >= INSTALL_MAX_TOTAL_BYTES) return null
  const res = await fetchWithTimeout(ctx.fetchImpl, url, { headers: { 'User-Agent': 'roxy-skills-installer' } }, ctx.signal)
  if (!res.ok) throw new HttpError(res.status, `GitHub ${res.status} for a file`)
  const len = Number(res.headers?.get?.('content-length') ?? '')
  if (Number.isFinite(len) && len > INSTALL_MAX_FILE_BYTES) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > INSTALL_MAX_FILE_BYTES) return null
  ctx.bytes += buf.length
  return buf
}

/**
 * Find directories that directly contain a `SKILL.md`, descending up to `depth`
 * levels (so `skills/<name>/SKILL.md` is found from a repo root). Bounded by the
 * skill count + the listing-call budget. A dir with its own SKILL.md is a leaf.
 */
async function findSkillDirs(
  ctx: InstallCtx,
  dirPath: string,
  ref: string | undefined,
  depth: number
): Promise<{ dir: string; fallback: string }[]> {
  let entries: GhEntry[]
  try {
    entries = await ghList(ctx, dirPath, ref)
  } catch {
    return []
  }
  const hasSkill = entries.some((e) => e.type === 'file' && e.name.toLowerCase() === 'skill.md')
  if (hasSkill) {
    return [{ dir: dirPath, fallback: dirPath ? path.basename(dirPath) : ctx.repo }]
  }
  if (depth <= 0) return []
  const out: { dir: string; fallback: string }[] = []
  for (const sub of entries) {
    if (sub.type !== 'dir') continue
    if (out.length >= INSTALL_MAX_SKILLS || ctx.listCalls >= INSTALL_MAX_LIST_CALLS) break
    out.push(...(await findSkillDirs(ctx, sub.path, ref, depth - 1)))
  }
  return out
}

/** Recursively gather the files under a skill dir (bounded), relative to it. */
async function collectFolderFiles(
  ctx: InstallCtx,
  dirPath: string,
  base: string,
  ref: string | undefined,
  depth: number,
  acc: { rel: string; url: string; size?: number }[]
): Promise<void> {
  if (acc.length >= INSTALL_MAX_FILES_PER_SKILL) return
  let entries: GhEntry[]
  try {
    entries = await ghList(ctx, dirPath, ref)
  } catch {
    return
  }
  for (const e of entries) {
    if (acc.length >= INSTALL_MAX_FILES_PER_SKILL) break
    const rel = path.posix.relative(base, e.path)
    if (rel.startsWith('..')) continue // never escape the skill dir
    if (e.type === 'file' && e.download_url) {
      acc.push({ rel, url: e.download_url, size: e.size })
    } else if (e.type === 'dir' && depth > 0) {
      await collectFolderFiles(ctx, e.path, base, ref, depth - 1, acc)
    }
  }
}

/** Write bytes under a skill dir, refusing any path that escapes it. */
async function writeUnder(baseDir: string, rel: string, bytes: Buffer): Promise<void> {
  const target = path.resolve(baseDir, rel)
  const root = path.resolve(baseDir)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path: ${rel}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, bytes)
}

/** Install one folder skill (a dir that contains a SKILL.md + optional companions). */
async function installFolderSkill(
  ctx: InstallCtx,
  dirPath: string,
  fallbackName: string,
  ref: string | undefined,
  root: string,
  scope: SkillScope
): Promise<InstalledSkillRef | { skipped: { name: string; reason: string } }> {
  const files: { rel: string; url: string; size?: number }[] = []
  await collectFolderFiles(ctx, dirPath, dirPath, ref, INSTALL_FIND_DEPTH, files)
  const skillFile = files.find((f) => f.rel.toLowerCase() === 'skill.md')
  if (!skillFile) return { skipped: { name: fallbackName, reason: 'no SKILL.md in the folder' } }

  let skillBytes: Buffer | null
  try {
    skillBytes = await ghBytes(ctx, skillFile.url, skillFile.size)
  } catch (e) {
    return { skipped: { name: fallbackName, reason: (e as Error).message } }
  }
  if (!skillBytes) return { skipped: { name: fallbackName, reason: 'SKILL.md too large' } }
  const { data } = parseSkillFrontmatter(skillBytes.toString('utf8'))
  const name = sanitizeSkillName(data.name || fallbackName)
  if (!name) return { skipped: { name: fallbackName, reason: 'could not derive a valid skill name' } }

  const targetDir = path.join(root, name)
  await fs.rm(targetDir, { recursive: true, force: true }) // fresh install / clean update
  // Write the SKILL.md first (already fetched), then the companions.
  await writeUnder(targetDir, 'SKILL.md', skillBytes)
  for (const f of files) {
    if (f === skillFile) continue
    if (ctx.bytes >= INSTALL_MAX_TOTAL_BYTES) break
    let bytes: Buffer | null = null
    try {
      bytes = await ghBytes(ctx, f.url, f.size)
    } catch {
      bytes = null
    }
    if (bytes) await writeUnder(targetDir, f.rel, bytes)
  }
  return { name, location: path.join(targetDir, 'SKILL.md'), scope }
}

/** Install a single markdown file as a canonical `<name>/SKILL.md` (no companions). */
async function installBareFile(
  ctx: InstallCtx,
  url: string,
  fallbackName: string,
  root: string,
  scope: SkillScope
): Promise<InstalledSkillRef | { skipped: { name: string; reason: string } }> {
  let bytes: Buffer | null
  try {
    bytes = await ghBytes(ctx, url)
  } catch (e) {
    return { skipped: { name: fallbackName, reason: (e as Error).message } }
  }
  if (!bytes) return { skipped: { name: fallbackName, reason: 'file too large' } }
  const text = bytes.toString('utf8')
  const { data } = parseSkillFrontmatter(text)
  const name = sanitizeSkillName(data.name || fallbackName.replace(/\.md$/i, ''))
  if (!name) return { skipped: { name: fallbackName, reason: 'could not derive a valid skill name' } }
  const targetDir = path.join(root, name)
  await fs.rm(targetDir, { recursive: true, force: true })
  await writeUnder(targetDir, 'SKILL.md', Buffer.from(text, 'utf8'))
  return { name, location: path.join(targetDir, 'SKILL.md'), scope }
}

/** Resolve a single file's raw download URL via the contents API (default branch ok). */
async function bareFileUrl(ctx: InstallCtx, p: string, ref?: string): Promise<string | undefined> {
  try {
    const entries = await ghList(ctx, p, ref)
    const one = entries[0]
    return one?.download_url ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Install one or more skills from a remote source — Roxy's in-app equivalent of
 * `npx skills add <src>`. Resolves the source (GitHub repo / dir / file, or a
 * direct SKILL.md URL), downloads the SKILL.md(s) + companion files, validates +
 * sanitizes each name, and writes canonical `<root>/<name>/SKILL.md` folders under
 * the chosen scope's primary root (workspace `.roxy/skills` or `~/.roxy/skills`).
 * Never throws — every failure (bad source, network, rate-limit, no SKILL.md)
 * degrades to `{ ok:false, error }`. Busts the discovery cache on success.
 */
export async function installSkillFromSource(
  source: string,
  opts: InstallSkillOptions = {}
): Promise<InstallSkillResult> {
  if (skillsDisabled()) return { ok: false, installed: [], error: 'Skills are disabled (ROXY_SKILLS=0).' }
  const resolved = resolveSkillSource(source)
  if (resolved.kind === 'unsupported') return { ok: false, installed: [], error: resolved.reason }

  const scope: SkillScope = opts.scope ?? (opts.cwd ? 'workspace' : 'global')
  const cwd = opts.cwd ?? ''
  if (scope === 'workspace' && !cwd) {
    return { ok: false, installed: [], error: 'No workspace folder available; install with scope "global".' }
  }
  const root = primarySkillRoot(scope, cwd)

  const installed: InstalledSkillRef[] = []
  const skipped: { name: string; reason: string }[] = []
  const record = (
    r: InstalledSkillRef | { skipped: { name: string; reason: string } }
  ): void => {
    if ('skipped' in r) skipped.push(r.skipped)
    else installed.push(r)
  }

  try {
    if (resolved.kind === 'raw-md') {
      const ctx = newCtx(opts, '', '')
      const fallback = path.basename(new URL(resolved.url).pathname) || 'skill'
      record(await installBareFile(ctx, resolved.url, fallback, root, scope))
    } else {
      const ctx = newCtx(opts, resolved.owner, resolved.repo)
      await installFromGitHub(ctx, resolved, root, scope, record)
    }
  } catch (e) {
    const err = e as Error
    const msg =
      e instanceof HttpError
        ? e.status === 404
          ? 'Source not found (404). Check the repo/URL is public and correct.'
          : e.status === 403
            ? 'GitHub rate limit or access denied (403). Set a GITHUB_TOKEN to lift the anonymous limit.'
            : `GitHub request failed (${e.status}).`
        : err.message || 'Install failed.'
    if (!installed.length) return { ok: false, installed: [], skipped: skipped.length ? skipped : undefined, error: msg }
  }

  if (installed.length) refreshSkills() // clear all cache keys so the new skills are visible
  if (!installed.length) {
    const reason = skipped.length
      ? `No skills installed. ${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')}`
      : 'No SKILL.md found at that source (looked at the repo root and skills/).'
    return { ok: false, installed: [], skipped: skipped.length ? skipped : undefined, error: reason }
  }
  return { ok: true, installed, skipped: skipped.length ? skipped : undefined }
}

function newCtx(opts: InstallSkillOptions, owner: string, repo: string): InstallCtx {
  return {
    fetchImpl: opts.fetchImpl ?? installFetchOverride ?? fetch,
    owner,
    repo,
    token: opts.token,
    signal: opts.signal,
    bytes: 0,
    listCalls: 0
  }
}

/** Dispatch a resolved GitHub source (repo / dir / file) to the right installer(s). */
async function installFromGitHub(
  ctx: InstallCtx,
  src: Extract<SkillSource, { kind: 'github-repo' | 'github-dir' | 'github-file' }>,
  root: string,
  scope: SkillScope,
  record: (r: InstalledSkillRef | { skipped: { name: string; reason: string } }) => void
): Promise<void> {
  if (src.kind === 'github-file') {
    const isSkillMd = path.basename(src.path).toLowerCase() === 'skill.md'
    if (isSkillMd) {
      const dir = path.posix.dirname(src.path)
      const dirPath = dir === '.' ? '' : dir
      record(await installFolderSkill(ctx, dirPath, dirPath ? path.basename(dirPath) : ctx.repo, src.ref, root, scope))
      return
    }
    const url = src.ref
      ? `https://raw.githubusercontent.com/${ctx.owner}/${ctx.repo}/${src.ref}/${src.path}`
      : await bareFileUrl(ctx, src.path)
    if (!url) {
      record({ skipped: { name: path.basename(src.path), reason: 'could not resolve the file' } })
      return
    }
    record(await installBareFile(ctx, url, path.basename(src.path), root, scope))
    return
  }

  // A repo hunts 2 levels deep (covers skills/<name>/SKILL.md); an explicit dir 1.
  const startPath = src.kind === 'github-dir' ? src.path : ''
  const depth = src.kind === 'github-dir' ? 1 : INSTALL_FIND_DEPTH
  const dirs = await findSkillDirs(ctx, startPath, src.ref, depth)
  if (dirs.length) {
    for (const d of dirs.slice(0, INSTALL_MAX_SKILLS)) {
      record(await installFolderSkill(ctx, d.dir, d.fallback, src.ref, root, scope))
    }
    return
  }
  // No folder skills — fall back to top-level bare `*.md` files (skip READMEs).
  let entries: GhEntry[] = []
  try {
    entries = await ghList(ctx, startPath, src.ref)
  } catch {
    entries = []
  }
  const bareMd = entries.filter(
    (e) => e.type === 'file' && /\.md$/i.test(e.name) && e.name.toLowerCase() !== 'readme.md' && e.download_url
  )
  for (const f of bareMd.slice(0, INSTALL_MAX_SKILLS)) {
    record(await installBareFile(ctx, f.download_url as string, f.name, root, scope))
  }
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/**
 * Test seam: force the fetch implementation used by installs that DON'T pass their
 * own `fetchImpl` (e.g. installs driven through `runTool`/`skill_manage`). Pass
 * undefined to restore the global fetch. Only used by smoke tests.
 */
let installFetchOverride: typeof fetch | undefined
export function _setInstallFetchForTests(fn: typeof fetch | undefined): void {
  installFetchOverride = fn
}

/** Clear the discovery cache between smoke cases. */
export function _resetSkillsForTests(): void {
  cache.clear()
}
