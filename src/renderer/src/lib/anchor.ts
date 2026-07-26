/**
 * Anchored floating-box geometry — pure math, no DOM.
 *
 * Given a trigger's rect, an image's natural size, and the viewport, decide
 * where a preview box should sit. Kept separate from the component (and free of
 * globals) so the placement rules can be exercised directly; see test/shared.ts.
 */

/** Space between the trigger and the box. */
export const GAP = 10
/** Keep-off distance from the viewport edges. */
export const MARGIN = 12
/** Ceilings, so a huge screenshot doesn't swallow the window. */
export const MAX_W = 560
export const MAX_H = 520
/** Upscale ceiling for small images, so a tiny favicon isn't a tiny preview. */
export const MIN_LONG_EDGE = 240
/**
 * Height of everything in the frame that isn't the image: 4px padding top and
 * bottom plus a fixed 20px caption strip. Positioning has to reserve this
 * before the box exists, so the caption is pinned to `h-5 leading-5` in the
 * component — a chrome height that drifts from this constant mispositions it.
 */
export const CHROME_H = 28
/**
 * A preview only earns its place on screen by showing meaningfully more than the
 * thumbnail already does — an absolute floor, plus a multiple of the trigger's
 * own size. Below that, hovering pops a box that's barely a step up while
 * covering the UI around it; showing nothing is the better answer.
 */
const MIN_USEFUL = 100
const MIN_GROWTH = 1.6

export type Side = 'top' | 'bottom' | 'right' | 'left'

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface Placement {
  left: number
  top: number
  width: number
  height: number
  side: Side
  /** transform-origin, so the entrance scales out of the trigger, not the void. */
  origin: string
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))

/* ---- anchored menus --------------------------------------------------------
 *
 * Popovers in the workstream strip and the composer footer are fixed-width
 * boxes pinned to one edge of their trigger (`left-0` / `right-0`) with no idea
 * where the window ends. That is fine until a trigger sits near an edge — then
 * the box simply runs off screen and is cut, because the app root is
 * `overflow: hidden` and there is nothing to scroll.
 *
 * The Processes popover hit this first (widest box, and its trigger is the LAST
 * segment of a centered row, so it starts furthest right), but the bug is
 * structural: every one of these menus has it. These two functions are the whole
 * fix — clamp the box into the viewport, and cap its height to the room actually
 * available on the side it opens toward.
 *
 * Kept here, pure and DOM-free, for the same reason `place` is: the interesting
 * part is the arithmetic at the edges, and that deserves tests. See
 * lib/useMenuAnchor.ts for the wiring.
 */

/** Which trigger edge the menu lines up with when there's room for its choice. */
export type MenuAlign = 'start' | 'end'
/** Which way the menu opens away from its trigger. */
export type MenuSide = 'top' | 'bottom'
/**
 * A menu never gets squeezed below this. Past it the honest answer is a scroll
 * bar, not a 30px sliver that can't show a single row.
 */
export const MIN_MENU_H = 120

/**
 * The menu's left edge, expressed RELATIVE TO ITS TRIGGER — i.e. exactly what an
 * `absolute` child of the trigger wants for `left`. Returning an offset rather
 * than a viewport coordinate keeps the menu a normal positioned child, so it
 * still moves with its trigger between measurements instead of detaching.
 */
export function alignMenu(
  triggerLeft: number,
  triggerWidth: number,
  menuWidth: number,
  viewportWidth: number,
  align: MenuAlign = 'start'
): number {
  const ideal = align === 'end' ? triggerLeft + triggerWidth - menuWidth : triggerLeft
  // When the menu is wider than the viewport allows, the left margin wins. Text
  // starts on the left, so a box that MUST be cut should lose its tail rather
  // than its first character.
  const left = Math.max(MARGIN, Math.min(ideal, viewportWidth - MARGIN - menuWidth))
  return Math.round(left - triggerLeft)
}

/**
 * How tall the menu may be before it has to scroll, given the room between the
 * trigger and the viewport edge it opens toward. `gap` is the space the menu
 * already reserves between itself and the trigger.
 */
