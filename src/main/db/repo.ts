import { randomUUID } from 'node:crypto'
import { resolveSeed } from '../../shared/providers'
import type {
  AddMessageInput,
  AppSettings,
  Chat,
  ConnectedProvider,
  ConnectProviderInput,
  IntegrationConnection,
  Loop,
  Message,
  MessagePart,
  MessageRole,
  ProviderAuth,
  ProviderWire,
  QueueImage,
  QueueItem,
  ReasoningEffort,
  SessionKind,
  SessionStatus,
  SessionTask
} from '../../shared/types'
import type { CreateChatInput, CreateLoopInput } from '../../shared/api'
import { getDb } from './database'
import { decryptSecret, encryptSecret } from '../services/secure'

// ---- Row shapes --------------------------------------------------------------

interface ProviderRow {
  id: string
  name: string
  wire: string
  auth: string
  base_url: string | null
  default_model: string | null
  enabled: number
  created_at: number
  has_credential: number
}

interface ChatRow {
  id: string
  title: string
  kind: string
  provider_id: string | null
  model: string | null
  workspace_path: string | null
  parent_id: string | null
  context_summary: string | null
  context_summary_at: number | null
  description: string | null
  tasks: string | null
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  chat_id: string
  role: string
  content: string
  parts: string | null
  created_at: number
}

interface IntegrationRow {
  id: string
  enabled: number
  config: string
  created_at: number
}

// ---- Settings ----------------------------------------------------------------

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    onboardingCompleted: map.get('onboarding_completed') === '1',
    activeProviderId: map.get('active_provider_id') ?? null,
    activeModel: map.get('active_model') ?? null,
    reasoningEffort: ((): ReasoningEffort => {
      const v = map.get('reasoning_effort')
      return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max'
        ? v
        : 'high'
    })(),
    contextLimit: map.get('context_limit') ? Number(map.get('context_limit')) : null
  }
}

function setSetting(key: string, value: string | null): void {
  const db = getDb()
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    return
  }
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}

export function setActiveProvider(providerId: string, model: string | null): AppSettings {
  setSetting('active_provider_id', providerId)
  setSetting('active_model', model)
  return getSettings()
}

export function setReasoningEffort(level: ReasoningEffort): AppSettings {
  setSetting('reasoning_effort', level)
  return getSettings()
}

export function setContextLimit(limit: number | null): AppSettings {
  setSetting('context_limit', limit === null ? null : String(limit))
  return getSettings()
}

export function completeOnboarding(): AppSettings {
  setSetting('onboarding_completed', '1')
  return getSettings()
}

/** Factory reset — wipe all user data (providers, sessions, loops, settings). */
export function resetAll(): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.exec(
      `DELETE FROM loops;
       DELETE FROM messages;
       DELETE FROM chats;
       DELETE FROM credentials;
       DELETE FROM providers;
       DELETE FROM integrations;
       DELETE FROM settings;`
    )
  })
  tx()
}

// ---- Providers ---------------------------------------------------------------

function rowToProvider(row: ProviderRow): ConnectedProvider {
  return {
    id: row.id,
    name: row.name,
    wire: row.wire as ProviderWire,
    auth: row.auth as ProviderAuth,
    baseURL: row.base_url ?? undefined,
    defaultModel: row.default_model ?? undefined,
    hasCredential: row.has_credential > 0,
    enabled: row.enabled > 0,
    createdAt: row.created_at
  }
}

const PROVIDER_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM credentials c WHERE c.provider_id = p.id) AS has_credential
  FROM providers p
