/**
 * Activity (contribution-graph) aggregation, shared by the main-process service
 * and the smoke tests. Pure + isomorphic (no Node/Electron): plain functions over
 * plain data, so the exact bucketing/levels can be pinned without a DB.
 *
 * The graph counts *agent turns* — one per assistant reply — bucketed into local
 * calendar days, then mapped to GitHub-style 0–4 intensity levels scaled to the
 * window's own peak (so a light week and a heavy week both read well).
 */
import type { ActivityDay, ActivityStats } from './types'
import { localDay } from './cost'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Map a day's `count` to a 0–4 level given the window's peak. 0 stays 0 (an empty
 * cell); everything else spreads across four tiers by fraction of the peak, so the
 * busiest day is always level 4 and a single-turn day is at least level 1.
 */
export function activityLevel(count: number, max: number): ActivityDay['level'] {
  if (count <= 0) return 0
  if (max <= 0) return 0
  const frac = count / max
  if (frac > 0.75) return 4
  if (frac > 0.5) return 3
  if (frac > 0.25) return 2
  return 1
}

/**
 * Roll a list of turn timestamps (epoch ms — one per assistant reply) into a
 * zero-filled daily series ending today, plus the headline figures the graph
 * shows above it (total, streaks, busiest day). `now` is injected so tests are
 * deterministic. `days` is the window length (e.g. 182 ≈ 26 weeks).
 */
export function aggregateActivity(timestamps: number[], now: number, days = 182): ActivityStats {
  const span = Math.max(1, Math.floor(days))
  const byDay = new Map<string, number>()
  for (const ts of timestamps) {
    const key = localDay(ts)
    byDay.set(key, (byDay.get(key) ?? 0) + 1)
  }

  // The window runs [now - (span-1) days .. now], oldest → newest, so the last
  // cell is always today and the grid fills left-to-right like GitHub's.
  const keys: string[] = []
  for (let i = span - 1; i >= 0; i--) keys.push(localDay(now - i * DAY_MS))

  const counts = keys.map((k) => byDay.get(k) ?? 0)
  let max = 0
  let total = 0
  let activeDays = 0
  for (const c of counts) {
    total += c
    if (c > 0) activeDays++
    if (c > max) max = c
  }

  const series: ActivityDay[] = keys.map((date, i) => ({
    date,
    count: counts[i],
    level: activityLevel(counts[i], max)
  }))

  // Longest run of consecutive active days anywhere in the window.
  let longestStreak = 0
  let run = 0
  for (const c of counts) {
    run = c > 0 ? run + 1 : 0
    if (run > longestStreak) longestStreak = run
  }

  // Current streak = active days ending at today (walk back from the end).
  let currentStreak = 0
  for (let i = counts.length - 1; i >= 0 && counts[i] > 0; i--) currentStreak++

  return { days: series, total, max, activeDays, longestStreak, currentStreak }
}
