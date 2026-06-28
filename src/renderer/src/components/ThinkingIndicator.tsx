import { useEffect, useState } from 'react'

/**
 * A single-character braille spinner — a minimal, infinitely-looping loading
 * animation shown while we wait for the first (or next) token, so a freshly
 * started assistant turn never looks empty.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function ThinkingIndicator(): JSX.Element {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 90)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <span className="select-none font-mono text-base leading-none text-accent" aria-hidden>
        {FRAMES[i]}
      </span>
      <span className="animate-pulse text-text-muted">thinking</span>
    </div>
  )
}