`

export function listConnectedProviders(): ConnectedProvider[] {
  const rows = getDb()
    .prepare(`${PROVIDER_SELECT} ORDER BY p.created_at ASC`)
    .all() as ProviderRow[]
  return rows.map(rowToProvider)
}

function getProvider(id: string): ConnectedProvider | undefined {
  const row = getDb().prepare(`${PROVIDER_SELECT} WHERE p.id = ?`).get(id) as
    | ProviderRow
    | undefined
  return row ? rowToProvider(row) : undefined
}

export function connectProvider(input: ConnectProviderInput): ConnectedProvider {
  const seed = resolveSeed(input.id)
  const now = Date.now()
  const baseURL = input.baseURL?.trim() || seed.baseURL || null
  const defaultModel = input.defaultModel?.trim() || null
  const db = getDb()

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO providers(id, name, wire, auth, base_url, default_model, enabled, created_at)
       VALUES(@id, @name, @wire, @auth, @base_url, @default_model, 1, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         wire = excluded.wire,
         auth = excluded.auth,
         base_url = excluded.base_url,
         default_model = excluded.default_model,
         enabled = 1`
    ).run({
      id: seed.id,
      name: seed.name,
      wire: seed.wire,
      auth: seed.auth,
      base_url: baseURL,
      default_model: defaultModel,
      created_at: now
    })

    const key = input.apiKey?.trim()
    if (key) {
      const { data, encrypted } = encryptSecret(key)
      db.prepare(
        `INSERT INTO credentials(provider_id, type, data, encrypted, created_at)
         VALUES(?, 'key', ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           type = excluded.type, data = excluded.data, encrypted = excluded.encrypted`
      ).run(seed.id, data, encrypted ? 1 : 0, now)
    }
  })
  tx()

  const provider = getProvider(seed.id)
  if (!provider) throw new Error(`Failed to connect provider ${seed.id}`)
  getDb().pragma('wal_checkpoint(TRUNCATE)')
  return provider
}

export function disconnectProvider(id: string): void {
  getDb().prepare('DELETE FROM providers WHERE id = ?').run(id)
}

/** Read + decrypt a provider's stored credential token (api key or oauth). */
export function getProviderToken(providerId: string): string | null {
  const row = getDb()
    .prepare('SELECT data, encrypted FROM credentials WHERE provider_id = ?')
    .get(providerId) as { data: string; encrypted: number } | undefined
  if (!row) return null
  try {
    return decryptSecret({ data: row.data, encrypted: row.encrypted > 0 })
  } catch {
    return null
  }
}

