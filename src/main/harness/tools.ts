/**
 * The agent tool layer — the capabilities that make Roxy powerful. Each tool
 * runs in the context of a session's workspace (`ctx.cwd`). File tools are
 * sandboxed to the workspace; `bash` runs commands in it with a timeout and
 * output cap. Returns a plain string `output` (what an LLM tool returns).
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { glob } from 'tinyglobby'
import type { ToolDiff, ToolResult, SessionTask } from '../../shared/types'
import type { WebFetchFormat } from '../../shared/web'
import {
  BROWSER_UA,
  EXA_MCP_URL,
  WEBFETCH_MAX_BYTES,
  WEBFETCH_OUTPUT_CAP,
  WEBFETCH_TIMEOUT_DEFAULT,
  WEBFETCH_TIMEOUT_MAX,
  WEBSEARCH_MAX_BYTES,
  WEBSEARCH_NO_RESULTS,
  WEBSEARCH_TIMEOUT,
  acceptHeader,
  buildExaRequestBody,
  clampResults,
  convertWebContent,
  isImageMime,
  isTextualMime,
  mimeFromContentType,
  normalizeFetchUrl,
  parseExaResponse
} from '../../shared/web'
import * as browser from '../services/browser'
import * as lsp from '../services/lsp'
import * as repo from '../db/repo'
import { isManagedToolOutputPath } from '../services/tool-output-store'
import { renderDiagnosticsBlock } from '../../shared/lsp'
import { isMcpTool, callMcpTool, reconnectMcpServer, disposeConnection, mcpServerSummaries } from '../services/mcp'
import {
  normalizeServerConfig,
  qualifyToolName,
  type McpServerConfig,
  type McpServerSummary
} from '../../shared/mcp'
import { loadSkill, listSkills, writeSkill, deleteSkill, installSkillFromSource } from '../services/skills'

export interface ToolContext {
  cwd: string
  /** The session (chat id) this turn runs in — the target of session-metadata tools. */
  sessionId?: string
  /**
   * The key that isolates this turn's browser (window + tabs + console). Defaults
   * to sessionId, so each chat drives its own browser and concurrent chats never
   * clobber each other's tabs. Subagents inherit their PARENT's key so they share
   * the project's one window (see agent.ts). Omitted -> the shared default window.
   */
  browserKey?: string
  /** Optional sink for incremental output (bash streams its logs here live). */
  onChunk?: (chunk: string) => void
}

const MAX_OUTPUT = 100_000
const MAX_DIFF_SIDE = 100_000
const MAX_IMAGE_BYTES = 3_000_000
const MAX_BG_OUTPUT = 200_000
const FG_TIMEOUT_MAX = 600_000
const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**']

/** A long-running command started by `bash` with background:true — it keeps running after the call returns. */
interface BgProc {
  id: string
  command: string
  cwd: string
  child: ReturnType<typeof spawn>
  output: string
  /** How far bash_output has already read, so each read returns only new output. */
  readCursor: number
  status: 'running' | 'exited' | 'killed' | 'error'
  exitCode: number | null
  startedAt: number
}
const bgProcs = new Map<string, BgProc>()
let bgCounter = 0

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'bash':
        return await runBash(str(input.command), ctx.cwd, ctx.onChunk, {
          timeout: num(input.timeout),
          background: bool(input.background)
        })
      case 'bash_list':
        return runBashList(ctx.cwd)
      case 'bash_output':
        return runBashOutput(str(input.id ?? input.process), ctx.cwd)
      case 'bash_kill':
        return runBashKill(str(input.id ?? input.process), ctx.cwd)
      case 'read':
        return await runRead(str(input.path ?? input.file), ctx.cwd)
      case 'write':
        return await runWrite(str(input.path), str(input.content), ctx.cwd)
      case 'edit':
        return await runEdit(
          str(input.path),
          str(input.oldString ?? input.old_string),
          str(input.newString ?? input.new_string),
          ctx.cwd
        )
      case 'list':
        return await runList(str(input.path) || '.', ctx.cwd)
      case 'glob':
        return await runGlob(str(input.pattern), ctx.cwd)
      case 'grep':
        return await runGrep(str(input.pattern), str(input.include ?? input.glob) || '**/*', ctx.cwd)
      case 'webfetch':
        return await runWebFetch(str(input.url), str(input.format), input.timeout, ctx.onChunk)
      case 'websearch':
        return await runWebSearch(str(input.query), input.numResults ?? input.count, ctx.onChunk)
      case 'browser_open':
        return await runBrowserOpen(str(input.url), browserKey(ctx))
      case 'browser_screenshot':
        return await runBrowserScreenshot(ctx.cwd, browserKey(ctx))
      case 'browser_read':
        return await runBrowserRead(str(input.selector) || undefined, browserKey(ctx))
      case 'browser_console':
        return runBrowserConsole(browserKey(ctx))
      case 'browser_click':
        return await runBrowserClick(str(input.selector), browserKey(ctx))
      case 'browser_scroll':
        return await runBrowserScroll(input, browserKey(ctx))
      case 'browser_type':
        return await runBrowserType(str(input.selector), str(input.text), browserKey(ctx))
      case 'browser_tabs':
        return runBrowserTabs(browserKey(ctx))
      case 'browser_new_tab':
        return runBrowserNewTab(str(input.url) || undefined, browserKey(ctx))
      case 'browser_activate_tab':
        return runBrowserActivateTab(str(input.id ?? input.tab), browserKey(ctx))
      case 'browser_close':
        browser.close(browserKey(ctx))
        return { ok: true, output: 'Closed the browser.' }
      case 'loop_create':
        return runLoopCreate(input, ctx.cwd)
      case 'loop_remove':
        return runLoopRemove(str(input.loop ?? input.name ?? input.id))
      case 'loop_list':
        return runLoopList()
      case 'loop_enable':
        return runLoopSet(str(input.loop ?? input.name ?? input.id), true)
      case 'loop_disable':
        return runLoopSet(str(input.loop ?? input.name ?? input.id), false)
      case 'change_session_metadata':
        return runSetSessionMetadata(input, ctx.sessionId)
      case 'lsp':
        return await runLspTool(str(input.path ?? input.file), ctx.cwd)
      case 'skill':
        return await loadSkill(str(input.name ?? input.skill), ctx.cwd)
      case 'skill_manage':
        return await runSkillManage(input, ctx.cwd)
      case 'mcp':
        return await runMcpTool(input, ctx.cwd)
      default:
        // Tools contributed by connected MCP servers use namespaced names
        // (`mcp__<server>__<tool>`) — route them to the MCP pool.
        if (isMcpTool(name)) return await callMcpTool(name, input)
        return { ok: false, output: `Unknown tool: ${name}` }
    }
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) }
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** The browser-isolation key for a turn: explicit override, else the session id. */
function browserKey(ctx: ToolContext): string | undefined {
  return ctx.browserKey ?? ctx.sessionId
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1'
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '\n…(truncated)' : text
}

