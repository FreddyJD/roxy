/**
 * Electron-runtime smoke test. Boots a headless Electron main process against a
 * throwaway userData/DB and exercises the REAL code paths: SQLite migrations +
 * repo CRUD, harness file/bash tools, loop tools, and the Electron browser tools.
 * Run: npm run smoke:app
 */
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

import * as repo from '../src/main/db/repo'
import { closeDb } from '../src/main/db/database'
import { runTool } from '../src/main/harness'
import * as browser from '../src/main/services/browser'
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
    repo.getSettings().activeProviderId === 'openai' && repo.getSettings().activeModel === 'gpt-test'
  )
  check('reasoning effort default high', repo.getSettings().reasoningEffort === 'high')
  repo.setReasoningEffort('low')
  check('setReasoningEffort persists', repo.getSettings().reasoningEffort === 'low')
  repo.setReasoningEffort('max')
  check('setReasoningEffort accepts the xhigh/max ladder', repo.getSettings().reasoningEffort === 'max')
  repo.setReasoningEffort('high')
  check('context limit default null', repo.getSettings().contextLimit === null)
  repo.setContextLimit(1_000_000)
  check('setContextLimit persists', repo.getSettings().contextLimit === 1_000_000)
  repo.setContextLimit(null)
  check('setContextLimit clears', repo.getSettings().contextLimit === null)

  // ---- chats / sessions ----
  const chat = repo.createChat({ title: 'smoke', kind: 'main', workspacePath: ws })
  check('createChat (main + workspace)', chat.kind === 'main' && chat.workspacePath === ws)
  check('listChats contains it', repo.listChats().some((c) => c.id === chat.id))
  check('getChatWorkspace', repo.getChatWorkspace(chat.id) === ws)
  repo.renameChat(chat.id, 'renamed')
  check('renameChat', repo.listChats().find((c) => c.id === chat.id)?.title === 'renamed')

  // ---- subagent sessions link to + cascade-delete with their parent (v9) ----
  const sub = repo.createChat({
    title: 'explore: find x',
    kind: 'sub',
    workspacePath: ws,
    parentId: chat.id
  })
  check('createChat (sub + parentId)', sub.kind === 'sub' && sub.parentId === chat.id)
  check('listSubchats returns the sub', repo.listSubchats(chat.id).some((c) => c.id === sub.id))
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
  check('pruneSubchats drops a queue-less sub', !repo.listSubchats(chat.id).some((c) => c.id === sub.id))
  check('pruneSubchats keeps a queued sub', repo.listSubchats(chat.id).some((c) => c.id === busySub.id))

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
  check('queue FIFO order', repo.listQueue(chat.id).map((x) => x.content).join() === 'q1,q2')
  repo.reorderQueue(chat.id, [q2.id, q1.id])
  check('queue reorder', repo.listQueue(chat.id).map((x) => x.content).join() === 'q2,q1')
  repo.removeQueueItem(q1.id)
  check('queue remove', repo.listQueue(chat.id).map((x) => x.content).join() === 'q2')
  const qImg = repo.enqueue(chat.id, 'with image', [
    { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png', name: 'a.png' }
  ])
  check(
    'queue stores images',
    repo.listQueue(chat.id).find((x) => x.id === qImg.id)?.images?.length === 1
  )
  repo.removeQueueItem(qImg.id)

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
  check('dueLoops includes enabled loop', repo.dueLoops(Date.now() + 1000).some((l) => l.id === loop.id))
  repo.appendLoopRun(loop.id, 'scheduled prompt', 'heartbeat reply')
  check('appendLoopRun posts into loop chat', repo.listMessages(loop.chatId).length === 2)
  const projLoop = repo.createLoop({ name: 'P', prompt: 'go', intervalMinutes: 3, workspacePath: ws })
  check('createLoop scopes to a project workspace', repo.getChatWorkspace(projLoop.chatId) === ws)
  const dueBefore = repo.dueLoops(Date.now() + 1000).some((l) => l.id === projLoop.id)
  repo.markLoopRan(projLoop.id)
  const dueAfter = repo.dueLoops(Date.now() + 1000).some((l) => l.id === projLoop.id)
  check('markLoopRan advances the schedule', dueBefore === true && dueAfter === false)

  // ---- sessions status excludes loop chats ----
  const status = repo.listSessionsStatus()
  check('listSessionsStatus includes the main session', status.some((s) => s.id === chat.id))
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
    img.ok && (img.image ?? '').startsWith('data:image/png;base64,') && img.output.startsWith('Read image'),
    img.output
  )
  const list = await run('list', { path: '.' })
  check('list tool', list.ok && list.output.includes('hello.txt'))
  const globr = await run('glob', { pattern: '*.txt' })
  check('glob tool', globr.ok && globr.output.includes('hello.txt'))
  const grepr = await run('grep', { pattern: 'WORLD', include: '*.txt' })
  check('grep tool', grepr.ok && grepr.output.includes('hello.txt'))
  const bashCmd = process.platform === 'win32' ? 'Write-Output roxy-bash-ok' : 'echo roxy-bash-ok'
  const bashr = await run('bash', { command: bashCmd })
  check('bash tool runs in workspace', bashr.ok && bashr.output.includes('roxy-bash-ok'), bashr.output)

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
  check('bash_output reads new output', bgOut.ok && bgOut.output.includes('roxy-bg-ok'), bgOut.output)
  const bgKill = await run('bash_kill', { id: bgId })
  check('bash_kill stops the process', bgKill.ok, bgKill.output)
  check('bash_output rejects an unknown id', !(await run('bash_output', { id: 'bg_nope' })).ok)

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
        (Boolean(shot.image) && shot.image!.startsWith('data:image/') && shot.output.includes('.roxy')),
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
