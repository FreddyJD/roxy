/**
 * LSP diagnostics primitives — the pure, dependency-free half of Phase 12.
 *
 * After the agent edits a file, Roxy feeds the language server's diagnostics
 * (type errors, unused symbols, …) straight back into the tool result, so the
 * model sees and fixes its own mistakes without waiting for a human or a build.
 * This is opencode's single biggest correctness multiplier, ported lean.
 *
 * This module owns everything that needs no Node/Electron: the JSON-RPC wire
 * framing (byte-accurate via `Uint8Array`/`TextEncoder`, so it's correct for
 * multi-byte UTF-8 and still runs in the renderer + the smoke:shared harness),
 * the server registry (which server serves which extension), `file://` URI
 * conversion, and the `<diagnostics>` rendering the model reads. The actual
 * process spawning + document lifecycle lives in `main/services/lsp.ts`.
 *
 * Modeled on opencode's `lsp/client.ts` + `lsp/diagnostic.ts` (MIT), adapted to
 * a dependency-free client and Roxy's "detect what's installed, never break an
 * edit" philosophy (opencode auto-downloads servers; we degrade gracefully).
 */

// ---- LSP protocol types (the subset we use) ----

/** LSP DiagnosticSeverity. 1=Error, 2=Warning, 3=Information, 4=Hint. */
export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4
} as const

/** A 0-based line/character position (LSP is 0-based; we render 1-based). */
export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

/** A single diagnostic as published by a language server. */
export interface LspDiagnostic {
  range: LspRange
  severity?: number
  message: string
  source?: string
  code?: string | number
}

// ---- JSON-RPC over stdio framing ----
//
// LSP frames each message as `Content-Length: N\r\n\r\n<N bytes of JSON>`. The
// length is in BYTES, so we frame on `Uint8Array` (not chars) to stay correct
// when the payload contains multi-byte UTF-8 (paths, messages with unicode).

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Frame a JSON-RPC message into a `Content-Length`-delimited byte buffer. */
export function encodeRpcMessage(msg: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(msg))
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`)
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

/** Parse a `Content-Length` value out of a header block; null if absent/invalid. */
export function parseContentLength(headerText: string): number | null {
  for (const line of headerText.split('\r\n')) {
    const m = /^Content-Length:\s*(\d+)\s*$/i.exec(line)
    if (m) {
      const n = Number(m[1])
      return Number.isFinite(n) && n >= 0 ? n : null
    }
  }
  return null
}

/** Byte offset of the header/body separator (`\r\n\r\n`) in `buf`, or -1. */
function indexOfHeaderEnd(buf: Uint8Array): number {
  // Look for 13 10 13 10 (\r\n\r\n).
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
  }
  return -1
}

/**
 * Incremental byte-accurate decoder for LSP's `Content-Length` framing. Feed it
 * raw stdout chunks (a child process's `Buffer`s are `Uint8Array`s); it returns
 * whatever complete JSON messages are now available and keeps the remainder
 * buffered for the next chunk. Malformed headers are skipped rather than
 * deadlocking the stream.
 */
export class RpcDecoder {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): unknown[] {
    if (chunk.length) {
      const next = new Uint8Array(this.buf.length + chunk.length)
      next.set(this.buf, 0)
      next.set(chunk, this.buf.length)
      this.buf = next
    }
    const out: unknown[] = []
    for (;;) {
      const sep = indexOfHeaderEnd(this.buf)
      if (sep < 0) break
      const headerText = decoder.decode(this.buf.subarray(0, sep))
      const len = parseContentLength(headerText)
      const bodyStart = sep + 4
      if (len == null) {
        // Unframeable header — drop it so one bad message can't wedge the stream.
        this.buf = this.buf.subarray(bodyStart)
        continue
      }
      if (this.buf.length < bodyStart + len) break // body not fully arrived yet
      const body = decoder.decode(this.buf.subarray(bodyStart, bodyStart + len))
      this.buf = this.buf.subarray(bodyStart + len)
      try {
        out.push(JSON.parse(body))
      } catch {
        // Skip a non-JSON body rather than throw out of the read loop.
      }
    }
    return out
  }
}

// ---- Server registry: which language server serves which file ----

export interface LspServerDef {
  /** Stable id, also the key half of a warm-client cache entry. */
  id: string
  /** File extensions (with leading dot, lowercased) this server handles. */
  extensions: string[]
  /** The server executable (looked up on PATH / node_modules/.bin). */
  command: string
  /** Args to launch it in stdio mode. */
  args: string[]
  /** Files/dirs whose presence marks a project root (nearest wins). */
  rootMarkers: string[]
}

/**
 * The built-in server registry. We only *use* a server if its command is found
 * on the system (PATH or the workspace's `node_modules/.bin`) — nothing is
 * downloaded. Ordered so the first match for an extension wins.
 */
export const LSP_SERVERS: LspServerDef[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git']
  },
  {
    id: 'pyright',
    extensions: ['.py', '.pyi'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    rootMarkers: ['pyrightconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', '.git']
  },
  {
    id: 'gopls',
    extensions: ['.go'],
    command: 'gopls',
    args: ['serve'],
    rootMarkers: ['go.mod', 'go.work', '.git']
  },
  {
    id: 'rust-analyzer',
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    rootMarkers: ['Cargo.toml', 'Cargo.lock', '.git']
  }
]

/** Lowercased file extension including the dot, e.g. `.ts` (or '' if none). */
export function extname(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = slash >= 0 ? p.slice(slash + 1) : p
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/** The server that handles this file's extension, if any. */
export function serverForPath(p: string): LspServerDef | undefined {
  const ext = extname(p)
  if (!ext) return undefined
  return LSP_SERVERS.find((s) => s.extensions.includes(ext))
}

/** LSP `languageId` for a file (used in `textDocument/didOpen`). */
export function languageIdForPath(p: string): string {
  switch (extname(p)) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript'
    case '.tsx':
      return 'typescriptreact'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.jsx':
      return 'javascriptreact'
    case '.py':
    case '.pyi':
      return 'python'
    case '.go':
      return 'go'
    case '.rs':
      return 'rust'
    default:
      return 'plaintext'
  }
}

// ---- file:// URI conversion ----

/**
 * Convert an absolute filesystem path to a `file://` URI, percent-encoding each
 * segment (spaces, unicode, `#`, `?`, …) while preserving separators. Handles
 * Windows drive paths (`C:\a` → `file:///C:/a`).
 */
