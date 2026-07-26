/**
 * App-wide overlay scrollbars.
 *
 * The native Windows/Linux scrollbar is a 10px opaque gutter that permanently
 * steals layout width and repaints as a bright bar over a near-black UI. No
 * amount of `::-webkit-scrollbar` styling fixes the two things that actually
 * make it look cheap: it is ALWAYS there, and it CHANGES THE LAYOUT when
 * content grows past its container. macOS solved this years ago by overlaying
 * the scrollbar and fading it out when you stop scrolling. This gives every
 * platform that behavior.
 *
 * ## Why `elements.viewport` points at the target itself
 *
 * By default OverlayScrollbars wraps your element: it injects a `viewport` div
 * inside, moves the children into it, and that inner div becomes the thing that
 * actually scrolls. That would silently break every piece of scroll logic in
 * this app, because they all hold a ref to the OUTER element:
 *
 *   - ChatView's stick-to-bottom + prepend-anchoring reads `scrollTop`,
 *     `scrollHeight`, `clientHeight` and calls `scrollTo` on its own ref.
 *   - ChatView's infinite-scroll-up pagination is a React `onScroll` prop,
 *     which only fires for a scroll event on THAT element.
 *   - ServicesSegment finds its log pane with `querySelector('pre')` and
 *     listens via `onScrollCapture` on a wrapper.
 *   - Sticky headers (ModelPicker's search box) are positioned against their
 *     scrollport; a new intermediate div changes what that is.
 *
 * Passing `viewport: target` tells the library "this element is already the
 * scrollport, do not build one". It then only observes and draws — no wrapper
 * div, no moved children, no changed containing block. The stylesheet's
 * `[data-overlayscrollbars-viewport]:not([data-overlayscrollbars])` rules are
 * written for exactly this mode. So every existing ref, event handler and
 * sticky child keeps working untouched, and the scrollbars become cosmetic.
 *
 * The tradeoff is that we keep the element's own `overflow` from Tailwind
 * (`overflow-y-auto` etc.) rather than letting the library manage it, which is
 * why `overflow` is left at its default here.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { OverlayScrollbars, type PartialOptions } from 'overlayscrollbars'

/**
 * Shared defaults.
 *
 * `autoHide: 'scroll'` is the macOS behavior the native Windows bar lacks: the
 * bar exists only while you are actually scrolling, then fades. `leave` was the
 * other candidate, but it keeps the bar visible the whole time the pointer is
 * anywhere over a pane — for the chat transcript, which fills the window, that
 * is indistinguishable from always-on.
 *
 * `autoHideSuspend: false` matters more than it looks: with `true` the library
 * keeps scrollbars visible until the FIRST scroll interaction, so every pane
 * would show a bar on mount and only start hiding after you touch it. We want
 * them hidden from the start.
 */
const BASE: PartialOptions = {
  scrollbars: {
    theme: 'os-theme-roxy',
    autoHide: 'scroll',
    autoHideDelay: 500,
    autoHideSuspend: false,
    // Click-drag the handle like a normal scrollbar; jump-on-track-click too.
    dragScroll: true,
    clickScroll: true
  }
}

/**
 * Attach overlay scrollbars to an element you already have a ref to.
 *
 * Use this when the element needs its own ref for scroll logic (ChatView) or
 * when it is rendered by a component you don't control the markup of. For
 * plain containers prefer `<Scroller>` below.
 */
export function useOverlayScroll(
  ref: RefObject<HTMLElement | null>,
  options?: PartialOptions
): void {
  // Keep the latest options in a ref so a caller passing an inline object
  // literal (the common case) doesn't tear down and rebuild the instance on
  // every render — which would lose scroll position.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const instance = OverlayScrollbars(
      // `viewport: el` == "the target already IS the scrollport". See the file
      // comment: this is what keeps refs and scroll math valid.
      //
      // `nativeScrollbarsOverlaid: false` forces initialization even on
      // platforms that already draw overlay scrollbars (macOS with a trackpad).
      // It has to: main.css hides native scrollbars inside #root
      // unconditionally, so cancelling there would leave macOS with no
      // scrollbar at all rather than falling back to a good native one.
      {
        target: el,
        elements: { viewport: el },
        cancel: { nativeScrollbarsOverlaid: false, body: null }
      },
      merge(BASE, optionsRef.current)
    )
    // Re-initializing on an element that a previous instance was destroyed on
    // leaves the new scrollbars stuck hidden: they keep
    // `os-scrollbar-auto-hide-hidden` and never fade in, however much you
    // scroll. Programmatic scrolling never clears it either — which is exactly
    // the chat transcript's case, since it scrolls itself to the bottom on
    // every new message — so the bar stays invisible for the life of the pane.
    //
    // This is not a rare path. React StrictMode runs every effect
    // mount -> cleanup -> mount in development, so the SECOND instance is the
    // one that survives and it is always the broken one. Any genuine remount
    // (route change, ref identity change) reproduces it in production too.
    //
    // A forced update makes the library recompute its auto-hide state against
    // the element it just adopted. Verified against overlayscrollbars 2.16.0
    // in Electron: without it the handle sits at opacity 0 through repeated
    // scrolls; with it, opacity 1 — identical to a clean first mount.
    instance.update(true)
    return () => instance.destroy()
  }, [ref])
}

/** Shallow-merge that keeps the nested `scrollbars` defaults intact. */
function merge(base: PartialOptions, extra?: PartialOptions): PartialOptions {
  if (!extra) return base
  return {
    ...base,
    ...extra,
    scrollbars: { ...base.scrollbars, ...extra.scrollbars }
  }
}
