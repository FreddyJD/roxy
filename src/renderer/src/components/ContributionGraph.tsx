/**
 * The Settings "activity" contribution graph — a GitHub-style heatmap of your
 * agent turns, day by day, drawn on a <canvas> with the same ordered (Bayer)
 * dither the rest of Roxy's charts use, in the Roxy accent blue.
 *
 * Each cell is a rounded square filled with the dither scatter; a day's 0–4
 * activity level drives the fill's coverage + opacity (per the engine's
 * "vary opacity, not shade" rule), so a quiet week and a busy one both read
 * cleanly. Cells sweep in left→right on mount (respecting reduced-motion), a
 * blurred additive copy blooms the lit blue, and hovering a day shows a tooltip.
 *
 * The grid stretches to fill its container: rather than a fixed cell size that
 * leaves the card half-empty, we derive a per-column "step" from the measured
 * width so the full year of data spans edge-to-edge (with proportional gaps and
 * corners, clamped so cells stay readable and never balloon).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityDay, ActivityStats } from '@shared/types'
import {
  BAYER,
  OFF_TIER,
  bloomLayerStyle,
  clamp01,
  easeOutCubic,
  prefersReducedMotion
} from './dither-kit/dither-paint'
import { PALETTE, rgb } from './dither-kit/palette'
import { useChartDimensions } from './dither-kit/use-chart-dimensions'

const ROWS = 7 // days of the week (Sun → Sat)
// Each column's step (its width, incl. gap) is derived from the container so the
// grid fills it; the step is split into a cell + gap and the cell into its
// rounded corner by these ratios. The step is clamped to [MIN_STEP, MAX_STEP]:
// MIN keeps cells readable (and caps how many weeks we cram in), MAX keeps a
// sparse graph (a brand-new user with a few days) from ballooning into big tiles.
const GAP_RATIO = 0.2 // gap as a fraction of the column step
const RADIUS_RATIO = 0.18 // corner radius as a fraction of the cell side
const MIN_STEP = 13 // smallest column step (css px) — else show fewer weeks
const MAX_STEP = 18 // largest column step (css px) — else left-align, don't balloon
const DCELL_CSS = 2 // css px per dither cell — chunky enough to read pixelated
const DURATION = 720 // entrance sweep, ms
const STAGGER = 0.6 // fraction of the timeline spent staggering columns

// The single fill hue (Roxy blue) — we only ever vary its alpha.
const FILL = PALETTE.blue.fill
// Empty (level 0) cells: a faint neutral square, so idle days read as "nothing
// here" instead of a dim blue.
const EMPTY = 'rgba(125,135,155,0.10)'
// Per-level dither coverage (Bayer threshold) and lit-cell opacity. Index by level.
const COVERAGE = [0, 0.42, 0.62, 0.82, 1]
const ALPHA = [0, 0.62, 0.76, 0.9, 1]

type Cell = { day: ActivityDay | null }
type Geom = { cols: number; step: number; cellSize: number; gap: number; radius: number }

/**
 * Fit `dataCols` week-columns into the measured `width`. We stretch the columns
 * to fill the width, but clamp the per-column step to [MIN_STEP, MAX_STEP]:
 *  - normal case → step lands in range and the grid spans the full width;
 *  - too many weeks for the width → step floors at MIN_STEP and we show only the
 *    most recent `cols` weeks that fit (older ones drop off the left);
 *  - too few weeks for a wide card → step caps at MAX_STEP and the grid is its
 *    natural width (left-aligned) rather than ballooning into huge tiles.
 * Cell and gap are fractions of the step; the corner radius a fraction of the cell.
 */
function geometry(width: number, dataCols: number): Geom {
  if (width <= 0 || dataCols <= 0) {
    return {
      cols: Math.max(1, dataCols),
      step: MIN_STEP,
      cellSize: MIN_STEP * (1 - GAP_RATIO),
      gap: MIN_STEP * GAP_RATIO,
      radius: MIN_STEP * (1 - GAP_RATIO) * RADIUS_RATIO
    }
  }
  // Step that would fit every data column exactly across the width.
  const ideal = width / Math.max(0.8, dataCols - GAP_RATIO)
  const step = Math.min(MAX_STEP, Math.max(MIN_STEP, ideal))
  // If we floored at MIN_STEP, not all weeks fit — show the most recent that do.
  const cols =
    ideal < MIN_STEP ? Math.max(1, Math.floor((width + step * GAP_RATIO) / step)) : dataCols
  const gap = step * GAP_RATIO
  const cellSize = step - gap
  const radius = cellSize * RADIUS_RATIO
  return { cols, step, cellSize, gap, radius }
}