/** Build a before/after diff for the UI, skipping no-ops and oversized files. */
function toolDiff(path: string, before: string, after: string): ToolDiff | undefined {
  if (before === after) return undefined
  if (before.length > MAX_DIFF_SIDE || after.length > MAX_DIFF_SIDE) return undefined
  return { path, before, after }
}

/** Image file extensions we render inline instead of dumping raw bytes as text. */
const IMAGE_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

/** Human-readable byte size, e.g. 45.2 KB. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Resolve a path within the workspace, rejecting anything that escapes it. */
function resolveInCwd(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p)
  const rel = path.relative(cwd, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace: ${p}`)
  }
  return resolved
}

function runBash(
  command: string,
  cwd: string,
  onChunk?: (chunk: string) => void,
  opts: { timeout?: number; background?: boolean } = {}
): Promise<ToolResult> {
  if (!command.trim()) return Promise.resolve({ ok: false, output: 'bash: missing "command"' })
  // Long-running commands (dev servers, watchers) run detached; poll via bash_output.
  if (opts.background) return Promise.resolve(startBackground(command, cwd))
  const timeoutMs = Math.min(Math.max((opts.timeout ?? 60) * 1000, 1000), FG_TIMEOUT_MAX)
  const { cmd, args } = shellInvocation(command)
  return new Promise((resolve) => {
    const header = `$ ${command}\n`
    onChunk?.(header)
    let acc = header
    let truncated = false
    let timedOut = false
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      // Coax CLIs into emitting ANSI color even though stdout is a pipe, not a
      // TTY. The UI renders the color; the agent strips it before the model reads it.
      env: { ...process.env, FORCE_COLOR: '3', CLICOLOR_FORCE: '1', TERM: 'xterm-256color' }
    })
    const onData = (buf: Buffer): void => {
      if (truncated) return
      let chunk = buf.toString()
      if (acc.length + chunk.length > MAX_OUTPUT) {
        chunk = chunk.slice(0, Math.max(0, MAX_OUTPUT - acc.length)) + '\n…(truncated)'
        truncated = true
      }
      acc += chunk
      onChunk?.(chunk)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const timer = setTimeout(() => {
      timedOut = true
      killProc(child)
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      const msg = `\n[error: ${e.message}]`
      onChunk?.(msg)
      resolve({ ok: false, output: (acc + msg).trimEnd() })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const exitCode = code ?? (timedOut ? 124 : 0)
      const suffix = timedOut
        ? `\n[timed out after ${Math.round(timeoutMs / 1000)}s — for a server or watcher, call bash again with background:true]`
        : exitCode !== 0
          ? `\n[exit ${exitCode}]`
          : ''
      if (suffix) onChunk?.(suffix)
      resolve({ ok: !timedOut && exitCode === 0, output: (acc + suffix).trimEnd() || '(no output)' })
    })
  })
}

/** Start a long-running command that keeps running after this call returns. */
function startBackground(command: string, cwd: string): ToolResult {
  const id = `bg_${++bgCounter}`
  const { cmd, args } = shellInvocation(command)
  const child = spawn(cmd, args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '3', CLICOLOR_FORCE: '1', TERM: 'xterm-256color' }
  })
  const proc: BgProc = {
    id,
    command,
    cwd,
    child,
    output: `$ ${command}\n`,
    readCursor: 0,
    status: 'running',
    exitCode: null,
    startedAt: Date.now()
  }
  const append = (buf: Buffer): void => {
    proc.output += buf.toString()
    if (proc.output.length > MAX_BG_OUTPUT) {
      const drop = proc.output.length - MAX_BG_OUTPUT
      proc.output = proc.output.slice(drop)
      proc.readCursor = Math.max(0, proc.readCursor - drop)
    }
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('error', (e) => {
    proc.status = 'error'
    proc.output += `\n[error: ${e.message}]`
  })
  child.on('close', (code) => {
    proc.exitCode = code ?? proc.exitCode
    if (proc.status === 'running') proc.status = 'exited'
  })
  bgProcs.set(id, proc)
  return {
    ok: true,
    output:
      `Started background process ${id}: $ ${command}\n` +
      `It runs in the background in this workspace. ` +
      `Use bash_output({ id: "${id}" }) to read new logs, bash_kill({ id: "${id}" }) to stop it, or bash_list to see all running processes.`
  }
}

function ownedBg(id: string, cwd: string): BgProc | undefined {
  const p = bgProcs.get(id)
  return p && p.cwd === cwd ? p : undefined
}

/** A short status label for a background process, e.g. `running 12s` / `exited (exit 0)`. */
function bgState(p: BgProc): string {
  const secs = Math.round((Date.now() - p.startedAt) / 1000)
  if (p.status === 'running') return `running ${secs}s`
  if (p.exitCode != null) return `${p.status} (exit ${p.exitCode})`
  return p.status
}

function runBashList(cwd: string): ToolResult {
  const mine = [...bgProcs.values()].filter((p) => p.cwd === cwd)
  if (!mine.length) return { ok: true, output: 'No background processes in this workspace.' }
  return { ok: true, output: mine.map((p) => `${p.id}  [${bgState(p)}]  $ ${p.command}`).join('\n') }
}

function runBashOutput(id: string, cwd: string): ToolResult {
  if (!id) return { ok: false, output: 'bash_output: missing "id"' }
  const p = ownedBg(id, cwd)
  if (!p)
    return { ok: false, output: `No background process "${id}" in this workspace. Use bash_list to see them.` }
  let fresh = p.output.slice(p.readCursor)
  p.readCursor = p.output.length
  if (fresh.length > MAX_OUTPUT) fresh = '…(truncated)\n' + fresh.slice(fresh.length - MAX_OUTPUT)
  const body = fresh.trim() ? fresh.replace(/[\r\n]+$/, '') : '(no new output)'
  return { ok: true, output: `[${id} ${bgState(p)}]\n${body}` }
}

function runBashKill(id: string, cwd: string): ToolResult {
  if (!id) return { ok: false, output: 'bash_kill: missing "id"' }
  const p = ownedBg(id, cwd)
  if (!p) return { ok: false, output: `No background process "${id}" in this workspace.` }
  if (p.status === 'running') {
    p.status = 'killed'
    killProc(p.child)
  }
  return { ok: true, output: `Killed background process ${id} ($ ${p.command}).` }
}

/** Kill a child process directly, swallowing the "already gone" race. */
function killChildSafely(child: ReturnType<typeof spawn>): void {
  try {
    child.kill()
  } catch {
    // already gone
  }
}

/** Kill a child process and, on Windows, its whole tree (servers spawn children). */
function killProc(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' || !child.pid) {
    killChildSafely(child)
    return
  }
  // Windows: `taskkill /t` kills the whole tree (a dev server spawns node
  // children). Resolve it by FULL PATH — a packaged app's PATH may not include
  // System32, so a bare `spawn('taskkill')` fails with ENOENT. CRUCIALLY, a
  // spawn failure is emitted ASYNCHRONOUSLY as an 'error' event, which a
  // try/catch can't catch and which CRASHES the whole main process if unhandled
  // — so attach an 'error' listener that falls back to a direct kill.
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  try {
    const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    killer.on('error', () => killChildSafely(child))
  } catch {
    killChildSafely(child)
  }
}

/** Kill every background process — called on app quit so dev servers aren't orphaned. */
export function killAllBackground(): void {
  for (const p of bgProcs.values()) {
    if (p.status === 'running') {
      p.status = 'killed'
      killProc(p.child)
    }
  }
}

/** How to invoke a shell command per platform (PowerShell on Windows, sh elsewhere). */
function shellInvocation(command: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
  }
  return { cmd: '/bin/sh', args: ['-c', command] }
}

async function runRead(p: string, cwd: string): Promise<ToolResult> {
  if (!p) return { ok: false, output: 'read: missing "path"' }
  // Spilled tool outputs live outside the workspace (see tool-output-store); the
  // model reaches them via the absolute pointer we handed it. Everything else
  // stays sandboxed to the workspace.
  const abs = path.isAbsolute(p) && isManagedToolOutputPath(p) ? p : resolveInCwd(cwd, p)
  // Image files: render inline instead of dumping raw bytes as garbled text.
  const mediaType = IMAGE_MEDIA[path.extname(p).toLowerCase()]
  if (mediaType) {
    const buf = await fs.readFile(abs)
    const size = fmtBytes(buf.length)
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: true, output: `Read image ${p} (${mediaType}, ${size}) — too large to preview inline.` }
    }
    return {
      ok: true,
      output: `Read image ${p} (${mediaType}, ${size}).`,
      image: `data:${mediaType};base64,${buf.toString('base64')}`
    }
  }
  const content = await fs.readFile(abs, 'utf8')
  return { ok: true, output: cap(content) }
}

async function runWrite(p: string, content: string, cwd: string): Promise<ToolResult> {
  if (!p) return { ok: false, output: 'write: missing "path"' }
  const abs = resolveInCwd(cwd, p)
  const before = await fs.readFile(abs, 'utf8').catch(() => '')
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
  return withDiagnostics(
    {
      ok: true,
      output: `Wrote ${Buffer.byteLength(content)} bytes to ${p}`,
      diff: toolDiff(p, before, content)
    },
    abs,
    cwd
  )
}

async function runEdit(
  p: string,
  oldString: string,
  newString: string,
  cwd: string
): Promise<ToolResult> {
  if (!p || !oldString) return { ok: false, output: 'edit: missing "path" or "oldString"' }
  const abs = resolveInCwd(cwd, p)
  const content = await fs.readFile(abs, 'utf8')
  const count = content.split(oldString).length - 1
  if (count === 0) return { ok: false, output: `edit: "oldString" not found in ${p}` }
  if (count > 1) {
    return { ok: false, output: `edit: "oldString" matches ${count}× in ${p}; make it unique` }
  }
  const after = content.replace(oldString, newString)
  await fs.writeFile(abs, after, 'utf8')
  return withDiagnostics({ ok: true, output: `Edited ${p}`, diff: toolDiff(p, content, after) }, abs, cwd)
}

/**
 * Append the language server's diagnostics for a just-edited file to the tool
 * result, so the model sees its own type errors on the next turn (Phase 12).
 * A no-op for unsupported file types or when no server is installed — it must
 * never change `ok` or block an edit.
 */
async function withDiagnostics(result: ToolResult, abs: string, cwd: string): Promise<ToolResult> {
  const block = await lsp.diagnosticsBlock(abs, cwd)
  if (block) result.output += `\n\n${block}`
  return result
}

/** On-demand `lsp` tool: report a file's current diagnostics (errors + warnings). */
async function runLspTool(p: string, cwd: string): Promise<ToolResult> {
  if (!p) return { ok: false, output: 'lsp: missing "path"' }
  const abs = resolveInCwd(cwd, p)
  if (!lsp.configuredServerId(abs)) {
    return { ok: true, output: `No language server is configured for ${p}.` }
  }
  const diags = await lsp.diagnostics(abs)
  const block = renderDiagnosticsBlock(p, diags, { includeWarnings: true, max: 50 })
  return { ok: true, output: block || `No diagnostics reported for ${p}.` }
}

async function runList(p: string, cwd: string): Promise<ToolResult> {
  const entries = await fs.readdir(resolveInCwd(cwd, p), { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`)
  const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name)
  const lines = [...dirs.sort(), ...files.sort()]
  return { ok: true, output: lines.length ? lines.join('\n') : '(empty)' }
}

