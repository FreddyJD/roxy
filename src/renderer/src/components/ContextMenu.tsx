import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placeContextMenu } from '../lib/anchor'
import { cn } from '../lib/cn'

/**
 * The shell every right-click menu in the app shares: positioning at the
 * cursor, portalling out of whatever scroll container summoned it, and the
 * dismissal rules.
 *
 * Extracted from the sidebar's session menu when a second one (the clipboard
 * menu) arrived. Two menus with independently-written dismissal logic is how
 * you end up with one that survives a scroll and one that doesn't — the
 * behaviour here IS the contract, so it lives in one place.
 */

/** Fixed width, so a menu can be positioned before it has rendered. */
export const CONTEXT_MENU_W = 208
/** One row. Must match the row markup below (`py-1.5` + `text-xs` line box). */
export const CONTEXT_ROW_H = 30
/** A divider: 1px rule with 2px of air on each side. */
export const CONTEXT_SEPARATOR_H = 5
/** The surface's own `py-1`, top + bottom. */
export const CONTEXT_MENU_PAD = 8

/**
 * Positioned, self-dismissing menu surface. `height` is the caller's estimate
 * of the rendered height — placement has to happen before layout, so the caller
 * derives it from its row counts using the constants above.
 *
 * Dismissal is deliberately broad (outside mousedown, scroll, Escape, window
 * blur): every one of those means attention has moved on, and a menu still
 * floating over content that has since moved is pointing at the wrong thing.
 */
export function ContextMenuSurface({
  x,
  y,
  height,
  width = CONTEXT_MENU_W,
  onClose,
  children
}: {
  x: number
  y: number
  height: number
  width?: number
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { left, top, origin } = placeContextMenu(
    x,
    y,
    width,
    height,
    window.innerWidth,
    window.innerHeight
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // Dismiss on mousedown rather than click, so the menu is gone before
    // whatever is underneath reacts — but only for a press OUTSIDE it. Closing
    // on a press inside would unmount the button between its own mousedown and
    // click, and the item would simply never fire.
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    // Capture phase throughout: `scroll` does not bubble, so this is the only
    // way to hear a list move — and a stopPropagation anywhere in the tree must
    // not be able to strand an open menu.
    //
    // Scroll, rather than wheel, is the precise condition: the menu is pinned to
    // viewport coordinates while the thing it acts on may be inside a scroll
    // container, so the moment that container moves the menu is pointing
    // elsewhere. That covers the thumb drag and the keyboard just as well as the
    // trackpad, and correctly ignores a wheel gesture over a list already at its
    // end — nothing moved, so nothing is stale.
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      style={{ left, top, width, transformOrigin: origin }}
      // Swallow the right-click so chording onto the menu doesn't reopen it at
      // a new point over itself.
      onContextMenu={(e) => e.preventDefault()}
      className="animate-pop-in fixed z-50 overflow-hidden sq-frame sq-lg sq-fill-elevated sq-ring rounded-lg border border-border bg-elevated py-1 shadow-2xl"
    >
      {children}
    </div>,
    document.body
  )
}

/**
 * One clickable row.
 *
 * `preserveFocus` is what makes the clipboard menu work at all: a <button>
 * takes focus on mousedown, which would blur the very input the command is
 * meant to act on, and `cut`/`paste` would then fire against nothing. Killing
 * the default on mousedown keeps focus (and the caret, and the selection)
 * exactly where the user left it.
 */
export function ContextMenuRow({
  label,
  icon: Icon,
  accelerator,
  disabled,
  danger,
  preserveFocus,
  onSelect
}: {
  label: string
  icon?: React.ComponentType<{ className?: string }>
  accelerator?: string
  disabled?: boolean
  danger?: boolean
  preserveFocus?: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={preserveFocus ? (e) => e.preventDefault() : undefined}
      onClick={onSelect}
      className={cn(
        'press-scale flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors',
        disabled
          ? 'cursor-default text-text-subtle opacity-50'
          : danger
            ? 'text-text-muted hover:bg-danger/10 hover:text-danger'
            : 'text-text-muted hover:bg-white/5 hover:text-text'
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      <span className="flex-1 truncate">{label}</span>
      {accelerator && (
        <span className="shrink-0 font-mono text-[10px] text-text-subtle">{accelerator}</span>
      )}
    </button>
  )
}

/** The hairline between groups. Height must stay CONTEXT_SEPARATOR_H. */
export function ContextMenuSeparator(): JSX.Element {
  return <div className="my-0.5 h-px bg-border" />
}
