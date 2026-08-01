/**
 * Live integration check for the CLIProxyAPI sidecar service.
 *
 * This is deliberately NOT part of `npm run smoke`: it downloads a ~20MB release
 * from GitHub and spawns a real process, which is the wrong thing to do on every
 * commit. It exists because the parts most likely to break — asset naming,
 * checksum verification, extraction, config generation, the spawn, the health
 * gate, and the Management API contract — cannot be covered by a pure unit test.
 *
 * Run: npx electron test/.out/cliproxy.cjs  (see the command at the bottom)
 * or:  npm run smoke:cliproxy
 *
 * It stops short of an actual OAuth login (that needs a human and a real
 * ChatGPT account) but does verify that the login endpoint hands back a usable
 * authorization URL, which is the last step Roxy controls.
 */
import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  baseUrl,
  disconnect,
  describeBadDownload,
  ensureRunning,
  installFromFile,
  extract,
  listProxyModels,
  localApiKey,
  shutdownCliProxy,
  startLogin,
  status,
  stop
} from '../src/main/services/cliproxy'

let pass = 0
const fails: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fails.push(name)
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

// Throwaway userData so this never touches a real install's tokens.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'roxy-cliproxy-test-'))
app.setPath('userData', tmp)
app.on('window-all-closed', () => undefined)

