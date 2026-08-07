/**
 * Cookie editor checks, run in a REAL Electron main process — the cookie jar is
 * a native API, so there is nothing meaningful to assert against a mock.
 *
 * These drive the SHIPPING module (src/main/services/cookies.ts), not a copy of
 * its logic, so the bridging rules it exists to encode are actually covered:
 * session cookies must omit `expirationDate` rather than send 0, `hostOnly` is
 * expressed by omitting `domain`, and the parent-domain walk is what makes a
 * `.example.com` cookie visible while you sit on `app.example.com`.
 *
 * SAFETY: every cookie here lives under example.com / example.org, and cleanup
 * is scoped to those hosts. The suite never calls the unscoped `clear()`, so it
 * cannot wipe real logins out of the shared browser partition.
 *
 * Run: npm run smoke:cookies
 */
import { app } from 'electron'
import { clear, importJson, list, remove, set } from '../src/main/services/cookies'

/** Hosts this suite owns. Cleanup and assertions never reach outside them. */
const HOSTS = ['example.com', 'example.org']

let failures = 0

function check(name: string, cond: boolean, detail: unknown = ''): void {
  const line = cond ? `  ok   ${name}` : `  FAIL ${name} ${detail === '' ? '' : String(detail)}`
  if (!cond) failures++
  // stderr, not stdout: Electron on Windows does not reliably deliver stdout to
  // a redirected parent shell, so a failure would otherwise be invisible in CI.
  process.stderr.write(line + '\n')
}

/** Delete only what this suite created. */
async function cleanup(): Promise<void> {
  for (const host of HOSTS) await clear(host)
}

async function main(): Promise<void> {
  await app.whenReady()
  process.stderr.write('cookie editor:\n')
  await cleanup()

  // --- 1. a Cookie-Editor style row survives a round trip -------------------
  const soon = Math.floor(Date.now() / 1000) + 3600
  let err = await set({
    name: 'sid',
    value: 'abc123',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    session: false,
    sameSite: 'lax',
    expirationDate: soon
  })
  check('set accepts a well-formed cookie', err === null, err)

  let rows = await list('https://example.com/')
  let sid = rows.find((c) => c.name === 'sid')
  check('persistent cookie round-trips', !!sid)
  check('  value preserved', sid?.value === 'abc123', sid?.value)
  check('  httpOnly preserved', sid?.httpOnly === true)
  check('  secure preserved', sid?.secure === true)
  check('  sameSite preserved', sid?.sameSite === 'lax', sid?.sameSite)
  check('  expiry preserved', Math.abs((sid?.expirationDate ?? 0) - soon) < 2, sid?.expirationDate)
  check('  a domain cookie is not hostOnly', sid?.hostOnly === false)
  check('  export carries Cookie-Editor storeId', sid?.storeId === '0', sid?.storeId)

  // --- 2. a session cookie must STAY a session cookie -----------------------
  // The bug this guards: sending `expirationDate: 0` for a session cookie
  // expires it on the spot instead of scoping it to the session.
  await set({
    name: 'tmp',
    value: 'x',
    domain: 'example.com',
    path: '/',
    secure: true,
    session: true
  })
  const tmp = (await list('https://example.com/')).find((c) => c.name === 'tmp')
  check('session cookie stays a session cookie', tmp?.session === true, JSON.stringify(tmp))
  check('  and reports no expiry', tmp?.expirationDate === undefined, tmp?.expirationDate)

  // --- 3. hostOnly is expressed by omitting `domain` ------------------------
  await set({
    name: 'host',
    value: 'y',
    domain: 'sub.example.com',
    path: '/',
    secure: true,
    session: true,
    hostOnly: true
  })
  const hostOnly = (await list('https://sub.example.com/')).find((c) => c.name === 'host')
  check('hostOnly cookie is host-scoped', hostOnly?.hostOnly === true, JSON.stringify(hostOnly))

  // --- 4. the parent-domain walk -------------------------------------------
  // Electron's `domain` filter matches a domain and its SUBdomains, never its
  // parents, so without the walk the session cookie you came to debug is
  // invisible from the subdomain you're actually on.
  const fromSub = await list('https://app.example.com/')
  check(
    'parent-domain cookie is visible from a subdomain',
    fromSub.some((c) => c.name === 'sid'),
    fromSub.map((c) => c.name).join(',')
  )

  // --- 5. SameSite normalization -------------------------------------------
  // Exports from DevTools-based tools use the HTTP header casing.
  await set({
    name: 'ss',
    value: 'z',
    domain: 'example.com',
    path: '/',
    secure: true,
    session: true,
    // Deliberately the wrong casing, as EditThisCookie emits it.
    sameSite: 'None' as never
  })
  const ss = (await list('https://example.com/')).find((c) => c.name === 'ss')
  check('"None" normalizes to no_restriction', ss?.sameSite === 'no_restriction', ss?.sameSite)

  // --- 6. import: the real Cookie-Editor blob shape -------------------------
  const blob = JSON.stringify([
    {
      name: 'imported',
      value: 'v1',
      domain: '.example.org',
      path: '/',
      secure: true,
      httpOnly: false,
      hostOnly: false,
      session: true,
      sameSite: 'lax',
      storeId: '0'
    },
    { name: 'bad', value: 'v2', domain: '', path: '/' }
  ])
  const res = await importJson(blob)
  check('import lands the valid cookie', res.imported === 1, JSON.stringify(res))
  check('  and reports the invalid one instead of throwing', res.failed === 1, JSON.stringify(res))
  check(
    '  imported cookie is readable',
    (await list('https://example.org/')).some((c) => c.name === 'imported')
  )

  // A `{ cookies: [...] }` wrapper is also in the wild.
  const wrapped = await importJson('{"cookies":[{"name":"w","value":"1","domain":"example.org"}]}')
  check(
    'import accepts a { cookies: [...] } wrapper',
    wrapped.imported === 1,
    JSON.stringify(wrapped)
  )

  // Malformed JSON is the one case that throws.
  let threw = false
  try {
    await importJson('not json')
  } catch {
    threw = true
  }
  check('import rejects malformed JSON', threw)

  // --- 7. export round-trips through import --------------------------------
  const exported = JSON.stringify(await list('https://example.org/'))
  await clear('example.org')
  check('cleared host is empty', (await list('https://example.org/')).length === 0)
  const back = await importJson(exported)
  check('an export re-imports cleanly', back.failed === 0, JSON.stringify(back))

  // --- 8. removal -----------------------------------------------------------
  await remove({ name: 'sid', domain: '.example.com', path: '/', secure: true })
  check(
    'remove deletes the cookie',
    !(await list('https://example.com/')).some((c) => c.name === 'sid')
  )

  await cleanup()
  check('scoped clear leaves nothing behind', (await list('https://example.com/')).length === 0)

  process.stderr.write(
    failures ? `\nCOOKIES FAILED — ${failures} failing\n` : '\nAll cookie checks passed.\n'
  )
  app.exit(failures ? 1 : 0)
}

process.on('uncaughtException', (e) => {
  process.stderr.write(`CRASH: ${e?.stack ?? e}\n`)
  app.exit(1)
})
process.on('unhandledRejection', (e) => {
  process.stderr.write(`REJECT: ${e instanceof Error ? e.stack : String(e)}\n`)
  app.exit(1)
})

void main()
