/**
 * The "Activity" panel at the top of Settings — a GitHub-style contribution graph
 * of your agent turns (day by day), so you can see your Roxy productivity over
 * time. Rendered with the dithered {@link ContributionGraph} canvas in Roxy blue.
 *
 * Loads its own data via `activity.stats` and refreshes whenever the last turn
 * lands (so opening Settings right after a session shows today's square filled).
 */
import { useEffect, useState } from 'react'
import type { ActivityStats } from '@shared/types'
import { api } from '../lib/api'
import { useRoxyStore } from '../lib/store'
import { ContributionGraph } from './ContributionGraph'

export function ActivitySection(): JSX.Element | null {
  const [stats, setStats] = useState<ActivityStats | null>(null)
  // Re-fetch when a turn finishes anywhere (usageStats is refreshed on every
  // finishTurn), so the graph stays live without its own event plumbing.
  const usageStats = useRoxyStore((s) => s.usageStats)

  useEffect(() => {
    let alive = true
    api.activity
      .stats()
      .then((s) => {
        if (alive) setStats(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [usageStats])

  // Nothing recorded yet → don't show an empty grid on a fresh install.
  if (!stats || stats.total === 0) return null

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
        Activity
      </h2>
      <div className="rounded-xl border border-border bg-surface p-4">
        <ContributionGraph data={stats} />
      </div>
    </section>
  )
}