async function runGlob(pattern: string, cwd: string): Promise<ToolResult> {
  if (!pattern) return { ok: false, output: 'glob: missing "pattern"' }
  const matches = await glob(pattern, { cwd, onlyFiles: true, ignore: IGNORE })
  if (!matches.length) return { ok: true, output: '(no matches)' }
  const shown = matches.slice(0, 500)
  const more = matches.length > 500 ? `\n…(${matches.length} total)` : ''
  return { ok: true, output: shown.join('\n') + more }
}

async function runGrep(pattern: string, include: string, cwd: string): Promise<ToolResult> {
  if (!pattern) return { ok: false, output: 'grep: missing "pattern"' }
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    return { ok: false, output: `grep: invalid regex: ${pattern}` }
  }
  const files = await glob(include, { cwd, onlyFiles: true, ignore: IGNORE })
  const results: string[] = []
  for (const rel of files.slice(0, 2000)) {
    let content: string
    try {
      content = await fs.readFile(path.join(cwd, rel), 'utf8')
    } catch {
      continue
    }
    if (content.includes('\0')) continue // skip binary
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
      if (results.length >= 200) break
    }
    if (results.length >= 200) break
  }
  return { ok: true, output: results.length ? results.join('\n') : '(no matches)' }
}

// ---- Web (fetch + search) ---------------------------------------------------

