/**
 * The typed contract exposed to the renderer as `window.roxy`.
 * Implemented in src/preload/index.ts, handled in src/main/ipc/*.
 */
import type {
  AddMessageInput,
  AppSettings,
  AppVersions,
  Chat,
  ConnectedProvider,
  ConnectProviderInput,
  DeviceFlowStart,
  IntegrationConnection,
  Loop,
  Message,
  QueueImage,
  QueueItem,
  ReasoningEffort,
  SessionKind,
  ToolDiff,
  ToolResult
} from './types'

export interface CreateChatInput {
  title?: string
  kind?: SessionKind
  providerId?: string | null
  model?: string | null
  workspacePath?: string | null
  parentId?: string | null
}

export interface CreateLoopInput {
  name: string
  prompt: string
  intervalMinutes: number
  /** Project (workspace folder) the loop's agent runs in; null = no workspace. */
  workspacePath?: string | null
}

/** An image attached to a user message, sent to vision-capable models. */
export interface ChatImage {
  /** Image as a data URL (data:image/png;base64,…). */
  dataUrl: string
  /** MIME type, e.g. 'image/png'. */
  mediaType: string
}

/** A single chat-completion message sent to the model. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Images to send alongside the text (user messages only). */
  images?: ChatImage[]
}

export interface LlmStartInput {
  requestId: string
  sessionId: string
  providerId: string
  model: string
  messages: ChatMessage[]
  /** Thinking effort for reasoning-capable models. */
  reasoningEffort?: ReasoningEffort
  /** Whether the model supports reasoning (gates sending the effort param). */
  reasoning?: boolean
  /** Effective context-window budget in tokens (drives large-context headers). */
  contextLimit?: number
}

export interface LlmResult {
  ok: boolean
  error?: string
}

/** One streamed step of an agent turn: prose text, or a tool call start/delta/end. */
export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; callId: string; tool: string; title?: string }
  | { type: 'tool-delta'; callId: string; chunk: string }
  | { type: 'tool-end'; callId: string; output: string; ok: boolean; image?: string; diff?: ToolDiff }

export interface LlmDelta {
  requestId: string
  event: LlmEvent
}

/** A model offered by a provider (from models.dev). */
export interface ModelInfo {
  id: string
  name: string
  reasoning: boolean
  toolCall: boolean
  /** Max input context window in tokens, when known. */
  contextLimit?: number
  /** Max output tokens, when known. */
  outputLimit?: number
}

/** Navigation state of the Roxy browser, for the URL-bar toolbar. */
export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/** One open tab in the Roxy browser, for the toolbar's tab strip. */
export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
}

/** Auto-update lifecycle state (main -> renderer). */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'not-available' }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

/** Snapshot returned by `updates.getState()`. */
export interface UpdateInfo {
  /** The running app version. */
  version: string
  /** False in dev/unpacked builds, where updates are inert. */
  packaged: boolean
  state: UpdateState
}

export interface RoxyApi {
  settings: {
    getAll(): Promise<AppSettings>
    setActiveProvider(providerId: string, model: string | null): Promise<AppSettings>
    setReasoningEffort(level: ReasoningEffort): Promise<AppSettings>
    setContextLimit(limit: number | null): Promise<AppSettings>
    completeOnboarding(): Promise<AppSettings>
    reset(): Promise<void>
  }
  providers: {
    listConnected(): Promise<ConnectedProvider[]>
    connect(input: ConnectProviderInput): Promise<ConnectedProvider>
    disconnect(id: string): Promise<void>
  }
  chats: {
    list(): Promise<Chat[]>
    create(input?: CreateChatInput): Promise<Chat>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
  }
  messages: {
    list(chatId: string): Promise<Message[]>
    add(input: AddMessageInput): Promise<Message>
  }
  integrations: {
    list(): Promise<IntegrationConnection[]>
    setEnabled(id: string, enabled: boolean): Promise<void>
  }
  system: {
    getVersions(): Promise<AppVersions>
    openExternal(url: string): Promise<void>
  }
  updates: {
    /** Manually trigger an update check. */
    check(): Promise<void>
    /** Quit and install a downloaded update. */
    install(): Promise<void>
    /** The running version + the latest known update state. */
    getState(): Promise<UpdateInfo>
    /** Subscribe to update-status changes; returns an unsubscribe fn. */
    onStatus(callback: (state: UpdateState) => void): () => void
  }
  copilot: {
    start(): Promise<DeviceFlowStart>
    poll(deviceCode: string, interval: number): Promise<ConnectedProvider>
  }
  dialog: {
    openWorkspace(): Promise<string | null>
  }
  loops: {
    list(): Promise<Loop[]>
    create(input: CreateLoopInput): Promise<Loop>
    setEnabled(id: string, enabled: boolean): Promise<void>
    remove(id: string): Promise<void>
    /** Subscribe to heartbeat ticks; returns an unsubscribe fn. */
    onTick(callback: (loopId: string) => void): () => void
  }
  tools: {
    run(sessionId: string, name: string, input: Record<string, unknown>): Promise<ToolResult>
  }
  queue: {
    list(chatId: string): Promise<QueueItem[]>
    add(chatId: string, content: string, images?: QueueImage[]): Promise<QueueItem>
    remove(id: string): Promise<void>
  }
  llm: {
    /** Stream a completion; text deltas arrive via onDelta. Resolves when done. */
    start(input: LlmStartInput): Promise<LlmResult>
    abort(requestId: string): Promise<void>
    onDelta(callback: (payload: LlmDelta) => void): () => void
  }
  models: {
    /** Live model list for a provider id, from models.dev. */
    list(providerId: string): Promise<ModelInfo[]>
  }
  context: {
    /** Summarize a chat's history into a compaction summary; returns the chat. */
    compact(chatId: string, providerId: string, model: string): Promise<Chat>
  }
  browser: {
    /** Open/focus the browser window (optionally navigating to a URL). */
    open(url?: string): Promise<void>
    navigate(url: string): Promise<void>
    back(): Promise<void>
    forward(): Promise<void>
    reload(): Promise<void>
    stop(): Promise<void>
    /** Open a new tab (optionally at a URL) and make it active. */
    newTab(url?: string): Promise<void>
    closeTab(id: string): Promise<void>
    activateTab(id: string): Promise<void>
    /** Reorder a tab to a new index in the strip (drag-to-reorder). */
    moveTab(id: string, toIndex: number): Promise<void>
    /** Subscribe to the browser toolbar's navigation state; returns an unsubscribe fn. */
    onState(callback: (state: BrowserState) => void): () => void
    /** Subscribe to the open tab list; returns an unsubscribe fn. */
    onTabs(callback: (tabs: BrowserTab[]) => void): () => void
  }
}
