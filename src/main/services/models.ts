/**
 * Model catalog from models.dev — the live list of models each provider offers,
 * so the user picks from real, current models for whatever they connected.
 * Fetched once and cached (the JSON is large; ~144 providers).
 */
import type { ModelInfo } from '../../shared/api'

const CATALOG_URL = 'https://models.dev/api.json'
const TTL_MS = 60 * 60 * 1000

interface ModelsDevModel {
  id: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  release_date?: string
  limit?: { context?: number; output?: number }
}
interface ModelsDevProvider {
  name?: string
  models?: Record<string, ModelsDevModel>
}

let cache: { at: number; data: Record<string, ModelsDevProvider> } | null = null

/**
 * Roxy's own inference gateway isn't in the models.dev catalog — it exposes its
 * marked-up model list at /api/models (no key required). Fetch + cache that
 * separately so the picker shows real, current Roxy models.
 */
const ROXY_CATALOG_URL = 'https://roxy.gg/api/models'
let roxyCache: { at: number; data: ModelInfo[] } | null = null

interface RoxyModel {
  id: string
  name?: string
  context_length?: number
}

async function listRoxyModels(): Promise<ModelInfo[]> {
  if (roxyCache && Date.now() - roxyCache.at < TTL_MS) return roxyCache.data
  try {
    const res = await fetch(ROXY_CATALOG_URL, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`roxy.gg models returned ${res.status}`)
    const body = (await res.json()) as { data?: RoxyModel[] }
    const list = (body.data ?? [])
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: false,
        toolCall: false,
        contextLimit: m.context_length,
        outputLimit: undefined
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    roxyCache = { at: Date.now(), data: list }
    return list
  } catch {
    return roxyCache?.data ?? []
  }
}

async function getCatalog(): Promise<Record<string, ModelsDevProvider>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`)
  const data = (await res.json()) as Record<string, ModelsDevProvider>
  cache = { at: Date.now(), data }
  return data
}

/** List the models models.dev knows for a provider id (newest first). */
export async function listModels(providerId: string): Promise<ModelInfo[]> {
  if (providerId === 'roxy') return listRoxyModels()
  try {
    const data = await getCatalog()
    const models = data[providerId]?.models
    if (!models) return []
    return Object.values(models)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: Boolean(m.reasoning),
        toolCall: Boolean(m.tool_call),
        contextLimit: m.limit?.context,
        outputLimit: m.limit?.output,
        release: m.release_date ?? ''
      }))
      .sort((a, b) => (a.release < b.release ? 1 : a.release > b.release ? -1 : a.name.localeCompare(b.name)))
      .map(({ id, name, reasoning, toolCall, contextLimit, outputLimit }) => ({
        id,
        name,
        reasoning,
        toolCall,
        contextLimit,
        outputLimit
      }))
  } catch {
    return []
  }
}
