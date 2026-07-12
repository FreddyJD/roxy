/**
 * The usage/cost dashboard service — turns persisted per-call usage rows into the
 * `UsageStats` payload the titlebar pill + popover render.
 *
 * Cost is priced when each call is *recorded* (in the harness), so historical
 * spend never shifts if a provider changes prices later. This service just reads
 * the last 30 days of rows, attaches human provider names, and rolls them up via
 * the pure `aggregateUsage` (shared with the tests).
 *
 * On first run after upgrading it also backfills estimated rows from existing
 * message history, so the graph isn't empty for someone who used Roxy before
 * usage tracking existed.
 */
import * as repo from '../db/repo'
import { listMessages } from '../db/repo'
import { messageTokens } from '../../shared/context'
import { aggregateUsage, usageCost } from '../../shared/cost'
import { modelCost } from './models'
import type { UsageStats, TokenUsage } from '../../shared/types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Start of today in local time (matches the aggregator's local-day bucketing). */
function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Human names for connected providers, keyed by id (for the tab labels). */
function providerNames(): Record<string, string> {
  const names: Record<string, string> = {}
  for (const p of repo.listConnectedProviders()) names[p.id] = p.name
  return names
}

/**
 * Seed the usage table from pre-existing messages the first time we ever run with
 * usage tracking. Each assistant turn becomes one estimated row: input ≈ the
 * conversation up to it, output ≈ the turn's own text. Best-effort and one-shot
 * (guarded by `hasAnyUsage`), so it never runs once real rows exist.
 */
export function backfillUsageFromHistory(): void {
  try {
    if (repo.hasAnyUsage()) return
    const chats = repo.listChatsForBackfill()
    for (const chat of chats) {
      const providerId = chat.providerId
      const model = chat.model
      if (!providerId || !model) continue
      const messages = listMessages(chat.id)
      if (messages.length === 0) continue

      const cost = modelCost(providerId, model)
      // Running input estimate: every prior message's tokens (rough, but stable).
      let runningInput = 0
      for (const m of messages) {
        const mt = messageTokens({ content: m.content })
        if (m.role === 'assistant') {
          const output = mt
          const usage: TokenUsage = {
            input: runningInput,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            estimated: true
          }
          repo.insertBackfilledUsage({
            chatId: chat.id,
            providerId,
            model,
            usage,
            cost: usageCost(usage, cost),
            createdAt: m.createdAt
          })
        }
        runningInput += mt
      }
    }
  } catch {
    // best-effort — a backfill failure must never block startup
  }
}

/** Build the usage dashboard payload for the last 30 days. */
export function getUsageStats(): UsageStats {
  const now = Date.now()
  const since = now - 30 * DAY_MS
  const records = repo.listUsageSince(since)
  return aggregateUsage(records, providerNames(), now, startOfToday(now))
}
