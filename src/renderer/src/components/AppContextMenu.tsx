import { useCallback, useEffect, useState } from 'react'
import { ClipboardPaste, Copy, Link2, Scissors, TextSelect } from 'lucide-react'
import {
  contextMenuItems,
  hasUsableItems,
  type ClickContext,
  type ClipboardAction,
  type ContextMenuItem
} from '@shared/context-menu'
import { api } from '../lib/api'
import {
  ContextMenuRow,
  ContextMenuSeparator,
  ContextMenuSurface,
  CONTEXT_MENU_PAD,
  CONTEXT_ROW_H,
  CONTEXT_SEPARATOR_H
} from './ContextMenu'

/**
 * The app-wide right-click editing menu — Cut / Copy / Paste / Select All.
 *
 * The app had no right-click menu of its own outside the sidebar's session
 * rows, so right-clicking the composer, a path field or a block of a reply did
 * nothing at all. One listener at the root fixes that for every input, textarea
 * and selectable region at once, so nothing has to opt in.
 *
 * The KEYBOARD shortcuts were never broken — see services/context-menu.ts for
 * why, and for the one change that would break them.
 *
 * Drawn in React rather than as a native Electron menu on purpose: the app
 * already portals a themed menu for session rows, and a grey system menu
 * popping up beside it reads as a bug. The COMMANDS still run natively through
 * main (see services/context-menu.ts) so the field's undo stack is untouched.
 */

const ICONS: Record<ClipboardAction, React.ComponentType<{ className?: string }>> = {
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  selectAll: TextSelect,
  copyLink: Link2,
  undo: Copy,
  redo: Copy
}

interface MenuState {
  x: number
  y: number
  items: ContextMenuItem[]
  linkUrl?: string
}

/** The editable host a click landed in, if any. */
function editableAt(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof HTMLElement ? target : null
  if (!el) return null
  if (el instanceof HTMLTextAreaElement) return el
  // Only text-bearing inputs: right-clicking a checkbox or a colour swatch has
  // nothing to cut, and offering it a text menu would be noise.
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    const textual =
      type === 'text' ||
      type === 'search' ||
      type === 'url' ||
      type === 'tel' ||
      type === 'email' ||
      type === 'password' ||
      type === 'number'
    return textual ? el : null
  }
  return el.closest<HTMLElement>('[contenteditable="true"], [contenteditable=""]')
}

/**
 * Is there a real selection inside this field? `selectionStart` is null for
 * input types that don't support it, which is why the textual filter above runs
 * first.
 */
function fieldHasSelection(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return (
      el.selectionStart !== null && el.selectionEnd !== null && el.selectionEnd > el.selectionStart
    )
  }
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && sel.toString().length > 0
}

/** Nothing to select — Select All would be a no-op. */
function fieldIsEmpty(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.length === 0
  }
  return (el.textContent ?? '').length === 0
}

export function AppContextMenu(): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const close = useCallback(() => setMenu(null), [])

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      // An element that already runs its own menu (the sidebar's session rows)
      // calls preventDefault first; this listener is the fallback, not an
      // override, so it must never replace a more specific menu.
      if (e.defaultPrevented) return

      const el = editableAt(e.target)
      const anchor = e.target instanceof HTMLElement ? e.target.closest('a[href]') : null
      const selection = window.getSelection()
      const ctx: ClickContext = {
        editable: !!el,
        hasSelection: el ? fieldHasSelection(el) : !!selection && !selection.isCollapsed,
        // Filled in below — the clipboard read is async and we don't want the
        // menu's position to wait on IPC.
        clipboardHasContent: false,
        readOnly:
          !!el &&
          ((el as HTMLInputElement).readOnly === true ||
            (el as HTMLInputElement).disabled === true),
        password: el instanceof HTMLInputElement && el.type.toLowerCase() === 'password',
        empty: !!el && fieldIsEmpty(el),
        linkUrl: anchor instanceof HTMLAnchorElement ? anchor.href : undefined
      }

      // Nothing to offer (a right-click on bare chrome with no selection): let
      // it pass rather than popping a box of greyed-out words. Close any menu
      // still open first — a mouse right-click would have dismissed it via the
      // preceding mousedown, but the keyboard's context-menu key fires no
      // mousedown at all, and would otherwise strand the previous menu.
      const provisional = contextMenuItems({ ...ctx, clipboardHasContent: true }, platform())
      if (!hasUsableItems(provisional)) {
        setMenu(null)
        return
      }

      e.preventDefault()
      const { clientX: x, clientY: y } = e
      // Show immediately with Paste optimistically live, then correct it once
      // the real clipboard state arrives. The alternative — awaiting IPC before
      // rendering — puts a visible delay between the click and the menu, which
      // is the one thing a context menu can't afford.
      setMenu({ x, y, items: provisional, linkUrl: ctx.linkUrl })
      void api.clipboard
        .hasContent()
        .then((has) => {
          if (has) return
          const corrected = contextMenuItems({ ...ctx, clipboardHasContent: false }, platform())
          setMenu((m) => {
            // Only correct the menu THIS click opened - a second right-click
            // during the round trip must not be rewritten by a stale answer.
            if (!m || m.x !== x || m.y !== y) return m
            // Paste was the only thing holding the menu up (an empty field, an
            // empty clipboard): close rather than leave a box of dead rows.
            return hasUsableItems(corrected) ? { ...m, items: corrected } : null
          })
        })
        .catch(() => {})
    }

    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])

  if (!menu) return null

  const groups = new Set(menu.items.map((i) => i.group))
  const height =
    menu.items.length * CONTEXT_ROW_H + (groups.size - 1) * CONTEXT_SEPARATOR_H + CONTEXT_MENU_PAD

  const run = (action: ClipboardAction): void => {
    close()
    void api.clipboard.exec(action, menu.linkUrl).catch(() => {})
  }

  let group = menu.items[0]?.group ?? 0
  return (
    <ContextMenuSurface x={menu.x} y={menu.y} height={height} onClose={close}>
      {menu.items.map((item) => {
        const divider = item.group !== group
        group = item.group
        return (
          <div key={item.action}>
            {divider && <ContextMenuSeparator />}
            <ContextMenuRow
              label={item.label}
              icon={ICONS[item.action]}
              accelerator={item.accelerator}
              disabled={!item.enabled}
              // The whole point: never steal focus from the field being edited.
              preserveFocus
              onSelect={() => run(item.action)}
            />
          </div>
        )
      })}
    </ContextMenuSurface>
  )
}

/** The OS, for accelerator labels (`Cmd+C` vs `Ctrl+C`). */
function platform(): string {
  return document.documentElement.dataset.platform ?? 'win32'
}
