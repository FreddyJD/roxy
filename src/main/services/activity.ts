/**
 * The activity dashboard service — turns the messages table into the
 * `ActivityStats` payload the Settings contribution graph renders.
 *
 * One agent turn = one assistant message. We count them per local calendar day
 * over a rolling window (default ~53 weeks, so the GitHub-style grid fills), then
 * hand the raw timestamps to the pure `aggregateActivity` (shared with the tests)
 * for zero-filling, level bucketing, and streak math.
 */
import * as repo from '../db/repo'
import { aggregateActivity } from '../../shared/activity'
import type { ActivityStats } from '../../shared/types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Default window: 53 weeks (371 days) — a full GitHub-style year that fills the card. */
export const ACTIVITY_DAYS = 371

/** Build the contribution-graph payload for the last `days` days (inclusive of today). */
export function getActivityStats(days = ACTIVITY_DAYS): ActivityStats {
  const now = Date.now()
  // Start-of-day `days-1` back, so a turn early on the first day still counts.
  const start = new Date(now - (days - 1) * DAY_MS)
  start.setHours(0, 0, 0, 0)
  const timestamps = repo.listAgentTurnTimestamps(start.getTime())
  return aggregateActivity(timestamps, now, days)
}
