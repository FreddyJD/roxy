/**
 * What a right-click should offer — the rules, as pure data.
 *
 * Roxy sets no application menu, so nothing in the app ever built the standard
 * edit menu for itself: right-clicking a selection or the composer produced
 * nothing at all. This module decides WHICH rows a given click earns; the two
 * places that render them (a themed React menu in the app window, a native
 * Electron menu over the agent's browser) both read from here, so a rule fixed
 * once is fixed in both.
 *
 * Pure and DOM-free on purpose — the interesting part is the edge cases
 * (password fields, read-only inputs, an empty clipboard), and those deserve
 * tests rather than a manual pass over every input in the app. See test/shared.ts.
 */

/** The editing commands a menu row can request. */
export type ClipboardAction = 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo' | 'copyLink'

/** Everything the rules need to know about what was clicked. */
export interface ClickContext {
  /** The click landed in an <input>, <textarea>, or a contenteditable host. */
  editable: boolean
  /** There is a non-collapsed selection (inside the field, or in the document). */
  hasSelection: boolean
  /** The clipboard holds something pasteable (text or an image). */
  clipboardHasContent: boolean
  /** An editable that can't be written to: `readonly` or `disabled`. */
  readOnly?: boolean
  /**
   * The editable holds no text. Select All is then a no-op, and Chromium's own
   * menu greys it out — so ours does too.
   */
  empty?: boolean
  /**
   * A password field. Its text can never leave the app — Chromium refuses to
   * cut or copy it — so offering those rows would be offering rows that lie.
   */
  password?: boolean
  /** Href of the anchor under the cursor, if any. */
  linkUrl?: string
}

export interface ContextMenuItem {
  action: ClipboardAction
  label: string
  /** Display-only shortcut hint. Rendered as text by the themed menu; Electron
   *  parses the same string as a real accelerator in the native one. */
  accelerator: string
  enabled: boolean
  /** Rows are drawn in ascending group order, with a divider between groups. */
  group: number
}

const isMac = (platform: string): boolean => platform === 'darwin'

/** `CmdOrCtrl+X` — the spelling Electron's Menu accepts, and readable as-is. */
const accel = (platform: string, key: string): string =>
  `${isMac(platform) ? 'Cmd' : 'Ctrl'}+${key}`

/**
 * The rows a right-click at `ctx` deserves, in the order every desktop platform
 * puts them: Cut / Copy / Paste, then Select All below a divider.
 *
 * Returns an EMPTY list when there is nothing honest to offer (a right-click on
 * a bare panel with no selection). Callers must treat that as "show no menu" —
 * popping an empty box, or one with every row greyed out, is worse than the
 * nothing we started with.
 *
 * Disabled-but-present beats absent for the three core rows whenever the click
 * is in a field: their positions are muscle memory, and a menu whose rows move
 * depending on whether the clipboard happens to be full can't be used without
 * reading it every time. Outside a field there's no such expectation, so the
 * menu shrinks to what actually applies.
 */
export function contextMenuItems(ctx: ClickContext, platform: string): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  const writable = ctx.editable && !ctx.readOnly
  // A password field's contents are unreadable to us by design; a read-only
  // field has text worth copying but nothing worth cutting.
  const canCopy = ctx.hasSelection && !ctx.password

  if (ctx.editable) {
    items.push(
      {
        action: 'cut',
        label: 'Cut',
        accelerator: accel(platform, 'X'),
        enabled: canCopy && writable,
        group: 0
      },
      {
        action: 'copy',
        label: 'Copy',
        accelerator: accel(platform, 'C'),
        enabled: canCopy,
        group: 0
      },
      {
        action: 'paste',
        label: 'Paste',
        accelerator: accel(platform, 'V'),
        enabled: writable && ctx.clipboardHasContent,
        group: 0
      }
    )
  } else if (canCopy) {
    // Nothing to cut or paste into, so Copy stands alone rather than sitting
    // between two rows that could never fire.
    items.push({
      action: 'copy',
      label: 'Copy',
      accelerator: accel(platform, 'C'),
      enabled: true,
      group: 0
    })
  }

  if (ctx.linkUrl) {
    items.push({
      action: 'copyLink',
      label: 'Copy Link',
      accelerator: '',
      enabled: true,
      group: 1
    })
  }

  // Select All is only meaningful where it has a defined target: inside a
  // field. On a page it would select the entire window's text, which is never
  // what someone right-clicking one paragraph meant.
  if (ctx.editable) {
    items.push({
      action: 'selectAll',
      label: 'Select All',
      accelerator: accel(platform, 'A'),
      enabled: !ctx.empty,
      group: 2
    })
  }

  return items
}

/** True when the menu has at least one row the user could actually click. */
export function hasUsableItems(items: ContextMenuItem[]): boolean {
  return items.some((i) => i.enabled)
}
