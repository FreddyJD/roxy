/**
 * A scrolling container with overlay scrollbars.
 *
 * Drop-in replacement for `<div className="… overflow-y-auto">`: it renders
 * exactly that element and attaches the scrollbars to it, so no wrapper enters
 * the tree and layout (flex sizing, sticky children, `max-h-*` caps) is
 * unchanged. See lib/overlayScroll.ts for why that matters.
 *
 * `as` switches the tag — `ul` for lists, `pre` for log panes — and the props
 * type follows it, so `<Scroller as="ul">` still type-checks its `<ul>` events.
 *
 * Deliberately does NOT forward a ref: this owns the element's ref to attach
 * the scrollbars, and on React 18 a `ref` prop would silently do nothing here.
 * If you need the node (to drive scroll position yourself, as ChatView does),
 * keep your own `<div ref>` and call `useOverlayScroll(ref)` instead.
 */
import { useRef, type ComponentPropsWithoutRef, type ElementType } from 'react'
import type { PartialOptions } from 'overlayscrollbars'
import { useOverlayScroll } from '../lib/overlayScroll'

type Props<T extends ElementType> = {
  as?: T
  options?: PartialOptions
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'options'>

export function Scroller<T extends ElementType = 'div'>({
  as,
  options,
  ...rest
}: Props<T>): JSX.Element {
  const Tag = (as ?? 'div') as ElementType
  const ref = useRef<HTMLElement>(null)
  useOverlayScroll(ref, options)
  return <Tag ref={ref} {...rest} />
}