/**
 * Fetch a URL and return it as markdown (default), plain text, or raw HTML.
 * Uses a real-browser UA, caps the download + the model-facing output, and
 * rejects binary/image responses (use the browser tools for those).
 */
async function runWebFetch(
  rawUrl: string,
  format: string,
  timeout: unknown,
  onChunk?: (chunk: string) => void
): Promise<ToolResult> {
  let url: string
  try {
    url = normalizeFetchUrl(rawUrl)
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) }
  }
  const fmt: WebFetchFormat = format === 'text' || format === 'html' ? format : 'markdown'
  const timeoutSec = clampTimeout(timeout)
  onChunk?.(`Fetching ${url}…`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: acceptHeader(fmt),
        'Accept-Language': 'en-US,en;q=0.9'
      }
    })
    if (!res.ok) {
      return { ok: false, output: `Failed to fetch ${url} — HTTP ${res.status} ${res.statusText}`.trim() }
    }
    const contentType = res.headers.get('content-type') ?? ''
    const mime = mimeFromContentType(contentType)
    if (isImageMime(mime)) {
      return { ok: false, output: `Refusing to fetch image content (${mime}). Use the browser tools to view images.` }
    }
    if (!isTextualMime(mime)) {
      return { ok: false, output: `Unsupported content type: ${mime || 'unknown'}. webfetch only reads text/HTML pages.` }
    }
    const raw = await readCapped(res, WEBFETCH_MAX_BYTES)
    const converted = convertWebContent(raw, contentType, fmt)
    const output = capText(converted, WEBFETCH_OUTPUT_CAP)
    return { ok: true, output: output || '(the page had no readable text content)' }
  } catch (e) {
    if (controller.signal.aborted) {
      return { ok: false, output: `Fetching ${url} timed out after ${timeoutSec}s.` }
    }
    return { ok: false, output: `Failed to fetch ${url} — ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Search the web via Exa's public MCP endpoint. Works keyless (rate-limited);
 * an optional Exa API key (Settings → Web search, or the EXA_API_KEY env var)
 * lifts the limits. Fails gracefully with a clear message when the network or
 * the provider is unavailable.
 */
async function runWebSearch(
  query: string,
  numResults: unknown,
  onChunk?: (chunk: string) => void
): Promise<ToolResult> {
  if (!query.trim()) return { ok: false, output: 'websearch: missing "query"' }
  const count = clampResults(numResults)
  const apiKey = webSearchApiKey()
  const endpoint = ((): string => {
    if (!apiKey) return EXA_MCP_URL
    const u = new URL(EXA_MCP_URL)
    u.searchParams.set('exaApiKey', apiKey)
    return u.toString()
  })()
  onChunk?.(`Searching the web for "${query}"…`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBSEARCH_TIMEOUT * 1000)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': BROWSER_UA
      },
      body: buildExaRequestBody(query, count)
    })
    if (!res.ok) {
      return {
        ok: false,
        output:
          `Web search failed — HTTP ${res.status} ${res.statusText}`.trim() +
          (res.status === 429 ? '\nRate limited. Add an Exa API key in Settings → Web search to raise the limit.' : '')
      }
    }
    const body = await readCapped(res, WEBSEARCH_MAX_BYTES)
    const text = parseExaResponse(body)
    return { ok: true, output: text ? capText(text, WEBFETCH_OUTPUT_CAP) : WEBSEARCH_NO_RESULTS }
  } catch (e) {
    if (controller.signal.aborted) {
      return { ok: false, output: `Web search timed out after ${WEBSEARCH_TIMEOUT}s.` }
    }
    return { ok: false, output: `Web search failed — ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** The optional Exa key: user setting first, then the EXA_API_KEY env var. */
function webSearchApiKey(): string | undefined {
  try {
    const fromSettings = repo.getSettings().webSearchApiKey
    if (fromSettings && fromSettings.trim()) return fromSettings.trim()
  } catch {
    // repo may be unavailable in non-Electron contexts — fall back to env.
  }
  const fromEnv = process.env.EXA_API_KEY
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined
}

function clampTimeout(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return WEBFETCH_TIMEOUT_DEFAULT
  return Math.min(Math.floor(n), WEBFETCH_TIMEOUT_MAX)
}

/** Read a response body as UTF-8 text, stopping once it exceeds `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body
  if (!body) return (await res.text()).slice(0, maxBytes)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString('utf8')
}

/** Truncate model-facing output with a clear marker. */
function capText(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n\n…[truncated ${text.length - cap} more characters]`
}

// ---- Browser (Electron-backed) ----------------------------------------------

const CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error']

async function runBrowserOpen(url: string, key?: string): Promise<ToolResult> {
  if (!url.trim()) return { ok: false, output: 'browser_open: missing "url"' }
  const { url: finalUrl, title, error } = await browser.open(url, key)
  const note = error ? `\n[load warning: ${error}]` : ''
  return { ok: !error, output: `Opened ${title || '(untitled)'}\n${finalUrl}${note}` }
}

async function runBrowserScreenshot(cwd: string, key?: string): Promise<ToolResult> {
  const shot = await browser.screenshot(cwd || undefined, key)
  const where = shot.savedTo ? `\nSaved to ${shot.savedTo}` : ''
  const page = browser.currentUrl(key) ?? 'the page'
  return {
    ok: true,
    output: `Captured a ${shot.width}\u00d7${shot.height} screenshot of ${page}.${where}`,
    image: shot.dataUrl
  }
}

async function runBrowserRead(selector: string | undefined, key?: string): Promise<ToolResult> {
  const html = await browser.getHtml(selector, key)
  return { ok: true, output: cap(html) }
}

function runBrowserConsole(key?: string): ToolResult {
  const { entries, errors, warnings } = browser.getConsole(key)
  if (entries.length === 0) return { ok: true, output: 'No console messages captured yet.' }
  const lines = entries.map((e) => {
    const label = (CONSOLE_LEVELS[e.level] ?? 'log').toUpperCase()
    const loc = e.url ? ` (${e.url}${e.line ? `:${e.line}` : ''})` : ''
    return `[${label}] ${e.message}${loc}`
  })
  const header = `${entries.length} message(s) · ${errors} error(s), ${warnings} warning(s)`
  return { ok: errors === 0, output: `${header}\n${cap(lines.join('\n'))}` }
}

function runBrowserTabs(key?: string): ToolResult {
  const open = browser.listTabs(key)
  if (open.length === 0) return { ok: true, output: 'No browser is open. Use browser_open first.' }
  const lines = open.map(
    (t) => `${t.active ? '*' : ' '} [${t.id}] ${t.title || '(untitled)'} — ${t.url || 'about:blank'}`
  )
  return { ok: true, output: `${open.length} open tab(s) (* = active):\n${lines.join('\n')}` }
}

function runBrowserNewTab(url: string | undefined, key?: string): ToolResult {
  browser.newTab(url, key)
  return runBrowserTabs(key)
}

function runBrowserActivateTab(id: string, key?: string): ToolResult {
  if (!id) return { ok: false, output: 'browser_activate_tab: missing "id"' }
  if (!browser.listTabs(key).some((t) => t.id === id)) {
    return { ok: false, output: `No tab with id "${id}". Use browser_tabs to list ids.` }
  }
  browser.activateTab(id, key)
  return runBrowserTabs(key)
}

async function runBrowserClick(selector: string, key?: string): Promise<ToolResult> {
  const out = await browser.click(selector, key)
  return { ok: !out.startsWith('No element') && !out.startsWith('browser_'), output: out }
}

async function runBrowserScroll(input: Record<string, unknown>, key?: string): Promise<ToolResult> {
  const out = await browser.scroll(
    {
      selector: typeof input.selector === 'string' ? input.selector : undefined,
      direction: typeof input.direction === 'string' ? input.direction : undefined,
      amount: typeof input.amount === 'number' ? input.amount : undefined
    },
    key
  )
  return { ok: !out.startsWith('No element'), output: out }
}

async function runBrowserType(selector: string, text: string, key?: string): Promise<ToolResult> {
  const out = await browser.type(selector, text, key)
  return { ok: !out.startsWith('No element') && !out.startsWith('browser_'), output: out }
}

// ---- Loops (turn scheduled prompts on/off via a tool, not a UI toggle) -------

function runLoopCreate(input: Record<string, unknown>, cwd: string): ToolResult {
  const name = str(input.name).trim()
  const prompt = str(input.prompt).trim()
  const interval = Number(
    input.interval_minutes ?? input.intervalMinutes ?? input.interval ?? input.minutes
  )
  if (!name || !prompt) return { ok: false, output: 'loop_create: needs "name" and "prompt".' }
  if (!Number.isFinite(interval) || interval < 1) {
    return { ok: false, output: 'loop_create: "interval_minutes" must be a number >= 1.' }
  }
  const loop = repo.createLoop({
    name,
    prompt,
    intervalMinutes: Math.floor(interval),
    workspacePath: cwd || null
  })
  return {
    ok: true,
    output: `Created loop "${loop.name}" — runs every ${loop.intervalMinutes} min${
      cwd ? ' in this project' : ''
    }. It fires shortly and on each interval; pause it with loop_disable.`
  }
}

function runLoopRemove(ref: string): ToolResult {
  if (!ref.trim()) return { ok: false, output: 'loop_remove: missing "loop" (a name or id)' }
  const loops = repo.listLoops()
  const needle = ref.trim().toLowerCase()
  const loop =
    loops.find((l) => l.id === ref) ??
    loops.find((l) => l.name.toLowerCase() === needle) ??
    loops.find((l) => l.name.toLowerCase().includes(needle))
  if (!loop) return { ok: false, output: `No loop matches "${ref}". Run loop_list to see them.` }
  repo.removeLoop(loop.id)
  return { ok: true, output: `Removed loop "${loop.name}".` }
}

function runLoopList(): ToolResult {
  const loops = repo.listLoops()
  if (loops.length === 0) return { ok: true, output: 'No loops defined.' }
  const lines = loops.map(
    (l) =>
      `${l.enabled ? '\u25cf' : '\u25cb'} ${l.name} \u2014 every ${l.intervalMinutes}m (${l.enabled ? 'running' : 'paused'})`
  )
  return { ok: true, output: lines.join('\n') }
}

function runLoopSet(ref: string, enabled: boolean): ToolResult {
  const verb = enabled ? 'loop_enable' : 'loop_disable'
  if (!ref.trim()) return { ok: false, output: `${verb}: missing "loop" (a name or id)` }
  const loops = repo.listLoops()
  const needle = ref.trim().toLowerCase()
  const loop =
    loops.find((l) => l.id === ref) ??
    loops.find((l) => l.name.toLowerCase() === needle) ??
    loops.find((l) => l.name.toLowerCase().includes(needle))
  if (!loop) return { ok: false, output: `No loop matches "${ref}". Run loop_list to see them.` }
  repo.setLoopEnabled(loop.id, enabled)
  return { ok: true, output: `${enabled ? 'Enabled' : 'Disabled'} loop "${loop.name}".` }
}

// ---- Skills authoring (the agent saving reusable workflows for later) --------

/**
 * The `skill_manage` tool: let the agent create / list / edit / remove reusable
 * Skills (SKILL.md files) itself, so capturing a workflow is one tool call. New
 * skills land under `.roxy/skills/<name>/SKILL.md` (workspace) or `~/.roxy/skills`
 * (global) and become loadable via the `skill` tool on the next turn. Never
 * throws — every failure degrades to an error ToolResult.
 */
async function runSkillManage(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const action = str(input.action ?? input.op).trim().toLowerCase()
  if (!action) {
    return { ok: false, output: 'skill_manage: missing "action" (create, install, list, edit, or remove).' }
  }
  if (action === 'list' || action === 'ls') return skillManageList(cwd)

  const source = str(input.source ?? input.url ?? input.repo ?? input.from).trim()
  // "install"/"add-from-url", or a create/add that supplied a source instead of a body.
  const wantsInstall =
    action === 'install' ||
    action === 'import' ||
    ((action === 'create' || action === 'add' || action === 'new') && !!source && !pickSkillBody(input))
  if (wantsInstall) return runSkillInstall(input, source, cwd)

  const name = str(input.name ?? input.skill ?? input.id).trim()
  if (!name) return { ok: false, output: `skill_manage ${action}: needs a "name". Run action:"list" to see existing skills.` }

  const scope = str(input.scope).trim().toLowerCase() === 'global' ? 'global' : 'workspace'
  const description = input.description != null ? str(input.description) : undefined
  const body = pickSkillBody(input)

  switch (action) {
    case 'create':
    case 'add':
    case 'new': {
      if (!body || !body.trim()) {
        return {
          ok: false,
          output:
            'skill_manage create: needs a "body" — the skill\'s instructions in Markdown. (To fetch a skill from a repo/URL, use action:"install" with a "source".)'
        }
      }
      const res = await writeSkill({ name, description, body, scope }, cwd, { mode: 'create' })
      return res.ok
        ? {
            ok: true,
            output: `Created ${scope} skill "${name}" at ${res.location}. It will be loadable with the skill tool on your next turn.`
          }
        : { ok: false, output: res.error ?? 'Failed to create skill.' }
    }
    case 'edit':
    case 'update': {
      if (description === undefined && (body === undefined || !body.length)) {
        return { ok: false, output: 'skill_manage edit: provide a new "description" and/or "body" to change.' }
      }
      const res = await writeSkill({ name, description, body, scope }, cwd, { mode: 'edit' })
      return res.ok
        ? { ok: true, output: `Updated skill "${name}" at ${res.location}.` }
        : { ok: false, output: res.error ?? 'Failed to update skill.' }
    }
    case 'remove':
    case 'delete':
    case 'rm': {
      const res = await deleteSkill(name, cwd)
      if (!res.ok) return { ok: false, output: res.error ?? 'Failed to remove skill.' }
      return {
        ok: true,
        output: res.removed ? `Removed skill "${name}" (${res.location}).` : (res.error ?? `No skill named "${name}".`)
      }
    }
    default:
      return {
        ok: false,
        output: `skill_manage: unknown action "${action}". Use create, install, list, edit, or remove.`
      }
  }
}

/**
 * The `install` action: fetch skill(s) from a GitHub repo/URL (like `npx skills
 * add <src>`) into the workspace (default) or global skills root. Reports every
 * skill written so the model knows what it can now `skill`-load next turn.
 */
async function runSkillInstall(
  input: Record<string, unknown>,
  source: string,
  cwd: string
): Promise<ToolResult> {
  if (!source) {
    return {
      ok: false,
      output:
        'skill_manage install: needs a "source" — a GitHub "owner/repo", a github.com URL, or a direct https URL to a SKILL.md.'
    }
  }
  const scope = str(input.scope).trim().toLowerCase() === 'global' ? 'global' : 'workspace'
  const res = await installSkillFromSource(source, { scope, cwd })
  if (!res.ok) return { ok: false, output: res.error ?? 'Failed to install the skill.' }
  const names = res.installed.map((s) => s.name)
  const lines = res.installed.map((s) => `- ${s.name} → ${s.location}`)
  const skippedNote =
    res.skipped && res.skipped.length
      ? `\nSkipped: ${res.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`
      : ''
  return {
    ok: true,
    output: `Installed ${names.length} ${scope} skill${names.length === 1 ? '' : 's'} from ${source}:\n${lines.join(
      '\n'
    )}${skippedNote}\nLoad one with the skill tool, e.g. skill { name: "${names[0]}" }.`
  }
}

/** Accept the skill body under any of the names a model might reasonably use. */
function pickSkillBody(input: Record<string, unknown>): string | undefined {
  for (const key of ['body', 'content', 'instructions', 'markdown', 'text']) {
    const v = input[key]
    if (typeof v === 'string') return v
  }
  return undefined
}

async function skillManageList(cwd: string): Promise<ToolResult> {
  const skills = await listSkills(cwd)
  if (!skills.length) {
    return { ok: true, output: 'No skills found. Create one with skill_manage action:"create".' }
  }
  const lines = skills.map(
    (s) => `- ${s.name} [${s.source}]${s.description ? ` — ${s.description}` : ''}\n    ${s.location}`
  )
  return { ok: true, output: `Skills (${skills.length}):\n${lines.join('\n')}` }
}

// ---- MCP servers (the agent hooking up external tool servers on demand) -------

/**
 * The `mcp` tool: let the agent add / list / (re)connect / enable / disable /
 * remove external MCP servers itself, so hooking one up is a single tool call
 * instead of a Settings visit. `add`/`enable`/`reconnect` connect the server
 * immediately (via the warm pool) and report the tools it exposes; `runLoop`
 * then merges those schemas into the live tool list so they're callable this
 * same turn. Never throws — every failure degrades to an error ToolResult.
 */
async function runMcpTool(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const action = str(input.action ?? input.op).trim().toLowerCase()
  if (!action) {
    return { ok: false, output: 'mcp: missing "action" (add, list, reconnect, enable, disable, or remove).' }
  }
  if (action === 'list' || action === 'ls' || action === 'status') return mcpListServers()

  const id = str(input.id ?? input.name ?? input.server).trim()
  if (!id) return { ok: false, output: `mcp ${action}: needs an "id" (the server name). Run action:"list" to see configured servers.` }

  switch (action) {
    case 'add':
    case 'upsert':
    case 'create': {
      const config = buildMcpConfig(input)
      if (!config) {
        return {
          ok: false,
          output:
            'mcp add: provide a LOCAL server "command" (argv array, e.g. ["npx","-y","@modelcontextprotocol/server-filesystem","/dir"]) OR a REMOTE "url".'
        }
      }
      repo.upsertMcpServer({ id, config, enabled: true })
      const summary = await reconnectMcpServer({ id, config, enabled: true }, cwd)
      return summarizeMcpConnect('Added', id, summary)
    }
    case 'reconnect':
    case 'refresh':
    case 'connect':
      return mcpReconnectServer(id, cwd)
    case 'enable':
      return mcpSetServerEnabled(id, true, cwd)
    case 'disable':
      return mcpSetServerEnabled(id, false, cwd)
    case 'remove':
    case 'delete':
    case 'rm':
      return mcpRemoveServer(id)
    default:
      return {
        ok: false,
        output: `mcp: unknown action "${action}". Use add, list, reconnect, enable, disable, or remove.`
      }
  }
}

/** Build an MCP config from the tool input — a local `command` or a remote `url`. */
function buildMcpConfig(input: Record<string, unknown>): McpServerConfig | null {
  const command = input.command ?? input.args ?? input.argv
  const url = input.url ?? input.endpoint
  const raw: Record<string, unknown> = {}
  if (Array.isArray(command) || (typeof command === 'string' && command.trim())) {
    raw.type = 'local'
    raw.command = command
    const env = input.env ?? input.environment
    if (env) raw.environment = env
    if (typeof input.cwd === 'string' && input.cwd.trim()) raw.cwd = input.cwd
  } else if (typeof url === 'string' && url.trim()) {
    raw.type = 'remote'
    raw.url = url
    if (input.headers) raw.headers = input.headers
  } else {
    return null
  }
  if (input.timeout != null) raw.timeout = input.timeout
  return normalizeServerConfig(raw)
}

function mcpListServers(): ToolResult {
  const records = repo.listMcpServers()
  if (!records.length) {
    return { ok: true, output: 'No MCP servers configured. Add one with mcp action:"add".' }
  }
  const statusById = new Map(mcpServerSummaries().map((s) => [s.id, s]))
  const lines = records.map((rec) => {
    const sum = statusById.get(rec.id)
    const transport =
      rec.config.type === 'local' ? `local: ${rec.config.command.join(' ')}` : `remote: ${rec.config.url}`
    const status = !rec.enabled ? 'disabled' : (sum?.status ?? 'not connected')
    const tools = sum && sum.tools.length ? ` — tools: ${sum.tools.join(', ')}` : ''
    const err = sum?.status === 'error' && sum.error ? ` (${sum.error})` : ''
    return `- ${rec.id} [${status}] ${transport}${tools}${err}`
  })
  return { ok: true, output: `MCP servers (${records.length}):\n${lines.join('\n')}` }
}

async function mcpReconnectServer(id: string, cwd: string): Promise<ToolResult> {
  const rec = repo.listMcpServers().find((r) => r.id === id)
  if (!rec) return { ok: false, output: `mcp reconnect: no server named "${id}". Run action:"list".` }
  const summary = await reconnectMcpServer(rec, cwd)
  return summarizeMcpConnect('Reconnected', id, summary)
}

async function mcpSetServerEnabled(id: string, enabled: boolean, cwd: string): Promise<ToolResult> {
  const rec = repo.listMcpServers().find((r) => r.id === id)
  if (!rec) {
    return { ok: false, output: `mcp ${enabled ? 'enable' : 'disable'}: no server named "${id}". Run action:"list".` }
  }
  repo.setMcpServerEnabled(id, enabled)
  if (!enabled) {
    await disposeConnection(id)
    return { ok: true, output: `Disabled MCP server "${id}" and disconnected it.` }
  }
  const summary = await reconnectMcpServer({ ...rec, enabled: true }, cwd)
  return summarizeMcpConnect('Enabled', id, summary)
}

async function mcpRemoveServer(id: string): Promise<ToolResult> {
  const existed = repo.listMcpServers().some((r) => r.id === id)
  await disposeConnection(id)
  repo.deleteMcpServer(id)
  return existed
    ? { ok: true, output: `Removed MCP server "${id}".` }
    : { ok: true, output: `No MCP server named "${id}" was configured (nothing to remove).` }
}

/** Turn a post-connect summary into a ToolResult that names the now-callable tools. */
function summarizeMcpConnect(verb: string, id: string, summary: McpServerSummary): ToolResult {
  if (summary.status === 'connected') {
    const tools = summary.tools.length
      ? `Its tools are now available to you: ${summary.tools.map((t) => qualifyToolName(id, t)).join(', ')}.`
      : 'It connected but exposed no tools.'
    return { ok: true, output: `${verb} MCP server "${id}" and connected it. ${tools}` }
  }
  if (summary.status === 'disabled') {
    return { ok: true, output: `${verb} MCP server "${id}", but it is disabled. Enable it with mcp action:"enable".` }
  }
  return {
    ok: false,
    output: `${verb} MCP server "${id}", but it failed to connect: ${summary.error ?? 'unknown error'}. Check the command/url and try mcp action:"reconnect".`
  }
}

// ---- Session metadata (the agent organizing its own session) ----------------

/** Coerce the model's `tasks` argument into a clean checklist (accepts strings or objects). */
function parseTasksInput(raw: unknown): SessionTask[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SessionTask[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ title: item.trim(), status: 'pending' })
      continue
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const title = str(rec.title ?? rec.text ?? rec.name).trim()
      if (!title) continue
      const status =
        rec.status === 'in_progress' || rec.status === 'completed'
          ? rec.status
          : rec.done === true || rec.completed === true
            ? 'completed'
            : 'pending'
      out.push({ title, status })
    }
  }
  return out
}

function runSetSessionMetadata(input: Record<string, unknown>, sessionId?: string): ToolResult {
  if (!sessionId) {
    return { ok: false, output: 'change_session_metadata: no active session to update.' }
  }
  const patch: { title?: string; description?: string; tasks?: SessionTask[] } = {}
  const title = str(input.title ?? input.name).trim()
  if (title) patch.title = title.slice(0, 80)
  if (typeof input.description === 'string') {
    patch.description = input.description.trim().slice(0, 2000)
  }
  const tasks = parseTasksInput(input.tasks)
  if (tasks) patch.tasks = tasks
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      output: 'change_session_metadata: provide at least one of title, description, or tasks.'
    }
  }
  let chat: ReturnType<typeof repo.setChatMetadata>
  try {
    chat = repo.setChatMetadata(sessionId, patch)
  } catch {
    return { ok: false, output: `change_session_metadata: no session "${sessionId}".` }
  }
  const bits: string[] = []
  if (patch.title) bits.push(`name → "${chat.title}"`)
  if (patch.description !== undefined) bits.push('description updated')
  if (patch.tasks) {
    const done = patch.tasks.filter((t) => t.status === 'completed').length
    bits.push(`tasks ${done}/${patch.tasks.length} done`)
  }
  return { ok: true, output: `Updated session metadata (${bits.join(', ')}).` }
}
