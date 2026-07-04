/**
 * Pure, dependency-free web helpers shared by the `webfetch` + `websearch`
 * tools (github.com/sst/opencode's webfetch/websearch, MIT — reimplemented here
 * without the Effect/turndown stack so the logic stays testable in the pure-Node
 * smoke harness and never leaks heavy deps into the renderer bundle).
 *
 * The main process (src/main/harness/tools.ts) does the actual I/O (native
 * `fetch`); everything here is pure string/URL work: URL normalization, HTML →
 * markdown/text conversion, and Exa MCP request/response shaping.
 */

export type WebFetchFormat = 'markdown' | 'text' | 'html'

/** Cap the raw response we download (matches opencode's 5 MB webfetch limit). */
export const WEBFETCH_MAX_BYTES = 5 * 1024 * 1024
/** Cap what we hand back to the model, so one page can't blow the context window. */
export const WEBFETCH_OUTPUT_CAP = 60_000
export const WEBFETCH_TIMEOUT_DEFAULT = 30
export const WEBFETCH_TIMEOUT_MAX = 120

/** A real-browser UA — many sites 403 an unknown agent. */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Exa's public MCP endpoint — works keyless (rate-limited); a key lifts limits. */
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
export const WEBSEARCH_MAX_BYTES = 512 * 1024
export const WEBSEARCH_TIMEOUT = 30
export const WEBSEARCH_DEFAULT_RESULTS = 8
export const WEBSEARCH_MAX_RESULTS = 20
export const WEBSEARCH_NO_RESULTS = 'No search results found. Try a different query.'

/**
 * Validate + normalize a URL for fetching: upgrade bare `http:` to `https:`,
 * reject anything that isn't http(s) (no `file:`, `data:`, etc.). Throws a
 * clear Error on anything invalid.
 */
export function normalizeFetchUrl(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) throw new Error('No URL provided.')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`)
  }
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${url.protocol}" — only http:// and https:// are allowed.`)
  }
  return url.toString()
}

/** The Accept header we send for a requested output format. */
export function acceptHeader(format: WebFetchFormat): string {
  switch (format) {
    case 'markdown':
      return 'text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1'
    case 'text':
      return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1'
    case 'html':
      return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1'
  }
}

/** The bare mime from a Content-Type header (drops the `; charset=…`). */
export function mimeFromContentType(contentType: string): string {
  return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase()
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

/** Whether a mime is text-like enough to decode as a string. */
export function isTextualMime(mime: string): boolean {
  return (
    !mime ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml') ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript' ||
    mime === 'application/xhtml+xml'
  )
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  deg: '\u00b0',
  middot: '\u00b7',
  bull: '\u2022',
  eacute: '\u00e9',
  egrave: '\u00e8',
  agrave: '\u00e0',
  uuml: '\u00fc',
  ouml: '\u00f6',
  auml: '\u00e4',
  szlig: '\u00df'
}

/** Decode the HTML entities that survive tag-stripping (named + numeric). */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X'
      const n = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return match
      try {
        return String.fromCodePoint(n)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()]
    return named ?? match
  })
}

/** Remove non-content regions (scripts, styles, head, comments) wholesale. */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, ' ')
    // A lone <head>…</head> may not close cleanly; the above also handles the common case.
    .replace(/<!doctype[^>]*>/gi, ' ')
}

/** Prefer the <body> when present — drops leftover head/meta noise. */
function bodyOnly(html: string): string {
  const m = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return m ? m[1] : html
}

/** Tidy whitespace: trim lines, collapse runs of blank lines, strip edges. */
function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML → plain readable text: keep the words, drop the markup. */
export function htmlToText(html: string): string {
  let s = bodyOnly(stripNoise(html))
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(
    /<\/(p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|ul|ol|tr|table|thead|tbody|blockquote|pre|figure|figcaption)\s*>/gi,
    '\n'
  )
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return collapseWhitespace(s)
}

/** Convert inline-level markup (links, emphasis, inline code) inside a block. */
function convertInline(html: string): string {
  return html
    .replace(/<a\b[^>]*?\shref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const label = stripTags(text).trim()
      const target = href.trim()
      if (!label) return target
      if (!target || target.startsWith('#') || target.startsWith('javascript:')) return label
      return `[${label}](${target})`
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${stripTags(inner).trim()}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${stripTags(inner).trim()}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${stripTags(inner).trim()}\``)
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

/** HTML → Markdown: preserve headings, links, lists, code, quotes. */
export function htmlToMarkdown(html: string): string {
  let s = bodyOnly(stripNoise(html))

  // Fenced code blocks first (protect their contents from inline conversion).
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, '\n'))).replace(/\n+$/g, '')
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`
  })

  // Headings.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const text = stripTags(convertInline(inner)).trim()
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '\n\n'
  })

  // Blockquotes.
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    const text = htmlToText(inner)
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`.replace(/\s+$/g, ''))
      .join('\n')
    return `\n\n${quoted}\n\n`
  })

  // List items → dashes (nested structure flattens, which is fine for reading).
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
    const text = stripTags(convertInline(inner.replace(/<br\s*\/?>/gi, ' '))).trim()
    return text ? `- ${text}\n` : ''
  })

  // Horizontal rules.
  s = s.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')

  // Inline formatting across whatever remains.
  s = convertInline(s)

  // Block boundaries → blank lines / newlines.
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|header|footer|main|aside|nav|tr|table|thead|tbody|figure|figcaption|ul|ol)\s*>/gi, '\n\n')

  // Drop every remaining tag, decode entities, tidy.
  s = stripTags(s)
  s = decodeEntities(s)
  return collapseWhitespace(s)
}

/** Convert fetched content to the requested format (only HTML needs work). */
export function convertWebContent(content: string, contentType: string, format: WebFetchFormat): string {
  const isHtml = contentType.toLowerCase().includes('html')
  if (!isHtml || format === 'html') return content
  return format === 'markdown' ? htmlToMarkdown(content) : htmlToText(content)
}

/** The JSON-RPC body for an Exa MCP `web_search_exa` call. */
export function buildExaRequestBody(query: string, numResults: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'web_search_exa',
      arguments: { query, numResults }
    }
  })
}

/** Clamp a requested result count into the allowed range. */
export function clampResults(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v) || v <= 0) return WEBSEARCH_DEFAULT_RESULTS
  return Math.min(Math.floor(v), WEBSEARCH_MAX_RESULTS)
}

/**
 * Pull the text payload out of an Exa MCP response. The endpoint answers either
 * with a plain JSON body or an SSE stream of `data: {…}` lines; in both cases the
 * useful text lives at `result.content[].text`. Returns undefined when empty.
 */
export function parseExaResponse(body: string): string | undefined {
  const fromPayload = (payload: string): string | undefined => {
    const trimmed = payload.trim()
    if (!trimmed.startsWith('{')) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return undefined
    }
    const content = (parsed as { result?: { content?: unknown } })?.result?.content
    if (!Array.isArray(content)) return undefined
    const texts = content
      .map((item) => (item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined))
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    return texts.length ? texts.join('\n\n') : undefined
  }

  const direct = fromPayload(body)
  if (direct) return direct

  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = fromPayload(line.slice(5))
    if (data) return data
  }
  return undefined
}