/** Persist the GitHub OAuth token for Copilot as an encrypted oauth credential. */
export function storeCopilotCredential(token: string): ConnectedProvider {
  const seed = resolveSeed('github-copilot')
  const now = Date.now()
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO providers(id, name, wire, auth, base_url, default_model, enabled, created_at)
       VALUES(@id, @name, @wire, @auth, @base_url, NULL, 1, @now)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, wire = excluded.wire, auth = excluded.auth, enabled = 1`
    ).run({
      id: seed.id,
      name: seed.name,
      wire: seed.wire,
      auth: seed.auth,
      base_url: seed.baseURL ?? null,
      now
    })
    const { data, encrypted } = encryptSecret(token)
    db.prepare(
      `INSERT INTO credentials(provider_id, type, data, encrypted, created_at)
       VALUES(?, 'oauth', ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         type = 'oauth', data = excluded.data, encrypted = excluded.encrypted`
    ).run(seed.id, data, encrypted ? 1 : 0, now)
  })
  tx()
  const provider = listConnectedProviders().find((p) => p.id === seed.id)
  if (!provider) throw new Error('Failed to connect GitHub Copilot')
  getDb().pragma('wal_checkpoint(TRUNCATE)')
  return provider
}

// ---- Chats -------------------------------------------------------------------

/** Parse the tasks JSON column into a checklist, tolerating malformed data. */
function parseTasks(raw: string | null): SessionTask[] {
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((t): t is SessionTask => !!t && typeof (t as SessionTask).title === 'string')
      .map((t) => ({
        title: t.title,
        status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending'
      }))
  } catch {
    return []
  }
}

function rowToChat(row: ChatRow): Chat {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as SessionKind,
    providerId: row.provider_id,
    model: row.model,
    workspacePath: row.workspace_path,
    parentId: row.parent_id,
    contextSummary: row.context_summary,
    contextSummaryAt: row.context_summary_at,
    description: row.description,
    tasks: parseTasks(row.tasks),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listChats(): Chat[] {
  const rows = getDb()
    .prepare('SELECT * FROM chats ORDER BY updated_at DESC')
    .all() as ChatRow[]
  return rows.map(rowToChat)
}

export function getChat(id: string): Chat | undefined {
  const row = getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined
  return row ? rowToChat(row) : undefined
}

/** Workspace path for a chat (null for loops / unset sessions). */
export function getChatWorkspace(chatId: string): string | null {
  const row = getDb()
    .prepare('SELECT workspace_path FROM chats WHERE id = ?')
    .get(chatId) as { workspace_path: string | null } | undefined
  return row?.workspace_path ?? null
}

export function createChat(input: CreateChatInput = {}): Chat {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO chats(id, title, kind, provider_id, model, workspace_path, parent_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.title?.trim() || 'New chat',
      input.kind ?? 'main',
      input.providerId ?? null,
      input.model ?? null,
      input.workspacePath ?? null,
      input.parentId ?? null,
      now,
      now
    )
  const chat = getChat(id)
  if (!chat) throw new Error('Failed to create chat')
  return chat
}

export function renameChat(id: string, title: string): void {
  getDb()
    .prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
    .run(title.trim() || 'New chat', Date.now(), id)
}

export function removeChat(id: string): void {
  const db = getDb()
  // Cascade to any subagent sessions this chat spawned.
  db.prepare('DELETE FROM chats WHERE parent_id = ?').run(id)
  db.prepare('DELETE FROM chats WHERE id = ?').run(id)
}

/** Subagent sessions spawned by a given chat, newest first. */
export function listSubchats(parentId: string): Chat[] {
  const rows = getDb()
    .prepare('SELECT * FROM chats WHERE parent_id = ? ORDER BY created_at ASC')
    .all(parentId) as ChatRow[]
  return rows.map(rowToChat)
}

/** Drop a chat's finished subagent sessions that have nothing queued — they're
 *  one-shot by nature and shouldn't pile up in the sidebar after a turn. */
export function pruneSubchats(parentId: string): void {
  const db = getDb()
  const subs = db
    .prepare("SELECT id FROM chats WHERE parent_id = ? AND kind = 'sub'")
    .all(parentId) as { id: string }[]
  const queued = db.prepare('SELECT COUNT(*) AS n FROM queue WHERE chat_id = ?')
  const del = db.prepare('DELETE FROM chats WHERE id = ?')
  for (const s of subs) {
    if ((queued.get(s.id) as { n: number }).n === 0) del.run(s.id)
  }
}

/** Store a compaction summary for a chat; messages up to `throughAt` are folded in. */
export function setChatSummary(chatId: string, summary: string, throughAt: number): Chat {
  getDb()
    .prepare(
      'UPDATE chats SET context_summary = ?, context_summary_at = ?, updated_at = ? WHERE id = ?'
    )
    .run(summary, throughAt, Date.now(), chatId)
  const chat = getChat(chatId)
  if (!chat) throw new Error('Chat not found')
  return chat
}

/** Update agent-settable session metadata (any subset of name / description / tasks). */
export function setChatMetadata(
  chatId: string,
  patch: { title?: string; description?: string; tasks?: SessionTask[] }
): Chat {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.title !== undefined) {
    sets.push('title = ?')
    vals.push(patch.title.trim() || 'New chat')
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    vals.push(patch.description.trim() || null)
  }
  if (patch.tasks !== undefined) {
    sets.push('tasks = ?')
    vals.push(JSON.stringify(patch.tasks))
  }
  if (sets.length === 0) {
    const chat = getChat(chatId)
    if (!chat) throw new Error('Chat not found')
    return chat
  }
  sets.push('updated_at = ?')
  vals.push(Date.now(), chatId)
  getDb()
    .prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals)
  const chat = getChat(chatId)
  if (!chat) throw new Error('Chat not found')
  return chat
}

// ---- Messages ----------------------------------------------------------------

/** Parse the JSON parts column, falling back to a single text part. */
function parseParts(raw: string | null, content: string): MessagePart[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as MessagePart[]
    } catch {
      // corrupt JSON — fall through to the text fallback
    }
  }
  return [{ type: 'text', text: content }]
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as MessageRole,
    content: row.content,
    parts: parseParts(row.parts, row.content),
    createdAt: row.created_at
  }
}

export function listMessages(chatId: string): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC')
    .all(chatId) as MessageRow[]
  return rows.map(rowToMessage)
}

export function addMessage(input: AddMessageInput): Message {
  const id = randomUUID()
  const now = Date.now()
  const parts: MessagePart[] = input.parts ?? [{ type: 'text', text: input.content }]
  const partsJson = JSON.stringify(parts)
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO messages(id, chat_id, role, content, parts, created_at) VALUES(?, ?, ?, ?, ?, ?)'
    ).run(id, input.chatId, input.role, input.content, partsJson, now)
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, input.chatId)
  })
  tx()
  return { id, chatId: input.chatId, role: input.role, content: input.content, parts, createdAt: now }
}

// ---- Loops -------------------------------------------------------------------

interface LoopRow {
  id: string
  name: string
  prompt: string
  interval_minutes: number
  enabled: number
  chat_id: string
  last_run_at: number | null
  next_run_at: number
  created_at: number
}

function rowToLoop(row: LoopRow): Loop {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled > 0,
    chatId: row.chat_id,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at
  }
}

function getLoop(id: string): Loop | undefined {
  const row = getDb().prepare('SELECT * FROM loops WHERE id = ?').get(id) as LoopRow | undefined
  return row ? rowToLoop(row) : undefined
}

export function listLoops(): Loop[] {
  const rows = getDb().prepare('SELECT * FROM loops ORDER BY created_at DESC').all() as LoopRow[]
  return rows.map(rowToLoop)
}

export function createLoop(input: CreateLoopInput): Loop {
  const id = randomUUID()
  const now = Date.now()
  const interval = Math.max(1, Math.floor(input.intervalMinutes))
  const name = input.name.trim() || 'Loop'
  const chat = createChat({ title: name, kind: 'loop', workspacePath: input.workspacePath ?? null })
  getDb()
    .prepare(
      `INSERT INTO loops(id, name, prompt, interval_minutes, enabled, chat_id, last_run_at, next_run_at, created_at)
       VALUES(?, ?, ?, ?, 1, ?, NULL, ?, ?)`
    )
    .run(id, name, input.prompt, interval, chat.id, now, now)
  const loop = getLoop(id)
  if (!loop) throw new Error('Failed to create loop')
  return loop
}

export function setLoopEnabled(id: string, enabled: boolean): void {
  if (enabled) {
    getDb().prepare('UPDATE loops SET enabled = 1, next_run_at = ? WHERE id = ?').run(Date.now(), id)
  } else {
    getDb().prepare('UPDATE loops SET enabled = 0 WHERE id = ?').run(id)
  }
}

export function removeLoop(id: string): void {
  const loop = getLoop(id)
  if (!loop) return
  // Deleting the chat cascades to the loop row and its messages.
  getDb().prepare('DELETE FROM chats WHERE id = ?').run(loop.chatId)
}

export function dueLoops(now: number): Loop[] {
  const rows = getDb()
    .prepare('SELECT * FROM loops WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC')
    .all(now) as LoopRow[]
  return rows.map(rowToLoop)
}

/** Append one heartbeat run (scheduled prompt + response) and schedule the next. */
export function appendLoopRun(loopId: string, userContent: string, assistantContent: string): void {
  const loop = getLoop(loopId)
  if (!loop) return
  const now = Date.now()
  addMessage({ chatId: loop.chatId, role: 'user', content: userContent })
  addMessage({ chatId: loop.chatId, role: 'assistant', content: assistantContent })
  getDb()
    .prepare('UPDATE loops SET last_run_at = ?, next_run_at = ? WHERE id = ?')
    .run(now, now + loop.intervalMinutes * 60_000, loopId)
}

/** Advance a loop's schedule after a beat fires (the agent turn runs separately). */
export function markLoopRan(loopId: string): void {
  const loop = getLoop(loopId)
  if (!loop) return
  const now = Date.now()
  getDb()
    .prepare('UPDATE loops SET last_run_at = ?, next_run_at = ? WHERE id = ?')
    .run(now, now + loop.intervalMinutes * 60_000, loopId)
}

// ---- Sessions status (list_sessions / check_session tools) -------------------

export function listSessionsStatus(): SessionStatus[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.title, c.workspace_path,
        (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
        (SELECT MAX(created_at) FROM messages m WHERE m.chat_id = c.id) AS last_msg
       FROM chats c WHERE c.kind = 'main' ORDER BY c.updated_at DESC`
    )
    .all() as {
    id: string
    title: string
    workspace_path: string | null
    message_count: number
    last_msg: number | null
  }[]
  const now = Date.now()
  return rows.map((r) => {
    const lastActivityAt = r.last_msg ?? 0
    return {
      id: r.id,
      title: r.title,
      workspacePath: r.workspace_path,
      messageCount: r.message_count,
      lastActivityAt,
      idle: lastActivityAt === 0 || now - lastActivityAt > 10 * 60_000
    }
  })
}

