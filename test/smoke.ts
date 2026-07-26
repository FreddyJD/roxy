/**
 * Electron-runtime smoke test. Boots a headless Electron main process against a
 * throwaway userData/DB and exercises the REAL code paths: SQLite migrations +
 * repo CRUD, harness file/bash tools, loop tools, and the Electron browser tools.
 * Run: npm run smoke:app
 */
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

import * as repo from '../src/main/db/repo'
import { closeDb } from '../src/main/db/database'
import {
  runTool,
  killSessionBackground,
  listServices,
  serviceOutput,
  stopService,
  restartService
} from '../src/main/harness'
import { sessionCwd } from '../src/main/services/workspace'
import Database from 'better-sqlite3'
import { MIGRATIONS, repairSchema } from '../src/main/db/migrations'
import * as git from '../src/main/services/git'
import {
  materializePendingWorktree,
  pruneWorktrees,
  removeWorktreeForChat,
  loadWorktreeConfig
} from '../src/main/services/worktree'
import { allocateDevPort, ensureDevPort } from '../src/main/services/ports'
import { spawn } from 'node:child_process'
import * as browser from '../src/main/services/browser'
import {
  boundToolOutput,
  isManagedToolOutputPath,
  toolOutputRoot,
  cleanupToolOutputs
} from '../src/main/services/tool-output-store'
import {
  registerBackgroundJob,
  finishBackgroundJob,
  listRunningBackgroundJobs,
  activeBackgroundSubChatIds,
  hasActiveBackgroundJobs,
  cancelBackgroundJob,
  cancelSessionBackgroundJobs,
  _resetBackgroundJobs
} from '../src/main/services/background-tasks'
import * as lsp from '../src/main/services/lsp'
import {
  ensureMcpConnected,
  mcpToolSchemas,
  callMcpTool,
  isMcpTool,
  mcpToolTitle,
  mcpServerSummaries,
  mcpInstructions,
  reconnectMcpServer,
  disposeConnection,
  shutdownAllMcp,
  loadWorkspaceMcpServers,
  _resetMcpForTests
} from '../src/main/services/mcp'
import type { McpServerRecord } from '../src/shared/mcp'
import {
  listSkills,
  skillInstructions,
  loadSkill,
  refreshSkills,
  installSkillFromSource,
  exportGlobalSkills,
  importGlobalSkills,
  _setInstallFetchForTests,
  _resetSkillsForTests
} from '../src/main/services/skills'
import { buildExport, applyImport } from '../src/main/services/portable'
import { parseBundle } from '../src/shared/portable'
import {
  streamTurn,
  isTransientModelError,
  isNonRetryableModelError,
  nextRetryDelay,
  abortableDelay,
  MODEL_FATAL_ATTEMPTS
} from '../src/main/harness/agent'
import { ModelHttpError } from '../src/main/services/llm'
import { getUsageStats } from '../src/main/services/usage'
import { consumeAiSdkStream } from '../src/main/services/aisdk'
import { APICallError } from 'ai'
import type { MessagePart } from '../src/shared/types'

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fails.push(name)
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

