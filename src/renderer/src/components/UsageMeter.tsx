/**
 * The usage/cost "menubar" — a titlebar pill showing today's spend, opening a
 * popover with an Overview tab plus one tab per provider. Each tab shows Today /
 * 30-day cost + tokens, the top model, and a 30-day daily-spend bar graph.
 *
 * Data is real provider token `usage` where the API reports it (Claude/Gemini
 * always; most OpenAI-compatible providers via `stream_options.include_usage`),
 * and a ~chars/4 estimate otherwise — so the numbers exist regardless of
 * provider. Cost is priced from the models.dev catalog at record time.
 */
import { useEffect, useRef, useState } from 'react'
import { BarChart3, LayoutGrid } from 'lucide-react'
import type { ProviderUsage, UsageDay, UsageStats } from '@shared/types'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'

/** Close-on-outside-click / Escape for the popover. */
function usePopover(): {
  open: boolean
  setOpen: (v: boolean) => void
  ref: React.RefObject<HTMLDivElement>
} {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref }
}

/** Compact token count: 1.2M, 34K, 999. */
function formatTokens(n: number): string {
  if (n >= 1_000_000_000)
    return `${Number((n / 1_000_000_000).toFixed(n % 1_000_000_000 ? 1 : 0))}B`
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(Math.round(n))
}

