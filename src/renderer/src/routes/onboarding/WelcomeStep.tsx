import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { DitherGradient } from '../../components/DitherGradient'

/**
 * Cycled on the welcome screen. `lang` picks the right font fallbacks and tells
 * screen readers how to pronounce each greeting.
 *
 * `latin: false` marks scripts Geist has no glyphs for — they render in a
 * system fallback whose metrics differ, so they skip the tight tracking that
 * only suits Latin type.
 */
const GREETINGS = [
  { text: 'Aloha', lang: 'haw', latin: true },
  { text: 'Hola', lang: 'es', latin: true },
  { text: 'Olá', lang: 'pt-BR', latin: true },
  { text: 'こんにちは', lang: 'ja', latin: false },
  { text: 'Bonjour', lang: 'fr', latin: true },
  { text: '안녕하세요', lang: 'ko', latin: false },
  { text: 'Ciao', lang: 'it', latin: true },
  { text: '你好', lang: 'zh', latin: false },
  { text: 'Hallo', lang: 'de', latin: true },
  { text: 'Привет', lang: 'ru', latin: false },
  { text: 'مرحبا', lang: 'ar', latin: false },
  { text: 'नमस्ते', lang: 'hi', latin: false },
  { text: 'Merhaba', lang: 'tr', latin: true },
  { text: 'Hej', lang: 'sv', latin: true },
  { text: 'Hello', lang: 'en', latin: true }
] as const

/** Long, slow drift — the word should breathe, not flip. */
const FADE_MS = 1100
const HOLD_MS = 3400

/**
 * First screen of the first-run experience: a dithered gradient backdrop with
 * a greeting that drifts between languages, and a single way forward.
 */
export function WelcomeStep({ onContinue }: { onContinue: () => void }): JSX.Element {
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    // Honour the OS setting — a word swapping on a timer is exactly the kind
    // of motion this covers. Reduced motion keeps the first greeting still.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let swap: ReturnType<typeof setTimeout>
    const hold = setTimeout(() => {
      setVisible(false)
      // Swap the text only once it has fully faded out, so the two words never
      // overlap mid-transition.
      swap = setTimeout(() => {
        setIndex((i) => (i + 1) % GREETINGS.length)
        setVisible(true)
      }, FADE_MS)
    }, HOLD_MS)

    return () => {
      clearTimeout(hold)
      clearTimeout(swap)
    }
  }, [index])

  const greeting = GREETINGS[index]

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <DitherGradient from="blue" direction="bottom" bloom="aura" stars={70} />

      <div className="relative flex h-full w-full flex-col items-center justify-center gap-6 px-8">
        {/* Fixed height keeps the button still while scripts of very different
            heights swap through. aria-live announces each greeting once. */}
        <div className="flex h-20 items-center" aria-live="polite" aria-atomic>
          {/* No `key` here on purpose: remounting the element would restart it
              at its final opacity and skip the fade-in entirely. */}
          <h1
            lang={greeting.lang}
            className={`text-5xl font-bold text-white ${greeting.latin ? 'tracking-tight' : 'tracking-normal'}`}
            style={{
              opacity: visible ? 1 : 0,
              // Barely-there drift, so it reads as a breeze rather than a slide.
              transform: visible ? 'translateY(0)' : 'translateY(6px)',
              transition: `opacity ${FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1), transform ${FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
              // Promote to its own layer so the fade composites on the GPU and
              // never re-rasterizes the text against the canvases behind it.
              willChange: 'opacity, transform'
            }}
          >
            {greeting.text}
          </h1>
        </div>

        {/* Static on purpose — it anchors the block while the greeting cycles. */}
        <p className="-mt-3 max-w-sm text-center text-sm text-white/60">
          This might be a complete disaster. It might also be the best thing you use all year!
        </p>

        <button
          onClick={onContinue}
          className="press-scale flex h-10 items-center justify-center gap-2 rounded-lg bg-white px-6 text-sm font-medium text-black hover:bg-white/90"
        >
          Continue
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
