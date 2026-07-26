/**
 * Hover-to-preview for attachment thumbnails.
 *
 * Attachments are stored as bounded data URLs (see lib/images.ts) and rendered
 * as 36–64px thumbnails, which is far too small to tell one screenshot from
 * another. Hovering a thumbnail floats the full image beside it so you can see
 * what you actually attached before it's sent.
 *
 * It renders through a portal on purpose: the queue list is a scroll container
 * (`max-h-52 overflow-y-auto`), so an absolutely-positioned preview would be
 * clipped by its own row. Fixed coordinates computed from the trigger's rect
 * escape every ancestor's overflow without needing a positioned parent.
 *
 * The geometry lives in lib/anchor.ts so it can be tested without a DOM.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { place, CHROME_H, type Placement } from '../lib/anchor'

/** Hover intent — long enough that sweeping across a row doesn't flash previews. */
const OPEN_DELAY = 200
/**
 * After one closes, the next opens instantly: once you're clearly scanning
 * attachments, re-paying the intent delay per thumbnail feels sticky.
 */
const CHAIN_WINDOW = 450

/** Shared across instances — "did a preview just close?" is a global question. */
let lastClosedAt = 0

/**
 * Natural dimensions per src. The thumbnail already decoded these bytes, but
 * caching makes repeat hovers synchronous instead of a promise tick late.
 */
const dimsCache = new Map<string, { w: number; h: number }>()

function measure(src: string): Promise<{ w: number; h: number } | null> {
  const hit = dimsCache.get(src)
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const dims = { w: img.naturalWidth, h: img.naturalHeight }
      if (!dims.w || !dims.h) return resolve(null)
      dimsCache.set(src, dims)
      resolve(dims)
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/**
 * Shared look for a hoverable attachment thumbnail: the cursor advertises that
 * there's more to see, and the border lifts on hover so the trigger reacts
 * immediately — before the preview's intent delay has elapsed.
 */
export const HOVERABLE_THUMB =
  'cursor-zoom-in border border-border object-cover transition-colors duration-150 hover:border-border-strong'

/**
 * Wraps a thumbnail: `children` is the trigger (rendered as-is), `src` is the
 * full image to float on hover.
 */
export function ImagePreview({
  src,
  name,
  className,
  children
}: {
  src: string
  name?: string
  className?: string
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  /**
   * Hover tracked explicitly rather than read back off `:hover`: measuring is
   * async and the pointer can leave mid-decode. A ref, not state, so the
   * pending timer sees the current value without re-running an effect.
   */
  const inside = useRef(false)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  const close = useCallback((): void => {
    clearTimeout(timer.current)
    setPlacement((prev) => {
      if (prev) lastClosedAt = Date.now()
      return null
    })
  }, [])

  const open = useCallback(async (): Promise<void> => {
    const size = dimsCache.get(src) ?? (await measure(src))
    // Bail if the image is undecodable, the pointer left during the decode, or
    // the row unmounted (a queued item can be sent while you're hovering it).
    if (!size || !inside.current || !ref.current) return
    const next = place(
      ref.current.getBoundingClientRect(),
      size.w,
      size.h,
      window.innerWidth,
      window.innerHeight
    )
    // No room anywhere — leave the thumbnail alone rather than cover it.
    if (!next) return
    setDims(size)
    setPlacement(next)
  }, [src])

  const onEnter = useCallback((): void => {
    inside.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => void open(),
      Date.now() - lastClosedAt < CHAIN_WINDOW ? 0 : OPEN_DELAY
    )
  }, [open])

  const onLeave = useCallback((): void => {
    inside.current = false
    close()
  }, [close])

  // Any layout change invalidates the anchored coordinates. Recomputing on
  // scroll would fight the pointer (the thumbnail slides out from under it), so
  // dismiss instead — the hover that opened it is no longer meaningful.
  useEffect(() => {
    if (!placement) return
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [placement, close])

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    // `inline-flex` lets the wrapper hug its child exactly, so it can stand in
    // for the thumbnail as a flex item without disturbing any layout — and
    // unlike `display: contents` it has a real box to measure.
    <span
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={cn('inline-flex', className)}
    >
      {children}
      {placement &&
        createPortal(
          <div
            // pointer-events-none: the preview sits in the cursor's path, and a
            // hover layer that can itself be hovered creates flicker loops.
            className="animate-pop-in pointer-events-none fixed z-50 overflow-hidden rounded-xl border border-border-strong bg-elevated p-1 shadow-2xl"
            style={{
              left: placement.left,
              top: placement.top,
              width: placement.width,
              transformOrigin: placement.origin
            }}
          >
            <img
              src={src}
              alt={name ?? 'attachment'}
              style={{ height: placement.height }}
              className="block w-full rounded-lg object-contain"
            />
            {/* Fixed height — lib/anchor.ts reserves exactly CHROME_H for this
                strip plus the frame's padding when it positions the box. */}
            <div
              style={{ height: CHROME_H - 8 }}
              className="flex items-center gap-1.5 px-1 text-[10px] text-text-subtle"
            >
              {name && <span className="min-w-0 truncate">{name}</span>}
              {dims && (
                <span className="ml-auto shrink-0 tabular-nums">
                  {dims.w}×{dims.h}
                </span>
              )}
            </div>
          </div>,
          document.body
        )}
    </span>
  )
}