export function pathToFileUri(absPath: string): string {
  let p = absPath.replace(/\\/g, '/')
  // Windows drive path → needs a leading slash before the drive letter.
  const isWinDrive = /^[a-zA-Z]:\//.test(p)
  if (isWinDrive) p = '/' + p
  const segments = p.split('/').map((seg) => encodeURIComponent(seg))
  return 'file://' + segments.join('/')
}

/** Convert a `file://` URI back to an absolute path (inverse of pathToFileUri). */
export function fileUriToPath(uri: string): string {
  let rest = uri.startsWith('file://') ? uri.slice('file://'.length) : uri
  // Drop an optional authority (the // after file: leaves host empty → rest
  // starts with '/'); nothing to strip for the common `file:///path` form.
  const decoded = rest
    .split('/')
    .map((seg) => decodeURIComponent(seg))
    .join('/')
  rest = decoded
  // `/C:/a` → `C:/a` on Windows-style URIs.
  if (/^\/[a-zA-Z]:\//.test(rest)) rest = rest.slice(1)
  return rest
}

// ---- Diagnostic rendering (what the model reads) ----

/** Cap per file, matching opencode — enough signal, never a wall of noise. */
export const MAX_DIAGNOSTICS_PER_FILE = 20

const SEVERITY_LABEL: Record<number, string> = {
  1: 'ERROR',
  2: 'WARN',
  3: 'INFO',
  4: 'HINT'
}

export function severityLabel(severity?: number): string {
  return SEVERITY_LABEL[severity ?? 1] ?? 'ERROR'
}

/** `ERROR [line:col] message` — 1-based line/col (LSP ranges are 0-based). */
export function prettyDiagnostic(d: LspDiagnostic): string {
  const line = d.range.start.line + 1
  const col = d.range.start.character + 1
  const src = d.source ? ` (${d.source})` : ''
  return `${severityLabel(d.severity)} [${line}:${col}] ${d.message}${src}`
}

export interface RenderOptions {
  /** Include warnings too (default: errors only, like opencode). */
  includeWarnings?: boolean
  /** Max diagnostics rendered before a "… and N more" suffix. */
  max?: number
}

/**
 * Render a file's diagnostics into the `<diagnostics file="…">` block appended
 * to a tool result. Errors only by default (warnings are noisy for the model),
 * sorted by position, capped. Returns '' when there's nothing worth surfacing.
 */
export function renderDiagnosticsBlock(
  file: string,
  diagnostics: LspDiagnostic[],
  opts: RenderOptions = {}
): string {
  const max = opts.max ?? MAX_DIAGNOSTICS_PER_FILE
  const wanted = diagnostics.filter((d) => {
    const sev = d.severity ?? 1
    return opts.includeWarnings ? sev <= 2 : sev === 1
  })
  if (wanted.length === 0) return ''
  const sorted = [...wanted].sort(
    (a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character
  )
  const limited = sorted.slice(0, max)
  const more = sorted.length - limited.length
  const suffix = more > 0 ? `\n... and ${more} more` : ''
  return `<diagnostics file="${file}">\n${limited.map(prettyDiagnostic).join('\n')}${suffix}\n</diagnostics>`
}
