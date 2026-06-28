import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { CreateChatInput, CreateLoopInput, LlmStartInput } from '../../shared/api'
import type { AddMessageInput, ConnectProviderInput, QueueImage, ReasoningEffort } from '../../shared/types'
import * as repo from '../db/repo'
import * as copilot from '../services/copilot'
import * as browser from '../services/browser'
import { listModels } from '../services/models'
import { compactChat } from '../services/compaction'
import { runTool, runAgentTurn } from '../harness'
import { checkForUpdates, quitAndInstall, getUpdateState } from '../services/updater'

/** In-flight streamed completions, keyed by requestId, so they can be aborted. */
const llmControllers = new Map<string, AbortController>()

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
  ipcMain.handle(CHANNELS.chatsRemove, (_e, id: string) => repo.removeChat(id))

  // ---- messages ----
  ipcMain.handle(CHANNELS.messagesList, (_e, chatId: string) => repo.listMessages(chatId))
  ipcMain.handle(CHANNELS.messagesAdd, (_e, input: AddMessageInput) => repo.addMessage(input))

  // ---- integrations ----
  ipcMain.handle(CHANNELS.integrationsList, () => repo.listIntegrations())
  ipcMain.handle(CHANNELS.integrationsSetEnabled, (_e, id: string, enabled: boolean) =>
    repo.setIntegrationEnabled(id, enabled)
  )

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
  ipcMain.handle(CHANNELS.queueList, (_e, chatId: string) => repo.listQueue(chatId))
  ipcMain.handle(CHANNELS.queueAdd, (_e, chatId: string, content: string, images?: QueueImage[]) =>
    repo.enqueue(chatId, content, images)
  )
  ipcMain.handle(CHANNELS.queueRemove, (_e, id: string) => repo.removeQueueItem(id))

  // ---- llm (streamed model completions) ----
  ipcMain.handle(CHANNELS.llmStart, async (event, input: LlmStartInput) => {
    const controller = new AbortController()
    llmControllers.set(input.requestId, controller)
    const cwd = repo.getChatWorkspace(input.sessionId) ?? ''
    try {
      await runAgentTurn({
        providerId: input.providerId,
        model: input.model,
        messages: input.messages,
        reasoning: input.reasoning,
        reasoningEffort: input.reasoningEffort,
        contextLimit: input.contextLimit,
        cwd,
        chatId: input.sessionId,
        signal: controller.signal,
        emit: (llmEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(CHANNELS.llmDelta, { requestId: input.requestId, event: llmEvent })
          }
        }
      })
      // The turn's subagents are one-shot — drop any with nothing queued so they
      // don't linger in the sidebar after the work is done.
      repo.pruneSubchats(input.sessionId)
      return { ok: true }
    } catch (e) {
      if (controller.signal.aborted) return { ok: false, error: 'Stopped.' }
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      llmControllers.delete(input.requestId)
    }
  })
  ipcMain.handle(CHANNELS.llmAbort, (_e, requestId: string) => {
    llmControllers.get(requestId)?.abort()
  })

  // ---- models (models.dev catalog) ----
  ipcMain.handle(CHANNELS.modelsList, (_e, providerId: string) => listModels(providerId))

  // ---- context (compaction) ----
  ipcMain.handle(CHANNELS.contextCompact, (_e, chatId: string, providerId: string, model: string) =>
    compactChat(chatId, providerId, model)
  )

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
}
