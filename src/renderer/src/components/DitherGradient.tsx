import { useEffect, useRef } from 'react'
import {
  BAYER,
  OFF_TIER,
  backingSize,
  bloomLayerStyle,
  clamp01,
  easeInOutCubic,
  easeOutCubic,
  prefersReducedMotion,
  type BloomInput
} from './dither-kit/dither-paint'
import type { AreaVariant } from './dither-kit/chart-context'
import { PALETTE, rgb, type DitherColor } from './dither-kit/palette'

export type DitherDirection = 'top' | 'bottom' | 'left' | 'right'

export type DitherGradientProps = {
  /** Palette hue the gradient dissolves in. */
  from?: DitherColor
  /** Edge the fill is solid at; it dithers away toward the opposite edge. */
  direction?: DitherDirection
  /** Dither texture — same four variants as the chart family. */
  variant?: AreaVariant
  /** Glow over the crisp dither. `aura` is the widest, softest preset. */
  bloom?: BloomInput
  /** Play the wipe-in entrance. */
  animate?: boolean
  /** Entrance length in ms. */
  animationDuration?: number
  /** Change to re-play the entrance without remounting. */
  replayToken?: number
  /** Drifting stars in the empty space. Number of stars, or 0 for none. */
  stars?: number
  /** Slowly rotate the gradient's axis instead of holding a fixed edge. */
  turn?: boolean
  /** Seconds for one full rotation when `turn` is set. */
  turnDuration?: number
  className?: string
}

/** Unit vector pointing from the solid edge toward the fading edge. */
const AXIS: Record<DitherDirection, [number, number]> = {
  top: [0, 1],
  bottom: [0, -1],
  left: [1, 0],
  right: [-1, 0]
}

/**
 * A dithered colour gradient that fills its nearest positioned ancestor.
 *
 * Absolutely positioned and `pointer-events-none`, so it drops into any
 * `relative` container — footers, section fades, cards — behind content that
 * carries its own stacking context:
 *
 * ```tsx
 * <footer className="relative">
 *   <DitherGradient from="blue" direction="left" />
 *   <p className="relative">…footer content…</p>
 * </footer>
 * ```
 *
 * Shares the chart family's knobs (`variant`, `bloom`, `animate` +
 * `animationDuration` + `replayToken`) and its 4×4 Bayer matrix and
 * colour-vs-opacity rule, so the texture matches the rest of the app. Painted
 * on a low-res backing canvas scaled up `pixelated`.
 */