/** Parse a local `YYYY-MM-DD` into a local-midnight Date (no UTC drift). */
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * Lay the oldest→newest day series into GitHub-style week columns: column 0 is
 * padded with empty cells up to the first day's weekday, then days flow down each
 * column (Sun→Sat) and wrap to the next week. Trailing cells of the current week
 * (future days) stay empty.
 */
function buildColumns(days: ActivityDay[]): Cell[][] {
  if (days.length === 0) return []
  const pad = parseLocalDate(days[0].date).getDay()
  const columns: Cell[][] = []
  let col: Cell[] = Array.from({ length: pad }, () => ({ day: null }))
  for (const day of days) {
    col.push({ day })
    if (col.length === ROWS) {
      columns.push(col)
      col = []
    }
  }
  if (col.length > 0) {
    while (col.length < ROWS) col.push({ day: null })
    columns.push(col)
  }
  return columns
}

/**
 * Paint one dithered cell into `ctx` at device-pixel rect (px,py,size). `level`
 * (0–4) picks the coverage + opacity; `k` (0–1) reveals it during the entrance.
 * The Bayer threshold is indexed off *global* device coords so the pixel texture
 * stays continuous across every cell (one field, not 182 little ones).
 */
function paintCell(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  level: number,
  k: number,
  dpr: number,
  radius: number
): void {
  const r = radius * dpr
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(px, py, size, size, r)
  ctx.clip()

  if (level <= 0) {
    ctx.globalAlpha = k
    ctx.fillStyle = EMPTY
    ctx.fillRect(px, py, size, size)
    ctx.globalAlpha = 1
    ctx.restore()
    return
  }

  const cov = COVERAGE[level] ?? 1
  const a = (ALPHA[level] ?? 1) * k
  const dcell = Math.max(1, Math.round(DCELL_CSS * dpr))
  const x1 = px + size
  const y1 = py + size
  for (let y = py; y < y1; y += dcell) {
    for (let x = px; x < x1; x += dcell) {
      const bx = Math.floor(x / dcell) & 3
      const by = Math.floor(y / dcell) & 3
      const lit = cov > BAYER[by][bx]
      const alpha = lit ? a : a * OFF_TIER
      ctx.fillStyle = rgb(FILL, 1, alpha)
      ctx.fillRect(x, y, dcell, dcell)
    }
  }
  ctx.restore()
}

/** Month labels for the visible columns, placed where a new month first appears. */
function monthLabels(columns: Cell[][], step: number): { text: string; left: number }[] {
  const out: { text: string; left: number }[] = []
  let prev = -1
  columns.forEach((col, c) => {
    const first = col.find((cell) => cell.day)?.day
    if (!first) return
    const month = parseLocalDate(first.date).getMonth()
    if (month === prev) return
    const left = c * step
    // Skip a label that would crowd the previous one (or hug the right edge).
    if (out.length && left - out[out.length - 1].left < step * 2.5) {
      prev = month
      return
    }
    out.push({
      text: parseLocalDate(first.date).toLocaleDateString(undefined, { month: 'short' }),
      left
    })
    prev = month
  })
  return out
}

/**
 * The contribution graph. Renders a crisp dither canvas plus a blurred bloom
 * copy, with HTML month labels above and a Less→More legend below. Stretches the
 * full year of data across the container width, so it fills the card.
 */
