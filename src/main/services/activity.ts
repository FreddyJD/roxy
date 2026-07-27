/**
 * The activity dashboard service — turns the durable activity ledger into the
 * `ActivityStats` payload the Settings contribution graph renders.
 *
 * One agent turn = one assistant message, credited to a local calendar day as it
 * happens (see `repo.recordActivityTurn`). Reading the LEDGER rather than the
 * messages table is the whole point: messages cascade away with their chat, so a
 * graph derived from them lost months of history the moment a session or a
 * project folder was removed. Your record of having worked shouldn't depend on
 * whether you kept the transcript.
 *
 * The per-day counts go to the pure `aggregateActivityDays` (shared with the
 * tests) for zero-filling, level bucketing, and streak math.
 */
import * as repo from '../db/repo'
import { aggregateActivityDays } from '../../shared/activity'
import { localDay } from '../../shared/cost'
import type { ActivityStats } from '../../shared/types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Default window: 53 weeks (371 days) — a full GitHub-style year that fills the card. */
export const ACTIVITY_DAYS = 371

/** Build the contribution-graph payload for the last `days` days (inclusive of today). */
export function getActivityStats(days = ACTIVITY_DAYS): ActivityStats {
  const now = Date.now()
  // The oldest day the window shows. Compared as a YYYY-MM-DD string, which sorts
  // chronologically, so the ledger scan is a cheap range over its primary key.
  const from = localDay(now - (days - 1) * DAY_MS)
  return aggregateActivityDays(repo.listActivityDays(from), now, days)
}
