import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { CHANNELS } from '../shared/ipc'
import type {
  RoxyApi,
  LlmDelta,
  TaskUpdate,
  BrowserState,
  BrowserTab,
  UpdateState
} from '../shared/api'

/**
 * The typed bridge exposed to the renderer as `window.roxy`. Every method maps
 * to an ipcMain.handle channel registered in src/main/ipc/index.ts.
 */
const roxy: RoxyApi = {
  settings: {
    getAll: () => ipcRenderer.invoke(CHANNELS.settingsGetAll),
    setActiveProvider: (providerId, model) =>
      ipcRenderer.invoke(CHANNELS.settingsSetActiveProvider, providerId, model),
    setReasoningEffort: (level) => ipcRenderer.invoke(CHANNELS.settingsSetReasoningEffort, level),
    setContextLimit: (limit) => ipcRenderer.invoke(CHANNELS.settingsSetContextLimit, limit),
    setWebSearchApiKey: (key) => ipcRenderer.invoke(CHANNELS.settingsSetWebSearchApiKey, key),
    completeOnboarding: () => ipcRenderer.invoke(CHANNELS.settingsCompleteOnboarding),
    reset: () => ipcRenderer.invoke(CHANNELS.settingsReset)
  },
  providers: {
    listConnected: () => ipcRenderer.invoke(CHANNELS.providersList),
    connect: (input) => ipcRenderer.invoke(CHANNELS.providersConnect, input),
    disconnect: (id) => ipcRenderer.invoke(CHANNELS.providersDisconnect, id)
  },
  chats: {
    list: () => ipcRenderer.invoke(CHANNELS.chatsList),
    create: (input) => ipcRenderer.invoke(CHANNELS.chatsCreate, input),
    rename: (id, title) => ipcRenderer.invoke(CHANNELS.chatsRename, id, title),
    remove: (id) => ipcRenderer.invoke(CHANNELS.chatsRemove, id)
  },
  messages: {
    list: (chatId) => ipcRenderer.invoke(CHANNELS.messagesList, chatId),
    add: (input) => ipcRenderer.invoke(CHANNELS.messagesAdd, input)
  },
  integrations: {
    list: () => ipcRenderer.invoke(CHANNELS.integrationsList),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.integrationsSetEnabled, id, enabled)
  },
  mcp: {
    list: () => ipcRenderer.invoke(CHANNELS.mcpList),
    upsert: (input) => ipcRenderer.invoke(CHANNELS.mcpUpsert, input),
    remove: (id) => ipcRenderer.invoke(CHANNELS.mcpRemove, id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.mcpSetEnabled, id, enabled),
    reconnect: (id) => ipcRenderer.invoke(CHANNELS.mcpReconnect, id)
  },
  skills: {
    list: (cwd) => ipcRenderer.invoke(CHANNELS.skillsList, cwd),
    refresh: (cwd) => ipcRenderer.invoke(CHANNELS.skillsRefresh, cwd),
    read: (name, cwd) => ipcRenderer.invoke(CHANNELS.skillsRead, name, cwd),
    create: (input, cwd) => ipcRenderer.invoke(CHANNELS.skillsCreate, input, cwd),
    update: (input, cwd) => ipcRenderer.invoke(CHANNELS.skillsUpdate, input, cwd),
    remove: (name, cwd) => ipcRenderer.invoke(CHANNELS.skillsRemove, name, cwd),
    install: (source, cwd) => ipcRenderer.invoke(CHANNELS.skillsInstall, source, cwd)
  },
  system: {
    getVersions: () => ipcRenderer.invoke(CHANNELS.systemGetVersions),
    openExternal: (url) => ipcRenderer.invoke(CHANNELS.systemOpenExternal, url)
  },
  updates: {
    check: () => ipcRenderer.invoke(CHANNELS.updateCheck),
    install: () => ipcRenderer.invoke(CHANNELS.updateInstall),
    getState: () => ipcRenderer.invoke(CHANNELS.updateGetState),
    onStatus: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, s: UpdateState): void => callback(s)
      ipcRenderer.on(CHANNELS.updateStatus, handler)
      return () => ipcRenderer.removeListener(CHANNELS.updateStatus, handler)
    }
  },
  copilot: {
    start: () => ipcRenderer.invoke(CHANNELS.copilotStart),
    poll: (deviceCode, interval) => ipcRenderer.invoke(CHANNELS.copilotPoll, deviceCode, interval)
  },
  dialog: {
    openWorkspace: () => ipcRenderer.invoke(CHANNELS.dialogOpenWorkspace)
  },
  loops: {
    list: () => ipcRenderer.invoke(CHANNELS.loopsList),
    create: (input) => ipcRenderer.invoke(CHANNELS.loopsCreate, input),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.loopsSetEnabled, id, enabled),
    remove: (id) => ipcRenderer.invoke(CHANNELS.loopsRemove, id),
    onTick: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, loopId: string): void => callback(loopId)
      ipcRenderer.on(CHANNELS.loopsTick, handler)
      return () => ipcRenderer.removeListener(CHANNELS.loopsTick, handler)
    }
  },
  tools: {
    run: (sessionId, name, input) => ipcRenderer.invoke(CHANNELS.toolsRun, sessionId, name, input)
  },
  queue: {
    list: (chatId) => ipcRenderer.invoke(CHANNELS.queueList, chatId),
    add: (chatId, content, images) => ipcRenderer.invoke(CHANNELS.queueAdd, chatId, content, images),
    remove: (id) => ipcRenderer.invoke(CHANNELS.queueRemove, id),
    reorder: (chatId, ids) => ipcRenderer.invoke(CHANNELS.queueReorder, chatId, ids)
  },
  llm: {
    start: (input) => ipcRenderer.invoke(CHANNELS.llmStart, input),
    abort: (requestId) => ipcRenderer.invoke(CHANNELS.llmAbort, requestId),
    onDelta: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LlmDelta): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.llmDelta, handler)
      return () => ipcRenderer.removeListener(CHANNELS.llmDelta, handler)
    }
  },
  tasks: {
    listRunning: (sessionId) => ipcRenderer.invoke(CHANNELS.tasksListRunning, sessionId),
    cancel: (jobId) => ipcRenderer.invoke(CHANNELS.tasksCancel, jobId),
    onUpdate: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, update: TaskUpdate): void =>
        callback(update)
      ipcRenderer.on(CHANNELS.taskUpdate, handler)
      return () => ipcRenderer.removeListener(CHANNELS.taskUpdate, handler)
    }
  },
  models: {
    list: (providerId) => ipcRenderer.invoke(CHANNELS.modelsList, providerId)
  },
  context: {
    compact: (chatId, providerId, model) =>
      ipcRenderer.invoke(CHANNELS.contextCompact, chatId, providerId, model),
    instructions: (cwd) => ipcRenderer.invoke(CHANNELS.contextInstructions, cwd)
  },
  browser: {
    open: (url) => ipcRenderer.invoke(CHANNELS.browserOpen, url),
    navigate: (url) => ipcRenderer.invoke(CHANNELS.browserNavigate, url),
    back: () => ipcRenderer.invoke(CHANNELS.browserBack),
    forward: () => ipcRenderer.invoke(CHANNELS.browserForward),
    reload: () => ipcRenderer.invoke(CHANNELS.browserReload),
    stop: () => ipcRenderer.invoke(CHANNELS.browserStop),
    newTab: (url) => ipcRenderer.invoke(CHANNELS.browserNewTab, url),
    closeTab: (id) => ipcRenderer.invoke(CHANNELS.browserCloseTab, id),
    activateTab: (id) => ipcRenderer.invoke(CHANNELS.browserActivateTab, id),
    moveTab: (id, toIndex) => ipcRenderer.invoke(CHANNELS.browserMoveTab, id, toIndex),
    onState: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: BrowserState): void =>
        callback(state)
      ipcRenderer.on(CHANNELS.browserState, handler)
      return () => ipcRenderer.removeListener(CHANNELS.browserState, handler)
    },
    onTabs: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, tabs: BrowserTab[]): void =>
        callback(tabs)
      ipcRenderer.on(CHANNELS.browserTabs, handler)
      return () => ipcRenderer.removeListener(CHANNELS.browserTabs, handler)
    }
  }
}

// With context isolation on (the secure default) we expose the bridge through
// the contextBridge. The `else` branch is only a fallback for sandbox-off dev.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('roxy', roxy)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (defined in index.d.ts)
  window.electron = electronAPI
  // @ts-ignore (defined in index.d.ts)
  window.roxy = roxy
}