export function DitherGradient({
  from = 'blue',
  direction = 'top',
  variant = 'gradient',
  bloom = 'aura',
  animate = true,
  animationDuration = 900,
  replayToken = 0,
  stars = 0,
  turn = false,
  turnDuration = 24,
  className
}: DitherGradientProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const crispRef = useRef<HTMLCanvasElement>(null)
  const bloomRef = useRef<HTMLCanvasElement>(null)
  const starsRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const crisp = crispRef.current
    const glow = bloomRef.current
    const starCanvas = starsRef.current
    if (!host || !crisp) return

    const seed = PALETTE[from]
    const reduced = prefersReducedMotion()
    let raf = 0
    let cols = 0
    let rows = 0
    // Stars live on their own canvas at full device resolution, so they render
    // as round dots instead of inheriting the gradient's chunky pixel cells.
    let starW = 0
    let starH = 0
    // Last painted entrance progress, so a settled gradient can skip repainting.
    let lastReveal = -1
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const start = performance.now()

    // Each star lives a random lifetime — drifting in, holding, drifting out —
    // then respawns somewhere new, so they keep appearing in different places
    // instead of sitting and pulsing. Positions are in CSS px.
    type Star = { x: number; y: number; r: number; born: number; life: number; peak: number }
    let field: Star[] = []

    /**
     * Place a star in the *empty* half of the frame — the end the gradient has
     * faded out to, where there's room for a star to read. `t` is 0 at the
     * solid edge and 1 at the faded edge, biased hard toward the faded end.
     */
    const placeStar = (now: number, stagger: boolean): Star => {
      const t = 0.45 + Math.random() ** 0.7 * 0.55
      const [ax, ay] = AXIS[direction]
      // Along the gradient axis, in -1..1 space; free across the other axis.
      const along = 2 * t - 1
      const across = Math.random() * 2 - 1
      const nx = ax === 0 ? across : ax * along
      const ny = ay === 0 ? across : ay * along
      const life = 2600 + Math.random() * 3800
      return {
        x: ((nx + 1) / 2) * starW,
        y: ((ny + 1) / 2) * starH,
        // Vary the size a little so the field has some depth to it.
        r: 0.6 + Math.random() * 0.9,
        // Stagger the first batch so they don't all flare in unison on load.
        born: stagger ? now - Math.random() * life : now,
        life,
        peak: 0.4 + Math.random() * 0.5
      }
    }

    const seedStars = (now: number) => {
      field =
        stars <= 0 || starW === 0 || starH === 0
          ? []
          : Array.from({ length: stars }, () => placeStar(now, true))
    }

    const resize = () => {
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      const size = backingSize(w, h)
      cols = size.cols
      rows = size.rows
      for (const c of [crisp, glow]) {
        if (!c) continue
        c.width = cols
        c.height = rows
      }
      starW = w
      starH = h
      if (starCanvas) {
        starCanvas.width = Math.round(w * dpr)
        starCanvas.height = Math.round(h * dpr)
      }
      // Resizing wipes the canvas, so force a repaint on the next frame.
      lastReveal = -1
      seedStars(performance.now())
    }

    const draw = (now: number) => {
      const ctx = crisp.getContext('2d')
      if (!ctx || cols === 0 || rows === 0) return

      const elapsed = now - start
      // Entrance: wipe the gradient in along its own axis. `reveal` is how far
      // the fill has travelled (0 → 1); reduced motion snaps straight to 1.
      const reveal =
        !animate || reduced ? 1 : easeInOutCubic(clamp01(elapsed / Math.max(animationDuration, 1)))

      // The dither is ~180k fillRects at full-window size, so only repaint it
      // when it can actually have changed: while the entrance is still running,
      // or when `turn` is rotating the axis. Once it settles, the canvas holds
      // its last frame and only the (cheap) star layer keeps animating.
      const dirty = turn ? true : reveal !== lastReveal
      if (dirty) {
        lastReveal = reveal
        ctx.clearRect(0, 0, cols, rows)

        // Rotate the axis when `turn` is set; otherwise hold the fixed edge.
        let [ax, ay] = AXIS[direction]
        if (turn && !reduced) {
          const base = Math.atan2(ay, ax)
          const angle = base + (elapsed / (turnDuration * 1000)) * Math.PI * 2
          ax = Math.cos(angle)
          ay = Math.sin(angle)
        }

        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            // Project the cell onto the axis, normalized to 0 at the solid edge
            // and 1 at the fading edge.
            const nx = cols <= 1 ? 0 : (x / (cols - 1)) * 2 - 1
            const ny = rows <= 1 ? 0 : (y / (rows - 1)) * 2 - 1
            const t = clamp01((nx * ax + ny * ay + 1) / 2)
            // Scale the ramp by `reveal` so the fill grows out of the solid edge.
            const density = reveal <= 0 ? 0 : clamp01(1 - easeOutCubic(clamp01(t / reveal)))
            if (density <= 0.002) continue

            if (variant === 'hatched' && ((x + y) & 3) >= 2) continue
            const lit = variant === 'solid' || density > BAYER[y & 3][x & 3]
            // "dotted" keeps real gaps for its open look; the others cover the
            // cell and let the dither ride the alpha, so nothing shows the
            // background through as a hole.
            if (!lit && variant === 'dotted') continue
            // Colour-vs-opacity: one hue, density rides the alpha (see
            // dither-paint.ts) so it reads on light and dark backgrounds alike.
            ctx.fillStyle = rgb(seed.fill, 1, lit ? density : density * OFF_TIER)
            ctx.fillRect(x, y, 1, 1)
          }
        }

        // The bloom layer is just a blurred copy of the crisp canvas. It's a
        // CSS-filtered layer, so redrawing it forces a re-blur — only do it
        // alongside a real dither repaint.
        if (glow) {
          const gctx = glow.getContext('2d')
          if (gctx) {
            gctx.clearRect(0, 0, cols, rows)
            gctx.drawImage(crisp, 0, 0)
          }
        }
      }

      // Stars are drawn last, on their own full-resolution canvas, as plain
      // round dots — no dither cells, so they stay crisp at any size.
      if (starCanvas) {
        const sctx = starCanvas.getContext('2d')
        if (sctx) {
          sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          sctx.clearRect(0, 0, starW, starH)
          for (let i = 0; i < field.length; i++) {
            const s = field[i]
            const age = (now - s.born) / s.life
            // Lifetime ran out — respawn this one somewhere new.
            if (age >= 1) {
              field[i] = placeStar(now, false)
              continue
            }
            // Fade in, hold, fade out. Squaring the sine keeps both ends gentle
            // so stars drift in and out instead of blinking on.
            const env = reduced ? 0.7 : Math.sin(age * Math.PI) ** 2
            const a = clamp01(s.peak * env * reveal)
            if (a <= 0.01) continue
            sctx.beginPath()
            sctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
            sctx.fillStyle = rgb(seed.star, 1, a)
            sctx.fill()
          }
        }
      }
      return reveal
    }

    // Hold the rAF loop only while something is actually moving: the entrance
    // until it lands, then only if turn/stars keep it alive.
    const ongoing = (turn || stars > 0) && !reduced
    const frame = (now: number) => {
      const reveal = draw(now)
      if (ongoing || (reveal ?? 1) < 1) raf = requestAnimationFrame(frame)
    }

    const ro = new ResizeObserver(() => {
      resize()
      if (!ongoing) draw(performance.now())
    })
    ro.observe(host)
    resize()
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [from, direction, variant, animate, animationDuration, replayToken, stars, turn, turnDuration])

  const glowStyle = bloomLayerStyle(bloom, true)

  return (
    <div
      ref={hostRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}
    >
      <canvas
        ref={crispRef}
        className="absolute inset-0 h-full w-full"
        style={{ imageRendering: 'pixelated' }}
      />
      {glowStyle && (
        <canvas
          ref={bloomRef}
          className="absolute inset-0 h-full w-full"
          style={{ ...glowStyle, imageRendering: 'pixelated' }}
        />
      )}
      {/* Stars render smooth (no `pixelated`) so the dots stay round. */}
      <canvas ref={starsRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}
