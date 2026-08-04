/**
 * Installs the squircle paint worklet and flips the `data-squircle` flag on
 * <html> once it's live. Everything in `main.css` under `[data-squircle]` stays
 * inert until then, so the app renders correct (just circular) corners on the
 * first frame and upgrades in place -- no flash of unstyled boxes, and no broken
 * UI if the API is missing.
 *
 * The worklet source is inlined with `?raw` and loaded from a blob: URL rather
 * than shipped as a separate chunk, because `addModule()` needs a URL that
 * resolves identically under the dev server (http://localhost) and in the packaged
 * app (file://), and Vite would otherwise treat the worklet as a normal module
 * and rewrite/hash it into `assets/`.
 */
import workletSource from './squircle-worklet.js?raw'

/**
 * Custom properties the worklet reads. Registering them buys three things a plain
 * `--var` doesn't have: the paint callback re-runs when the value changes, the
 * worklet receives a parsed `CSSUnitValue`/color instead of a raw token string,
 * and each has an initial value so an element that only sets `--sq-r` still gets a
 * sane ring color.
 */
const PROPS: { name: string; syntax: string; initialValue: string }[] = [
  { name: '--sq-r', syntax: '<length>', initialValue: '8px' },
  { name: '--sq-dash', syntax: '<length>', initialValue: '0px' },
  { name: '--sq-ring', syntax: '<color>', initialValue: 'transparent' },
  { name: '--sq-fill', syntax: '<color>', initialValue: 'transparent' }
]

let started = false

export function installSquircle(): void {
  if (started) return
  started = true

  const css = window.CSS as (typeof window.CSS & { paintWorklet?: Worklet }) | undefined
  if (!css?.paintWorklet || typeof css.registerProperty !== 'function') return

  for (const prop of PROPS) {
    try {
      css.registerProperty({ ...prop, inherits: false })
    } catch {
      // Already registered (StrictMode double-invoke, or a hot reload that kept
      // the document alive). Harmless -- the definition is identical.
    }
  }

  const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }))
  void css.paintWorklet
    .addModule(url)
    .then(() => {
      document.documentElement.dataset.squircle = ''
    })
    .catch(() => {
      // Leave the flag off: every `.sq-*` class keeps its `border-radius`
      // fallback, so the app just looks like it did before.
    })
    .finally(() => URL.revokeObjectURL(url))
}
