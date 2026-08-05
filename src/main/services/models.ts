/**
 * Model catalog from models.dev — the live list of models each provider offers,
 * so the user picks from real, current models for whatever they connected.
 * Fetched once and cached (the JSON is large; ~144 providers).
 */
import type { ModelInfo, ModelCost } from '../../shared/api'
import type { ReasoningEffort } from '../../shared/types'
import { REASONING_EFFORTS } from '../../shared/session-config'
import { getProviderToken, listConnectedProviders } from '../db/repo'
import { isCliProxyProvider } from '../../shared/cliproxy'
import { ensureRunning as ensureCliProxy, listProxyModels } from './cliproxy'

const CATALOG_URL = 'https://models.dev/api.json'
const TTL_MS = 60 * 60 * 1000

interface ModelsDevModel {
  id: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  release_date?: string
  limit?: { context?: number; output?: number }
  /** USD per 1M tokens — models.dev already returns this; we no longer drop it. */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}
interface ModelsDevProvider {
  name?: string
  models?: Record<string, ModelsDevModel>
}

let cache: { at: number; data: Record<string, ModelsDevProvider> } | null = null

/**
 * Roxy's own inference gateway isn't in the models.dev catalog — it exposes its
 * marked-up model list at /api/models (no key required). When the user has a
 * Roxy key connected we instead hit the authenticated /v1/models, so a team on
 * "Managed" mode sees only its curated roxy/managed aliases + allow-list. The
 * server enforces the policy either way; this just keeps the picker honest.
 */
const ROXY_PUBLIC_CATALOG_URL = 'https://roxy.gg/api/models'
const ROXY_DEFAULT_BASE = 'https://roxy.gg/v1'
// Shorter than the models.dev TTL: this list is team/policy-sensitive now, so an
// owner toggling Managed mode should reflect on the desktop within minutes.
const ROXY_TTL_MS = 5 * 60 * 1000
let roxyCache: { at: number; data: ModelInfo[] } | null = null

/**
 * A model as roxy.gg's gateway reports it (an OpenRouter-shaped record).
 *
 * Two fields matter beyond the name: `supported_parameters` says whether
 * the model can take tools and a reasoning effort at all, and `reasoning`
 * gives the PER-MODEL effort ladder. `pricing` is USD per SINGLE token
 * here, not per 1M like models.dev.
 */
interface RoxyModel {
  id: string
  name?: string
  context_length?: number
  supported_parameters?: string[]
  reasoning?: {
    mandatory?: boolean
    default_enabled?: boolean
    supported_efforts?: string[]
    default_effort?: string
  }
  pricing?: {
    prompt?: string
    completion?: string
    input_cache_read?: string
    input_cache_write?: string
  }
  top_provider?: { context_length?: number; max_completion_tokens?: number }
}

/** Parse a roxy.gg per-token price string into USD per 1M tokens. */
function perMillion(v: string | undefined): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n * 1_000_000 : undefined
}

/** roxy.gg `pricing` (USD per token) -> our ModelCost (USD per 1M tokens). */
function roxyCost(p: RoxyModel['pricing']): ModelCost | undefined {
  if (!p) return undefined
  const cost: ModelCost = {}
  const input = perMillion(p.prompt)
  const output = perMillion(p.completion)
  const cacheRead = perMillion(p.input_cache_read)
  const cacheWrite = perMillion(p.input_cache_write)
  if (input !== undefined) cost.input = input
  if (output !== undefined) cost.output = output
  if (cacheRead !== undefined) cost.cacheRead = cacheRead
  if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite
  return Object.keys(cost).length ? cost : undefined
}

/**
 * The model's effort ladder, narrowed to the levels Roxy's picker has.
 *
 * The gateway also reports `minimal` and `none`, which sit below our
 * weakest rung and have no UI - they are dropped rather than folded into
 * `low`, since
 * silently spending more thinking than the model was told to is worse than
 * offering one fewer level. An empty result means "no usable ladder", which
 * reads as unknown so the full range stays available.
 */
function roxyEfforts(m: RoxyModel): ReasoningEffort[] | undefined {
  const raw = m.reasoning?.supported_efforts
  if (!Array.isArray(raw)) return undefined
  const efforts = REASONING_EFFORTS.filter((e) => raw.includes(e))
  return efforts.length ? efforts : undefined
}

/**
 * Whether the gateway will accept a thinking effort for this model.
 *
 * `supported_parameters` is the authority (it is what the request
 * validator reads); the `reasoning` block alone is enough for models that think
 * unconditionally, where effort is implicit rather than a parameter.
 */
function roxyReasoning(m: RoxyModel): boolean {
  const params = m.supported_parameters ?? []
  return (
    params.includes('reasoning_effort') ||
    params.includes('reasoning') ||
    Boolean(m.reasoning?.mandatory) ||
    Boolean(m.reasoning?.default_enabled)
  )
}

/** Where to fetch the Roxy catalog from + how to authenticate, if at all. */
function roxyCatalogSource(): { url: string; token: string | null } {
  const token = getProviderToken('roxy')
  if (!token) return { url: ROXY_PUBLIC_CATALOG_URL, token: null }
  const base = (
    listConnectedProviders().find((p) => p.id === 'roxy')?.baseURL || ROXY_DEFAULT_BASE
  ).replace(/\/+$/, '')
  return { url: `${base}/models`, token }
}

/**
 * Map the gateway's catalog into ModelInfo, KEEPING the capability flags.
 *
 * These used to be hardcoded to false, which quietly disabled three features
 * for every roxy.gg model at once: the thinking-effort picker hides itself
 * when `reasoning` is false, `pickDefaultModel` skips models that
 * are not tool-capable, and unpriced models make the usage meter report zero
 * spend. The gateway reports all three, so read them rather than assume.
 */