export function menuMaxHeight(
  triggerTop: number,
  triggerBottom: number,
  viewportHeight: number,
  side: MenuSide = 'top',
  gap = 6
): number {
  const room =
    side === 'top' ? triggerTop - gap - MARGIN : viewportHeight - triggerBottom - gap - MARGIN
  return Math.max(MIN_MENU_H, Math.floor(room))
}

/** Largest the image can be drawn inside `availW`×`availH`, or null if it can't. */
function fit(
  natW: number,
  natH: number,
  availW: number,
  availH: number,
  floor: number
): [number, number] | null {
  const w = Math.min(availW, MAX_W)
  const h = Math.min(availH, MAX_H)
  if (w < floor || h < floor) return null
  const shrink = Math.min(w / natW, h / natH)
  // Only upscale genuinely small images, and never past what actually fits.
  const scale =
    shrink < 1 ? shrink : Math.min(shrink, Math.max(1, MIN_LONG_EDGE / Math.max(natW, natH)))
  // Round, then clamp to what's available. Flooring both would visibly distort
  // extreme ratios — an 80×3000 strip loses 6% of its width to a single floor —
  // while the clamp keeps the box inside its budget regardless.
  const outW = Math.min(Math.round(natW * scale), Math.floor(w))
  const outH = Math.min(Math.round(natH * scale), Math.floor(h))
  // Judged on the long edge: a panorama is perfectly legible at 400×20 even
  // though its height never clears the floor, so requiring both would reject it.
  if (Math.max(outW, outH) < floor) return null
  return [outW, outH]
}

/**
 * Anchor the box to the trigger on whichever side gives the biggest image.
 *
 * Trying only above/below isn't enough: a tall screenshot next to a thumbnail in
 * the middle of a short window fits in neither band, and clamping it into one
 * anyway covers the very thumbnail you're pointing at. So all four sides are
 * measured and the roomiest wins, biased toward above/below — those read as the
 * natural direction and shouldn't be traded away for a marginal size gain.
 *
 * Returns null when no side has room: a viewport that small is better served by
 * the bare thumbnail than by a box sitting on top of it.
 */
export function place(
  rect: Rect,
  natW: number,
  natH: number,
  vw: number,
  vh: number
): Placement | null {
  if (natW <= 0 || natH <= 0) return null
  // Worth-it floor, relative to the thumbnail you're already looking at.
  const floor = Math.max(MIN_USEFUL, Math.max(rect.width, rect.height) * MIN_GROWTH)
  const spanW = vw - MARGIN * 2
  const spanH = vh - MARGIN * 2 - CHROME_H

  const avail: Record<Side, [number, number]> = {
    top: [spanW, rect.top - GAP - MARGIN - CHROME_H],
    bottom: [spanW, vh - rect.bottom - GAP - MARGIN - CHROME_H],
    right: [vw - rect.right - GAP - MARGIN, spanH],
    left: [rect.left - GAP - MARGIN, spanH]
  }
  // Vertical placements win ties and near-ties (see above).
  const bias: Record<Side, number> = { top: 1.2, bottom: 1.15, right: 1, left: 1 }

  let best: { side: Side; w: number; h: number } | null = null
  let bestScore = 0
  for (const side of ['top', 'bottom', 'right', 'left'] as Side[]) {
    const got = fit(natW, natH, avail[side][0], avail[side][1], floor)
    if (!got) continue
    const score = got[0] * got[1] * bias[side]
    if (score > bestScore) {
      bestScore = score
      best = { side, w: got[0], h: got[1] }
    }
  }
  if (!best) return null

  const { side, w, h } = best
  const boxH = h + CHROME_H
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2

  if (side === 'top' || side === 'bottom') {
    const left = clamp(cx - w / 2, MARGIN, vw - MARGIN - w)
    const top = side === 'top' ? rect.top - GAP - boxH : rect.bottom + GAP
    return {
      left,
      top,
      width: w,
      height: h,
      side,
      origin: `${clamp(cx - left, 0, w)}px ${side === 'top' ? '100%' : '0'}`
    }
  }
  const left = side === 'right' ? rect.right + GAP : rect.left - GAP - w
  const top = clamp(cy - boxH / 2, MARGIN, vh - MARGIN - boxH)
  return {
    left,
    top,
    width: w,
    height: h,
    side,
    origin: `${side === 'right' ? '0' : '100%'} ${clamp(cy - top, 0, boxH)}px`
  }
}
