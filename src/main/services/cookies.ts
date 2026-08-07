/**
 * Cookie editing for the Roxy browser — the "Cookie-Editor extension", built in.
 *
 * The Roxy browser runs every tab on one persisted session partition, so its
 * cookie jar is a single Electron `Session.cookies` store. That store already
 * exposes everything the Cookie-Editor extension wraps (get/set/remove), which
 * is why this ships as a native panel instead of real Chrome extension support:
 * `chrome.cookies` IS `session.cookies` here, minus a CRX loader we'd otherwise
 * have to carry.
 *
 * INTEROP is the point. Import/export speak the exact JSON shape Cookie-Editor
 * and EditThisCookie use, so a blob copied out of Chrome pastes straight in
 * here (and back). That format differs from Electron's in three ways we bridge:
 *   - session cookies must OMIT `expirationDate` entirely rather than send 0,
 *     which would instead expire the cookie on the spot;
 *   - `hostOnly` is derived, not settable — Electron infers it from whether you
 *     pass `domain` at all, so a host-only cookie is written by dropping it;
 *   - `sameSite` arrives in several casings ("no_restriction", "None", "Lax")
 *     depending on which tool exported it, so it gets normalized.
 */
import { session } from 'electron'
import { PARTITION } from './browser'
import type { CookieImportResult, CookieRow } from '../../shared/api'

/** The Roxy browser's cookie jar (the same partition every tab renders on). */
function jar(): Electron.Cookies {
  return session.fromPartition(PARTITION).cookies
}

/**
 * Normalize the many spellings of SameSite into Electron's four values.
 * Chrome's extension API and Electron both use snake_case, but tools exporting
 * from DevTools emit the HTTP header casing ("None"/"Lax"/"Strict") — and an
 * unrecognized value must fall back to `unspecified` rather than throw, or one
 * bad row would reject an entire paste.
 */
function normalizeSameSite(raw: unknown): CookieRow['sameSite'] {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (v === 'no_restriction' || v === 'none') return 'no_restriction'
  if (v === 'lax') return 'lax'
  if (v === 'strict') return 'strict'
  return 'unspecified'
}

/**
 * The URL to address a cookie by. Electron's cookie store is keyed by URL, not
 * by domain, so every set/remove needs one synthesized from the cookie itself.
 * The scheme must track `secure`: Chromium refuses to store a Secure cookie
 * against an http:// URL.
 */
function urlFor(c: { domain?: string; path?: string; secure?: boolean }): string {
  const host = (c.domain ?? '').replace(/^\./, '')
  const scheme = c.secure ? 'https' : 'http'
  return `${scheme}://${host}${c.path || '/'}`
}

/** Convert one Electron cookie into the interchange shape. */
function toRow(c: Electron.Cookie): CookieRow {
  const row: CookieRow = {
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    hostOnly: Boolean(c.hostOnly),
    session: Boolean(c.session),
    sameSite: normalizeSameSite(c.sameSite),
    storeId: '0'
  }
  if (!c.session && typeof c.expirationDate === 'number') row.expirationDate = c.expirationDate
  return row
}

/** The hostname of a URL, or '' when it isn't parseable (about:blank, empty). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * The domains whose cookies are in play for `host`: the host itself and each
 * parent down to a two-label name — so `app.stage.example.com` also pulls
 * `.example.com`, where the session cookie you're actually debugging usually
 * lives.
 *
 * Electron's `domain` filter matches a domain and its SUBdomains, never its
 * parents, so querying the host alone silently omits exactly those cookies.
 * Bare hostnames (`localhost`) and IP literals have no parents to walk.
 */
function domainChain(host: string): string[] {
  if (!host) return []
  if (/^[\d.]+$/.test(host) || host.includes(':')) return [host]
  const parts = host.split('.')
  if (parts.length < 2) return [host]
  const out: string[] = []
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join('.'))
  return out
}

/**
 * Every cookie relevant to `url` (its whole domain chain), or the entire jar
 * when no URL is given. Deduped, because a host and its parent both match a
 * cookie sitting in the middle of the chain.
 */
