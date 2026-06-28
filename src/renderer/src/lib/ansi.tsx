import type { CSSProperties, ReactNode } from 'react'

/**
 * Renders ANSI-colored terminal text (the SGR escape codes that CLIs like
 * vitest / eslint / tsc emit) as styled React spans. Non-color escape sequences
 * (cursor moves, erase-line, OSC, carriage returns) are dropped so they don't
 * show up as garbage. Kept dependency-free on purpose.
 */

// Standard + bright 16-color palette (indices 0-15), tuned for a dark terminal.
const BASIC16 = [
  '#52525b',
  '#f87171',
  '#4ade80',
  '#fbbf24',
  '#60a5fa',
  '#c084fc',
  '#22d3ee',
  '#d4d4d4',
  '#71717a',
  '#fca5a5',
  '#86efac',
  '#fde047',
  '#93c5fd',
  '#d8b4fe',
  '#67e8f9',
  '#ffffff'
]

/** 30-37 / 90-97 (fg) and 40-47 / 100-107 (bg) map onto the 16-color palette. */
function basicColor(code: number): string {
  if (code >= 30 && code <= 37) return BASIC16[code - 30]
  if (code >= 90 && code <= 97) return BASIC16[code - 90 + 8]
  if (code >= 40 && code <= 47) return BASIC16[code - 40]
  if (code >= 100 && code <= 107) return BASIC16[code - 100 + 8]
  return ''
}

/** xterm 256-color index → CSS color. */
function xterm256(n: number): string {
  if (n < 16) return BASIC16[n] ?? ''
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v}, ${v}, ${v})`
  }
  const i = n - 16
  const r = Math.floor(i / 36)
  const g = Math.floor((i % 36) / 6)
  const b = i % 6
  const ch = (x: number): number => (x === 0 ? 0 : 55 + x * 40)
  return `rgb(${ch(r)}, ${ch(g)}, ${ch(b)})`
}

/** Fold a single SGR parameter list (the bit between `\x1b[` and `m`) into a style. */
function applySgr(prev: CSSProperties, codeStr: string): CSSProperties {
  const codes = codeStr.split(';').map((c) => (c === '' ? 0 : Number(c)))
  let s: CSSProperties = { ...prev }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) s = {}
    else if (c === 1) s.fontWeight = 700
    else if (c === 2) s.opacity = 0.75
    else if (c === 3) s.fontStyle = 'italic'
    else if (c === 4) s.textDecoration = 'underline'
    else if (c === 22) {
      delete s.fontWeight
      delete s.opacity
    } else if (c === 23) delete s.fontStyle
    else if (c === 24) delete s.textDecoration
    else if (c === 39) delete s.color
    else if (c === 49) delete s.backgroundColor
    else if (c === 38 || c === 48) {
      const mode = codes[i + 1]
      if (mode === 5) {
        const col = xterm256(codes[i + 2] ?? 0)
        if (c === 38) s.color = col
        else s.backgroundColor = col
        i += 2
      } else if (mode === 2) {
        const col = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`
        if (c === 38) s.color = col
        else s.backgroundColor = col
        i += 4
      }
    } else {
      const col = basicColor(c)
      if (col) {
        if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) s.color = col
        else s.backgroundColor = col
      }
    }
  }
  return s
}

// SGR color sequence (captured) | OSC | other CSI / charset escapes | carriage return.
// eslint-disable-next-line no-control-regex
const TOKEN = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[(][0-9;?]*[A-Za-z]|\r/g

export function renderAnsi(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let style: CSSProperties = {}
  let last = 0
  let key = 0
  const push = (t: string): void => {
    if (!t) return
    nodes.push(
      Object.keys(style).length > 0 ? (
        <span key={key++} style={{ ...style }}>
          {t}
        </span>
      ) : (
        <span key={key++}>{t}</span>
      )
    )
  }
  let m: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index))
    last = TOKEN.lastIndex
    if (m[1] !== undefined) style = applySgr(style, m[1]) // an SGR color sequence
    // every other match is a non-color escape or a CR → dropped
  }
  if (last < text.length) push(text.slice(last))
  return nodes
}