export function ContributionGraph({ data }: { data: ActivityStats }): JSX.Element {
  const { ref: wrapRef, size } = useChartDimensions<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bloomRef = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ day: ActivityDay; x: number; y: number } | null>(null)
  const hoverIndexRef = useRef<number>(-1)
  const scheduleRef = useRef<() => void>(() => {})
  // Play the entrance sweep once (on mount); later re-renders from a resize or a
  // data refresh just repaint the settled frame, so resizing doesn't re-sweep.
  const didEnterRef = useRef(false)

  // Every week of data becomes a column; geometry() stretches them to the width
  // (clamped), and tells us how many of the most-recent weeks actually fit.
  const allColumns = useMemo(() => buildColumns(data.days), [data.days])
  const { cols, step, cellSize, gap, radius } = geometry(size.width, allColumns.length)
  const columns = useMemo(
    () => (allColumns.length > cols ? allColumns.slice(allColumns.length - cols) : allColumns),
    [allColumns, cols]
  )
  const labels = useMemo(() => monthLabels(columns, step), [columns, step])

  const gridW = columns.length * step - gap
  const gridH = ROWS * step - gap

  const columnsRef = useRef(columns)
  columnsRef.current = columns

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    if (size.width <= 0) return // wait for the container to be measured
    const bloomCanvas = bloomRef.current
    const bloomCtx = bloomCanvas?.getContext('2d') ?? null
    const dpr = window.devicePixelRatio || 1
    for (const cv of [canvas, bloomCanvas]) {
      if (!cv) continue
      cv.width = Math.max(1, Math.round(gridW * dpr))
      cv.height = Math.max(1, Math.round(gridH * dpr))
      cv.style.width = `${gridW}px`
      cv.style.height = `${gridH}px`
    }

    const reduce = prefersReducedMotion()

    const paint = (prog: number): void => {
      const cols2 = columnsRef.current
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const nCols = cols2.length
      for (let c = 0; c < nCols; c++) {
        const colStart = nCols > 1 ? (c / (nCols - 1)) * STAGGER : 0
        const k = reduce ? 1 : easeOutCubic(clamp01((prog - colStart) / (1 - STAGGER)))
        if (k <= 0) continue
        for (let row = 0; row < ROWS; row++) {
          const cell = cols2[c][row]
          if (!cell.day) continue
          const px = Math.round(c * step * dpr)
          const py = Math.round(row * step * dpr)
          const sz = Math.round(cellSize * dpr)
          paintCell(ctx, px, py, sz, cell.day.level, k, dpr, radius)
          if (hoverIndexRef.current === c * ROWS + row) {
            ctx.save()
            ctx.beginPath()
            ctx.roundRect(px + 0.5, py + 0.5, sz - 1, sz - 1, radius * dpr)
            ctx.strokeStyle = 'rgba(237,237,237,0.55)'
            ctx.lineWidth = Math.max(1, dpr)
            ctx.stroke()
            ctx.restore()
          }
        }
      }
      if (bloomCtx && bloomCanvas) {
        bloomCtx.clearRect(0, 0, bloomCanvas.width, bloomCanvas.height)
        bloomCtx.drawImage(canvas, 0, 0)
      }
    }

    let raf = 0
    let start = 0
    let running = true
    const frame = (now: number): void => {
      if (!start) start = now
      const prog = reduce ? 1 : clamp01((now - start) / DURATION)
      paint(prog)
      if (prog < 1) raf = requestAnimationFrame(frame)
      else running = false
    }
    scheduleRef.current = (): void => {
      if (running) return
      running = true
      // Jump past the entrance so a hover repaint lands a single settled frame.
      start = performance.now() - DURATION
      raf = requestAnimationFrame(frame)
    }
    if (didEnterRef.current || reduce) {
      // Resize / data refresh (or reduced motion): draw the settled grid at once.
      running = false
      paint(1)
    } else {
      didEnterRef.current = true
      raf = requestAnimationFrame(frame)
    }
    return () => {
      running = false
      cancelAnimationFrame(raf)
    }
  }, [columns, gridW, gridH, step, cellSize, radius, size.width])

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const c = Math.floor(x / step)
    const row = Math.floor(y / step)
    const inCell = x - c * step <= cellSize && y - row * step <= cellSize
    const cell =
      c >= 0 && c < columns.length && row >= 0 && row < ROWS ? columns[c][row] : undefined
    const index = cell?.day && inCell ? c * ROWS + row : -1
    if (index === hoverIndexRef.current) return // same cell (or still empty) — no churn
    hoverIndexRef.current = index
    if (cell?.day && index !== -1) {
      setHover({ day: cell.day, x: c * step + cellSize / 2, y: row * step })
    } else {
      setHover(null)
    }
    scheduleRef.current()
  }

  const onPointerLeave = (): void => {
    if (hoverIndexRef.current === -1) return
    hoverIndexRef.current = -1
    setHover(null)
    scheduleRef.current()
  }

  const bloom = bloomLayerStyle('low', true)

  return (
    <div ref={wrapRef} className="w-full">
      {/* Month labels */}
      <div className="relative mb-1.5" style={{ height: 14, width: gridW }}>
        {labels.map((l) => (
          <span
            key={`${l.text}-${l.left}`}
            className="absolute top-0 text-[10px] leading-none text-text-subtle"
            style={{ left: l.left }}
          >
            {l.text}
          </span>
        ))}
      </div>

      {/* Grid (crisp canvas + blurred bloom copy on top, additively blended) */}
      <div className="relative" style={{ width: gridW, height: gridH }}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0"
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
        />
        <canvas
          ref={bloomRef}
          className="pointer-events-none absolute inset-0"
          style={bloom ?? { opacity: 0 }}
        />
        {hover && (
          <div
            className="animate-fade-in pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-border bg-elevated px-2 py-1 text-[11px] text-text shadow-xl"
            style={{ left: hover.x, top: hover.y - 6 }}
          >
            <span className="font-semibold tabular-nums">{hover.day.count}</span>{' '}
            {hover.day.count === 1 ? 'turn' : 'turns'}
            <span className="text-text-subtle">
              {' · '}
              {parseLocalDate(hover.day.date).toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric'
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
