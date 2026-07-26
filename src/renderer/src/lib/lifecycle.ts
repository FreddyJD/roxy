/**
 * The shared visual vocabulary for a branch's lifecycle state.
 *
 * Two places render it now - the workstream strip under the composer, and the
 * sidebar's session rows - and they must never disagree. A `merged` PR that is
 * green in one and grey in the other is worse than showing it in only one
 * place: the user learns the colour means nothing.
 *
 * So the mapping lives here rather than in either component. `LifecycleTone` is
 * the semantic layer (defined in `shared/forge` alongside the state machine
 * that produces it); this is the only file allowed to turn a tone into a class.
 */
import type { LifecycleTone } from '@shared/forge'

/**
 * Colour is the fastest channel a status indicator has, so it carries the one
 * thing worth interrupting for: whether something needs the user. Merged is the
 * only green - "done" is the state worth celebrating, and if everything were
 * coloured nothing would stand out.
 */
export const TONE_TEXT: Record<LifecycleTone, string> = {
  neutral: 'text-text-subtle hover:text-text-muted',
  info: 'text-text-muted hover:text-text',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger'
}

/**
 * The same tones without the hover pair, for places that aren't a button.
 * Splitting them matters: `hover:` on a non-interactive span is a lie the
 * cursor tells, promising a click that does nothing.
 */
export const TONE_TEXT_STATIC: Record<LifecycleTone, string> = {
  neutral: 'text-text-subtle',
  info: 'text-text-muted',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger'
}

export const TONE_BG: Record<LifecycleTone, string> = {
  neutral: 'bg-text-subtle/70',
  info: 'bg-text-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger'
}