async function main(): Promise<void> {
  // ---- initial state ----
  const before = await status()
  check('starts not-installed on a fresh userData', before.status === 'not-installed')
  check('no port before starting', before.port === null)
  check('no accounts before signing in', before.accounts.length === 0)

  // ---- install + start (downloads, verifies, extracts, spawns, health-checks) ----
  console.log('  … downloading + starting the sidecar (this takes a moment)')
  const started = Date.now()
  const url = await ensureRunning()
  console.log(`  … up in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  check('ensureRunning returns a loopback base URL', /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(url))
  const running = await status()
  check('status is running', running.status === 'running', running.error)
  check('a port was assigned', typeof running.port === 'number')
  check('baseUrl() agrees with ensureRunning', baseUrl() === url)
  check('download reported completion', running.progress === 100)

  // The binary landed where the service expects it, and it is executable.
  const bin = path.join(
    tmp,
    'cliproxy',
    `v${running.version}`,
    process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'
  )
  check('binary extracted to the versioned install dir', await exists(bin))

  // ---- the generated config ----
  const config = await fs.readFile(path.join(tmp, 'cliproxy', 'config.yaml'), 'utf8')
  check('config binds loopback only', config.includes('host: "127.0.0.1"'))
  check('config disables remote management', config.includes('allow-remote: false'))
  check('config disables the control panel', config.includes('disable-control-panel: true'))
  check('config disables usage telemetry', config.includes('usage-statistics-enabled: false'))
  check('config disables plugins', config.includes('enabled: false'))
  check(
    'config points at the shared auth dir',
    config.includes(path.join(tmp, 'cliproxy', 'auths').replace(/\\/g, '\\\\'))
  )

  // ---- secrets are generated, not hardcoded ----
  const key = await localApiKey()
  check('a local api key was generated', key.startsWith('roxy-') && key.length > 32)
  const key2 = await localApiKey()
  check('the local api key is stable across calls', key === key2)

  // ---- the proxy actually answers on its OpenAI-compatible surface ----
  const res = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${key}` } })
  check('GET /v1/models returns 200 with the local key', res.ok, `status ${res.status}`)

  const unauth = await fetch(`${url}/models`, { headers: { Authorization: 'Bearer wrong-key' } })
  check('a wrong key is rejected', unauth.status === 401, `status ${unauth.status}`)

  // No credential is signed in, so the catalog is legitimately empty — the point
  // is that it parses and returns a list rather than throwing.
  const models = await listProxyModels()
  check('listProxyModels returns an array', Array.isArray(models))
  check('no models before signing in', models.length === 0)

  // ---- the management API is reachable and the login flow starts ----
  const login = await startLogin()
  check(
    'startLogin returns an OpenAI authorization URL',
    login.url.startsWith('https://auth.openai.com/')
  )
  check('the auth URL targets the Codex client', login.url.includes('client_id=app_'))
  check('the auth URL uses PKCE', login.url.includes('code_challenge_method=S256'))
  check('startLogin returns a state token', login.state.length > 0)
  check('the auth URL carries that state', login.url.includes(`state=${login.state}`))

  // ---- teardown leaves the install (and would-be tokens) in place ----
  const stopped = await stop()
  check('stop() reports stopped, not not-installed', stopped.status === 'stopped')
  check('stop() clears the port', stopped.port === null)
  check('the binary survives a stop', await exists(bin))

  const dead = await fetch(`${url}/models`, {
    headers: { Authorization: `Bearer ${key}` }
  }).catch(() => null)
  check('the port stops answering after stop()', dead === null || !dead.ok)

  // ---- restarting reuses the install (no second download) ----
  const restarted = Date.now()
  await ensureRunning()
  const elapsed = Date.now() - restarted
  check('restart skips the download', elapsed < 20_000, `${elapsed}ms`)
  check('restart is running again', (await status()).status === 'running')

  // ---- disconnect wipes the tokens, not just the provider row ----
  // Stand in for a signed-in account: disconnect must remove the auth dir
  // whether or not the Management API call succeeds.
  const auths = path.join(tmp, 'cliproxy', 'auths')
  await fs.mkdir(auths, { recursive: true })
  await fs.writeFile(path.join(auths, 'codex-test.json'), '{"type":"codex"}')
  check('a token file exists before disconnect', await exists(path.join(auths, 'codex-test.json')))

  await disconnect()
  check('disconnect removes the token files', !(await exists(auths)))
  check('disconnect stops the proxy', (await status()).port === null)
  check('disconnect reports no accounts', (await status()).accounts.length === 0)
  // The install is a cache, not a credential - re-signing in shouldn't re-download.
  check('disconnect keeps the binary', await exists(bin))

  // ---- regression: a corrupt archive must never reach tar ----
  //
  // The original bug. install() hashed the download STREAM and then handed the
  // FILE to tar, so anything that damaged the file after the socket (a short
  // write, a full disk, an antivirus scanner rewriting the temp file) sailed
  // through the checksum gate and detonated inside tar as
  // "ZIP decompression failed (-5): Unknown error" — which reads like a broken
  // release rather than a broken download. The gate now hashes what is on disk.
  {
    const probe = path.join(tmp, 'corrupt-probe')
    await fs.mkdir(probe, { recursive: true })

    // Build a valid archive from the install we already verified, then damage it
    // the way a truncated write would.
    const goodZip = path.join(probe, 'good.zip')
    const tarExe =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
    await execFileAsync(tarExe, ['-a', '-cf', goodZip, '-C', path.dirname(bin), path.basename(bin)])

    const goodHash = await sha256OfFile(goodZip)
    const bytes = await fs.readFile(goodZip)
    const corrupt = path.join(probe, 'corrupt.zip')
    await fs.writeFile(corrupt, bytes.subarray(0, Math.floor(bytes.length * 0.75)))

    // What the NEW code checks: the file tar will actually open.
    check('on-disk hash rejects a corrupt archive', (await sha256OfFile(corrupt)) !== goodHash)
    check('on-disk hash still accepts a good archive', (await sha256OfFile(goodZip)) === goodHash)

    // Confirm the corrupt file really is what produces the reported failure, so
    // this test keeps testing the thing it claims to.
    let tarError = ''
    try {
      await execFileAsync(tarExe, ['-xf', corrupt, '-C', probe])
    } catch (e) {
      tarError = e instanceof Error ? e.message : String(e)
    }
    check(
      'the corrupt archive is what breaks tar',
      tarError.length > 0,
      'tar unexpectedly succeeded'
    )

    // extract() must translate that into something a human can act on, rather
    // than surfacing tar's raw "(-5)" dump in the sign-in panel.
    let friendly = ''
    try {
      await extract(corrupt, probe)
    } catch (e) {
      friendly = e instanceof Error ? e.message : String(e)
    }
    check(
      'extract() reports a corrupt archive in plain language',
      /corrupt/i.test(friendly),
      friendly
    )
    check('extract() does not leak tar internals', !/-5|Unknown error/.test(friendly), friendly)
  }

  // ---- a failed integrity check must DIAGNOSE, not guess ----
  //
  // The first version of this message blamed "network or antivirus"
  // unconditionally. That is a guess wearing a diagnosis's clothes: it sends
  // people to disable their AV for what is usually a captive portal or a
  // TLS-inspecting proxy. The bytes on disk already say which it was, so these
  // assert that each distinct failure gets its own accurate explanation.
  {
    const d = path.join(tmp, 'diagnosis')
    await fs.mkdir(d, { recursive: true })

    // A captive portal / intercepting proxy answers with a web page.
    const portal = path.join(d, 'portal.zip')
    await fs.writeFile(portal, '<!DOCTYPE html>\n<html><body>Sign in</body></html>')
    const mPortal = await describeBadDownload(portal, 48, 48, 48)
    check('captive portal is named as interception', /proxy, VPN, or network sign-in/.test(mPortal))
    check('captive portal does not blame antivirus', !/antivirus/i.test(mPortal), mPortal)

    // Content replaced with something that is not an archive at all.
    const junk = path.join(d, 'junk.zip')
    await fs.writeFile(junk, Buffer.alloc(2048, 0x41))
    check(
      'substituted content is named as a replaced archive',
      /not a valid archive/.test(await describeBadDownload(junk, 2048, 2048, 2048))
    )

    // A real zip header, but the transfer ended early.
    const zip = path.join(d, 'short.zip')
    await fs.writeFile(
      zip,
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(1000)])
    )
    const mShort = await describeBadDownload(zip, 1004, 20854695, 1004)
    check('a truncated download reports both byte counts', /1004 of 20854695/.test(mShort))
    check('a truncated download does not blame antivirus', !/antivirus/i.test(mShort), mShort)

    // THE REPORTED CASE. With no content-length (a proxy that re-chunks the
    // response) the length check cannot fire, and the old code fell through to
    // a flat antivirus claim with nothing behind it.
    const mNoLen = await describeBadDownload(zip, 1004, 0, 1004)
    check(
      'a missing content-length is admitted, not papered over',
      /no length to check against/.test(mNoLen)
    )
    check('a missing content-length points at the proxy', /proxy/.test(mNoLen), mNoLen)

    // Downloaded N but only M reached disk: the one case that really does
    // implicate local software.
    const mWrite = await describeBadDownload(zip, 1004, 20854695, 20854695)
    check(
      'a short write reports downloaded vs on-disk',
      /20854695 bytes downloaded, 1004 on disk/.test(mWrite)
    )
    check('a short write is where antivirus is named', /Antivirus/.test(mWrite))

    // Full length, right shape, wrong hash.
    check(
      'intact-but-wrong-hash is named as modification in transit',
      /modified in transit/.test(await describeBadDownload(zip, 1004, 1004, 1004))
    )

    // If several shapes collapse to one message this is theatre, not diagnosis.
    const messages = new Set([mPortal, mShort, mNoLen, mWrite])
    check('the failure modes stay distinguishable', messages.size === 4, `${messages.size}/4`)
  }

  // ---- manual install (the escape hatch for blocked networks) ----
  //
  // Retries and a second network stack cannot help a network that blocks
  // github.com outright, so the user can supply the archive themselves. It must
  // still be checksum-verified: a different delivery route is not a reason to
  // run unverified code.
  {
    const d = path.join(tmp, 'manual')
    await fs.mkdir(d, { recursive: true })

    const bogus = path.join(d, 'bogus.zip')
    await fs.writeFile(bogus, Buffer.alloc(4096, 0x42))
    let rejected = ''
    try {
      await installFromFile(bogus)
    } catch (e) {
      rejected = e instanceof Error ? e.message : String(e)
    }
    check('a mismatched archive is refused', rejected.length > 0)
    check(
      '...and the message names what was expected',
      /doesn't match the expected/.test(rejected),
      rejected
    )
    check('...and nothing was installed from it', (await status()).status !== 'running')
  }
}

/** sha256 of a file's contents on disk — what extraction actually reads. */
async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

const execFileAsync = promisify(execFile)

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

app.whenReady().then(async () => {
  console.log('cliproxy sidecar integration test\n')
  // Generous: a real download over a slow link is the dominant cost.
  const watchdog = setTimeout(() => {
    console.error('\nCLIPROXY TEST TIMEOUT (180s)')
    shutdownCliProxy()
    app.exit(2)
  }, 180_000)
  watchdog.unref?.()

  try {
    await main()
  } catch (e) {
    fails.push('fatal: ' + (e instanceof Error ? e.message : String(e)))
    console.error('\nFATAL', e)
  } finally {
    clearTimeout(watchdog)
    shutdownCliProxy()
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    const ok = fails.length === 0
    console.log(
      ok
        ? `\nCLIPROXY OK \u2014 ${pass} checks passed`
        : `\nCLIPROXY FAILED \u2014 ${fails.length} failing: ${fails.join(', ')}`
    )
    setTimeout(() => app.exit(ok ? 0 : 1), 150)
  }
})
