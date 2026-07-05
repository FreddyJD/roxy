import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { CreateChatInput, CreateLoopInput, LlmStartInput, McpServerView, RemoteStartInput, SkillView, SkillWriteInput, UpsertMcpServerInput } from '../../shared/api'
import type { AddMessageInput, ConnectProviderInput, QueueImage, ReasoningEffort } from '../../shared/types'
import * as repo from '../db/repo'
import * as copilot from '../services/copilot'
import * as browser from '../services/browser'
import { listModels } from '../services/models'
import { compactChat } from '../services/compaction'
import { runTool, projectInstructions } from '../harness'
import { checkForUpdates, quitAndInstall, getUpdateState } from '../services/updater'
import {
  cancelBackgroundJob,
  cancelSessionBackgroundJobs,
  listRunningBackgroundJobs
} from '../services/background-tasks'
import { mcpServerSummaries, reconnectMcpServer, disposeConnection } from '../services/mcp'
import { listSkills, refreshSkills, readSkill, writeSkill, deleteSkill, installSkillFromSource } from '../services/skills'
import { runSessionTurn } from '../services/session-turn'
import * as remote from '../services/remote'

/** In-flight streamed completions, keyed by requestId, so they can be aborted. */
const llmControllers = new Map<string, AbortController>()

/** Merge persisted MCP server rows with their live connection status for the UI. */
function listMcpServersWithStatus(): McpServerView[] {
  const statusById = new Map(mcpServerSummaries().map((s) => [s.id, s]))
  return repo.listMcpServers().map((rec) => {
    const live = statusById.get(rec.id)
    return {
      id: rec.id,
      config: rec.config,
      enabled: rec.enabled,
      status: live?.status ?? 'disabled',
      tools: live?.tools ?? [],
      error: live?.error
    }
  })
}

/**
 * Discover skills for the Skills page. With no cwd we scan the user's global
 * skill roots (~/.roxy/skills etc.); a workspace path additionally surfaces that
 * project's skills. Returns metadata only (bodies load on demand via the tool).
 */
async function discoverSkillViews(cwd?: string): Promise<SkillView[]> {
  const base = cwd || app.getPath('home')
  const skills = await listSkills(base)
  return skills.map(({ name, description, location, source }) => ({ name, description, location, source }))
}

/**
 * Register every IPC handler. Each maps 1:1 to a method on the `window.roxy`
 * bridge declared in src/preload/index.ts. Add agent capabilities by adding a
 * channel here + a matching bridge method.
 */