export async function list(url?: string): Promise<CookieRow[]> {
  const host = url ? hostOf(url) : ''
  const queries: Electron.CookiesGetFilter[] = host
    ? domainChain(host).map((domain) => ({ domain }))
    : [{}]
  const found = new Map<string, CookieRow>()
  for (const q of queries) {
    for (const c of await jar().get(q)) {
      const row = toRow(c)
      found.set(`${row.domain}|${row.path}|${row.name}`, row)
    }
  }
  return [...found.values()].sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name)
  )
}

/**
 * Create or overwrite one cookie. Returns an error string rather than throwing:
 * a bulk import must be able to report "3 of 40 rejected" instead of dying on
 * the first cookie Chromium dislikes (bad domain, `__Host-` prefix rules, ...).
 */
export async function set(row: Partial<CookieRow>): Promise<string | null> {
  const name = String(row.name ?? '').trim()
  if (!name) return 'a cookie in the list has no name'
  const domain = String(row.domain ?? '').trim()
  if (!domain) return `"${name}": no domain`

  const details: Electron.CookiesSetDetails = {
    url: urlFor({ domain, path: row.path, secure: row.secure }),
    name,
    value: String(row.value ?? ''),
    path: row.path || '/',
    secure: Boolean(row.secure),
    httpOnly: Boolean(row.httpOnly),
    sameSite: normalizeSameSite(row.sameSite)
  }
  // A host-only cookie is expressed by OMITTING domain (Electron then binds it
  // to the URL's host); sending a domain always yields a subdomain cookie.
  if (!row.hostOnly) details.domain = domain
  // Session cookies must omit expirationDate entirely — sending 0 would expire
  // the cookie immediately instead of making it session-scoped.
  if (!row.session && typeof row.expirationDate === 'number') {
    details.expirationDate = row.expirationDate
  }

  try {
    await jar().set(details)
    return null
  } catch (e) {
    return `"${name}": ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Delete one cookie, addressed the same way it was stored. */
export async function remove(
  row: Pick<CookieRow, 'name' | 'domain' | 'path' | 'secure'>
): Promise<void> {
  await jar().remove(urlFor(row), row.name)
}

/**
 * Delete every cookie, or every cookie in one host's domain chain. Removal goes
 * through the per-cookie API rather than `clearStorageData` so a domain-scoped
 * wipe is possible at all, and so localStorage logins survive a cookie reset.
 */
export async function clear(host?: string): Promise<number> {
  const queries: Electron.CookiesGetFilter[] = host
    ? domainChain(host).map((domain) => ({ domain }))
    : [{}]
  const seen = new Set<string>()
  let removed = 0
  for (const q of queries) {
    for (const c of await jar().get(q)) {
      const id = `${c.domain}|${c.path}|${c.name}`
      if (seen.has(id)) continue
      seen.add(id)
      try {
        await jar().remove(urlFor(c), c.name)
        removed++
      } catch {
        // Already gone, or unaddressable — nothing useful to do per-cookie.
      }
    }
  }
  return removed
}

/**
 * Import a Cookie-Editor / EditThisCookie JSON blob. Accepts either a bare
 * array (what those tools emit) or a `{ cookies: [...] }` wrapper, because both
 * are in the wild. Bad rows are collected and reported, never fatal — only
 * malformed JSON throws.
 */
export async function importJson(text: string): Promise<CookieImportResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const wrapped = (parsed as { cookies?: unknown } | null)?.cookies
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(wrapped) ? wrapped : null
  if (!rows) throw new Error('Expected an array of cookies (or { "cookies": [...] }).')

  const errors: string[] = []
  let imported = 0
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') {
      errors.push('skipped an entry that was not an object')
      continue
    }
    const err = await set(raw as Partial<CookieRow>)
    if (err) errors.push(err)
    else imported++
  }
  // Keep the error list short — a 500-cookie paste that wholly fails shouldn't
  // push 500 near-identical strings through IPC into a toast.
  return { imported, failed: errors.length, errors: errors.slice(0, 8) }
}