export function checkSession(id: string): SessionStatus | null {
  return listSessionsStatus().find((s) => s.id === id) ?? null
}

// ---- Queue (generic per-chat prompt queue) -----------------------------------

interface QueueRow {
  id: string
  chat_id: string
  content: string
  images: string | null
  created_at: number
}

export function listQueue(chatId: string): QueueItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM queue WHERE chat_id = ? ORDER BY created_at ASC')
    .all(chatId) as QueueRow[]
  return rows.map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    content: r.content,
    ...(r.images ? { images: JSON.parse(r.images) as QueueImage[] } : {}),
    createdAt: r.created_at
  }))
}

export function enqueue(chatId: string, content: string, images?: QueueImage[]): QueueItem {
  const id = randomUUID()
  const now = Date.now()
  const imagesJson = images && images.length ? JSON.stringify(images) : null
  getDb()
    .prepare('INSERT INTO queue(id, chat_id, content, images, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(id, chatId, content, imagesJson, now)
  return { id, chatId, content, ...(images && images.length ? { images } : {}), createdAt: now }
}

export function removeQueueItem(id: string): void {
  getDb().prepare('DELETE FROM queue WHERE id = ?').run(id)
}

/** Reorder a chat's queue to match `orderedIds` (front = runs next). Assigns
 *  small strictly-increasing sort keys (1,2,3…) — far below any real `Date.now()`
 *  so newly-enqueued items still append after. No-op unless the full set of the
 *  chat's queue ids is passed. */
export function reorderQueue(chatId: string, orderedIds: string[]): void {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM queue WHERE chat_id = ?').all(chatId) as {
    id: string
  }[]
  if (existing.length < 2) return
  const valid = new Set(existing.map((r) => r.id))
  const ids = orderedIds.filter((id) => valid.has(id))
  if (ids.length !== existing.length) return
  const update = db.prepare('UPDATE queue SET created_at = ? WHERE id = ?')
  db.transaction(() => ids.forEach((id, i) => update.run(i + 1, id)))()
}

// ---- Integrations ------------------------------------------------------------

export function listIntegrations(): IntegrationConnection[] {
  const rows = getDb().prepare('SELECT * FROM integrations').all() as IntegrationRow[]
  return rows.map((row) => ({
    id: row.id,
    enabled: row.enabled > 0,
    config: safeParse(row.config),
    createdAt: row.created_at
  }))
}

export function setIntegrationEnabled(id: string, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO integrations(id, enabled, config, created_at)
       VALUES(?, ?, '{}', ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`
    )
    .run(id, enabled ? 1 : 0, Date.now())
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}