export function registerIpc(): void {
  // ---- settings ----
  ipcMain.handle(CHANNELS.settingsGetAll, () => repo.getSettings())
  ipcMain.handle(
    CHANNELS.settingsSetActiveProvider,
    (_e, providerId: string, model: string | null) => repo.setActiveProvider(providerId, model)
  )
  ipcMain.handle(CHANNELS.settingsSetReasoningEffort, (_e, level: ReasoningEffort) =>
    repo.setReasoningEffort(level)
  )
  ipcMain.handle(CHANNELS.settingsSetContextLimit, (_e, limit: number | null) =>
    repo.setContextLimit(limit)
  )
  ipcMain.handle(CHANNELS.settingsSetWebSearchApiKey, (_e, key: string | null) =>
    repo.setWebSearchApiKey(key)
  )
  ipcMain.handle(CHANNELS.settingsCompleteOnboarding, () => repo.completeOnboarding())
  ipcMain.handle(CHANNELS.settingsReset, () => repo.resetAll())

  // ---- providers ----
  ipcMain.handle(CHANNELS.providersList, () => repo.listConnectedProviders())
  ipcMain.handle(CHANNELS.providersConnect, (_e, input: ConnectProviderInput) =>
    repo.connectProvider(input)
  )
  ipcMain.handle(CHANNELS.providersDisconnect, (_e, id: string) => repo.disconnectProvider(id))

  // ---- chats ----
  ipcMain.handle(CHANNELS.chatsList, () => repo.listChats())
  ipcMain.handle(CHANNELS.chatsCreate, (_e, input?: CreateChatInput) => repo.createChat(input))
  ipcMain.handle(CHANNELS.chatsRename, (_e, id: string, title: string) =>
    repo.renameChat(id, title)
  )
  ipcMain.handle(CHANNELS.chatsRemove, (_e, id: string) => {
    // Cancel any background subagents this session launched before it's deleted,
    // so detached work doesn't keep running against a gone parent.
    cancelSessionBackgroundJobs(id)
    return repo.removeChat(id)
  })
  ipcMain.handle(CHANNELS.chatsReorder, (_e, workspacePath: string | null, ids: string[]) =>
    repo.reorderSessions(workspacePath, ids)
  )

  // ---- messages ----
  ipcMain.handle(CHANNELS.messagesList, (_e, chatId: string) => repo.listMessages(chatId))
  ipcMain.handle(CHANNELS.messagesAdd, (_e, input: AddMessageInput) => repo.addMessage(input))

  // ---- integrations ----
  ipcMain.handle(CHANNELS.integrationsList, () => repo.listIntegrations())
  ipcMain.handle(CHANNELS.integrationsSetEnabled, (_e, id: string, enabled: boolean) =>
    repo.setIntegrationEnabled(id, enabled)
  )

  // ---- MCP servers (Phase 13) ----
  ipcMain.handle(CHANNELS.mcpList, () => listMcpServersWithStatus())
  ipcMain.handle(CHANNELS.mcpUpsert, (_e, input: UpsertMcpServerInput) => {
    repo.upsertMcpServer(input)
    return listMcpServersWithStatus()
  })
  ipcMain.handle(CHANNELS.mcpRemove, async (_e, id: string) => {
    await disposeConnection(id)
    repo.deleteMcpServer(id)
    return listMcpServersWithStatus()
  })
  ipcMain.handle(CHANNELS.mcpSetEnabled, async (_e, id: string, enabled: boolean) => {
    repo.setMcpServerEnabled(id, enabled)
    // Disabling should immediately tear down the live connection; enabling connects
    // lazily on the next agent turn (or via an explicit reconnect).
    if (!enabled) await disposeConnection(id)
    return listMcpServersWithStatus()
  })
  ipcMain.handle(CHANNELS.mcpReconnect, async (_e, id: string) => {
    const rec = repo.listMcpServers().find((r) => r.id === id)
    if (rec) await reconnectMcpServer(rec, app.getPath('home'))
    return listMcpServersWithStatus()
  })

  // ---- skills (SKILL.md discovery) ----
  ipcMain.handle(CHANNELS.skillsList, (_e, cwd?: string) => discoverSkillViews(cwd))
  ipcMain.handle(CHANNELS.skillsRefresh, (_e, cwd?: string) => {
    refreshSkills(cwd || undefined)
    return discoverSkillViews(cwd)
  })
  ipcMain.handle(CHANNELS.skillsRead, async (_e, name: string, cwd?: string) => {
    const skill = await readSkill(name, cwd || app.getPath('home'))
    if (!skill) return null
    const { name: n, description, location, source, content } = skill
    return { name: n, description, location, source, body: content }
  })
  // The Skills page has no workspace context, so it authors GLOBAL skills by
  // default (~/.roxy/skills); the agent's `skill_manage` tool can target either
  // scope. Both go through the same writeSkill/deleteSkill service.
  ipcMain.handle(CHANNELS.skillsCreate, async (_e, input: SkillWriteInput, cwd?: string) => {
    await writeSkill({ ...input, scope: input.scope ?? 'global' }, cwd || '', { mode: 'create' })
    return discoverSkillViews(cwd)
  })
  ipcMain.handle(CHANNELS.skillsUpdate, async (_e, input: SkillWriteInput, cwd?: string) => {
    await writeSkill({ ...input, scope: input.scope ?? 'global' }, cwd || '', { mode: 'edit' })
    return discoverSkillViews(cwd)
  })
  ipcMain.handle(CHANNELS.skillsRemove, async (_e, name: string, cwd?: string) => {
    await deleteSkill(name, cwd || '')
    return discoverSkillViews(cwd)
  })
  // Install skill(s) from a remote source (GitHub repo/URL or a direct SKILL.md).
  // The Skills page has no workspace context, so it installs GLOBAL skills; the
  // agent's `skill_manage` install action can target the workspace.
  ipcMain.handle(CHANNELS.skillsInstall, async (_e, source: string, cwd?: string) => {
    const res = await installSkillFromSource(source, {
      scope: cwd ? 'workspace' : 'global',
      cwd: cwd || undefined
    })
    return {
      ok: res.ok,
      installed: res.installed.map(({ name, location }) => ({ name, location })),
      skipped: res.skipped,
      error: res.error,
      skills: await discoverSkillViews(cwd)
    }
  })

  // ---- system ----
  ipcMain.handle(CHANNELS.systemGetVersions, () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }))

  // ---- auto-update (GitHub Releases) ----
  ipcMain.handle(CHANNELS.updateCheck, () => checkForUpdates())
  ipcMain.handle(CHANNELS.updateInstall, () => quitAndInstall())
  ipcMain.handle(CHANNELS.updateGetState, () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    state: getUpdateState()
  }))
  ipcMain.handle(CHANNELS.systemOpenExternal, async (_e, url: string) => {
    // Only allow web URLs — never file:, javascript:, or other schemes.
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        await shell.openExternal(url)
      }
    } catch {
      // ignore malformed URLs
    }
  })

  // ---- github copilot device flow ----
  ipcMain.handle(CHANNELS.copilotStart, () => copilot.startDeviceFlow())
  ipcMain.handle(CHANNELS.copilotPoll, async (_e, deviceCode: string, interval: number) => {
    const token = await copilot.pollForToken(deviceCode, interval)
    const provider = repo.storeCopilotCredential(token)
    repo.setActiveProvider(provider.id, provider.defaultModel ?? null)
    return provider
  })

  // ---- dialogs ----
  ipcMain.handle(CHANNELS.dialogOpenWorkspace, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Open a workspace folder',
      properties: ['openDirectory', 'createDirectory'] as const
    }
    const result = win
      ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ---- loops ----
  ipcMain.handle(CHANNELS.loopsList, () => repo.listLoops())
  ipcMain.handle(CHANNELS.loopsCreate, (_e, input: CreateLoopInput) => repo.createLoop(input))
  ipcMain.handle(CHANNELS.loopsSetEnabled, (_e, id: string, enabled: boolean) =>
    repo.setLoopEnabled(id, enabled)
  )
  ipcMain.handle(CHANNELS.loopsRemove, (_e, id: string) => repo.removeLoop(id))

  // ---- tools ----
  ipcMain.handle(
    CHANNELS.toolsRun,
    async (_e, sessionId: string, name: string, input: Record<string, unknown>) => {
      const cwd = repo.getChatWorkspace(sessionId)
      // Browser & loop tools don't need a workspace; file/bash tools do.
      const needsWorkspace = !name.startsWith('browser_') && !name.startsWith('loop_')
      if (!cwd && needsWorkspace) {
        return { ok: false, output: 'No workspace is open for this session.' }
      }
      return runTool(name, input ?? {}, { cwd: cwd ?? '' })
    }
  )

  // ---- queue ----
  // Each mutation re-mirrors the shared queue to any paired phone (remote is a
  // no-op when nothing is shared), so desktop-side edits stay in sync on both ends.
  ipcMain.handle(CHANNELS.queueList, (_e, chatId: string) => repo.listQueue(chatId))
  ipcMain.handle(CHANNELS.queueAdd, (_e, chatId: string, content: string, images?: QueueImage[]) => {
    const item = repo.enqueue(chatId, content, images)
    remote.notifyQueueChanged()
    return item
  })
  ipcMain.handle(CHANNELS.queueRemove, (_e, id: string) => {
    repo.removeQueueItem(id)
    remote.notifyQueueChanged()
  })
  ipcMain.handle(CHANNELS.queueReorder, (_e, chatId: string, ids: string[]) => {
    repo.reorderQueue(chatId, ids)
    remote.notifyQueueChanged()
  })

  // ---- llm (streamed model completions) ----
  // The turn body lives in runSessionTurn so the remote host (phone-driven)
  // path runs the exact same code. Here we just own the AbortController (for
  // llm:abort) and stream each event to the renderer that started the turn.
  ipcMain.handle(CHANNELS.llmStart, async (event, input: LlmStartInput) => {
    const controller = new AbortController()
    llmControllers.set(input.requestId, controller)
    try {
      return await runSessionTurn(
        input,
        (llmEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(CHANNELS.llmDelta, { requestId: input.requestId, event: llmEvent })
          }
        },
        controller.signal
      )
    } finally {
      llmControllers.delete(input.requestId)
    }
  })
  ipcMain.handle(CHANNELS.llmAbort, (_e, requestId: string) => {
    llmControllers.get(requestId)?.abort()
  })

  // ---- background subagent tasks (Phase 11) ----
  ipcMain.handle(CHANNELS.tasksListRunning, (_e, sessionId: string) =>
    listRunningBackgroundJobs(sessionId)
  )
  ipcMain.handle(CHANNELS.tasksCancel, (_e, jobId: string) => cancelBackgroundJob(jobId))

  // ---- models (models.dev catalog) ----
  ipcMain.handle(CHANNELS.modelsList, (_e, providerId: string) => listModels(providerId))

  // ---- context (compaction) ----
  ipcMain.handle(CHANNELS.contextCompact, (_e, chatId: string, providerId: string, model: string) =>
    compactChat(chatId, providerId, model)
  )
  ipcMain.handle(CHANNELS.contextInstructions, (_e, cwd: string) => projectInstructions(cwd))

  // ---- browser (URL bar + manual control) ----
  ipcMain.handle(CHANNELS.browserOpen, async (_e, url?: string) => {
    browser.openWindow()
    if (url) await browser.navigate(url)
  })
  ipcMain.handle(CHANNELS.browserNavigate, (_e, url: string) => browser.navigate(url))
  ipcMain.handle(CHANNELS.browserBack, () => browser.back())
  ipcMain.handle(CHANNELS.browserForward, () => browser.forward())
  ipcMain.handle(CHANNELS.browserReload, () => browser.reload())
  ipcMain.handle(CHANNELS.browserStop, () => browser.stop())
  ipcMain.handle(CHANNELS.browserNewTab, (_e, url?: string) => browser.newTab(url))
  ipcMain.handle(CHANNELS.browserCloseTab, (_e, id: string) => browser.closeTab(id))
  ipcMain.handle(CHANNELS.browserActivateTab, (_e, id: string) => browser.activateTab(id))
  ipcMain.handle(CHANNELS.browserMoveTab, (_e, id: string, toIndex: number) =>
    browser.moveTab(id, toIndex)
  )

  // ---- remote (Remote Workspace: share a session to a phone via roxy.gg) ----
  ipcMain.handle(CHANNELS.remoteStart, (_e, input: RemoteStartInput) => remote.start(input))
  ipcMain.handle(CHANNELS.remoteStop, () => remote.stop())
  ipcMain.handle(CHANNELS.remoteStatus, () => remote.status())
}
