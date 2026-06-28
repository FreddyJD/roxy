import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { CHANNELS } from '../shared/ipc'
import type {
  RoxyApi,
  LlmDelta,
  BrowserState,
  BrowserTab,
  TerminalSessionInfo,
  TerminalDataEvent,
  TerminalExitEvent
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
  system: {
    getVersions: () => ipcRenderer.invoke(CHANNELS.systemGetVersions),
    openExternal: (url) => ipcRenderer.invoke(CHANNELS.systemOpenExternal, url)
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
    remove: (id) => ipcRenderer.invoke(CHANNELS.queueRemove, id)
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
  models: {
    list: (providerId) => ipcRenderer.invoke(CHANNELS.modelsList, providerId)
  },
  context: {
    compact: (chatId, providerId, model) =>
      ipcRenderer.invoke(CHANNELS.contextCompact, chatId, providerId, model)
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
  },
  terminal: {
    list: () => ipcRenderer.invoke(CHANNELS.terminalList),
    create: (input) => ipcRenderer.invoke(CHANNELS.terminalCreate, input),
    read: (id) => ipcRenderer.invoke(CHANNELS.terminalRead, id),
    write: (id, data) => ipcRenderer.invoke(CHANNELS.terminalWrite, id, data),
    kill: (id) => ipcRenderer.invoke(CHANNELS.terminalKill, id),
    onData: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, p: TerminalDataEvent): void => callback(p)
      ipcRenderer.on(CHANNELS.terminalData, handler)
      return () => ipcRenderer.removeListener(CHANNELS.terminalData, handler)
    },
    onExit: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, p: TerminalExitEvent): void => callback(p)
      ipcRenderer.on(CHANNELS.terminalExit, handler)
      return () => ipcRenderer.removeListener(CHANNELS.terminalExit, handler)
    },
    onSessions: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, s: TerminalSessionInfo[]): void => callback(s)
      ipcRenderer.on(CHANNELS.terminalSessions, handler)
      return () => ipcRenderer.removeListener(CHANNELS.terminalSessions, handler)
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
