/**
 * Right-click editing menus — the main-process half.
 *
 * Two consumers, one rule set (../../shared/context-menu):
 *
 *  - The APP window renders a themed React menu (it already has one for session
 *    rows, and a grey native menu next to it would look like a bug). It only
 *    needs main for the two things a renderer genuinely cannot do: read the
 *    system clipboard without a permission prompt, and run cut/copy/paste as
 *    real editing commands. `navigator.clipboard` is the wrong tool for the
 *    latter — it can move text but not integrate with the field's own undo
 *    stack, so Ctrl+Z after a paste would leave the box in a state the user
 *    never typed. `webContents.paste()` is the same command the OS shortcut
 *    fires, so undo behaves exactly as it does everywhere else.
 *
 *  - The agent's BROWSER shows a NATIVE menu, because those pages are arbitrary
 *    websites in a BrowserView — there is no React tree of ours to portal into.
 *    Roles are used rather than manual commands so the menu acts on whatever
 *    Chromium considers focused, which is the only thing that stays correct
 *    inside cross-origin iframes.
 *
 * ON THE KEYBOARD SHORTCUTS: they already work, and this module is not what
 * makes them work. Electron installs a default application menu (with an Edit
 * submenu carrying the cut/copy/paste/selectAll roles) whenever an app never
 * calls `Menu.setApplicationMenu`, which Roxy doesn't — and on Windows/Linux
 * Blink handles Ctrl+C/V/X/A inside editable fields itself regardless. So DO
 * NOT "tidy up" by calling `Menu.setApplicationMenu(null)`: it is advertised as
 * a startup optimization and it silently kills Cmd+C/V/X/A on macOS, where
 * those keys are NSMenu key equivalents and have nowhere else to come from.
 * `autoHideMenuBar` (which both windows do set) is fine — it hides the bar
 * without destroying the accelerators.
 */
import { Menu, clipboard, type MenuItemConstructorOptions, type WebContents } from 'electron'
import {
  contextMenuItems,
  hasUsableItems,
  type ClickContext,
  type ClipboardAction
} from '../../shared/context-menu'

/**
 * Is there anything worth pasting? Text covers the overwhelming majority;
 * images matter because the composer accepts pasted screenshots, and a greyed
 * "Paste" over a copied screenshot would be wrong.
 *
 * `availableFormats()` is the cheap check — reading the image itself decodes a
 * bitmap on every right-click, which is real work for a menu that may never open.
 */
export function clipboardHasContent(): boolean {
  try {
    if (clipboard.readText().length > 0) return true
    return clipboard.availableFormats().some((f) => f.startsWith('image/'))
  } catch {
    return false
  }
}

/**
 * Run one menu command against a webContents.
 *
 * Everything except `copyLink` delegates to Chromium's editing commands, so the
 * field's undo history, selection and input events behave as though the user
 * had pressed the shortcut.
 */
export function runClipboardAction(
  wc: WebContents,
  action: ClipboardAction,
  linkUrl?: string
): void {
  if (wc.isDestroyed()) return
  switch (action) {
    case 'cut':
      wc.cut()
      break
    case 'copy':
      wc.copy()
      break
    case 'paste':
      // `pasteAndMatchStyle` would strip formatting, which sounds tidy and is
      // wrong for a plain <textarea>: it also normalizes newlines, so a pasted
      // stack trace loses its line breaks.
      wc.paste()
      break
    case 'selectAll':
      wc.selectAll()
      break
    case 'undo':
      wc.undo()
      break
    case 'redo':
      wc.redo()
      break
    case 'copyLink':
      if (linkUrl) clipboard.writeText(linkUrl)
      break
  }
}

/** Electron's `role` for each action, where one exists. */
const ROLES: Partial<Record<ClipboardAction, MenuItemConstructorOptions['role']>> = {
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  selectAll: 'selectAll',
  undo: 'undo',
  redo: 'redo'
}

/**
 * Give a webContents a native right-click editing menu.
 *
 * Used for the agent browser's pages. The menu is suppressed entirely when no
 * row would be usable — right-clicking blank page background should do nothing,
 * not pop a box of five greyed-out words.
 */
export function attachNativeContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    const ctx: ClickContext = {
      editable: params.isEditable,
      hasSelection: params.selectionText.trim().length > 0,
      clipboardHasContent: clipboardHasContent(),
      // Chromium reports a read-only or disabled field as editable-but-unwritable,
      // and `canPaste` is exactly that distinction — it reflects the FIELD's own
      // editability, not whether the clipboard happens to hold something.
      readOnly: params.isEditable && !params.editFlags.canPaste,
      password: params.formControlType === 'input-password',
      // Chromium already worked out whether there is anything to select.
      empty: params.isEditable && !params.editFlags.canSelectAll,
      linkUrl: params.linkURL || undefined
    }
    const items = contextMenuItems(ctx, process.platform)
    if (!hasUsableItems(items)) return

    const template: MenuItemConstructorOptions[] = []
    let group = items[0]?.group ?? 0
    for (const item of items) {
      if (item.group !== group) {
        template.push({ type: 'separator' })
        group = item.group
      }
      const role = ROLES[item.action]
      template.push(
        role
          ? { role, label: item.label, enabled: item.enabled }
          : {
              label: item.label,
              enabled: item.enabled,
              click: () => runClipboardAction(wc, item.action, ctx.linkUrl)
            }
      )
    }
    Menu.buildFromTemplate(template).popup({ x: params.x, y: params.y })
  })
}
