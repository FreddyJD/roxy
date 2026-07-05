/**
 * Small, isomorphic formatting helpers shared by the main process and renderer.
 * Types and pure functions only — no Node/Electron/DOM imports.
 */

const MIN_PER_HOUR = 60
const MIN_PER_DAY = 60 * 24

/**
 * A compact human label for a duration given in minutes — used for loop
 * heartbeats in the sidebar. Rolls minutes up into hours past an hour and into
 * days past a day, so "every 360m" reads "every 6hrs" and a daily loop reads
 * "every 1 day" instead of "every 1440m".
 *
 *   5    → "5m"
 *   60   → "1hr"
 *   90   → "1hr 30m"
 *   360  → "6hrs"
 *   1440 → "1 day"
 *   2880 → "2 days"
 *   1500 → "1 day 1hr"
 */
export function formatInterval(minutes: number): string {
  const total = Math.max(1, Math.round(minutes))
  if (total < MIN_PER_HOUR) return `${total}m`

  if (total < MIN_PER_DAY) {
    const hrs = Math.floor(total / MIN_PER_HOUR)
    const mins = total % MIN_PER_HOUR
    const head = `${hrs}hr${hrs === 1 ? '' : 's'}`
    return mins ? `${head} ${mins}m` : head
  }

  const days = Math.floor(total / MIN_PER_DAY)
  const hrs = Math.floor((total % MIN_PER_DAY) / MIN_PER_HOUR)
  const head = `${days} day${days === 1 ? '' : 's'}`
  return hrs ? `${head} ${hrs}hr${hrs === 1 ? '' : 's'}` : head
}
