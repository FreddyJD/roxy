import { safeStorage } from 'electron'

export interface SecurePayload {
  data: string
  encrypted: boolean
}

/**
 * Encrypt a secret (API key) with the OS keychain via Electron safeStorage when
 * available, falling back to base64 (obfuscation only) on platforms without it.
 */
export function encryptSecret(plain: string): SecurePayload {
  if (safeStorage.isEncryptionAvailable()) {
    return { data: safeStorage.encryptString(plain).toString('base64'), encrypted: true }
  }
  return { data: Buffer.from(plain, 'utf8').toString('base64'), encrypted: false }
}

export function decryptSecret(payload: SecurePayload): string {
  const buf = Buffer.from(payload.data, 'base64')
  if (payload.encrypted) {
    return safeStorage.decryptString(buf)
  }
  return buf.toString('utf8')
}