/** USD, with cents under $100 and whole dollars above (keeps the pill tidy). */
function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString()}`
}

/** Pretty a model id for the "Top model" line (drop a provider prefix if present). */
function prettyModel(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/** A small labeled figure (e.g. "Today" / "$224.93"). */
function Figure({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-text-subtle">{label}</div>
      <div className="truncate text-[15px] font-semibold text-text tabular-nums">{value}</div>
    </div>
  )
}

/** 30-day daily-spend bar graph. Bars scale to the max day; cost drives height,
 *  falling back to tokens when nothing is priced yet. Hover shows the day. */
function SpendGraph({ daily }: { daily: UsageDay[] }): JSX.Element {
  const priced = daily.some((d) => d.cost > 0)
  const val = (d: UsageDay): number => (priced ? d.cost : d.tokens)
  const max = Math.max(1, ...daily.map(val))
  const peak = daily.reduce((a, b) => (val(b) > val(a) ? b : a), daily[0])
  return (
    <div>
      <div className="mb-1 flex items-end justify-end">
        <span className="text-[11px] text-text-subtle tabular-nums">
          {priced ? formatUsd(peak ? peak.cost : 0) : formatTokens(peak ? peak.tokens : 0)}
        </span>
      </div>
      <div className="flex h-16 items-end gap-[3px]">
        {daily.map((d, i) => {
          const h = Math.max(val(d) > 0 ? 6 : 2, Math.round((val(d) / max) * 100))
          const isPeak = d === peak && val(d) > 0
          return (
            <div
              key={d.date}
              title={`${d.date} · ${formatUsd(d.cost)} · ${formatTokens(d.tokens)} tok`}
              className={cn(
                'flex-1 rounded-sm transition-colors',
                isPeak ? 'bg-accent' : 'bg-accent/35 hover:bg-accent/60',
                i === daily.length - 1 && !isPeak && 'bg-accent/60'
              )}
              style={{ height: `${h}%` }}
            />
          )
        })}
      </div>
    </div>
  )
}

/** The body of one tab (Overview or a provider) — the shared stat layout. */
function UsagePanel({
  title,
  subtitle,
  today,
  cost30,
  tokens30,
  latestTokens,
  topModel,
  daily,
  note
}: {
  title: string
  subtitle?: string
  today: number
  cost30: number
  tokens30: number
  latestTokens: number
  topModel: string | null
  daily: UsageDay[]
  note: string
}): JSX.Element {
  const empty = tokens30 === 0
  return (
    <div className="p-3.5">
      <div className="mb-3 border-b border-border pb-3">
        <div className="text-sm font-semibold text-text">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs text-text-subtle">{subtitle}</div>}
      </div>
      {empty ? (
        <div className="py-6 text-center text-xs text-text-subtle">
          No usage recorded yet. Run a turn and it’ll show up here.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Figure label="Today" value={formatUsd(today)} />
            <Figure label="30d cost" value={formatUsd(cost30)} />
            <Figure label="30d tokens" value={formatTokens(tokens30)} />
            <Figure label="Latest tokens" value={formatTokens(latestTokens)} />
          </div>
          <div className="mt-4">
            <SpendGraph daily={daily} />
          </div>
          {topModel && (
            <div className="mt-3 text-xs text-text-muted">
              Top model: <span className="text-text">{prettyModel(topModel)}</span>
            </div>
          )}
          <div className="mt-1 text-[11px] leading-snug text-text-subtle">{note}</div>
        </>
      )}
    </div>
  )
}

/** Build the estimate/pricing caveat line for a panel. */
function noteFor(hasEstimates: boolean, hasUnpriced: boolean): string {
  const parts: string[] = []
  if (hasUnpriced) parts.push('some models have no public price, so cost is a floor')
  if (hasEstimates) parts.push('token counts marked ~ are estimated')
  if (parts.length === 0) return 'Priced from the models.dev catalog at API rates.'
  return `Priced from models.dev; ${parts.join('; ')}.`
}

/** Latest-call token volume for a provider panel = today's tokens (a proxy for "recent"). */
function overviewPanel(stats: UsageStats): JSX.Element {
  const o = stats.overview
  return (
    <UsagePanel
      title="Overview"
      subtitle="All providers, last 30 days"
      today={o.today.cost}
      cost30={o.last30d.cost}
      tokens30={o.last30d.tokens}
      latestTokens={o.today.tokens}
      topModel={o.topModel}
      daily={o.daily}
      note={noteFor(o.hasEstimates, o.hasUnpriced)}
    />
  )
}

function providerPanel(p: ProviderUsage): JSX.Element {
  return (
    <UsagePanel
      title={p.name}
      subtitle="Last 30 days"
      today={p.today.cost}
      cost30={p.last30d.cost}
      tokens30={p.last30d.tokens}
      latestTokens={p.today.tokens}
      topModel={p.topModel}
      daily={p.daily}
      note={noteFor(p.hasEstimates, p.hasUnpriced)}
    />
  )
}

/**
 * The titlebar usage pill. Shows today's spend (or 30-day when today is $0) and
 * opens the dashboard popover. Hidden until there's any usage to show.
 */
export function UsageMeter(): JSX.Element | null {
  const usageStats = useRoxyStore((s) => s.usageStats)
  const refreshUsage = useRoxyStore((s) => s.refreshUsage)
  const { open, setOpen, ref } = usePopover()
  const [tab, setTab] = useState<string>('overview')

  // Refresh whenever the popover opens, so it reflects the latest turn.
  useEffect(() => {
    if (open) void refreshUsage()
  }, [open, refreshUsage])

  if (!usageStats || usageStats.overview.last30d.tokens === 0) return null

  const o = usageStats.overview
  // Pill label: prefer today's cost; if nothing today, show the 30-day figure.
  const pillCost = o.today.cost > 0 ? o.today.cost : o.last30d.cost
  const pillTitle =
    o.today.cost > 0
      ? 'Spent today — click for usage & cost'
      : 'Spent in the last 30 days — click for usage & cost'

  const tabs = [
    { id: 'overview', label: 'Overview' },
    ...usageStats.providers.map((p) => ({ id: p.providerId, label: p.name }))
  ]
  const activeProvider = usageStats.providers.find((p) => p.providerId === tab)

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={pillTitle}
        className={cn(
          'press-scale flex h-7 items-center gap-1.5 rounded-lg border px-2 text-xs tabular-nums transition-colors',
          open
            ? 'border-border-strong bg-elevated text-text'
            : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text'
        )}
      >
        <BarChart3 className="h-3.5 w-3.5" />
        <span>{formatUsd(pillCost)}</span>
      </button>

      {open && (
        <div className="animate-pop-in absolute right-0 top-full z-50 mt-2 w-80 origin-top-right overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl">
          {/* Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto border-b border-border p-1.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                  tab === t.id
                    ? 'bg-accent text-white'
                    : 'text-text-muted hover:bg-white/5 hover:text-text'
                )}
              >
                {t.id === 'overview' && <LayoutGrid className="h-3.5 w-3.5" />}
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'overview'
            ? overviewPanel(usageStats)
            : activeProvider
              ? providerPanel(activeProvider)
              : overviewPanel(usageStats)}
        </div>
      )}
    </div>
  )
}
