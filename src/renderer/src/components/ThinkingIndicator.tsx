import { useEffect, useState } from 'react'
import { cn } from '../lib/cn'

/**
 * A single-character braille spinner — a minimal, infinitely-looping loading
 * animation shown while we wait for the first (or next) token, so a freshly
 * started assistant turn never looks empty.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * The bare cycling braille glyph — reused both by the chat's "thinking" indicator
 * and the sidebar's per-session activity spinner so the two stay in sync. Style
 * it (size/color) via `className`.
 */
export function BrailleSpinner({ className }: { className?: string }): JSX.Element {
  const [i, setI] = useState(0)
  useEffect(() => {
    const spin = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 90)
    return () => clearInterval(spin)
  }, [])
  return (
    <span className={cn('select-none font-mono leading-none', className)} aria-hidden>
      {FRAMES[i]}
    </span>
  )
}

export function ThinkingIndicator(): JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const clock = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(clock)
  }, [])
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <BrailleSpinner className="text-base text-accent" />
      <span className="animate-pulse text-text-muted">thinking</span>
      {seconds > 0 && (
        <span className="font-mono text-xs tabular-nums text-text-subtle">{seconds}s</span>
      )}
    </div>
  )
}
