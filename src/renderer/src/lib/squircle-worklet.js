/**
 * Squircle paint worklet.
 *
 * Runs inside the CSS Paint API (Houdini) worklet scope -- a separate, isolated
 * JS realm with no DOM. It is NOT bundled as a module; `lib/squircle.ts` imports
 * this file's *source* with `?raw` and hands it to `CSS.paintWorklet.addModule()`
 * through a blob: URL. That avoids shipping a separate asset and keeps it working
 * identically in `electron-vite dev` (http://) and in production (file://), where
 * a relative worklet URL is fragile.
 *
 * Why a worklet at all: `border-radius` draws a quarter *circle*, which meets the
 * straight edge with a sudden jump in curvature -- the corner reads as "stuck on"
 * and, at the small radii a dense app UI uses, faintly cheap. A superellipse
 * (squircle) ramps curvature in continuously, the same shape Apple uses for icons
 * and sheets. Chromium only gained a native `corner-shape: superellipse()` in 139;
 * this app runs on 130, so we paint the shape ourselves.
 *
 * Two painters, because an element needs one or the other, never both:
 *   paint(squircle-mask) -> `mask-image`. Clips the element to the shape, so every
 *                           existing `bg-*` / `hover:bg-*` utility keeps working
 *                           untouched. Clips descendants and outer shadows too.
 *   paint(squircle-box)  -> `background-image`. Draws the fill (`--sq-fill`) and/or
 *                           the hairline (`--sq-ring`) as the element's own
 *                           background. Nothing is clipped, so this is the one for
 *                           anything with a real `box-shadow` or `overflow-hidden`.
 *
 * Both are painted over the *border* box (`mask-origin` defaults there, and CSS
 * sets `background-origin: border-box`), so `size` is the full border box and the
 * border width can be read straight off the element.
 */

/* Exponent of the superellipse |x/r|^n + |y/r|^n = 1. n=2 is a plain circle;
   Apple's icon grid sits around 5. 4 keeps the corner visibly continuous while
   staying tight enough not to read as a chamfer at the 6-24px radii used here. */
const N = 4

/* Line segments per corner. The curve is flattest near its ends, so 14 is already
   sub-pixel at these radii even at 2x DPR, and Chromium caches the painted image
   per geometry -- this runs on resize, not per frame. */
const STEPS = 14

const EXP = 2 / N

/**
 * Trace a superellipse-cornered rectangle. `inset` shrinks the box on all sides,
 * which is how the hairline gets centred inside the border area rather than half
 * hanging outside it (where a mask, or the element's own edge, would clip it).
 */
function squirclePath(ctx, width, height, radius, inset) {
  const x0 = inset
  const y0 = inset
  const x1 = width - inset
  const y1 = height - inset
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return

  // A radius past half the shorter side has no room left; clamp so short/wide
  // boxes degrade to a pill instead of self-intersecting.
  const r = Math.max(0, Math.min(radius - inset, w / 2, h / 2))

  ctx.beginPath()
  if (r === 0) {
    ctx.rect(x0, y0, w, h)
    ctx.closePath()
    return
  }

  // Unit superellipse offsets. Math.pow of a value in [0,1] stays in [0,1], so
  // both offsets stay within r.
  const dx = (t) => r * Math.pow(Math.cos(t), EXP)
  const dy = (t) => r * Math.pow(Math.sin(t), EXP)
  const step = Math.PI / 2 / STEPS

  ctx.moveTo(x0 + r, y0)
  ctx.lineTo(x1 - r, y0)
  // top-right: sweep from the top edge round to the right edge
  for (let i = STEPS; i >= 0; i--) {
    const t = i * step
    ctx.lineTo(x1 - r + dx(t), y0 + r - dy(t))
  }
  ctx.lineTo(x1, y1 - r)
  // bottom-right
  for (let i = 0; i <= STEPS; i++) {
    const t = i * step
    ctx.lineTo(x1 - r + dx(t), y1 - r + dy(t))
  }
  ctx.lineTo(x0 + r, y1)
  // bottom-left
  for (let i = STEPS; i >= 0; i--) {
    const t = i * step
    ctx.lineTo(x0 + r - dx(t), y1 - r + dy(t))
  }
  ctx.lineTo(x0, y0 + r)
  // top-left
  for (let i = 0; i <= STEPS; i++) {
    const t = i * step
    ctx.lineTo(x0 + r - dx(t), y0 + r - dy(t))
  }
  ctx.closePath()
}

/** Registered `<length>` properties arrive as CSSUnitValue; be defensive anyway,
 *  since an unregistered one would come through as an unparsed token list. */
function px(styleMap, name, fallback) {
  const value = styleMap.get(name)
  if (!value) return fallback
  const n = typeof value.value === 'number' ? value.value : parseFloat(String(value))
  return Number.isFinite(n) ? n : fallback
}

/** Colors serialize to something canvas accepts (`rgb(...)` / `oklab(...)`). */
function color(styleMap, name) {
  const value = styleMap.get(name)
  return value ? String(value).trim() : 'transparent'
}

/* `registerPaint` throws on a duplicate name, which happens when the dev server
   hot-reloads (the worklet scope outlives the page's JS). Swallowing it stops HMR
   from turning into an unhandled rejection that silently kills squircles. */
function register(name, ctor) {
  try {
    registerPaint(name, ctor)
  } catch {
    /* already registered */
  }
}

register(
  'squircle-mask',
  class {
    static get inputProperties() {
      return ['--sq-r']
    }
    paint(ctx, size, styleMap) {
      squirclePath(ctx, size.width, size.height, px(styleMap, '--sq-r', 8), 0)
      // Any opaque color does -- only the alpha channel is read as the mask.
      ctx.fillStyle = '#fff'
      ctx.fill()
    }
  }
)

register(
  'squircle-box',
  class {
    static get inputProperties() {
      return ['--sq-r', '--sq-fill', '--sq-ring', '--sq-dash', 'border-top-width']
    }
    paint(ctx, size, styleMap) {
      const r = px(styleMap, '--sq-r', 12)

      // Skipped when `--sq-fill` is left at its `transparent` default, i.e. the
      // element is keeping its own `bg-*` and only wants the hairline.
      const fill = color(styleMap, '--sq-fill')
      if (fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)') {
        squirclePath(ctx, size.width, size.height, r, 0)
        ctx.fillStyle = fill
        ctx.fill()
      }

      const w = px(styleMap, 'border-top-width', 0)
      if (w <= 0) return
      // Centre the stroke on the inner half of the border area so the whole
      // hairline lands inside the shape -- a stroke centred on the outline would
      // lose its outer half and render at half opacity.
      squirclePath(ctx, size.width, size.height, r, w / 2)
      ctx.lineWidth = w
      ctx.strokeStyle = color(styleMap, '--sq-ring')
      // `border-style: dashed` is painted by the UA along the *rectangle*, so its
      // dashes get sliced by the shape at every corner. `--sq-dash` re-creates it
      // along the squircle path instead. 0 (the default) means a solid stroke.
      const dash = px(styleMap, '--sq-dash', 0)
      if (dash > 0) ctx.setLineDash([dash, dash])
      ctx.stroke()
    }
  }
)