function toModelInfo(body: { data?: RoxyModel[] }): ModelInfo[] {
  return (body.data ?? [])
    .map((m) => {
      const reasoning = roxyReasoning(m)
      const cost = roxyCost(m.pricing)
      return {
        id: m.id,
        name: m.name || m.id,
        reasoning,
        toolCall: (m.supported_parameters ?? []).includes('tools'),
        ...(reasoning ? { reasoningEfforts: roxyEfforts(m) } : {}),
        contextLimit: m.context_length ?? m.top_provider?.context_length,
        outputLimit: m.top_provider?.max_completion_tokens,
        ...(cost ? { cost } : {})
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function listRoxyModels(): Promise<ModelInfo[]> {
  if (roxyCache && Date.now() - roxyCache.at < ROXY_TTL_MS) return roxyCache.data
  const { url, token } = roxyCatalogSource()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    let res = await fetch(url, { headers })
    // If the authenticated call fails (bad/expired key, etc.), fall back to the
    // public catalog so the picker still shows something usable.
    if (!res.ok && token)
      res = await fetch(ROXY_PUBLIC_CATALOG_URL, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`roxy.gg models returned ${res.status}`)
    const list = toModelInfo((await res.json()) as { data?: RoxyModel[] })
    roxyCache = { at: Date.now(), data: list }
    return list
  } catch {
    return roxyCache?.data ?? []
  }
}

/**
 * Models for a subscription provider: whatever the local CLIProxyAPI sidecar
 * currently exposes for THAT subscription.
 *
 * This deliberately does NOT come from models.dev. The available models are a
 * function of the signed-in plan (Plus and Pro see different lists), and the
 * sidecar already resolves that from the live credential - so it is the only
 * source that can be right. An empty list means the proxy isn't up or nobody
 * has signed in yet, which the picker renders as "no models" rather than as a
 * wrong list.
 *
 * The provider id is passed through because one sidecar serves every signed-in
 * subscription from a single model list; `listProxyModels` splits it by upstream
 * so the ChatGPT picker never offers a Gemini model it cannot route.
 *
 * Every model here is a frontier reasoning model with tool calling, so both
 * capability flags are asserted rather than guessed per id.
 */
async function listSubscriptionModels(providerId: string): Promise<ModelInfo[]> {
  // Boot the sidecar first when the provider is connected. After an app restart
  // the proxy is installed but not running, and an un-booted proxy reports no
  // models - which would render as an empty picker for a provider the user can
  // demonstrably use. Connected implies installed (you cannot connect without a
  // completed login), so this is a spawn, never a download.
  if (listConnectedProviders().some((p) => p.id === providerId)) {
    try {
      await ensureCliProxy()
    } catch {
      // Couldn't start - fall through to the empty list rather than break the
      // whole picker for every other provider.
    }
  }
  const models = await listProxyModels(providerId)
  return models
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      reasoning: true,
      toolCall: true,
      // Priced at $0: the user already paid for the plan, so per-token cost
      // accounting would invent spend that never happens.
      contextLimit: undefined,
      outputLimit: undefined
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function getCatalog(): Promise<Record<string, ModelsDevProvider>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`)
  const data = (await res.json()) as Record<string, ModelsDevProvider>
  cache = { at: Date.now(), data }
  return data
}

/** Map a models.dev `cost` block (per 1M tokens) to our ModelCost, dropping empties. */
function toModelCost(c: ModelsDevModel['cost']): ModelCost | undefined {
  if (!c) return undefined
  const cost: ModelCost = {}
  if (typeof c.input === 'number') cost.input = c.input
  if (typeof c.output === 'number') cost.output = c.output
  if (typeof c.cache_read === 'number') cost.cacheRead = c.cache_read
  if (typeof c.cache_write === 'number') cost.cacheWrite = c.cache_write
  return Object.keys(cost).length ? cost : undefined
}

/** List the models models.dev knows for a provider id (newest first). */
export async function listModels(providerId: string): Promise<ModelInfo[]> {
  if (providerId === 'roxy') return listRoxyModels()
  if (isCliProxyProvider(providerId)) return listSubscriptionModels(providerId)
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
        cost: toModelCost(m.cost),
        release: m.release_date ?? ''
      }))
      .sort((a, b) =>
        a.release < b.release ? 1 : a.release > b.release ? -1 : a.name.localeCompare(b.name)
      )
      .map(({ id, name, reasoning, toolCall, contextLimit, outputLimit, cost }) => ({
        id,
        name,
        reasoning,
        toolCall,
        contextLimit,
        outputLimit,
        ...(cost ? { cost } : {})
      }))
  } catch {
    return []
  }
}

/**
 * Look up a model's USD-per-1M-tokens pricing from the (already cached) catalog,
 * for the cost layer. Synchronous + best-effort: returns undefined if the catalog
 * hasn't been fetched yet or the model isn't priced. A turn always fetches the
 * catalog before running, so by record-pricing time the cache is warm.
 */
export function modelCost(providerId: string, modelId: string): ModelCost | undefined {
  // Roxy's gateway isn't in models.dev and prices its own (marked-up) catalog,
  // so read the price the user is actually charged from the roxy cache. Without
  // this every roxy turn records $0 and the usage meter reports no spend at all.
  if (providerId === 'roxy') {
    return roxyCache?.data.find((m) => m.id === modelId)?.cost
  }
  if (!cache) return undefined
  const models = cache.data[providerId]?.models
  if (!models) return undefined
  // models.dev keys by id; fall back to a scan for aliased/proxied ids.
  const m = models[modelId] ?? Object.values(models).find((x) => x.id === modelId)
  return toModelCost(m?.cost)
}
