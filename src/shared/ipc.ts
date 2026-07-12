/** IPC channel names shared by the preload bridge and the main-process handlers. */
export const CHANNELS = {
  settingsGetAll: 'settings:getAll',
  settingsSetActiveProvider: 'settings:setActiveProvider',
  settingsSetReasoningEffort: 'settings:setReasoningEffort',
  settingsSetContextLimit: 'settings:setContextLimit',
  settingsSetWebSearchApiKey: 'settings:setWebSearchApiKey',
  settingsCompleteOnboarding: 'settings:completeOnboarding',
  settingsReset: 'settings:reset',

  providersList: 'providers:listConnected',
  providersConnect: 'providers:connect',
  providersDisconnect: 'providers:disconnect',

  chatsList: 'chats:list',
  chatsCreate: 'chats:create',
  chatsRename: 'chats:rename',
  chatsRemove: 'chats:remove',
  chatsReorder: 'chats:reorder',

  /** Project (workspace) display order — read + drag-to-reorder. */
  projectsListOrder: 'projects:listOrder',
  projectsReorder: 'projects:reorder',

  messagesList: 'messages:list',
  messagesAdd: 'messages:add',

  integrationsList: 'integrations:list',
  integrationsSetEnabled: 'integrations:setEnabled',

  mcpList: 'mcp:list',
  mcpUpsert: 'mcp:upsert',
  mcpRemove: 'mcp:remove',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpReconnect: 'mcp:reconnect',

  skillsList: 'skills:list',
  skillsRefresh: 'skills:refresh',
  skillsRead: 'skills:read',
  skillsCreate: 'skills:create',
  skillsUpdate: 'skills:update',
  skillsRemove: 'skills:remove',
  skillsInstall: 'skills:install',

  systemGetVersions: 'system:getVersions',
  systemOpenExternal: 'system:openExternal',

  copilotStart: 'copilot:start',
  copilotPoll: 'copilot:poll',

  dialogOpenWorkspace: 'dialog:openWorkspace',

  /** Portable backup: export/import global skills + MCP configs to a file. */
  configExport: 'config:export',
  configImport: 'config:import',

  loopsList: 'loops:list',
  loopsCreate: 'loops:create',
  loopsSetEnabled: 'loops:setEnabled',
  loopsRemove: 'loops:remove',
  /** main -> renderer event when a loop heartbeat fires */
  loopsTick: 'loops:tick',

  toolsRun: 'tools:run',

  queueList: 'queue:list',
  queueAdd: 'queue:add',
  queueRemove: 'queue:remove',
  queueReorder: 'queue:reorder',
  queueUpdate: 'queue:update',

  usageStats: 'usage:stats',

  llmStart: 'llm:start',
  llmAbort: 'llm:abort',
  /** main -> renderer event carrying a streamed completion chunk */
  llmDelta: 'llm:delta',

  /** main -> renderer event when a background subagent task changes state */
  taskUpdate: 'task:update',
  /** renderer -> main: list a session's running background tasks */
  tasksListRunning: 'tasks:listRunning',
  /** renderer -> main: cancel a running background task */
  tasksCancel: 'tasks:cancel',

  modelsList: 'models:list',

  contextCompact: 'context:compact',
  /** Load project instruction files (AGENTS.md/CLAUDE.md/CONTEXT.md) for a cwd. */
  contextInstructions: 'context:instructions',

  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateGetState: 'update:get-state',
  /** main -> renderer: auto-update status changes */
  updateStatus: 'update:status',

  browserOpen: 'browser:open',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserStop: 'browser:stop',
  browserNewTab: 'browser:new-tab',
  browserCloseTab: 'browser:close-tab',
  browserActivateTab: 'browser:activate-tab',
  browserMoveTab: 'browser:move-tab',
  /** main -> browser toolbar: navigation state */
  browserState: 'browser:state',
  /** main -> browser toolbar: open tab list */
  browserTabs: 'browser:tabs',

  remoteStart: 'remote:start',
  remoteStop: 'remote:stop',
  remoteStatus: 'remote:status',
  /** main -> renderer: Remote Workspace sharing status changed */
  remoteState: 'remote:state'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
