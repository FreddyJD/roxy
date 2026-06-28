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
import * as browser from '../services/browser'
import * as repo from '../db/repo'

export interface ToolContext {
  cwd: string
  /** The session (chat id) this turn runs in — the target of session-metadata tools. */
  sessionId?: string
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
      case 'browser_open':
        return await runBrowserOpen(str(input.url))
      case 'browser_screenshot':
        return await runBrowserScreenshot(ctx.cwd)
      case 'browser_read':
        return await runBrowserRead(str(input.selector) || undefined)
      case 'browser_console':
        return runBrowserConsole()
      case 'browser_click':
        return await runBrowserClick(str(input.selector))
      case 'browser_scroll':
        return await runBrowserScroll(input)
      case 'browser_type':
        return await runBrowserType(str(input.selector), str(input.text))
      case 'browser_tabs':
        return runBrowserTabs()
      case 'browser_new_tab':
        return runBrowserNewTab(str(input.url) || undefined)
      case 'browser_activate_tab':
        return runBrowserActivateTab(str(input.id ?? input.tab))
      case 'browser_close':
        browser.close()
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
      default:
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

/** Kill a child process and, on Windows, its whole tree (servers spawn children). */
function killProc(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    } else {
      child.kill()
    }
  } catch {
    // already gone
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
  const abs = resolveInCwd(cwd, p)
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
  return {
    ok: true,
    output: `Wrote ${Buffer.byteLength(content)} bytes to ${p}`,
    diff: toolDiff(p, before, content)
  }
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
  return { ok: true, output: `Edited ${p}`, diff: toolDiff(p, content, after) }
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

// ---- Browser (Electron-backed) ----------------------------------------------

const CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error']

async function runBrowserOpen(url: string): Promise<ToolResult> {
  if (!url.trim()) return { ok: false, output: 'browser_open: missing "url"' }
  const { url: finalUrl, title, error } = await browser.open(url)
  const note = error ? `\n[load warning: ${error}]` : ''
  return { ok: !error, output: `Opened ${title || '(untitled)'}\n${finalUrl}${note}` }
}

async function runBrowserScreenshot(cwd: string): Promise<ToolResult> {
  const shot = await browser.screenshot(cwd || undefined)
  const where = shot.savedTo ? `\nSaved to ${shot.savedTo}` : ''
  const page = browser.currentUrl() ?? 'the page'
  return {
    ok: true,
    output: `Captured a ${shot.width}\u00d7${shot.height} screenshot of ${page}.${where}`,
    image: shot.dataUrl
  }
}

async function runBrowserRead(selector?: string): Promise<ToolResult> {
  const html = await browser.getHtml(selector)
  return { ok: true, output: cap(html) }
}

function runBrowserConsole(): ToolResult {
  const { entries, errors, warnings } = browser.getConsole()
  if (entries.length === 0) return { ok: true, output: 'No console messages captured yet.' }
  const lines = entries.map((e) => {
    const label = (CONSOLE_LEVELS[e.level] ?? 'log').toUpperCase()
    const loc = e.url ? ` (${e.url}${e.line ? `:${e.line}` : ''})` : ''
    return `[${label}] ${e.message}${loc}`
  })
  const header = `${entries.length} message(s) · ${errors} error(s), ${warnings} warning(s)`
  return { ok: errors === 0, output: `${header}\n${cap(lines.join('\n'))}` }
}

function runBrowserTabs(): ToolResult {
  const open = browser.listTabs()
  if (open.length === 0) return { ok: true, output: 'No browser is open. Use browser_open first.' }
  const lines = open.map(
    (t) => `${t.active ? '*' : ' '} [${t.id}] ${t.title || '(untitled)'} — ${t.url || 'about:blank'}`
  )
  return { ok: true, output: `${open.length} open tab(s) (* = active):\n${lines.join('\n')}` }
}

function runBrowserNewTab(url?: string): ToolResult {
  browser.newTab(url)
  return runBrowserTabs()
}

function runBrowserActivateTab(id: string): ToolResult {
  if (!id) return { ok: false, output: 'browser_activate_tab: missing "id"' }
  if (!browser.listTabs().some((t) => t.id === id)) {
    return { ok: false, output: `No tab with id "${id}". Use browser_tabs to list ids.` }
  }
  browser.activateTab(id)
  return runBrowserTabs()
}

async function runBrowserClick(selector: string): Promise<ToolResult> {
  const out = await browser.click(selector)
  return { ok: !out.startsWith('No element') && !out.startsWith('browser_'), output: out }
}

async function runBrowserScroll(input: Record<string, unknown>): Promise<ToolResult> {
  const out = await browser.scroll({
    selector: typeof input.selector === 'string' ? input.selector : undefined,
    direction: typeof input.direction === 'string' ? input.direction : undefined,
    amount: typeof input.amount === 'number' ? input.amount : undefined
  })
  return { ok: !out.startsWith('No element'), output: out }
}

async function runBrowserType(selector: string, text: string): Promise<ToolResult> {
  const out = await browser.type(selector, text)
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