/** Reject after `ms` so a stalled browser op fails its check instead of hanging. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)
    )
  ])
}

// Isolate from the real app: throwaway userData → throwaway roxy.db.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'roxy-smoke-'))
app.setPath('userData', tmp)

// Closing the browser window must NOT auto-quit the app before we report — we
// exit explicitly at the end. (Default Electron behavior quits on Windows.)
app.on('window-all-closed', () => undefined)

async function main(): Promise<void> {
  const ws = path.join(tmp, 'workspace')
  await fs.mkdir(ws, { recursive: true })
  const run = (name: string, input: Record<string, unknown>): ReturnType<typeof runTool> =>
    runTool(name, input, { cwd: ws })

  // ---- migrations + settings ----
  check('settings default (onboarding false)', repo.getSettings().onboardingCompleted === false)
  repo.completeOnboarding()
  check('completeOnboarding persists', repo.getSettings().onboardingCompleted === true)
  repo.setActiveProvider('openai', 'gpt-test')
  check(
    'setActiveProvider persists',
    repo.getSettings().activeProviderId === 'openai' &&
      repo.getSettings().activeModel === 'gpt-test'
  )
  // Auto-workstream defaults ON and is stored only when disabled, so existing
  // installs are opted in without a migration.
  check('auto-workstream defaults on', repo.getSettings().autoWorkstream === true)
  repo.setAutoWorkstream(false)
  check('setAutoWorkstream(false) persists', repo.getSettings().autoWorkstream === false)
  repo.setAutoWorkstream(true)
  check('setAutoWorkstream(true) restores the default', repo.getSettings().autoWorkstream === true)

  check('reasoning effort default high', repo.getSettings().reasoningEffort === 'high')
  repo.setReasoningEffort('low')
  check('setReasoningEffort persists', repo.getSettings().reasoningEffort === 'low')
  repo.setReasoningEffort('max')
  check(
    'setReasoningEffort accepts the xhigh/max ladder',
    repo.getSettings().reasoningEffort === 'max'
  )
  repo.setReasoningEffort('high')
  check('context limit default null', repo.getSettings().contextLimit === null)
  repo.setContextLimit(1_000_000)
  check('setContextLimit persists', repo.getSettings().contextLimit === 1_000_000)
  repo.setContextLimit(null)
  check('setContextLimit clears', repo.getSettings().contextLimit === null)
  check('web search key default null', repo.getSettings().webSearchApiKey === null)
  repo.setWebSearchApiKey('exa_test_key')
  check('setWebSearchApiKey persists', repo.getSettings().webSearchApiKey === 'exa_test_key')
  repo.setWebSearchApiKey('   ')
  check('setWebSearchApiKey blanks to null', repo.getSettings().webSearchApiKey === null)

  // ---- chats / sessions ----
  const chat = repo.createChat({ title: 'smoke', kind: 'main', workspacePath: ws })
  check('createChat (main + workspace)', chat.kind === 'main' && chat.workspacePath === ws)
  check(
    'listChats contains it',
    repo.listChats().some((c) => c.id === chat.id)
  )
  check('getChatWorkspace', repo.getChatWorkspace(chat.id) === ws)
  repo.renameChat(chat.id, 'renamed')
  check('renameChat', repo.listChats().find((c) => c.id === chat.id)?.title === 'renamed')
  // ---- session reorder within a project (v12: sort_order) ----
  const rws = path.join(ws, 'reorder-project')
  const rs1 = repo.createChat({ title: 'r1', kind: 'main', workspacePath: rws })
  const rs2 = repo.createChat({ title: 'r2', kind: 'main', workspacePath: rws })
  const rs3 = repo.createChat({ title: 'r3', kind: 'main', workspacePath: rws })
  const orderOf = (): string =>
    repo
      .listChats()
      .filter((c) => c.workspacePath === rws)
      .map((c) => c.title)
      .join()
  check(
    'all three sessions are grouped under the project',
    orderOf().split(',').sort().join() === 'r1,r2,r3'
  )
  // reorderSessions assigns distinct descending keys, so the order is exact.
  repo.reorderSessions(rws, [rs1.id, rs3.id, rs2.id])
  check('reorderSessions persists a new order', orderOf() === 'r1,r3,r2')
  repo.reorderSessions(rws, [rs2.id, rs1.id, rs3.id])
  check('reorderSessions persists another order', orderOf() === 'r2,r1,r3')
  // A partial/foreign id set is ignored (guards against clobbering).
  repo.reorderSessions(rws, [rs1.id])
  check('reorderSessions ignores an incomplete set', orderOf() === 'r2,r1,r3')

  // ---- project (workspace) order is explicit + independent of sessions (v13) ----
  // New projects register at the BOTTOM of the order, not the top.
  const pA = path.join(ws, 'proj-a')
  const pB = path.join(ws, 'proj-b')
  const pC = path.join(ws, 'proj-c')
  repo.createChat({ title: 'a1', kind: 'main', workspacePath: pA })
  repo.createChat({ title: 'b1', kind: 'main', workspacePath: pB })
  repo.createChat({ title: 'c1', kind: 'main', workspacePath: pC })
  const projOrder = (): string =>
    repo
      .listProjectOrder()
      .filter((p) => p === pA || p === pB || p === pC)
      .map((p) => p.split(/[\\/]/).pop())
      .join()
  check(
    'new projects append at the bottom in creation order',
    projOrder() === 'proj-a,proj-b,proj-c'
  )
  // Creating another session in the FIRST project must not float it to the top.
  repo.createChat({ title: 'a2', kind: 'main', workspacePath: pA })
  check('a new session does not reorder its project', projOrder() === 'proj-a,proj-b,proj-c')
  // Reordering a project session order must not touch the project order either.
  const paIds = repo
    .listChats()
    .filter((c) => c.workspacePath === pA)
    .map((c) => c.id)
  repo.reorderSessions(pA, [paIds[1], paIds[0]])
  check('reordering sessions does not reorder projects', projOrder() === 'proj-a,proj-b,proj-c')
  // Explicit reorder: move C to the front.
  repo.reorderProjects([pC, pA, pB])
  check('reorderProjects persists a new order', projOrder() === 'proj-c,proj-a,proj-b')
  // Deleting a project last session/loop forgets the project (drops its slot).
  repo
    .listChats()
    .filter((c) => c.workspacePath === pB)
    .forEach((c) => repo.removeChat(c.id))
  check('an emptied project is dropped from the order', !repo.listProjectOrder().includes(pB))
  // Re-opening that folder later appends it at the bottom again (fresh slot).
  repo.createChat({ title: 'b2', kind: 'main', workspacePath: pB })
  check('a re-opened project appends at the bottom', projOrder() === 'proj-c,proj-a,proj-b')
  ;[pA, pB, pC].forEach((p) =>
    repo
      .listChats()
      .filter((c) => c.workspacePath === p)
      .forEach((c) => repo.removeChat(c.id))
  )
  check(
    'all test projects cleaned up',
    repo.listProjectOrder().every((p) => p !== pA && p !== pB && p !== pC)
  )

  repo.removeChat(rs1.id)
  repo.removeChat(rs2.id)
  repo.removeChat(rs3.id)

  // ---- subagent sessions link to + cascade-delete with their parent (v9) ----
  const sub = repo.createChat({
    title: 'explore: find x',
    kind: 'sub',
    workspacePath: ws,
    parentId: chat.id
  })
  check('createChat (sub + parentId)', sub.kind === 'sub' && sub.parentId === chat.id)
  check(
    'listSubchats returns the sub',
    repo.listSubchats(chat.id).some((c) => c.id === sub.id)
  )
  const tmpParent = repo.createChat({ title: 'tmp', kind: 'main', workspacePath: ws })
  const tmpSub = repo.createChat({ title: 'sub', kind: 'sub', parentId: tmpParent.id })
  repo.removeChat(tmpParent.id)
  check(
    'removeChat cascades to subagent sessions',
    !repo.listChats().some((c) => c.id === tmpParent.id || c.id === tmpSub.id)
  )
  // prune drops a finished (queue-less) subagent session, but keeps a queued one
  const busySub = repo.createChat({ title: 'busy sub', kind: 'sub', parentId: chat.id })
  repo.enqueue(busySub.id, 'follow-up')
  repo.pruneSubchats(chat.id)
  check(
    'pruneSubchats drops a queue-less sub',
    !repo.listSubchats(chat.id).some((c) => c.id === sub.id)
  )
  check(
    'pruneSubchats keeps a queued sub',
    repo.listSubchats(chat.id).some((c) => c.id === busySub.id)
  )

  // ---- messages + ordered parts round-trip (v6) ----
  repo.addMessage({ chatId: chat.id, role: 'user', content: 'hi' })
  const parts: MessagePart[] = [
    { type: 'reasoning', text: 'thinking' },
    { type: 'tool', tool: 'bash', state: 'done', title: 'ls', output: 'a\nb' },
    { type: 'text', text: 'done' }
  ]
  repo.addMessage({ chatId: chat.id, role: 'assistant', content: 'done', parts })
  const msgs = repo.listMessages(chat.id)
  check('messages persisted in order', msgs.length === 2 && msgs[0].role === 'user')
  check(
    'assistant parts round-trip (reasoning→tool→text)',
    msgs[1].parts.length === 3 &&
      msgs[1].parts[0].type === 'reasoning' &&
      msgs[1].parts[1].type === 'tool' &&
      msgs[1].parts[2].type === 'text'
  )
  const userPart = msgs[0].parts[0]
  check(
    'legacy/no-parts row falls back to single text part',
    msgs[0].parts.length === 1 && userPart.type === 'text' && userPart.text === 'hi'
  )

  // ---- queue (FIFO) ----
  const q1 = repo.enqueue(chat.id, 'q1')
  const q2 = repo.enqueue(chat.id, 'q2')
  check(
    'queue FIFO order',
    repo
      .listQueue(chat.id)
      .map((x) => x.content)
      .join() === 'q1,q2'
  )
  repo.reorderQueue(chat.id, [q2.id, q1.id])
  check(
    'queue reorder',
    repo
      .listQueue(chat.id)
      .map((x) => x.content)
      .join() === 'q2,q1'
  )
  repo.removeQueueItem(q1.id)
  check(
    'queue remove',
    repo
      .listQueue(chat.id)
      .map((x) => x.content)
      .join() === 'q2'
  )
  const qImg = repo.enqueue(chat.id, 'with image', [
    { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png', name: 'a.png' }
  ])
  check(
    'queue stores images',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.images?.length === 1
  )
  // Editing rewrites text + images in place, keeping the item's FIFO position.
  const qEditPos = repo.listQueue(chat.id).findIndex((x) => x.id === qImg.id)
  const qEdited = repo.updateQueueItem(qImg.id, 'edited text', [
    { dataUrl: 'data:image/png;base64,AAAA', mediaType: 'image/png', name: 'b.png' },
    { dataUrl: 'data:image/png;base64,BBBB', mediaType: 'image/png', name: 'c.png' }
  ])
  check('queue edit returns updated item', qEdited?.content === 'edited text')
  check(
    'queue edit persists text',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.content === 'edited text'
  )
  check(
    'queue edit updates images',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.images?.length === 2
  )
  check(
    'queue edit preserves position',
    repo.listQueue(chat.id).findIndex((x) => x.id === qImg.id) === qEditPos
  )
  // Clearing images on edit drops them entirely (no empty array left behind).
  repo.updateQueueItem(qImg.id, 'text only', [])
  check(
    'queue edit can clear images',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.images === undefined
  )
  check('queue edit unknown id is a no-op', repo.updateQueueItem('missing-id', 'x') === undefined)
  repo.removeQueueItem(qImg.id)

  // ---- usage / cost recording + rollup ----
  check('usage empty before any record', repo.hasAnyUsage() === false)
  const nowU = Date.now()
  const rec1 = repo.recordUsage({
    chatId: chat.id,
    providerId: 'openai',
    model: 'gpt-x',
    usage: {
      input: 1000,
      output: 500,
      cacheRead: 100,
      cacheWrite: 0,
      reasoning: 20,
      estimated: false
    },
    cost: 0.03
  })
  check('usage record returns id + fields', !!rec1.id && rec1.input === 1000 && rec1.cost === 0.03)
  check('usage record persists estimated flag', rec1.estimated === false)
  repo.recordUsage({
    chatId: chat.id,
    providerId: 'anthropic',
    model: 'claude-y',
    usage: {
      input: 3000,
      output: 1500,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      estimated: true
    },
    cost: 0.09
  })
  check('usage hasAnyUsage after record', repo.hasAnyUsage() === true)
  const since = nowU - 60_000
  const listed = repo.listUsageSince(since)
  check('usage listUsageSince returns both rows', listed.length === 2)
  check('usage listUsageSince newest-first', listed[0].createdAt >= listed[1].createdAt)
  check(
    'usage rounds fractional tokens',
    repo.recordUsage({
      chatId: null,
      providerId: 'openai',
      model: 'gpt-x',
      usage: {
        input: 10.7,
        output: 0.2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        estimated: false
      },
      cost: 0
    }).input === 11
  )
  // Service rollup (prices already baked into rows).
  const uStats = getUsageStats()
  check('usage stats overview has spend', uStats.overview.last30d.cost > 0.11)
  check('usage stats has provider tabs', uStats.providers.length >= 2)
  check('usage stats daily is 30 long', uStats.overview.daily.length === 30)
  // Deleting a chat keeps its usage rows (chat_id SET NULL, not cascade).
  const before = repo.listUsageSince(since).length
  const throwaway = repo.createChat({ title: 'x', kind: 'main' })
  repo.recordUsage({
    chatId: throwaway.id,
    providerId: 'openai',
    model: 'gpt-x',
    usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false },
    cost: 0.001
  })
  repo.removeChat(throwaway.id)
  check('usage survives chat deletion', repo.listUsageSince(since).length === before + 1)

  // ---- compaction summary ----
  check('chat summary null by default', repo.getChat(chat.id)?.contextSummary === null)
  const compacted = repo.setChatSummary(chat.id, 'compact summary', 123)
  check(
    'setChatSummary persists',
    compacted.contextSummary === 'compact summary' && compacted.contextSummaryAt === 123
  )
  check('getChat reflects summary', repo.getChat(chat.id)?.contextSummary === 'compact summary')

  // ---- loops ----
  const loop = repo.createLoop({ name: 'PR watcher', prompt: 'check the PR', intervalMinutes: 5 })
  check('createLoop (enabled, owns loop-kind chat)', loop.enabled === true)
  check(
    'loop chat is kind=loop',
    repo.listChats().some((c) => c.id === loop.chatId && c.kind === 'loop')
  )
  check(
    'dueLoops includes enabled loop',
    repo.dueLoops(Date.now() + 1000).some((l) => l.id === loop.id)
  )
  repo.appendLoopRun(loop.id, 'scheduled prompt', 'heartbeat reply')
  check('appendLoopRun posts into loop chat', repo.listMessages(loop.chatId).length === 2)
  const projLoop = repo.createLoop({
    name: 'P',
    prompt: 'go',
    intervalMinutes: 3,
    workspacePath: ws
  })
  check('createLoop scopes to a project workspace', repo.getChatWorkspace(projLoop.chatId) === ws)
  const dueBefore = repo.dueLoops(Date.now() + 1000).some((l) => l.id === projLoop.id)
  repo.markLoopRan(projLoop.id)
  const dueAfter = repo.dueLoops(Date.now() + 1000).some((l) => l.id === projLoop.id)
  check('markLoopRan advances the schedule', dueBefore === true && dueAfter === false)

  // ---- sessions status excludes loop chats ----
  const status = repo.listSessionsStatus()
  check(
    'listSessionsStatus includes the main session',
    status.some((s) => s.id === chat.id)
  )
  check('listSessionsStatus excludes loop chats', !status.some((s) => s.id === loop.chatId))
  check('checkSession reports message count', repo.checkSession(chat.id)?.messageCount === 2)

  // ---- harness file/bash tools (real fs, sandboxed to ws) ----
  const wrote = await run('write', { path: 'hello.txt', content: 'world' })
  check('write tool', wrote.ok)
  check('write tool diff (new file)', wrote.diff?.before === '' && wrote.diff?.after === 'world')
  const read = await run('read', { path: 'hello.txt' })
  check('read tool', read.ok && read.output === 'world', read.output)
  const edited = await run('edit', { path: 'hello.txt', oldString: 'world', newString: 'WORLD' })
  check('edit tool', edited.ok)
  check(
    'edit tool diff (before/after)',
    edited.diff?.before === 'world' && edited.diff?.after === 'WORLD'
  )
  check('edit applied', (await run('read', { path: 'hello.txt' })).output === 'WORLD')
  // Image files render inline (data URL) instead of dumping raw bytes as text.
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  await fs.writeFile(path.join(ws, 'pixel.png'), Buffer.from(png1x1, 'base64'))
  const img = await run('read', { path: 'pixel.png' })
  check(
    'read image returns inline image',
    img.ok &&
      (img.image ?? '').startsWith('data:image/png;base64,') &&
      img.output.startsWith('Read image'),
    img.output
  )
  const list = await run('list', { path: '.' })
  check('list tool', list.ok && list.output.includes('hello.txt'))
  const globr = await run('glob', { pattern: '*.txt' })
  check('glob tool', globr.ok && globr.output.includes('hello.txt'))
  const grepr = await run('grep', { pattern: 'WORLD', include: '*.txt' })
  check('grep tool', grepr.ok && grepr.output.includes('hello.txt'))

  // ---- webfetch (offline-safe reject paths; no network needed) ----
  const badScheme = await run('webfetch', { url: 'file:///etc/passwd' })
  check(
    'webfetch rejects non-http scheme',
    !badScheme.ok && badScheme.output.includes('scheme'),
    badScheme.output
  )
  const badUrl = await run('webfetch', { url: 'not a url' })
  check(
    'webfetch rejects a malformed url',
    !badUrl.ok && badUrl.output.toLowerCase().includes('valid'),
    badUrl.output
  )
  const emptyQuery = await run('websearch', { query: '' })
  check(
    'websearch rejects an empty query',
    !emptyQuery.ok && emptyQuery.output.includes('missing'),
    emptyQuery.output
  )

  // ---- disk-backed tool-output store (Phase 9.3) ----
  const smallBound = await boundToolOutput('sess-1', 'call-small', 'a short result')
  check('boundToolOutput passes small output through untouched', smallBound === 'a short result')
  // >2000 lines trips the line bound while staying well under read's 100k char cap.
  const bigText = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n')
  const bigBound = await boundToolOutput('sess-1', 'call-big', bigText)
  check(
    'boundToolOutput previews oversized output',
    bigBound.length < bigText.length && bigBound.includes('truncated')
  )
  const ptrMatch = bigBound.match(/saved to (\S+\.txt)/)
  const ptr = ptrMatch?.[1] ?? ''
  check(
    'boundToolOutput returns a file pointer',
    ptr.length > 0 && isManagedToolOutputPath(ptr),
    ptr
  )
  check('spilled file lives under the managed root', ptr.startsWith(toolOutputRoot()))
  const full = await fs.readFile(ptr, 'utf8')
  check('spilled file holds the full output', full === bigText)
  // The model can read the pointer back via the read tool (managed dir is allowed).
  const readBack = await run('read', { path: ptr })
  check(
    'read tool can reach the spilled pointer',
    readBack.ok && readBack.output.includes('line 2499'),
    readBack.output
  )
  // A path outside both the workspace and the managed dir is still rejected.
  const escaped = await run('read', { path: path.join(tmp, 'outside.txt') })
  check('read still rejects non-managed absolute paths', !escaped.ok, escaped.output)
  await cleanupToolOutputs()
  check(
    'cleanupToolOutputs keeps fresh spills',
    await fs
      .readFile(ptr, 'utf8')
      .then(() => true)
      .catch(() => false)
  )

  const bashCmd = process.platform === 'win32' ? 'Write-Output roxy-bash-ok' : 'echo roxy-bash-ok'
  const bashr = await run('bash', { command: bashCmd })
  check(
    'bash tool runs in workspace',
    bashr.ok && bashr.output.includes('roxy-bash-ok'),
    bashr.output
  )

  // ---- background bash (long-running processes: dev servers / watchers) ----
  const bgCmd =
    process.platform === 'win32'
      ? 'Write-Output roxy-bg-ok; Start-Sleep -Seconds 5'
      : 'echo roxy-bg-ok; sleep 5'
  const started = await run('bash', { command: bgCmd, background: true })
  const bgId = started.output.match(/bg_\d+/)?.[0] ?? ''
  check('bash background starts and returns an id', started.ok && bgId !== '', started.output)
  await new Promise((r) => setTimeout(r, 1500))
  const bgList = await run('bash_list', {})
  check(
    'bash_list shows the running process',
    bgList.ok && bgList.output.includes(bgId) && bgList.output.includes('running'),
    bgList.output
  )
  const bgOut = await run('bash_output', { id: bgId })
  check(
    'bash_output reads new output',
    bgOut.ok && bgOut.output.includes('roxy-bg-ok'),
    bgOut.output
  )
  const bgKill = await run('bash_kill', { id: bgId })
  check('bash_kill stops the process', bgKill.ok, bgKill.output)
  check('bash_output rejects an unknown id', !(await run('bash_output', { id: 'bg_nope' })).ok)

  // ---- background procs are owned per SESSION, not per cwd ----
  // Two sessions open on the SAME folder must not see or kill each other's dev
  // servers, and a subagent's processes must be owned by its parent session.
  {
    const sessA = repo.createChat({ title: 'bg A', kind: 'main', workspacePath: ws })
    const sessB = repo.createChat({ title: 'bg B', kind: 'main', workspacePath: ws })
    const subOfA = repo.createChat({ title: 'sub of A', kind: 'sub', parentId: sessA.id })
    check(
      'rootSessionId: a main session is its own root',
      repo.rootSessionId(sessA.id) === sessA.id
    )
    check('rootSessionId: a sub resolves to its parent', repo.rootSessionId(subOfA.id) === sessA.id)
    check('rootSessionId: an unknown id is returned as-is', repo.rootSessionId('nope') === 'nope')

    const inSession = (
      sessionId: string,
      name: string,
      input: Record<string, unknown>
    ): ReturnType<typeof runTool> => runTool(name, input, { cwd: ws, sessionId })

    const aStart = await inSession(sessA.id, 'bash', { command: bgCmd, background: true })
    const aId = aStart.output.match(/bg_\d+/)?.[0] ?? ''
    check('session A starts a background process', aStart.ok && aId !== '', aStart.output)

    // Same cwd, different session — the old cwd-keyed code leaked here.
    const bList = await inSession(sessB.id, 'bash_list', {})
    check(
      "session B cannot SEE session A's process (same folder)",
      bList.ok && !bList.output.includes(aId),
      bList.output
    )
    const bKill = await inSession(sessB.id, 'bash_kill', { id: aId })
    check("session B cannot KILL session A's process", !bKill.ok, bKill.output)
    const bOut = await inSession(sessB.id, 'bash_output', { id: aId })
    check("session B cannot READ session A's process output", !bOut.ok, bOut.output)

    const aList = await inSession(sessA.id, 'bash_list', {})
    check(
      'session A still sees its own process',
      aList.ok && aList.output.includes(aId),
      aList.output
    )

    // A subagent's process is registered under the PARENT, so the parent's
    // bash_list sees it (and deleting the parent will stop it).
    const subStart = await inSession(subOfA.id, 'bash', { command: bgCmd, background: true })
    const subId = subStart.output.match(/bg_\d+/)?.[0] ?? ''
    check('a subagent can start a background process', subStart.ok && subId !== '', subStart.output)
    const aList2 = await inSession(sessA.id, 'bash_list', {})
    check(
      "a subagent's process shows up in its PARENT's bash_list",
      aList2.ok && aList2.output.includes(subId),
      aList2.output
    )
    const bList2 = await inSession(sessB.id, 'bash_list', {})
    check(
      "an unrelated session still can't see the subagent's process",
      bList2.ok && !bList2.output.includes(subId),
      bList2.output
    )

    // Deleting a session stops its processes (previously they lived until quit).
    const killedCount = killSessionBackground(sessA.id)
    check('killSessionBackground kills the session + subagent processes', killedCount === 2)
    const aList3 = await inSession(sessA.id, 'bash_list', {})
    check(
      'the registry is emptied for that session after the kill',
      aList3.ok && !aList3.output.includes(aId) && !aList3.output.includes(subId),
      aList3.output
    )
    check(
      'killSessionBackground on an unknown session is a no-op',
      killSessionBackground('nope') === 0
    )
    check('killSessionBackground ignores an empty id', killSessionBackground('') === 0)

    repo.removeChat(sessA.id)
    repo.removeChat(sessB.id)
  }

  // ---- migration repair (two branches, two different "v14"s) ----
  // The schema version is an ARRAY POSITION, so when the usage-dashboard branch
  // and the worktree branch each shipped a migration numbered v14, a database
  // that applied one advanced past the other and would never run it. Both
  // directions leave a DB that looks fully migrated with a schema object missing.
  // The reconcile step must repair either, be idempotent, and lose no data.
  {
    /** Open a database the way database.ts does: migrate, then repair. */
    const runLadder = (db: InstanceType<typeof Database>): void => {
      for (
        let v = db.pragma('user_version', { simple: true }) as number;
        v < MIGRATIONS.length;
        v++
      ) {
        const step = MIGRATIONS[v]
        if (typeof step === 'string') db.exec(step)
        else step(db)
        db.pragma(`user_version = ${v + 1}`)
      }
      // Unconditional: the version counter alone can't tell us the schema is
      // actually complete.
      repairSchema(db)
    }
    const colsOf = (db: InstanceType<typeof Database>): string[] =>
      (db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map((c) => c.name)
    const tablesOf = (db: InstanceType<typeof Database>): string[] =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((t) => t.name)
    /** Apply the first `upTo` migrations, then seed a session. */
    const seeded = async (name: string, upTo: number): Promise<InstanceType<typeof Database>> => {
      const dir = path.join(tmp, name)
      await fs.mkdir(dir, { recursive: true })
      const db = new Database(path.join(dir, 'roxy.db'))
      for (let i = 0; i < upTo; i++) {
        const step = MIGRATIONS[i]
        if (typeof step === 'string') db.exec(step)
        else step(db)
      }
      db.pragma(`user_version = ${upTo}`)
      db.prepare(
        `INSERT INTO chats(id, title, kind, workspace_path, created_at, updated_at, sort_order)
         VALUES('mig1','pre-existing','main','/proj',1,1,1)`
      ).run()
      return db
    }

    // Direction 1: took the usage v14, so the worktree columns were skipped.
    // This is the state from the bug report ("no such column: worktree_path").
    {
      const db = await seeded('mig-usage-first', 14)
      db.exec('ALTER TABLE chats ADD COLUMN worktree_pending TEXT')
      db.pragma('user_version = 15')
      check('migration repro: worktree columns are missing', !colsOf(db).includes('worktree_path'))
      let reported = ''
      try {
        db.prepare('UPDATE chats SET worktree_path = ? WHERE id = ?').run('/wt', 'mig1')
      } catch (e) {
        reported = e instanceof Error ? e.message : String(e)
      }
      check(
        'migration repro: reproduces the reported error',
        /no such column: worktree_path/.test(reported),
        reported
      )

      runLadder(db)
      for (const col of ['worktree_path', 'branch', 'dev_port', 'worktree_pending']) {
        check(`migration repair (usage-first): adds ${col}`, colsOf(db).includes(col))
      }
      db.prepare('UPDATE chats SET worktree_path = ? WHERE id = ?').run('/wt', 'mig1')
      const row = db.prepare('SELECT * FROM chats WHERE id = ?').get('mig1') as {
        title: string
        worktree_path: string | null
      }
      check(
        'migration repair (usage-first): the failing write now succeeds',
        row.worktree_path === '/wt'
      )
      check('migration repair (usage-first): existing rows survive', row.title === 'pre-existing')
      check('migration repair (usage-first): usage table intact', tablesOf(db).includes('usage'))

      // Idempotent — it runs on every open, including healthy databases.
      repairSchema(db)
      repairSchema(db)
      check(
        'migration repair: re-running changes nothing',
        (
          db.prepare('SELECT worktree_path AS w FROM chats WHERE id = ?').get('mig1') as {
            w: string
          }
        ).w === '/wt'
      )
      check(
        'migration repair: no duplicate columns',
        colsOf(db).filter((c) => c === 'worktree_path').length === 1
      )
      db.close()
    }

    // Direction 2: took the WORKTREE v14 (the pre-merge build), so the usage
    // table was skipped — the cost dashboard would crash instead.
    {
      const db = await seeded('mig-worktree-first', 13)
      db.exec(`ALTER TABLE chats ADD COLUMN worktree_path TEXT;
               ALTER TABLE chats ADD COLUMN branch TEXT;
               ALTER TABLE chats ADD COLUMN dev_port INTEGER;`)
      db.pragma('user_version = 14')
      db.exec('ALTER TABLE chats ADD COLUMN worktree_pending TEXT')
      db.pragma('user_version = 15')
      check('migration repro: the usage table is missing', !tablesOf(db).includes('usage'))

      runLadder(db)
      check(
        'migration repair (worktree-first): creates the usage table',
        tablesOf(db).includes('usage')
      )
      check(
        'migration repair (worktree-first): keeps the worktree columns',
        colsOf(db).includes('worktree_path')
      )
      check(
        'migration repair (worktree-first): existing rows survive',
        (db.prepare('SELECT title FROM chats WHERE id = ?').get('mig1') as { title: string })
          .title === 'pre-existing'
      )
      // The usage table must be the REAL one, not a stub.
      const usageCols = (db.prepare('PRAGMA table_info(usage)').all() as { name: string }[]).map(
        (c) => c.name
      )
      for (const col of ['provider_id', 'model', 'cost', 'estimated']) {
        check(`migration repair (worktree-first): usage.${col} exists`, usageCols.includes(col))
      }
      db.close()
    }
  }

  // ---- schema self-heal ----
  // `user_version` counts the steps that RAN, not what the database contains.
  // When the counter runs ahead of reality — two branches numbering a migration
  // the same, a partial upgrade, a restored backup — the ladder has "nothing to
  // do" while a table or column is missing, and it only surfaces much later as a
  // runtime crash ("no such table: projects"). repairSchema runs unconditionally
  // on every open to close that hole.
  {
    const healDir = path.join(tmp, 'heal')
    await fs.mkdir(healDir, { recursive: true })
    let n = 0
    /** A fully migrated DB with one session, as a healthy install would look. */
    const healthy = (): InstanceType<typeof Database> => {
      const db = new Database(path.join(healDir, `h${++n}.db`))
      for (const step of MIGRATIONS) {
        if (typeof step === 'string') db.exec(step)
        else step(db)
      }
      db.pragma(`user_version = ${MIGRATIONS.length}`)
      repairSchema(db)
      db.prepare(
        `INSERT INTO chats(id, title, kind, workspace_path, created_at, updated_at, sort_order)
         VALUES('h1','seeded','main','/proj',1,1,1)`
      ).run()
      return db
    }
    const tablesOf = (db: InstanceType<typeof Database>): string[] =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((t) => t.name)

    // Every table the app depends on must come back, not just the ones a
    // previously-reported bug happened to name.
    for (const table of ['projects', 'usage', 'queue', 'mcp_servers', 'settings']) {
      const db = healthy()
      db.exec(`DROP TABLE ${table}`)
      check(`self-heal: ${table} is missing before repair`, !tablesOf(db).includes(table))
      repairSchema(db)
      check(`self-heal: ${table} is restored`, tablesOf(db).includes(table))
      check(
        `self-heal: data survives the ${table} repair`,
        (db.prepare('SELECT title AS t FROM chats WHERE id = ?').get('h1') as { t: string }).t ===
          'seeded'
      )
      db.close()
    }

    // The reported crash, end to end.
    {
      const db = healthy()
      db.exec('DROP TABLE projects')
      let before = ''
      try {
        db.prepare('SELECT path FROM projects ORDER BY sort_order ASC').all()
      } catch (e) {
        before = e instanceof Error ? e.message : String(e)
      }
      check(
        'self-heal: reproduces "no such table: projects"',
        /no such table: projects/.test(before),
        before
      )
      repairSchema(db)
      let after = ''
      try {
        db.prepare('SELECT path FROM projects ORDER BY sort_order ASC').all()
      } catch (e) {
        after = e instanceof Error ? e.message : String(e)
      }
      check('self-heal: projects:listOrder works again', after === '', after)
      // projects is derived state, so it can be rebuilt from the sessions.
      check(
        'self-heal: projects is re-seeded from existing sessions',
        (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n === 1
      )
      db.close()
    }

    // A hand-ordered project list must never be clobbered by that re-seed.
    {
      const db = healthy()
      db.prepare('INSERT INTO projects(path, sort_order, created_at) VALUES(?,?,?)').run(
        '/proj',
        7,
        1
      )
      repairSchema(db)
      check(
        'self-heal: an existing project order is preserved',
        (
          db.prepare('SELECT sort_order AS s FROM projects WHERE path = ?').get('/proj') as {
            s: number
          }
        ).s === 7
      )
      db.close()
    }

    // Idempotent: it runs on every open, so it must cost nothing when healthy.
    {
      const db = healthy()
      const before = tablesOf(db).length
      repairSchema(db)
      repairSchema(db)
      check('self-heal: repeating it on a healthy DB is a no-op', tablesOf(db).length === before)
      check(
        'self-heal: no duplicate columns after repeats',
        (db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).filter(
          (c) => c.name === 'worktree_path'
        ).length === 1
      )
      db.close()
    }
  }

  // ---- sessionCwd (the one working-directory resolver) ----
  {
    check('sessionCwd: an unknown chat resolves to empty', sessionCwd('nope') === '')
    check('sessionCwd: an empty id resolves to empty', sessionCwd('') === '')

    const plain = repo.createChat({ title: 'cwd plain', kind: 'main', workspacePath: ws })
    check('sessionCwd: no worktree -> the project folder', sessionCwd(plain.id) === ws)

    const noWs = repo.createChat({ title: 'cwd no workspace', kind: 'main' })
    check('sessionCwd: no workspace -> empty', sessionCwd(noWs.id) === '')

    // New columns default to NULL, so nothing changes for existing sessions.
    const fresh = repo.getChat(plain.id)
    check(
      'migration v14: worktree columns default to null',
      fresh?.worktreePath === null && fresh?.branch === null && fresh?.devPort === null
    )

    // A worktree redirects the session; the project IS the repo root here, so
    // the cwd is the worktree itself.
    const wtDir = path.join(tmp, 'wt-fix-auth')
    await fs.mkdir(wtDir, { recursive: true })
    repo.setChatWorktree(plain.id, {
      worktreePath: wtDir,
      branch: 'roxy/a1b2c3d4',
      devPort: 3101
    })
    const wired = repo.getChat(plain.id)
    check(
      'setChatWorktree persists path/branch/port',
      wired?.worktreePath === wtDir && wired?.branch === 'roxy/a1b2c3d4' && wired?.devPort === 3101
    )
    // `ws` has no .git, so findGitRoot finds nothing and we stay put — this is
    // the deliberate "can't trust the mapping" fallback.
    check(
      'sessionCwd: a worktree without a repo root falls back to the project folder',
      sessionCwd(plain.id) === ws
    )

    // With a real repo root, the sub-path is preserved.
    const repoRoot = path.join(tmp, 'repo-with-git')
    const pkgDir = path.join(repoRoot, 'apps', 'web')
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
    const subFolder = repo.createChat({
      title: 'cwd subfolder',
      kind: 'main',
      workspacePath: pkgDir
    })
    repo.setChatWorktree(subFolder.id, { worktreePath: wtDir, branch: 'roxy/deadbeef' })
    check(
      'sessionCwd: a project inside a repo keeps its subpath in the worktree',
      sessionCwd(subFolder.id) === path.join(wtDir, 'apps', 'web')
    )

    // Subagents always run in their parent's tree, never their own.
    const kid = repo.createChat({ title: 'cwd sub', kind: 'sub', parentId: subFolder.id })
    check(
      'sessionCwd: a sub-session resolves through its parent',
      sessionCwd(kid.id) === path.join(wtDir, 'apps', 'web')
    )
    const grandkid = repo.createChat({ title: 'cwd sub2', kind: 'sub', parentId: kid.id })
    check(
      'sessionCwd: a nested sub-session still resolves to the root worktree',
      sessionCwd(grandkid.id) === path.join(wtDir, 'apps', 'web')
    )

    // Clearing the worktree returns the session to the project folder.
    repo.setChatWorktree(subFolder.id, { worktreePath: null })
    check(
      'sessionCwd: clearing the worktree restores the project folder',
      sessionCwd(subFolder.id) === pkgDir
    )

    repo.removeChat(plain.id)
    repo.removeChat(noWs.id)
    repo.removeChat(subFolder.id)
  }

  // ---- git service + real worktrees ----
  // Builds an actual repo on disk and drives the real `git` binary. Skipped
  // wholesale when git isn't installed, so the suite still runs on a bare box.
  {
    const gitOk = await git.isGitAvailable()
    if (!gitOk) {
      console.log('  (skipping git/worktree checks — no git binary)')
    } else {
      const gitRepo = path.join(tmp, 'gitrepo')
      await fs.mkdir(gitRepo, { recursive: true })
      const runGit = (args: string[], cwd = gitRepo): Promise<number> =>
        new Promise((resolve) => {
          const c = spawn('git', args, { cwd, shell: false, windowsHide: true })
          c.on('close', (code) => resolve(code ?? 1))
          c.on('error', () => resolve(1))
        })
      await runGit(['init', '--initial-branch=main'])
      await runGit(['config', 'user.email', 'smoke@roxy.test'])
      await runGit(['config', 'user.name', 'Roxy Smoke'])
      await runGit(['config', 'commit.gpgsign', 'false'])
      await fs.writeFile(path.join(gitRepo, 'README.md'), '# smoke\n')
      await runGit(['add', '.'])
      await runGit(['commit', '-m', 'initial'])

      // ---- queries ----
      const root = await git.repoRoot(gitRepo)
      check('git.repoRoot finds the repo', !!root, String(root))
      check('git.repoRoot is null outside a repo', (await git.repoRoot(tmp)) === null)
      check('git.currentBranch reads the branch', (await git.currentBranch(gitRepo)) === 'main')
      check(
        'git.defaultBranch falls back to local main',
        (await git.defaultBranch(gitRepo)) === 'main'
      )
      const branches = await git.listBranches(gitRepo)
      check('git.listBranches includes main', branches.includes('main'), branches.join(','))

      const st = await git.status(gitRepo)
      check('git.status: a fresh checkout is clean', st?.dirty === false, JSON.stringify(st))
      await fs.writeFile(path.join(gitRepo, 'dirty.txt'), 'x')
      const st2 = await git.status(gitRepo)
      check('git.status: an untracked file is dirty', st2?.dirty === true && st2.changed === 1)
      await fs.rm(path.join(gitRepo, 'dirty.txt'))

      // The main working tree is always listed, and flagged as main.
      const wt0 = await git.listWorktrees(root!)
      check('git.listWorktrees lists the main tree', wt0.length === 1 && wt0[0].isMain === true)

      // ---- branch naming ----
      const tmpBranch = git.temporaryBranchName()
      check(
        'temporaryBranchName looks like roxy/<8 hex>',
        /^roxy\/[0-9a-f]{8}$/.test(tmpBranch),
        tmpBranch
      )
      check('isTemporaryBranch accepts a generated name', git.isTemporaryBranch(tmpBranch))
      check('isTemporaryBranch rejects a user branch', !git.isTemporaryBranch('fix-auth'))
      check(
        'isTemporaryBranch rejects a roxy-prefixed real name',
        !git.isTemporaryBranch('roxy/fix-auth')
      )
      check('isTemporaryBranch rejects null', !git.isTemporaryBranch(null))

      // ---- create ----
      const created = await git.createWorktree({ repoRoot: root!, branch: tmpBranch })
      check('createWorktree succeeds', created.ok && !!created.worktree, created.error ?? '')
      const wtPath = created.worktree!.path
      check('the worktree directory exists', existsSync(wtPath))
      check(
        'the worktree lives OUTSIDE the repo',
        !path.normalize(wtPath).startsWith(path.normalize(gitRepo)),
        wtPath
      )
      check('the worktree has the repo content', existsSync(path.join(wtPath, 'README.md')))
      check(
        'createWorktree records the PR base in git config',
        (await git.baseBranchFor(gitRepo, tmpBranch)) === 'main'
      )
      const wt1 = await git.listWorktrees(root!)
      check('listWorktrees now sees two trees', wt1.length === 2, String(wt1.length))
      check(
        'the new worktree is not flagged main',
        wt1.some((w) => w.path === wtPath && !w.isMain)
      )

      // Asking for the same branch again ATTACHES rather than failing — git
      // refuses to check one branch out twice.
      const again = await git.createWorktree({ repoRoot: root!, branch: tmpBranch })
      check(
        'createWorktree on a checked-out branch attaches instead of failing',
        again.ok && again.attached === true && again.worktree?.path === wtPath,
        again.error ?? ''
      )

      // ---- sessionCwd resolves into the worktree ----
      const wtChat = repo.createChat({
        title: 'worktree session',
        kind: 'main',
        workspacePath: gitRepo
      })
      repo.setChatWorktree(wtChat.id, { worktreePath: wtPath, branch: tmpBranch })
      check(
        'sessionCwd resolves into the worktree',
        sessionCwd(wtChat.id) === wtPath,
        sessionCwd(wtChat.id)
      )

      // A tool run in that session must actually land in the worktree.
      const wrote = await runTool(
        'write',
        { path: 'from-agent.txt', content: 'hi' },
        {
          cwd: sessionCwd(wtChat.id),
          sessionId: wtChat.id
        }
      )
      check(
        'a tool writes inside the worktree',
        wrote.ok && existsSync(path.join(wtPath, 'from-agent.txt'))
      )
      check('...and NOT in the main checkout', !existsSync(path.join(gitRepo, 'from-agent.txt')))

      // ---- lazy materialization ----
      const lazy = repo.createChat({
        title: 'lazy worktree',
        kind: 'main',
        workspacePath: gitRepo,
        worktree: { mode: 'new' }
      })
      check(
        'a pending worktree intent is persisted',
        repo.getChat(lazy.id)?.worktreePending?.mode === 'new'
      )
      check('...and no worktree exists yet', repo.getChat(lazy.id)?.worktreePath === null)
      const mat = await materializePendingWorktree(lazy.id)
      check(
        'materialize creates the worktree on first turn',
        mat.ok && !!mat.worktreePath,
        mat.error ?? ''
      )
      check('the intent is cleared afterwards', repo.getChat(lazy.id)?.worktreePending === null)
      check(
        'the session now points at its worktree',
        repo.getChat(lazy.id)?.worktreePath === mat.worktreePath
      )
      // Second call: the intent is gone, so it reports "nothing to do" and must
      // leave the existing worktree alone rather than making another.
      const wtCountBefore = (await git.listWorktrees(root!)).length
      const redo = await materializePendingWorktree(lazy.id)
      check('materialize does nothing on a second call', redo.ok === false)
      check(
        '...and the session keeps its worktree',
        repo.getChat(lazy.id)?.worktreePath === mat.worktreePath
      )
      check(
        '...and no extra worktree was created',
        (await git.listWorktrees(root!)).length === wtCountBefore
      )

      // Materializing a worktree also reserves a dev port for the session.
      check(
        'a materialized worktree gets a dev port',
        typeof repo.getChat(lazy.id)?.devPort === 'number',
        String(repo.getChat(lazy.id)?.devPort)
      )

      // The setup script runs in the NEW worktree, through the background path,
      // so it is owned by the session and visible in bash_list.
      {
        await fs.mkdir(path.join(gitRepo, '.roxy'), { recursive: true })
        const marker = 'roxy-setup-ran.txt'
        const setupCmd =
          process.platform === 'win32'
            ? `Set-Content -Path ${marker} -Value "$env:ROXY_PROJECT_ROOT|$env:ROXY_WORKTREE_PATH|$env:ROXY_PORT"`
            : `printf '%s' "$ROXY_PROJECT_ROOT|$ROXY_WORKTREE_PATH|$ROXY_PORT" > ${marker}`
        await fs.writeFile(
          path.join(gitRepo, '.roxy', 'worktree.json'),
          JSON.stringify({ setup: setupCmd })
        )
        const withSetup = repo.createChat({
          title: 'setup script',
          kind: 'main',
          workspacePath: gitRepo,
          worktree: { mode: 'new' }
        })
        const sm = await materializePendingWorktree(withSetup.id)
        check('worktree with a setup script materializes', sm.ok, sm.error ?? '')
        // Fire-and-forget by design (installs take minutes) — poll for the marker.
        let setupOut = ''
        for (let i = 0; i < 60 && !setupOut; i++) {
          await new Promise((r) => setTimeout(r, 100))
          try {
            setupOut = await fs.readFile(path.join(sm.worktreePath!, marker), 'utf8')
          } catch {
            /* not yet */
          }
        }
        check('the setup script ran INSIDE the new worktree', setupOut !== '', setupOut)
        const [gotRoot, gotWt, gotPort] = setupOut.trim().split('|')
        check('ROXY_PROJECT_ROOT points at the project', gotRoot === gitRepo, gotRoot)
        check('ROXY_WORKTREE_PATH points at the worktree', gotWt === sm.worktreePath, gotWt)
        check(
          'ROXY_PORT is the session port',
          gotPort === String(repo.getChat(withSetup.id)?.devPort),
          gotPort
        )
        check(
          'the setup script did NOT run in the main checkout',
          !existsSync(path.join(gitRepo, marker))
        )
        await fs.rm(path.join(gitRepo, '.roxy'), { recursive: true, force: true })
        await removeWorktreeForChat(withSetup.id, { force: true })
        repo.removeChat(withSetup.id)
      }

      // A sub-session must never take a worktree of its own.
      const subWt = repo.createChat({
        title: 'sub w/ intent',
        kind: 'sub',
        parentId: lazy.id,
        workspacePath: gitRepo,
        worktree: { mode: 'new' }
      })
      const subMat = await materializePendingWorktree(subWt.id)
      check('a sub-session never materializes its own worktree', subMat.ok === false)
      check('...and its intent is dropped', repo.getChat(subWt.id)?.worktreePending === null)

      // ---- prune ----
      const orphan = await git.createWorktree({ repoRoot: root!, branch: 'roxy/aaaaaaaa' })
      check('created an orphan worktree for prune', orphan.ok, orphan.error ?? '')
      const dry = await pruneWorktrees(gitRepo, { dryRun: true })
      check(
        'prune (dry run) finds the orphan',
        dry.ok && dry.candidates.some((c) => c.path === orphan.worktree!.path),
        JSON.stringify(dry.candidates)
      )
      check(
        'prune (dry run) does NOT list a session-owned worktree',
        !dry.candidates.some((c) => c.path === wtPath)
      )
      check(
        'prune (dry run) removes nothing',
        dry.removed.length === 0 && existsSync(orphan.worktree!.path)
      )
      const wet = await pruneWorktrees(gitRepo, { dryRun: false, force: true })
      check(
        'prune removes the orphan',
        wet.removed.includes(orphan.worktree!.path),
        JSON.stringify(wet.failed)
      )
      check('...and the directory is gone', !existsSync(orphan.worktree!.path))
      check(
        'prune never touches the main working tree',
        existsSync(path.join(gitRepo, 'README.md'))
      )

      // ---- remove ----
      const shared = repo.createChat({
        title: 'shares the worktree',
        kind: 'main',
        workspacePath: gitRepo
      })
      repo.setChatWorktree(shared.id, { worktreePath: wtPath, branch: tmpBranch })
      const blocked = await removeWorktreeForChat(wtChat.id)
      check(
        'a worktree shared with another session is NOT removed',
        blocked.ok && blocked.removed === false
      )
      check('...and it still exists', existsSync(wtPath))
      repo.removeChat(shared.id)

      // Deleting a session must NEVER discard uncommitted code. This used to
      // pass force:true, which mattered little when worktrees were opt-in and
      // rare -- now that every session gets one by default, a stray click on
      // the trash icon would silently `rm -rf` unpushed work with no
      // confirmation and nothing in the reflog to recover from.
      await fs.writeFile(path.join(wtPath, 'uncommitted.txt'), 'precious\n')
      const dirtyRemove = await removeWorktreeForChat(wtChat.id)
      check('a DIRTY worktree is not deleted on session delete', dirtyRemove.removed === false)
      check('...and it says why', !!dirtyRemove.error, dirtyRemove.error ?? '')
      check(
        '...and the uncommitted file survives',
        existsSync(path.join(wtPath, 'uncommitted.txt'))
      )
      await fs.rm(path.join(wtPath, 'uncommitted.txt'))

      // Clean it properly -> the default (non-forced) path removes it happily,
      // so the protection above is about dirt, not a blanket refusal. The
      // sandbox check earlier in this block left `from-agent.txt` behind, which
      // is exactly the kind of untracked file git refuses to discard.
      await fs.rm(path.join(wtPath, 'from-agent.txt'))
      const cleanRemove = await removeWorktreeForChat(wtChat.id)
      check(
        'a CLEAN worktree is removed without force',
        cleanRemove.ok && cleanRemove.removed,
        cleanRemove.error ?? ''
      )
      check('...and its directory is gone', !existsSync(wtPath))

      // Re-attach it so the shared/force-removal checks below still have a
      // worktree to act on. The BRANCH outlives `git worktree remove`, so this
      // is an attach, not a create (`-b` would fail on an existing branch).
      const recreated = await git.attachWorktree({
        repoRoot: root!,
        branch: tmpBranch,
        path: wtPath
      })
      check(
        're-attached the worktree for the remaining checks',
        recreated.ok,
        recreated.error ?? ''
      )
      check('...at the same path', recreated.worktree?.path === wtPath, recreated.worktree?.path)
      repo.setChatWorktree(wtChat.id, { worktreePath: wtPath, branch: tmpBranch })

      const removed = await removeWorktreeForChat(wtChat.id, { force: true })
      check(
        'removeWorktreeForChat removes an unshared worktree',
        removed.ok && removed.removed,
        removed.error ?? ''
      )
      check('the worktree directory is gone', !existsSync(wtPath))
      const wt2 = await git.listWorktrees(root!)
      check('git no longer lists the removed worktree', !wt2.some((w) => w.path === wtPath))
      check(
        'removeWorktreeForChat is a no-op without a worktree',
        (await removeWorktreeForChat(shared.id)).removed === false
      )

      repo.removeChat(wtChat.id)
      repo.removeChat(lazy.id)
    }
  }

  // ---- services (the panel's view of a session's background processes) ----
  {
    const svcA = repo.createChat({ title: 'svc A', kind: 'main', workspacePath: ws })
    const svcB = repo.createChat({ title: 'svc B', kind: 'main', workspacePath: ws })
    const svcSub = repo.createChat({ title: 'svc sub', kind: 'sub', parentId: svcA.id })

    check('listServices is empty for a fresh session', listServices(svcA.id).length === 0)

    const started = await runTool(
      'bash',
      { command: bgCmd, background: true },
      {
        cwd: ws,
        sessionId: svcA.id
      }
    )
    const svcId = started.output.match(/bg_\d+/)?.[0] ?? ''
    check('a background process appears in listServices', listServices(svcA.id).length === 1)

    const [svc] = listServices(svcA.id)
    check('service carries its command', svc.command === bgCmd)
    check('service carries its cwd', svc.cwd === ws)
    check('service is running', svc.status === 'running')
    // bgState is reused rather than reimplemented in the UI.
    check('service state is the bash_list label', /^running \d+s$/.test(svc.state), svc.state)

    // Isolation: the panel is per session, exactly like bash_list.
    check("session B does not see session A's service", listServices(svcB.id).length === 0)
    check('an empty session id lists nothing', listServices('').length === 0)

    // A subagent's process is owned by the ROOT session, so it shows up in the
    // parent's panel — the parent is who can stop it.
    await runTool('bash', { command: bgCmd, background: true }, { cwd: ws, sessionId: svcSub.id })
    check("a subagent's service appears in the PARENT's panel", listServices(svcA.id).length === 2)
    check('...and not under the sub itself', listServices(svcSub.id).length === 0)

    // Log view reads the whole buffer WITHOUT moving the agent's read cursor.
    const logs = serviceOutput(svcId, svcA.id)
    check('serviceOutput returns the buffered output', logs.includes(bgCmd), logs.slice(0, 80))
    check('serviceOutput is stable when read twice', serviceOutput(svcId, svcA.id) === logs)
    const agentRead = await runTool('bash_output', { id: svcId }, { cwd: ws, sessionId: svcA.id })
    check(
      "the UI's read did not consume the agent's new output",
      agentRead.ok && agentRead.output.includes('roxy-bg-ok'),
      agentRead.output
    )
    check('serviceOutput refuses another session', serviceOutput(svcId, svcB.id) === '')

    // Restart replaces the row rather than accumulating a dead one per restart.
    const restarted = await restartService(svcId, svcA.id)
    check('restartService succeeds', restarted.ok && !!restarted.id, restarted.error ?? '')
    check('...with a NEW process id', restarted.id !== svcId)
    check('...and does not leave the old row behind', listServices(svcA.id).length === 2)
    check(
      'the restarted service runs the same command',
      listServices(svcA.id).some((s) => s.id === restarted.id && s.command === bgCmd)
    )
    check(
      'restartService refuses another session',
      (await restartService(restarted.id!, svcB.id)).ok === false
    )

    // Stop is idempotent.
    const stopped = stopService(restarted.id!, svcA.id)
    check('stopService succeeds', stopped.ok)
    check(
      '...and the service is no longer running',
      listServices(svcA.id).find((s) => s.id === restarted.id)?.status !== 'running'
    )
    check('stopService twice is fine', stopService(restarted.id!, svcA.id).ok)
    check('stopService refuses an unknown id', stopService('bg_nope', svcA.id).ok === false)

    killSessionBackground(svcA.id)
    repo.removeChat(svcA.id)
    repo.removeChat(svcB.id)
  }

  // ---- dev ports (parallel sessions must not fight over :3000) ----
  {
    const pA = repo.createChat({ title: 'port A', kind: 'main', workspacePath: ws })
    const pB = repo.createChat({ title: 'port B', kind: 'main', workspacePath: ws })

    check('a new session starts with no port', repo.getChat(pA.id)?.devPort === null)
    const portA = await ensureDevPort(pA.id)
    check(
      'ensureDevPort allocates a port',
      typeof portA === 'number' && portA! >= 3100,
      String(portA)
    )
    check('...and persists it', repo.getChat(pA.id)?.devPort === portA)

    // Stability is the whole point: a bookmarked localhost:<port>, an open tab
    // and a running server all assume it never moves.
    check('ensureDevPort is idempotent', (await ensureDevPort(pA.id)) === portA)
    check('...even called repeatedly', (await ensureDevPort(pA.id)) === portA)

    const portB = await ensureDevPort(pB.id)
    check('a second session gets a DIFFERENT port', portB !== portA, `${portA} vs ${portB}`)
    check(
      'listDevPorts reports both',
      repo.listDevPorts().includes(portA!) && repo.listDevPorts().includes(portB!)
    )

    // An already-claimed port is skipped even when nothing is listening on it.
    const fresh = await allocateDevPort()
    check(
      'allocateDevPort skips ports claimed by other sessions',
      fresh !== portA && fresh !== portB,
      String(fresh)
    )

    // The port reaches spawned commands as PORT + ROXY_PORT.
    const echoCmd =
      process.platform === 'win32'
        ? 'Write-Output "P=$env:PORT R=$env:ROXY_PORT"'
        : 'echo "P=$PORT R=$ROXY_PORT"'
    const envRes = await runTool('bash', { command: echoCmd }, { cwd: ws, sessionId: pA.id })
    check(
      'PORT is exported to spawned commands',
      envRes.ok && envRes.output.includes(`P=${portA}`),
      envRes.output
    )
    check(
      'ROXY_PORT is exported too',
      envRes.ok && envRes.output.includes(`R=${portA}`),
      envRes.output
    )

    // A session with no port must NOT get a blank PORT clobbering an inherited one.
    const noPort = repo.createChat({ title: 'no port', kind: 'main', workspacePath: ws })
    const noPortRes = await runTool('bash', { command: echoCmd }, { cwd: ws, sessionId: noPort.id })
    check(
      'a session without a port does not set PORT',
      noPortRes.ok && !/P=\d/.test(noPortRes.output),
      noPortRes.output
    )

    // Subagents share the parent's port (they share its tree and its servers).
    const subPort = repo.createChat({ title: 'sub port', kind: 'sub', parentId: pA.id })
    check('a sub-session has no port of its own', repo.getChat(subPort.id)?.devPort === null)

    repo.removeChat(pA.id)
    repo.removeChat(pB.id)
    repo.removeChat(noPort.id)
  }

  // ---- worktree setup config ----
  {
    check('no .roxy/worktree.json -> empty config', loadWorktreeConfig(ws).setup === undefined)

    const cfgDir = path.join(tmp, 'cfgproj')
    await fs.mkdir(path.join(cfgDir, '.roxy'), { recursive: true })
    await fs.writeFile(
      path.join(cfgDir, '.roxy', 'worktree.json'),
      JSON.stringify({ setup: 'echo hello' })
    )
    check('reads the setup command', loadWorktreeConfig(cfgDir).setup === 'echo hello')

    await fs.writeFile(path.join(cfgDir, '.roxy', 'worktree.json'), '{ not json')
    check('malformed config degrades to empty', loadWorktreeConfig(cfgDir).setup === undefined)

    await fs.writeFile(path.join(cfgDir, '.roxy', 'worktree.json'), JSON.stringify({ setup: 42 }))
    check('a non-string setup is ignored', loadWorktreeConfig(cfgDir).setup === undefined)
    check('an empty project root is safe', loadWorktreeConfig('').setup === undefined)
  }

  // ---- change_session_metadata (the agent organizing its own session) ----
  const metaChat = repo.createChat({ title: 'Session 1', workspacePath: ws, kind: 'main' })
  const metaRes = await runTool(
    'change_session_metadata',
    {
      title: 'Auth refactor',
      description: 'Refactoring the login flow',
      tasks: [
        { title: 'read auth code', status: 'completed' },
        { title: 'write tests', status: 'in_progress' }
      ]
    },
    { cwd: ws, sessionId: metaChat.id }
  )
  const metaAfter = repo.getChat(metaChat.id)
  check(
    'change_session_metadata sets name/description/tasks',
    metaRes.ok &&
      metaAfter?.title === 'Auth refactor' &&
      metaAfter?.description === 'Refactoring the login flow' &&
      metaAfter?.tasks.length === 2 &&
      metaAfter?.tasks[0].status === 'completed',
    metaRes.output
  )
  check(
    'change_session_metadata refuses without a session',
    !(await runTool('change_session_metadata', { title: 'x' }, { cwd: ws })).ok
  )
  const escape = await run('read', { path: '../../../etc/hosts' })
  check('path-escape is rejected (sandbox)', !escape.ok)

  // ---- loop tools via runTool ----
  const ll = await run('loop_list', {})
  check('loop_list tool', ll.ok && ll.output.includes('PR watcher'))
  const le = await run('loop_enable', { loop: 'PR watcher' })
  check(
    'loop_enable by name',
    le.ok && repo.listLoops().find((l) => l.id === loop.id)?.enabled === true
  )
  const ld = await run('loop_disable', { loop: loop.id })
  check(
    'loop_disable by id',
    ld.ok && repo.listLoops().find((l) => l.id === loop.id)?.enabled === false
  )
  check('loop tool rejects unknown loop', !(await run('loop_disable', { loop: 'nope' })).ok)

  // ---- background-task registry (Phase 11: parallel + background subagents) ----
  {
    _resetBackgroundJobs()
    const s1 = 'sess_bg_1'
    const s2 = 'sess_bg_2'
    const j1 = registerBackgroundJob({
      sessionId: s1,
      subChatId: 'sub_1',
      description: 'crunch',
      subagentType: 'general'
    })
    check(
      'registerBackgroundJob returns a job id',
      typeof j1.jobId === 'string' && j1.jobId.length > 0
    )
    check('a fresh background job signal is not aborted', j1.signal.aborted === false)
    check(
      'listRunningBackgroundJobs shows the running job',
      listRunningBackgroundJobs(s1).length === 1
    )
    check('hasActiveBackgroundJobs true while running', hasActiveBackgroundJobs(s1) === true)
    check(
      'activeBackgroundSubChatIds tracks the sub session',
      activeBackgroundSubChatIds().has('sub_1')
    )

    // A second session's job is isolated; a null subChatId is never tracked for pruning.
    const j2 = registerBackgroundJob({
      sessionId: s2,
      subChatId: null,
      description: 'watch',
      subagentType: 'explore'
    })
    check(
      'background jobs are isolated per session',
      listRunningBackgroundJobs(s1).length === 1 && listRunningBackgroundJobs(s2).length === 1
    )
    check(
      'null subChatId is not tracked for pruning',
      activeBackgroundSubChatIds().size === 1 && activeBackgroundSubChatIds().has('sub_1')
    )

    // Cancel aborts the signal, but the job stays listed until its run settles + finishes.
    cancelBackgroundJob(j1.jobId)
    check('cancelBackgroundJob aborts the job signal', j1.signal.aborted === true)
    check(
      'a cancelled job is still listed until it finishes',
      listRunningBackgroundJobs(s1).length === 1
    )

    // Finishing removes it from the registry, freeing its sub session to be pruned.
    finishBackgroundJob(j1.jobId, 'error')
    check('finishBackgroundJob removes the job', listRunningBackgroundJobs(s1).length === 0)
    check('a finished job frees its sub session', !activeBackgroundSubChatIds().has('sub_1'))
    check(
      'hasActiveBackgroundJobs false after the last job finishes',
      hasActiveBackgroundJobs(s1) === false
    )
    check(
      'finishing an unknown job id is a no-op',
      (finishBackgroundJob('nope', 'completed'), true)
    )

    // cancelSessionBackgroundJobs aborts every job belonging to a session.
    finishBackgroundJob(j2.jobId, 'completed')
    const a = registerBackgroundJob({
      sessionId: s1,
      subChatId: 'sub_a',
      description: 'a',
      subagentType: 'general'
    })
    const b = registerBackgroundJob({
      sessionId: s1,
      subChatId: 'sub_b',
      description: 'b',
      subagentType: 'general'
    })
    cancelSessionBackgroundJobs(s1)
    check(
      'cancelSessionBackgroundJobs aborts every session signal',
      a.signal.aborted && b.signal.aborted
    )

    // _resetBackgroundJobs clears everything (test isolation).
    _resetBackgroundJobs()
    check(
      '_resetBackgroundJobs clears the registry',
      listRunningBackgroundJobs(s1).length === 0 && !hasActiveBackgroundJobs(s1)
    )
  }

  // ---- LSP diagnostics after edit (Phase 12) via a real mock language server ----
  // Exercises the actual LspClient machinery (spawn → initialize handshake →
  // didOpen/didChange → publishDiagnostics → debounce) against a mock server that
  // flags any document containing "BROKEN". No real language server required.
  {
    const mockPath = path.join(process.cwd(), 'test', 'fixtures', 'mock-lsp.cjs')
    if (!existsSync(mockPath)) {
      check('mock-lsp fixture is present', false, mockPath)
    } else {
      const registerMock = (): void =>
        lsp._registerServerForTests({
          id: 'mocklsp',
          extensions: ['.mocklsp'],
          command: process.execPath, // electron binary, run as node via env below
          args: [mockPath],
          rootMarkers: ['.git'],
          env: { ELECTRON_RUN_AS_NODE: '1' }
        })

      lsp._resetLspForTests()
      registerMock()
      const f = path.join(ws, 'sample.mocklsp')

      check(
        'lsp: configuredServerId matches the registered server',
        lsp.configuredServerId(f) === 'mocklsp'
      )

      // A clean document produces no diagnostics (didOpen → empty push).
      await fs.writeFile(f, 'all good here', 'utf8')
      const clean = await withTimeout(lsp.diagnostics(f), 15_000, 'lsp clean')
      check('lsp: clean file has no diagnostics', clean.length === 0)

      // Editing in a fault surfaces an error (warm client → didChange → error push).
      await fs.writeFile(f, 'this line is BROKEN now', 'utf8')
      const dirty = await withTimeout(lsp.diagnostics(f), 15_000, 'lsp dirty')
      check(
        'lsp: error surfaced after edit',
        dirty.length === 1 && dirty[0].severity === 1,
        JSON.stringify(dirty)
      )
      check('lsp: diagnostic carries the message', (dirty[0]?.message ?? '').includes('BROKEN'))

      const block = await withTimeout(lsp.diagnosticsBlock(f, ws), 15_000, 'lsp block')
      check(
        'lsp: diagnosticsBlock renders an errors block',
        block.includes('<diagnostics') && block.includes('ERROR')
      )
      check('lsp: diagnosticsBlock path is workspace-relative', block.includes('sample.mocklsp'))

      // Fixing the fault clears diagnostics on the next edit (warm didChange).
      await fs.writeFile(f, 'clean again', 'utf8')
      const cleared = await withTimeout(lsp.diagnostics(f), 15_000, 'lsp cleared')
      check('lsp: re-edit clears diagnostics', cleared.length === 0)

      // Graceful degradation: an unsupported file type yields nothing, never throws.
      const none = await lsp.diagnosticsBlock(path.join(ws, 'notes.unknownext'), ws)
      check('lsp: unsupported file → empty block', none === '')

      // Reset disposes the client; a fresh call re-spawns and still works.
      lsp._resetLspForTests()
      registerMock()
      await fs.writeFile(f, 'BROKEN once more', 'utf8')
      const respawned = await withTimeout(lsp.diagnostics(f), 15_000, 'lsp respawn')
      check('lsp: re-spawns a server after reset', respawned.length === 1)
      lsp._resetLspForTests()
    }
  }

  // ---- MCP client (Phase 13) via a real mock MCP server over the official SDK ----
  // Exercises the ACTUAL @modelcontextprotocol/sdk Client: stdio spawn → initialize
  // handshake → capability negotiation → tools/list → tools/call, plus roxy's pool,
  // schema conversion, namespaced dispatch (through runTool), and lifecycle.
  {
    const mockPath = path.join(process.cwd(), 'test', 'fixtures', 'mock-mcp.cjs')
    if (!existsSync(mockPath)) {
      check('mock-mcp fixture is present', false, mockPath)
    } else {
      const rec: McpServerRecord = {
        id: 'mockmcp',
        enabled: true,
        config: {
          type: 'local',
          command: [process.execPath, mockPath], // electron binary, run as node via env
          environment: { ELECTRON_RUN_AS_NODE: '1' }
        }
      }

      await _resetMcpForTests()
      await withTimeout(ensureMcpConnected([rec], ws), 20_000, 'mcp connect')

      const schemas = mcpToolSchemas()
      const names = schemas.map((s) => (s.function as { name: string }).name)
      const echoName = names.find((n) => n.endsWith('__echo')) ?? ''
      const boomName = names.find((n) => n.endsWith('__boom')) ?? ''
      check('mcp: discovered both tools', schemas.length === 2, names.join(','))
      check(
        'mcp: tool names are mcp-namespaced',
        echoName.startsWith('mcp__mockmcp__') && boomName.startsWith('mcp__mockmcp__')
      )
      check('mcp: isMcpTool routes namespaced names', isMcpTool(echoName) && !isMcpTool('read'))
      check('mcp: mcpToolTitle renders server · tool', mcpToolTitle(echoName) === 'mockmcp · echo')

      const echoSchema = schemas.find((s) => (s.function as { name: string }).name === echoName)
      check(
        'mcp: tool schema is a function schema with parameters',
        !!echoSchema && echoSchema.type === 'function' && typeof echoSchema.function === 'object'
      )

      const summaries = mcpServerSummaries()
      check(
        'mcp: server summary reports connected + tools',
        summaries.length === 1 &&
          summaries[0].status === 'connected' &&
          summaries[0].tools.includes('echo')
      )
      const instr = mcpInstructions()
      check('mcp: instructions blurb mentions the server', !!instr && instr.includes('mockmcp'))

      const echoRes = await withTimeout(
        callMcpTool(echoName, { message: 'hi' }),
        15_000,
        'mcp echo'
      )
      check(
        'mcp: callMcpTool(echo) returns text',
        echoRes.ok && echoRes.output.includes('echo: hi'),
        echoRes.output
      )
      const boomRes = await withTimeout(callMcpTool(boomName, {}), 15_000, 'mcp boom')
      check(
        'mcp: callMcpTool(boom) surfaces isError → ok:false',
        !boomRes.ok && boomRes.output.includes('boom'),
        boomRes.output
      )
      const missRes = await callMcpTool('mcp__mockmcp__nope', {})
      check('mcp: unknown MCP tool → ok:false (never throws)', !missRes.ok)

      // The real dispatch seam: runTool's default case routes namespaced names.
      const viaRunTool = await withTimeout(run(echoName, { message: 'hey' }), 15_000, 'mcp runTool')
      check(
        'mcp: runTool dispatches MCP tools',
        viaRunTool.ok && viaRunTool.output.includes('echo: hey'),
        viaRunTool.output
      )

      // Dispose drops the tools + closes the child; a stale call degrades cleanly.
      await disposeConnection('mockmcp')
      check('mcp: dispose removes tool schemas', mcpToolSchemas().length === 0)
      const afterDispose = await callMcpTool(echoName, { message: 'x' })
      check('mcp: call after dispose → ok:false', !afterDispose.ok)

      // Reconnect brings the pool back.
      await withTimeout(reconnectMcpServer(rec, ws), 20_000, 'mcp reconnect')
      check('mcp: reconnect restores tools', mcpToolSchemas().length === 2)

      // Workspace scoping: the pool is process-global, but a turn only sees the
      // servers in ITS record set (so workspace A's `.roxy/mcp.json` server can't
      // leak into workspace B's chat).
      check(
        'mcp: schemas scoped to own ids include the server',
        mcpToolSchemas(new Set(['mockmcp'])).length === 2
      )
      check(
        'mcp: schemas scoped to other ids exclude the server',
        mcpToolSchemas(new Set(['other'])).length === 0
      )
      check(
        'mcp: instructions scoped to other ids are empty',
        mcpInstructions(new Set(['other'])) === undefined
      )
      check(
        'mcp: summaries scoped to other ids are empty',
        mcpServerSummaries(new Set(['other'])).length === 0
      )

      // Race guard: disposing DURING the connect window must not resurrect a zombie
      // pool entry (the in-flight connect self-tears-down instead of committing).
      await _resetMcpForTests()
      const inflight = ensureMcpConnected([rec], ws) // do NOT await — connect is mid-flight
      await disposeConnection('mockmcp') // tear down before connectOne resolves
      await withTimeout(inflight, 20_000, 'mcp inflight')
      check(
        'mcp: dispose during connect leaves no resurrected connection',
        mcpToolSchemas().length === 0
      )
      await withTimeout(ensureMcpConnected([rec], ws), 20_000, 'mcp reconnect after race')
      check('mcp: pool still healthy after a mid-connect dispose', mcpToolSchemas().length === 2)

      // A disabled record contributes nothing (never spawns).
      await _resetMcpForTests()
      await ensureMcpConnected([{ ...rec, enabled: false }], ws)
      check('mcp: disabled record spawns nothing', mcpToolSchemas().length === 0)

      // Workspace `.roxy/mcp.json` loader (project-portable config source).
      await fs.mkdir(path.join(ws, '.roxy'), { recursive: true })
      await fs.writeFile(
        path.join(ws, '.roxy', 'mcp.json'),
        JSON.stringify({ mcpServers: { wsserver: { command: ['node', 'x.js'], disabled: true } } }),
        'utf8'
      )
      const wsRecords = loadWorkspaceMcpServers(ws)
      check(
        'mcp: loadWorkspaceMcpServers parses .roxy/mcp.json',
        wsRecords.length === 1 && wsRecords[0].id === 'wsserver'
      )
      check('mcp: workspace `disabled:true` → enabled:false', wsRecords[0].enabled === false)
      check(
        'mcp: loader never throws on a missing file',
        loadWorkspaceMcpServers(path.join(ws, 'nope')).length === 0
      )

      await shutdownAllMcp()
      check('mcp: shutdownAllMcp clears the pool', mcpToolSchemas().length === 0)
      await _resetMcpForTests()

      // ---- the `mcp` MANAGEMENT tool (add/list/enable/disable/reconnect/remove) ----
      // Drives the agent-facing tool through runTool end-to-end against the real DB
      // + the mock server: add → connect → use in the same flow → toggle → remove.
      const mcpCmd = {
        action: 'add',
        id: 'toolmcp',
        command: [process.execPath, mockPath],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
      const added = await withTimeout(run('mcp', mcpCmd), 20_000, 'mcp tool add')
      check(
        'mcp tool: add connects the server and names its tools',
        added.ok && added.output.includes('mcp__toolmcp__echo'),
        added.output
      )
      check(
        'mcp tool: add persists the server to the DB',
        repo.listMcpServers().some((r) => r.id === 'toolmcp')
      )
      // This is what runLoop calls to rebuild the live tool list mid-turn:
      check(
        'mcp tool: added server is immediately in the scoped schemas (usable same turn)',
        mcpToolSchemas(new Set(['toolmcp'])).length === 2
      )

      const listedRes = await run('mcp', { action: 'list' })
      check(
        'mcp tool: list shows the server as connected',
        listedRes.ok &&
          listedRes.output.includes('toolmcp') &&
          listedRes.output.includes('connected'),
        listedRes.output
      )

      // The payoff: a tool the agent just added is callable through the same runTool.
      const usedAdded = await withTimeout(
        run('mcp__toolmcp__echo', { message: 'viatool' }),
        15_000,
        'mcp added echo'
      )
      check(
        "mcp tool: a just-added server's tool is callable",
        usedAdded.ok && usedAdded.output.includes('echo: viatool'),
        usedAdded.output
      )

      const disabled = await withTimeout(
        run('mcp', { action: 'disable', id: 'toolmcp' }),
        15_000,
        'mcp tool disable'
      )
      check(
        'mcp tool: disable disconnects + drops its schemas',
        disabled.ok && mcpToolSchemas().length === 0
      )
      check(
        'mcp tool: disable persists enabled=false',
        repo.listMcpServers().find((r) => r.id === 'toolmcp')?.enabled === false
      )

      const enabled = await withTimeout(
        run('mcp', { action: 'enable', id: 'toolmcp' }),
        20_000,
        'mcp tool enable'
      )
      check(
        'mcp tool: enable reconnects the server',
        enabled.ok && mcpToolSchemas(new Set(['toolmcp'])).length === 2,
        enabled.output
      )

      const reconnected = await withTimeout(
        run('mcp', { action: 'reconnect', id: 'toolmcp' }),
        20_000,
        'mcp tool reconnect'
      )
      check(
        'mcp tool: reconnect refreshes the connection',
        reconnected.ok && mcpToolSchemas(new Set(['toolmcp'])).length === 2,
        reconnected.output
      )

      const removed = await withTimeout(
        run('mcp', { action: 'remove', id: 'toolmcp' }),
        15_000,
        'mcp tool remove'
      )
      check(
        'mcp tool: remove deletes from DB + drops schemas',
        removed.ok &&
          !repo.listMcpServers().some((r) => r.id === 'toolmcp') &&
          mcpToolSchemas().length === 0
      )

      // Input validation — every bad call degrades to ok:false, never throws.
      const noAction = await run('mcp', {})
      check('mcp tool: missing action → ok:false', !noAction.ok)
      const noConfig = await run('mcp', { action: 'add', id: 'incomplete' })
      check('mcp tool: add without command/url → ok:false', !noConfig.ok)
      check(
        'mcp tool: a failed add did not persist a broken server',
        !repo.listMcpServers().some((r) => r.id === 'incomplete')
      )
      const ghost = await run('mcp', { action: 'reconnect', id: 'ghost' })
      check('mcp tool: reconnect an unknown server → ok:false', !ghost.ok)
      const bogus = await run('mcp', { action: 'frobnicate', id: 'toolmcp' })
      check('mcp tool: unknown action → ok:false', !bogus.ok)
      const rmGhost = await run('mcp', { action: 'remove', id: 'never-existed' })
      check('mcp tool: removing a non-existent server is a friendly no-op (ok:true)', rmGhost.ok)

      await _resetMcpForTests()
    }
  }

  // ---- Skills runtime (Phase 14): discover SKILL.md on disk + the `skill` tool ----
  // Builds a real fixture skills tree (workspace + an isolated global home) and
  // exercises the ACTUAL discovery/dedup/cache + the `skill` tool through runTool.
  {
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    const prevDisabled = process.env.ROXY_SKILLS
    const skHome = path.join(tmp, 'skhome')
    const w = (p: string): string => path.join(ws, p)
    try {
      // Isolate the global skill roots to a throwaway home so discovery is deterministic.
      process.env.HOME = skHome
      process.env.USERPROFILE = skHome
      const globalActive = os.homedir() === skHome

      // Workspace fixture: frontmatter-named + folder-named + bare-file skills, a
      // companion file, and a name clash across .roxy/.claude roots.
      await fs.mkdir(w('.roxy/skills/demo/scripts'), { recursive: true })
      await fs.writeFile(
        w('.roxy/skills/demo/SKILL.md'),
        '---\nname: demokit\ndescription: Workspace demo skill\n---\n# Demo\nUse scripts/run.sh.\n',
        'utf8'
      )
      await fs.writeFile(w('.roxy/skills/demo/scripts/run.sh'), 'echo hi\n', 'utf8')
      await fs.writeFile(
        w('.roxy/skills/notes.md'),
        '---\ndescription: Bare single-file skill\n---\nNotes body.\n',
        'utf8'
      )
      await fs.mkdir(w('.claude/skills/greet'), { recursive: true })
      await fs.writeFile(
        w('.claude/skills/greet/SKILL.md'),
        '---\ndescription: Says hello\n---\nHello!\n',
        'utf8'
      )
      await fs.mkdir(w('.roxy/skills/dup'), { recursive: true })
      await fs.writeFile(
        w('.roxy/skills/dup/SKILL.md'),
        '---\ndescription: roxy wins\n---\nR\n',
        'utf8'
      )
      await fs.mkdir(w('.claude/skills/dup'), { recursive: true })
      await fs.writeFile(
        w('.claude/skills/dup/SKILL.md'),
        '---\ndescription: claude loses\n---\nC\n',
        'utf8'
      )

      // Global fixture (under the isolated home): one that clashes with the workspace
      // (must lose) and one global-only (must be discovered).
      if (globalActive) {
        await fs.mkdir(path.join(skHome, '.roxy/skills/demokit'), { recursive: true })
        await fs.writeFile(
          path.join(skHome, '.roxy/skills/demokit/SKILL.md'),
          '---\ndescription: global demokit (should lose)\n---\nG\n',
          'utf8'
        )
        await fs.mkdir(path.join(skHome, '.roxy/skills/awscli'), { recursive: true })
        await fs.writeFile(
          path.join(skHome, '.roxy/skills/awscli/SKILL.md'),
          '---\ndescription: Global AWS skill\n---\nAWS\n',
          'utf8'
        )
      }

      _resetSkillsForTests()
      const found = await listSkills(ws)
      const by = new Map(found.map((s) => [s.name, s]))
      check('skills: frontmatter name wins over folder name', by.has('demokit') && !by.has('demo'))
      check('skills: discovers a folder-named SKILL.md', by.get('greet')?.source === 'workspace')
      check('skills: discovers a bare <name>.md', by.has('notes'))
      check(
        'skills: results sorted by name',
        found.map((s) => s.name).join() === [...found.map((s) => s.name)].sort().join()
      )
      check(
        'skills: .roxy beats .claude on a name clash',
        by.get('dup')?.description === 'roxy wins'
      )
      if (globalActive) {
        check('skills: discovers global skills', by.get('awscli')?.source === 'global')
        check(
          'skills: workspace overrides a same-named global',
          by.get('demokit')?.source === 'workspace' &&
            by.get('demokit')?.description === 'Workspace demo skill'
        )
      }

      const instr = await skillInstructions(ws)
      check(
        'skills: instructions block lists discovered skills',
        !!instr &&
          instr.includes('<available_skills>') &&
          instr.includes('demokit') &&
          instr.includes('greet')
      )

      const loaded = await loadSkill('demokit', ws)
      check(
        'skills: loadSkill returns body + base dir',
        loaded.ok &&
          loaded.output.includes('Use scripts/run.sh') &&
          loaded.output.includes('Base directory')
      )
      check(
        'skills: loadSkill samples companion files (relative)',
        loaded.output.includes('<skill_files>') &&
          loaded.output.includes('<file>scripts/run.sh</file>')
      )

      // Symlink hardening: a symlinked file whose real path escapes the skill dir
      // must NOT be listed (no out-of-dir path leaked into the model context).
      try {
        const outside = path.join(tmp, 'outside-secret.txt')
        await fs.writeFile(outside, 'TOPSECRET', 'utf8')
        await fs.symlink(outside, w('.roxy/skills/demo/secret.txt'))
        const linked = await loadSkill('demokit', ws)
        check(
          'skills: symlinked file escaping the skill dir is not listed',
          linked.ok && !linked.output.includes('secret.txt') && !linked.output.includes('TOPSECRET')
        )
      } catch {
        check('skills: symlink hardening (skipped — symlinks unsupported here)', true)
      }
      const loadedBare = await loadSkill('notes', ws)
      check(
        'skills: a bare-file skill has no <skill_files>',
        loadedBare.ok && !loadedBare.output.includes('<skill_files>')
      )
      const loadedCI = await loadSkill('DEMOKIT', ws)
      check('skills: loadSkill is case-insensitive', loadedCI.ok)
      const loadedMiss = await loadSkill('nope', ws)
      check(
        'skills: unknown skill → ok:false with a list',
        !loadedMiss.ok && loadedMiss.output.includes('Available skills')
      )

      const viaRun = await run('skill', { name: 'demokit' })
      check(
        'skills: runTool dispatches the skill tool',
        viaRun.ok && viaRun.output.includes('<skill_content')
      )

      // Cache invalidation: a newly-added skill is only seen after a refresh.
      await fs.writeFile(
        w('.roxy/skills/fresh.md'),
        '---\ndescription: Added later\n---\nX\n',
        'utf8'
      )
      check(
        'skills: discovery is cached (new file not seen yet)',
        !(await listSkills(ws)).some((s) => s.name === 'fresh')
      )
      refreshSkills(ws)
      check(
        'skills: refreshSkills re-scans',
        (await listSkills(ws)).some((s) => s.name === 'fresh')
      )

      // Kill switch.
      process.env.ROXY_SKILLS = '0'
      _resetSkillsForTests()
      check('skills: ROXY_SKILLS=0 disables discovery', (await listSkills(ws)).length === 0)
      const disabledLoad = await loadSkill('demokit', ws)
      check(
        'skills: ROXY_SKILLS=0 disables the tool',
        !disabledLoad.ok && disabledLoad.output.toLowerCase().includes('disabled')
      )
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevProfile
      if (prevDisabled === undefined) delete process.env.ROXY_SKILLS
      else process.env.ROXY_SKILLS = prevDisabled
      _resetSkillsForTests()
    }
  }

  // ---- Portable config export/import (backup skills + MCP to another machine) ----
  // Drives the REAL buildExport/applyImport against an isolated global home + the
  // live DB: seed global skills (folder + companion, and a bare .md) and MCP rows,
  // export to a bundle, wipe everything, then import and verify a faithful restore.
  {
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    const prevDisabled = process.env.ROXY_SKILLS
    delete process.env.ROXY_SKILLS
    const pHome = path.join(tmp, 'porthome')
    try {
      process.env.HOME = pHome
      process.env.USERPROFILE = pHome
      const homeOk = os.homedir() === pHome

      if (homeOk) {
        // Seed two global skills: a folder skill with a companion, and a bare .md.
        await fs.mkdir(path.join(pHome, '.roxy/skills/backupme/scripts'), { recursive: true })
        await fs.writeFile(
          path.join(pHome, '.roxy/skills/backupme/SKILL.md'),
          '---\nname: backupme\ndescription: Backup me\n---\nBody here. Use scripts/go.sh.\n',
          'utf8'
        )
        await fs.writeFile(
          path.join(pHome, '.roxy/skills/backupme/scripts/go.sh'),
          'echo go\n',
          'utf8'
        )
        await fs.writeFile(
          path.join(pHome, '.roxy/skills/solo.md'),
          '---\ndescription: Bare solo skill\n---\nSolo body.\n',
          'utf8'
        )
        _resetSkillsForTests()

        const exported = await exportGlobalSkills()
        const byName = new Map(exported.map((s) => [s.name, s]))
        check(
          'portable(app): export finds the folder + bare skills',
          byName.has('backupme') && byName.has('solo')
        )
        check(
          'portable(app): folder skill carries its companion file',
          (byName.get('backupme')?.files.length ?? 0) === 2
        )
        check(
          'portable(app): bare skill is normalized to a SKILL.md file',
          byName.get('solo')?.files.some((f) => f.path.toLowerCase() === 'skill.md') === true
        )

        // Seed MCP rows, then build the whole export via the service (skills + DB).
        repo.upsertMcpServer({
          id: 'port-fs',
          config: { type: 'local', command: ['npx', 'srv'] },
          enabled: true
        })
        repo.upsertMcpServer({
          id: 'port-remote',
          config: { type: 'remote', url: 'https://p.example/mcp' },
          enabled: false
        })
        const built = await buildExport()
        check(
          'portable(app): buildExport counts skills + servers',
          built.skills >= 2 && built.mcpServers >= 2
        )
        check(
          'portable(app): buildExport text is a valid bundle',
          parseBundle(built.text).ok === true
        )

        // Wipe both sides, then restore from the exported text.
        await fs.rm(path.join(pHome, '.roxy/skills'), { recursive: true, force: true })
        repo.deleteMcpServer('port-fs')
        repo.deleteMcpServer('port-remote')
        _resetSkillsForTests()
        check('portable(app): skills gone before import', (await exportGlobalSkills()).length === 0)

        const applied = await applyImport(built.text)
        check('portable(app): applyImport reports ok', applied.ok === true)
        check(
          'portable(app): applyImport restored the skills',
          applied.skills.some((s) => s.name === 'backupme')
        )
        check(
          'portable(app): applyImport restored the servers',
          applied.mcpServers.some((s) => s.id === 'port-fs') &&
            applied.mcpServers.some((s) => s.id === 'port-remote')
        )

        // Verify the files + DB rows really came back.
        const restoredSkill = await fs
          .readFile(path.join(pHome, '.roxy/skills/backupme/SKILL.md'), 'utf8')
          .catch(() => '')
        check(
          'portable(app): restored SKILL.md content matches',
          restoredSkill.includes('Body here.')
        )
        const restoredCompanion = await fs
          .readFile(path.join(pHome, '.roxy/skills/backupme/scripts/go.sh'), 'utf8')
          .catch(() => '')
        check(
          'portable(app): restored companion file matches',
          restoredCompanion.includes('echo go')
        )
        const remote = repo.listMcpServers().find((r) => r.id === 'port-remote')
        check(
          'portable(app): restored a disabled remote server',
          remote?.enabled === false && remote?.config.type === 'remote'
        )

        // Re-importing overwrites (replaced=true), never duplicates.
        const again = await applyImport(built.text)
        check(
          'portable(app): re-import marks skills replaced',
          again.skills.find((s) => s.name === 'backupme')?.replaced === true
        )
        check(
          'portable(app): re-import marks servers replaced',
          again.mcpServers.find((s) => s.id === 'port-fs')?.replaced === true
        )

        // A malformed bundle is a graceful, structured failure.
        const bad = await applyImport('{ not a bundle }')
        check(
          'portable(app): applyImport rejects junk without throwing',
          bad.ok === false && !!bad.error
        )

        // importGlobalSkills refuses a path escaping the skill folder.
        const escaped = await importGlobalSkills([
          {
            name: 'evil',
            files: [
              {
                path: 'SKILL.md',
                dataBase64: Buffer.from('---\nname: evil\n---\nx', 'utf8').toString('base64')
              },
              { path: '../pwn.sh', dataBase64: Buffer.from('bad', 'utf8').toString('base64') }
            ]
          }
        ])
        check(
          'portable(app): import writes the skill but drops the escaping path',
          escaped.installed.some((s) => s.name === 'evil')
        )
        check(
          'portable(app): the escaping companion was not written',
          !existsSync(path.join(pHome, '.roxy/skills/pwn.sh')) &&
            !existsSync(path.join(tmp, 'pwn.sh'))
        )

        // Clean up DB rows this block created.
        repo.deleteMcpServer('port-fs')
        repo.deleteMcpServer('port-remote')
      } else {
        check('portable(app): skipped (home override unsupported here)', true)
      }
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevProfile
      if (prevDisabled === undefined) delete process.env.ROXY_SKILLS
      else process.env.ROXY_SKILLS = prevDisabled
      _resetSkillsForTests()
    }
  }
  // ---- skill_manage tool (Phase 14+): the model authoring/managing skills ----
  // Drives the real writeSkill/deleteSkill service through runTool against the
  // smoke workspace `ws` (scope defaults to workspace → writes ws/.roxy/skills),
  // so it never touches the user's real ~/.roxy/skills.
  {
    const prevDisabled = process.env.ROXY_SKILLS
    delete process.env.ROXY_SKILLS
    _resetSkillsForTests()
    try {
      const SN = 'smokemanaged'
      const MARK = 'SMOKE-BODY-MARKER-A'

      // create
      const created = await run('skill_manage', {
        action: 'create',
        name: SN,
        description: 'first desc',
        body: `# ${SN}\n${MARK}\n`
      })
      check('skill_manage: create returns ok', created.ok && created.output.includes(SN))
      check(
        'skill_manage: created skill is discovered',
        (await listSkills(ws)).some((s) => s.name === SN)
      )

      // the `skill` tool can load what we just created
      const loaded = await run('skill', { name: SN })
      check(
        'skill_manage: created skill loads via the skill tool',
        loaded.ok && loaded.output.includes(MARK)
      )

      // duplicate create is refused
      const dup = await run('skill_manage', { action: 'create', name: SN, body: 'x' })
      check('skill_manage: duplicate create → ok:false', !dup.ok)

      // edit description only → body preserved
      const edited = await run('skill_manage', {
        action: 'edit',
        name: SN,
        description: 'second desc'
      })
      check('skill_manage: edit returns ok', edited.ok)
      const afterEdit = (await listSkills(ws)).find((s) => s.name === SN)
      check('skill_manage: edit changed the description', afterEdit?.description === 'second desc')
      const reloaded = await run('skill', { name: SN })
      check(
        'skill_manage: edit preserved the omitted body',
        reloaded.ok && reloaded.output.includes(MARK)
      )

      // list action surfaces it
      const listed = await run('skill_manage', { action: 'list' })
      check('skill_manage: list includes the skill', listed.ok && listed.output.includes(SN))

      // synonyms: op/add + content alias
      const viaSyn = await run('skill_manage', {
        op: 'add',
        name: 'smokesyn',
        content: 'body via content alias'
      })
      check('skill_manage: op/add + content alias works', viaSyn.ok)
      await run('skill_manage', { action: 'remove', name: 'smokesyn' })

      // remove deletes it
      const removed = await run('skill_manage', { action: 'remove', name: SN })
      check(
        'skill_manage: remove returns ok+removed',
        removed.ok && removed.output.includes('Removed')
      )
      check(
        'skill_manage: removed skill is gone',
        !(await listSkills(ws)).some((s) => s.name === SN)
      )

      // validation / never-throws
      const noAction = await run('skill_manage', {})
      check('skill_manage: missing action → ok:false', !noAction.ok)
      const noName = await run('skill_manage', { action: 'edit' })
      check('skill_manage: edit without name → ok:false', !noName.ok)
      const noBody = await run('skill_manage', { action: 'create', name: 'smokenobody' })
      check('skill_manage: create without body → ok:false', !noBody.ok)
      const badName = await run('skill_manage', { action: 'create', name: 'bad name', body: 'x' })
      check('skill_manage: invalid name → ok:false', !badName.ok)
      const unknown = await run('skill_manage', { action: 'frobnicate', name: 'x' })
      check('skill_manage: unknown action → ok:false', !unknown.ok)
      const missRm = await run('skill_manage', { action: 'remove', name: 'does-not-exist-xyz' })
      check(
        'skill_manage: remove nonexistent → friendly ok',
        missRm.ok && /no skill/i.test(missRm.output)
      )
    } finally {
      if (prevDisabled === undefined) delete process.env.ROXY_SKILLS
      else process.env.ROXY_SKILLS = prevDisabled
      _resetSkillsForTests()
    }
  }

  // ---- skill install from a remote source (Roxy's `npx skills add`) ----
  // Drives the REAL installSkillFromSource + runTool('skill_manage' install) with a
  // network-free fake fetch that serves a tiny GitHub repo (contents API + raw files).
  {
    const prevDisabled = process.env.ROXY_SKILLS
    delete process.env.ROXY_SKILLS
    _resetSkillsForTests()

    const SKILL_HELLO = '---\nname: hello\ndescription: Say hi\n---\n# Hello\nRun scripts/run.sh\n'
    const SKILL_SOLO = '---\nname: solo\ndescription: A single-file skill\n---\n# Solo\nJust me.\n'
    const RAWBASE = 'https://raw.githubusercontent.com'
    const ghFile = (repo: string, p: string, size = 60): Record<string, unknown> => ({
      type: 'file',
      name: path.posix.basename(p),
      path: p,
      size,
      download_url: `${RAWBASE}/acme/${repo}/HEAD/${p}`
    })
    const ghDir = (p: string): Record<string, unknown> => ({
      type: 'dir',
      name: path.posix.basename(p),
      path: p
    })
    // Contents API tree, keyed by "owner/repo" then repo-relative dir path.
    const contents: Record<string, Record<string, unknown[]>> = {
      'acme/skills': {
        '': [ghDir('skills'), ghFile('skills', 'README.md', 10)],
        skills: [ghDir('skills/hello')],
        'skills/hello': [ghFile('skills', 'skills/hello/SKILL.md'), ghDir('skills/hello/scripts')],
        'skills/hello/scripts': [ghFile('skills', 'skills/hello/scripts/run.sh', 8)]
      },
      'acme/empty': { '': [ghFile('empty', 'README.md', 10)] }
    }
    const rawBodies: Record<string, string> = {
      [`${RAWBASE}/acme/skills/HEAD/skills/hello/SKILL.md`]: SKILL_HELLO,
      [`${RAWBASE}/acme/skills/HEAD/skills/hello/scripts/run.sh`]: 'echo hi\n',
      [`${RAWBASE}/acme/skills/HEAD/README.md`]: '# readme\n',
      [`${RAWBASE}/acme/empty/HEAD/README.md`]: '# readme\n',
      [`${RAWBASE}/acme/solo/main/solo/SKILL.md`]: SKILL_SOLO
    }
    const mkResp = (body: unknown, bytes: string | null, ok = true, status = 200): Response =>
      ({
        ok,
        status,
        json: async () => body,
        text: async () => bytes ?? '',
        arrayBuffer: async () => new TextEncoder().encode(bytes ?? '').buffer,
        headers: { get: (): string | null => null }
      }) as unknown as Response
    const fakeFetch = (async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString()
      const apiMatch = /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/?([^?]*)/.exec(url)
      if (apiMatch) {
        const key = `${apiMatch[1]}/${apiMatch[2]}`
        const dir = decodeURIComponent(apiMatch[3] || '')
        const tree = contents[key]
        const listing = tree?.[dir]
        if (!listing) return mkResp(null, null, false, 404)
        return mkResp(listing, null)
      }
      if (url in rawBodies) return mkResp(null, rawBodies[url])
      return mkResp(null, null, false, 404)
    }) as unknown as typeof fetch

    try {
      // 1) Repo install (owner/repo shorthand) → finds skills/hello + companion file.
      const res = await installSkillFromSource('acme/skills', {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check(
        'skill install: repo install ok',
        res.ok && res.installed.some((s) => s.name === 'hello')
      )
      const helloMd = path.join(ws, '.roxy/skills/hello/SKILL.md')
      check('skill install: wrote SKILL.md', existsSync(helloMd))
      check(
        'skill install: wrote companion file',
        existsSync(path.join(ws, '.roxy/skills/hello/scripts/run.sh'))
      )
      refreshSkills(ws)
      const found = await listSkills(ws)
      check(
        'skill install: installed skill is discovered',
        found.some((s) => s.name === 'hello')
      )
      const loaded = await loadSkill('hello', ws)
      check(
        'skill install: installed skill loads with companions',
        loaded.ok &&
          loaded.output.includes('Run scripts/run.sh') &&
          loaded.output.includes('run.sh')
      )

      // 2) Direct blob URL to a SKILL.md → installs that one skill (via its folder).
      const blob = await installSkillFromSource(
        'https://github.com/acme/skills/blob/main/skills/hello/SKILL.md',
        { cwd: ws, scope: 'workspace', fetchImpl: fakeFetch }
      )
      check(
        'skill install: blob URL installs the skill',
        blob.ok && blob.installed[0]?.name === 'hello'
      )

      // 3) Direct raw SKILL.md URL → bare install using its frontmatter name.
      const raw = await installSkillFromSource(`${RAWBASE}/acme/solo/main/solo/SKILL.md`, {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check(
        'skill install: raw .md URL installs (frontmatter name)',
        raw.ok && raw.installed[0]?.name === 'solo'
      )
      check(
        'skill install: raw install wrote canonical SKILL.md',
        existsSync(path.join(ws, '.roxy/skills/solo/SKILL.md'))
      )

      // 4) A repo with no SKILL.md → friendly ok:false (never throws).
      const empty = await installSkillFromSource('acme/empty', {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check(
        'skill install: no SKILL.md → ok:false',
        !empty.ok && /no skill\.?md/i.test(empty.error ?? '')
      )

      // 5) Unsupported source (GitLab) → ok:false with a reason, no fetch.
      const gitlab = await installSkillFromSource('https://gitlab.com/o/r', {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check(
        'skill install: unsupported source → ok:false',
        !gitlab.ok && /gitlab/i.test(gitlab.error ?? '')
      )

      // 6) 404 source → friendly message, never throws.
      const missing = await installSkillFromSource('acme/nope', {
        cwd: ws,
        scope: 'workspace',
        fetchImpl: fakeFetch
      })
      check('skill install: 404 source → friendly ok:false', !missing.ok && !!missing.error)

      // 7) Through runTool('skill_manage', install) using the test fetch seam.
      _setInstallFetchForTests(fakeFetch)
      const viaTool = await run('skill_manage', { action: 'install', source: 'acme/skills' })
      check(
        'skill install: skill_manage install dispatches via runTool',
        viaTool.ok && viaTool.output.includes('Installed') && viaTool.output.includes('hello')
      )
      // create-with-source-and-no-body is treated as an install (forgiving routing).
      const viaCreate = await run('skill_manage', {
        action: 'create',
        source: `${RAWBASE}/acme/solo/main/solo/SKILL.md`
      })
      check(
        'skill install: create+source (no body) routes to install',
        viaCreate.ok && viaCreate.output.includes('Installed')
      )
      const noSource = await run('skill_manage', { action: 'install' })
      check('skill install: install without source → ok:false', !noSource.ok)
    } finally {
      _setInstallFetchForTests(undefined)
      if (prevDisabled === undefined) delete process.env.ROXY_SKILLS
      else process.env.ROXY_SKILLS = prevDisabled
      _resetSkillsForTests()
    }
  }

  // ---- browser tools (real Electron window, local file, no network) ----
  try {
    const page =
      '<!doctype html><html><head><title>Smoke</title></head><body><h1 id="h">Hi roxy</h1>' +
      '<script>console.error("boom-smoke-error")</script></body></html>'
    const pagePath = path.join(ws, 'smoke.html')
    await fs.writeFile(pagePath, page, 'utf8')
    const fileUrl = pathToFileURL(pagePath).href

    const opened = await withTimeout(browser.open(fileUrl), 15_000, 'browser_open')
    check('browser_open loads a page', Boolean(opened.url) && !opened.error, opened.error ?? '')
    const html = await withTimeout(browser.getHtml('#h'), 15_000, 'browser_read')
    check('browser_read returns element HTML', html.includes('Hi roxy'), html.slice(0, 80))
    const tabsOut = await withTimeout(run('browser_tabs', {}), 15_000, 'browser_tabs')
    check(
      'browser_tabs lists the active tab',
      tabsOut.ok && tabsOut.output.includes('smoke.html') && tabsOut.output.includes('*'),
      tabsOut.output
    )
    const shot = await withTimeout(run('browser_screenshot', {}), 15_000, 'browser_screenshot')
    // Embedded views can't be captured on a headless display surface; the tool
    // works in the real (windowed) app. Tolerate that specific env limitation.
    const headlessCapture = !shot.ok && /display surface not available/i.test(shot.output)
    check(
      'browser_screenshot returns an inline image + saves a file',
      headlessCapture ||
        (Boolean(shot.image) &&
          shot.image!.startsWith('data:image/') &&
          shot.output.includes('.roxy')),
      headlessCapture ? '(skipped: headless has no capturable surface)' : shot.output
    )
    const con = await withTimeout(run('browser_console', {}), 15_000, 'browser_console')
    check(
      'browser_console captures the page error',
      con.output.toLowerCase().includes('boom-smoke-error'),
      con.output.slice(0, 120)
    )
    // Tab reorder (drag-to-reorganize): move the first tab to the end.
    browser.newTab('about:blank')
    const before = browser.listTabs().map((t) => t.id)
    if (before.length >= 2) {
      browser.moveTab(before[0], before.length - 1)
      const after = browser.listTabs().map((t) => t.id)
      check(
        'browser.moveTab reorders the strip',
        after[after.length - 1] === before[0] && after.length === before.length,
        after.join(',')
      )
    }
    browser.close()
  } catch (e) {
    check('browser tools', false, e instanceof Error ? e.message : String(e))
  }

  // ---- overnight resilience: transient model failures don't kill the run ----
  // There's no cap on tool-call count (the loop runs `for (;;)`); the real
  // overnight risk is a transient provider blip throwing out of the model stream.
  // `streamTurn` rides those out. These checks lock in the classification + the
  // retry policy without touching the network (fake model call, skipped backoff).
  try {
    const apiErr = (statusCode: number, responseBody = ''): APICallError =>
      new APICallError({
        message: `api ${statusCode}`,
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode,
        responseHeaders: {},
        responseBody
      })

    check(
      'isTransientModelError: ModelHttpError 429/5xx/408/409 are transient',
      [429, 500, 503, 408, 409].every((s) => isTransientModelError(new ModelHttpError(s, 'x')))
    )
    check(
      'isTransientModelError: ModelHttpError 4xx (400/401/403/404) are fatal',
      [400, 401, 403, 404].every((s) => !isTransientModelError(new ModelHttpError(s, 'x')))
    )
    check(
      'isTransientModelError: AI SDK APICallError follows its own isRetryable',
      isTransientModelError(apiErr(429)) &&
        isTransientModelError(apiErr(503)) &&
        !isTransientModelError(apiErr(400)) &&
        !isTransientModelError(apiErr(404))
    )
    check(
      'isTransientModelError: a status-less NETWORK error is transient',
      isTransientModelError(new Error('ECONNRESET: socket hang up')) &&
        isTransientModelError(new TypeError('fetch failed')) &&
        isTransientModelError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })) &&
        isTransientModelError(
          Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('read'), { code: 'ECONNRESET' })
          })
        )
    )
    check(
      'isTransientModelError: a status-less SETUP error (revoked token / not connected) is fatal',
      !isTransientModelError(new Error('Provider "openai" is not connected.')) &&
        !isTransientModelError(new Error('GitHub Copilot is not linked.')) &&
        !isTransientModelError(new TypeError("Cannot read properties of undefined (reading 'x')"))
    )
    check(
      'isNonRetryableModelError: 402 Payment Required is terminal (both transports)',
      isNonRetryableModelError(new ModelHttpError(402, 'Model request failed (402).')) &&
        isNonRetryableModelError(apiErr(402))
    )
    check(
      'isNonRetryableModelError: out-of-credits / quota text is terminal whatever the status',
      isNonRetryableModelError(
        new ModelHttpError(
          429,
          'Model request failed (429). {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}'
        )
      ) &&
        isNonRetryableModelError(
          new ModelHttpError(400, 'Your credit balance is too low to access the Anthropic API.')
        ) &&
        isNonRetryableModelError(
          apiErr(429, '{"type":"error","error":{"code":"insufficient_quota"}}')
        )
    )
    check(
      'isNonRetryableModelError: a plain rate-limit / 5xx / network blip is NOT billing',
      !isNonRetryableModelError(
        new ModelHttpError(429, 'Rate limit reached, please try again in 2s')
      ) &&
        !isNonRetryableModelError(new ModelHttpError(503, 'upstream temporarily unavailable')) &&
        !isNonRetryableModelError(new Error('ECONNRESET: socket hang up'))
    )
    check(
      'isTransientModelError: an out-of-quota 429 is NOT a retry-forever rate-limit',
      !isTransientModelError(
        new ModelHttpError(429, 'insufficient_quota: You exceeded your current quota')
      ) &&
        // …but a genuine rate-limit 429 still rides out during a long run.
        isTransientModelError(new ModelHttpError(429, 'Rate limit reached, try again shortly'))
    )
    check(
      'nextRetryDelay ramps 1s→16s then caps at 30s (never negative)',
      nextRetryDelay(0) === 1000 &&
        nextRetryDelay(1) === 2000 &&
        nextRetryDelay(2) === 4000 &&
        nextRetryDelay(3) === 8000 &&
        nextRetryDelay(4) === 16000 &&
        nextRetryDelay(5) === 30000 &&
        nextRetryDelay(9) === 30000 &&
        nextRetryDelay(-3) === 1000
    )

    {
      const ac = new AbortController()
      ac.abort()
      const t0 = Date.now()
      await abortableDelay(10_000, ac.signal)
      check('abortableDelay returns at once when already aborted', Date.now() - t0 < 500)
    }
    {
      const ac = new AbortController()
      const t0 = Date.now()
      const p = abortableDelay(10_000, ac.signal)
      setTimeout(() => ac.abort(), 10)
      await p
      check('abortableDelay wakes the moment the signal aborts mid-wait', Date.now() - t0 < 500)
    }

    // streamTurn orchestration — fake the model call + skip the real backoff.
    const noDelay = async (): Promise<void> => {}
    const ok = { text: 'done', toolCalls: [] as never[], usage: null }
    const call = (
      signal: AbortSignal,
      deps: {
        runOnce?: (...a: unknown[]) => Promise<{ text: string; toolCalls: never[] }>
        delay?: (ms: number, signal: AbortSignal) => Promise<void>
      }
    ): ReturnType<typeof streamTurn> =>
      streamTurn(
        'openai',
        false,
        'm',
        [],
        signal,
        undefined,
        undefined,
        [],
        () => {},
        () => {},
        deps as never
      )

    {
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        if (calls < 3) throw new ModelHttpError(503, 'boom')
        return ok
      }
      const r = await call(ac.signal, { runOnce, delay: noDelay })
      check('streamTurn retries transient failures then succeeds', r.text === 'done' && calls === 3)
    }
    {
      // A 429 window longer than MODEL_FATAL_ATTEMPTS still recovers — the core
      // overnight guarantee: transient errors are never given up on.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        if (calls <= MODEL_FATAL_ATTEMPTS + 3) throw new ModelHttpError(429, 'rate limited')
        return ok
      }
      const r = await call(ac.signal, { runOnce, delay: noDelay })
      check(
        'streamTurn never gives up on 429 (survives a long rate-limit)',
        r.text === 'done' && calls === MODEL_FATAL_ATTEMPTS + 4
      )
    }
    {
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        throw new ModelHttpError(400, 'bad request')
      }
      let threw = false
      try {
        await call(ac.signal, { runOnce, delay: noDelay })
      } catch {
        threw = true
      }
      check(
        'streamTurn gives up on a fatal 400 after MODEL_FATAL_ATTEMPTS',
        threw && calls === MODEL_FATAL_ATTEMPTS
      )
    }
    {
      // A hard billing / out-of-credits wall surfaces IMMEDIATELY — no retries,
      // no backoff — so an out-of-credits run fails fast with a clear message
      // instead of hammering the endpoint every 30s for hours.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        throw new ModelHttpError(
          429,
          'insufficient_quota: You exceeded your current quota, check your plan and billing'
        )
      }
      let threw = false
      try {
        await call(ac.signal, { runOnce, delay: noDelay })
      } catch {
        threw = true
      }
      check('streamTurn surfaces a billing/quota wall at once (no retry)', threw && calls === 1)
    }
    {
      // A permanent status-less setup error (revoked token, not connected) must
      // ALSO surface after the bounded attempts — not loop forever overnight.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        throw new Error('Provider "openai" is not connected.')
      }
      let threw = false
      try {
        await call(ac.signal, { runOnce, delay: noDelay })
      } catch {
        threw = true
      }
      check(
        'streamTurn gives up on a permanent status-less error (does not loop forever)',
        threw && calls === MODEL_FATAL_ATTEMPTS
      )
    }
    {
      // Once bytes have streamed this attempt, a failure is NOT retried — re-running
      // would duplicate the partial output the user already saw.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (...a: unknown[]): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        ;(a[8] as (d: string) => void)('partial ')
        throw new ModelHttpError(503, 'mid-stream drop')
      }
      let threw = false
      try {
        await call(ac.signal, { runOnce, delay: noDelay })
      } catch {
        threw = true
      }
      check('streamTurn does not retry after output already streamed', threw && calls === 1)
    }
    {
      // Stop pressed during a backoff wait ends the turn cleanly.
      const ac = new AbortController()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        throw new ModelHttpError(503, 'boom')
      }
      const delay = async (): Promise<void> => {
        ac.abort()
      }
      const r = await call(ac.signal, { runOnce, delay })
      check('streamTurn stops when aborted during backoff', r.text === '' && calls === 1)
    }
    {
      const ac = new AbortController()
      ac.abort()
      let calls = 0
      const runOnce = async (): Promise<{ text: string; toolCalls: never[] }> => {
        calls++
        return ok
      }
      const r = await call(ac.signal, { runOnce, delay: noDelay })
      check('streamTurn is a no-op when already aborted', r.text === '' && calls === 0)
    }

    // ---- AI SDK usage capture (Claude/Gemini report tokens in `finish`) ----
    {
      async function* parts(): AsyncGenerator<{
        type: string
        text?: string
        totalUsage?: Record<string, number>
      }> {
        yield { type: 'text-delta', text: 'hi' }
        yield {
          type: 'finish',
          // AI SDK's inputTokens INCLUDES cached; consume splits them out.
          totalUsage: {
            inputTokens: 1000,
            outputTokens: 200,
            cachedInputTokens: 300,
            reasoningTokens: 50
          }
        }
      }
      const ac = new AbortController()
      const out = await consumeAiSdkStream(
        parts(),
        ac.signal,
        () => {},
        () => {}
      )
      check(
        'aisdk: captures real usage from finish',
        out.usage !== null && out.usage.estimated === false
      )
      check(
        'aisdk: splits cached out of input',
        out.usage?.input === 700 && out.usage?.cacheRead === 300
      )
      check(
        'aisdk: maps output + reasoning',
        out.usage?.output === 200 && out.usage?.reasoning === 50
      )
    }
    {
      // No finish/usage frame → consume returns null (streamViaAiSdk estimates upstream).
      async function* parts(): AsyncGenerator<{ type: string; text?: string }> {
        yield { type: 'text-delta', text: 'hello world' }
      }
      const ac = new AbortController()
      const out = await consumeAiSdkStream(
        parts(),
        ac.signal,
        () => {},
        () => {}
      )
      check(
        'aisdk: usage null when provider omits finish',
        out.usage === null && out.text === 'hello world'
      )
    }
  } catch (e) {
    check('overnight resilience (streamTurn)', false, e instanceof Error ? e.message : String(e))
  }

  closeDb()
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
}

app.whenReady().then(async () => {
  console.log('roxy runtime smoke test\n')
  // Watchdog so an overnight run can never hang.
  const watchdog = setTimeout(() => {
    console.error('\nSMOKE TIMEOUT (60s)')
    app.exit(2)
  }, 60_000)
  watchdog.unref?.()

  try {
    await main()
  } catch (e) {
    fails.push('fatal: ' + (e instanceof Error ? e.message : String(e)))
    console.error('\nFATAL', e)
  } finally {
    clearTimeout(watchdog)
    const ok = fails.length === 0
    console.log(
      ok
        ? `\nSMOKE OK \u2014 ${pass} checks passed`
        : `\nSMOKE FAILED \u2014 ${fails.length} failing: ${fails.join(', ')}`
    )
    // Short drain delay so the summary flushes before app.exit tears down.
    setTimeout(() => app.exit(ok ? 0 : 1), 150)
  }
})
