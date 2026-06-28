/**
 * GitHub Copilot authentication via the OAuth Device Authorization Grant.
 *
 *  1. POST /login/device/code  -> user_code + verification_uri + device_code
 *  2. user enters the code at github.com/login/device and approves
 *  3. poll /login/oauth/access_token -> GitHub access token
 *
 * The GitHub token is stored; the short-lived Copilot token is exchanged from it
 * at request time (a later milestone). Uses the public Copilot client id that
 * community tooling uses for the device flow.
 */
import type { DeviceFlowStart } from '../../shared/types'

const CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const USER_AGENT = 'Roxy'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' })
  })
  if (!res.ok) {
    throw new Error(`GitHub device code request failed (${res.status})`)
  }
  const data = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in?: number
    interval?: number
  }
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    deviceCode: data.device_code,
    interval: data.interval ?? 5,
    expiresIn: data.expires_in ?? 900
  }
}

/** Poll until the user authorizes, returning the GitHub access token. */
export async function pollForToken(deviceCode: string, interval: number): Promise<string> {
  let waitMs = Math.max(1, interval) * 1000
  const deadline = Date.now() + 15 * 60 * 1000

  while (Date.now() < deadline) {
    await sleep(waitMs)
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    })
    const data = (await res.json()) as {
      access_token?: string
      error?: string
      error_description?: string
    }

    if (data.access_token) return data.access_token
    switch (data.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        waitMs += 5000
        break
      case 'expired_token':
        throw new Error('The code expired before you authorized. Please try again.')
      case 'access_denied':
        throw new Error('Authorization was denied.')
      default:
        if (data.error) throw new Error(data.error_description || data.error)
    }
  }
  throw new Error('Timed out waiting for authorization.')
}
