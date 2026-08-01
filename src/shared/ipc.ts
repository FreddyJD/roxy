/** IPC channel names shared by the preload bridge and the main-process handlers. */
export const CHANNELS = {
  settingsGetAll: 'settings:getAll',
  settingsSetActiveProvider: 'settings:setActiveProvider',
  settingsSetActiveAgent: 'settings:setActiveAgent',
  settingsSetReasoningEffort: 'settings:setReasoningEffort',
  settingsSetContextLimit: 'settings:setContextLimit',
  settingsSetWebSearchApiKey: 'settings:setWebSearchApiKey',
  settingsSetAutoWorkstream: 'settings:setAutoWorkstream',
  settingsSetBranchPrefix: 'settings:setBranchPrefix',
  settingsCompleteOnboarding: 'settings:completeOnboarding',
  settingsReset: 'settings:reset',

  providersList: 'providers:listConnected',
  providersConnect: 'providers:connect',
  providersDisconnect: 'providers:disconnect',

  chatsList: 'chats:list',
  chatsCreate: 'chats:create',
  /** Copy a session's history into a new session (see repo.forkChat). */
  chatsFork: 'chats:fork',
  chatsRename: 'chats:rename',
  chatsRemove: 'chats:remove',
  chatsReorder: 'chats:reorder',
  /** Pin part of a single session's inference config (model/mode/effort/context). */
  chatsSetConfig: 'chats:setConfig',
  /**
   * main -> renderer: a session row changed in MAIN, with no renderer call to
   * hang a refresh off. The only source of truth for `worktree_path` / `branch`
   * / `dev_port` is the main process, and it writes them mid-turn (lazy worktree
   * materialization) — so without this push the workstream strip keeps claiming
   * "(pending) / branch pending" until something unrelated happens to refetch.
   */
  chatsUpdated: 'chats:updated',

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

  /** CLIProxyAPI sidecar: use a ChatGPT/Codex subscription via a local proxy. */
  cliproxyStatus: 'cliproxy:status',
  cliproxyLogin: 'cliproxy:login',
  cliproxySignOut: 'cliproxy:signOut',
  cliproxyStop: 'cliproxy:stop',
  /** install from a user-picked archive (blocked networks / air-gapped) */
  cliproxyInstallFile: 'cliproxy:installFile',
  /** main -> renderer: sidecar install/run status changed */
  cliproxyState: 'cliproxy:state',

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

  /** Per-day agent activity for the Settings contribution graph. */
  activityStats: 'activity:stats',

  llmStart: 'llm:start',
  llmAbort: 'llm:abort',
  /**
   * renderer -> main: stop EVERYTHING in flight for a session.
   *
   * llm:abort needs a requestId, which the renderer only has once the turn is
   * already streaming — so it cannot cancel the pre-flight work (compaction
   * above all) that runs first. This is Stop as the user means it, keyed by the
   * one id the UI always has.
   */
  llmAbortSession: 'llm:abortSession',
  /** main -> renderer event carrying a streamed completion chunk */
  llmDelta: 'llm:delta',

  /** main -> renderer event when a background subagent task changes state */
  taskUpdate: 'task:update',
  /** renderer -> main: list a session's running background tasks */
  tasksListRunning: 'tasks:listRunning',
  /** renderer -> main: cancel a running background task */
  tasksCancel: 'tasks:cancel',

  /** main -> renderer: one live step of a subagent, tagged with ITS OWN session id */
  subagentDelta: 'subagent:delta',
  /** renderer -> main: catch-up parts for a subagent already mid-run */
  subagentSnapshot: 'subagent:snapshot',
  /** renderer -> main: every subagent currently running (window (re)load) */
  subagentListRunning: 'subagent:listRunning',
  /** renderer -> main: which chat is on screen, so a viewed sub session isn't pruned */
  subagentSetViewed: 'subagent:setViewed',
  /**
   * renderer -> main: cancel ONE running subagent by its session id.
   *
   * Keyed by sub chat id rather than the background job id `tasks:cancel` uses,
   * because that is the only handle the UI has for a FOREGROUND delegate (which
   * has no job at all) — and it's the id every subagent surface already knows.
   */
  subagentCancel: 'subagent:cancel',

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

  /** renderer -> main: a session's background processes (the Services panel) */
  servicesList: 'services:list',
  /** renderer -> main: full buffered output of one service, for the log view */
  servicesOutput: 'services:output',
  servicesStop: 'services:stop',
  servicesRestart: 'services:restart',
  servicesOpen: 'services:open',

  gitAvailable: 'git:available',
  gitStatus: 'git:status',
  gitBranches: 'git:branches',
  gitWorktrees: 'git:worktrees',
  gitCreateWorktree: 'git:create-worktree',
  gitRemoveWorktree: 'git:remove-worktree',
  gitPruneWorktrees: 'git:prune-worktrees',
  gitRenameBranch: 'git:rename-branch',

  /** Forge = the git host (GitHub/Azure DevOps/GitLab/Bitbucket) behind `origin`. */
  forgeStatus: 'forge:status',
  forgePush: 'forge:push',
  forgePull: 'forge:pull',
  forgeReset: 'forge:reset',
  forgeCreateUrl: 'forge:create-url',
  forgeListHosts: 'forge:list-hosts',
  forgeSetHostKind: 'forge:set-host-kind',
  remoteStart: 'remote:start',
  remoteStop: 'remote:stop',
  remoteStatus: 'remote:status',
  /** main -> renderer: Remote Workspace sharing status changed */
  remoteState: 'remote:state',
  /** main -> renderer: a streamed event from a phone-driven turn (live desktop mirror) */
  remoteDelta: 'remote:delta'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
