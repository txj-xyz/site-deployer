import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { config } from '../config.js'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32

let cachedKey: Buffer | null = null
let keySource = 'unknown'

function parseKey(raw: string): Buffer | null {
  const trimmed = raw.trim()
  const hex = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : null
  if (hex?.length === KEY_BYTES) return hex
  try {
    const decoded = Buffer.from(trimmed, 'base64')
    if (decoded.length === KEY_BYTES) return decoded
  } catch {
    // fall through
  }
  return null
}

/**
 * Loads the encryption key from SECRET_KEY, or from a generated key file.
 *
 * Generating one on first run keeps the deployer working out of the box while
 * still encrypting at rest. The file is the whole secret: losing it means every
 * stored env value becomes unreadable, which is why startup says where it is.
 */
export function secretKey(): Buffer {
  if (cachedKey) return cachedKey

  const fromEnv = process.env.SECRET_KEY
  if (fromEnv && fromEnv.trim() !== '') {
    const parsed = parseKey(fromEnv)
    if (!parsed) {
      throw new Error('SECRET_KEY must be 32 bytes, as 64 hex characters or base64')
    }
    cachedKey = parsed
    keySource = 'SECRET_KEY'
    return cachedKey
  }

  const keyPath = join(config.dataDir, 'secret.key')
  if (existsSync(keyPath)) {
    let contents: string
    try {
      contents = readFileSync(keyPath, 'utf8')
    } catch (err) {
      // The file exists but is unreadable - wrong owner, restrictive mode, or a
      // sandbox. Say so, and say how to get moving again, rather than surfacing
      // a bare EPERM from deep inside startup.
      throw new Error(
        `cannot read the secret key at ${keyPath}: ${err instanceof Error ? err.message : String(err)}. ` +
          'Fix its permissions, or set SECRET_KEY and the file will be ignored.',
      )
    }
    const parsed = parseKey(contents)
    if (!parsed) throw new Error(`${keyPath} does not contain a valid 32-byte key`)
    cachedKey = parsed
    keySource = keyPath
    return cachedKey
  }

  const generated = randomBytes(KEY_BYTES)
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, generated.toString('base64'), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(keyPath, 0o600)
  } catch {
    // Best effort: some filesystems do not support it.
  }
  cachedKey = generated
  keySource = `${keyPath} (generated)`
  return cachedKey
}

export function keyDescription(): string {
  secretKey()
  return keySource
}

export function isSealed(value: string): boolean {
  return value.startsWith(`${VERSION}:`)
}

export function sealValue(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, secretKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
}

/**
 * Decrypts a sealed value. A value without the version prefix is returned as-is:
 * rows written before encryption existed stay readable, and they are re-sealed
 * the next time the site is saved.
 */
export function openValue(stored: string): string {
  if (!isSealed(stored)) return stored

  const [, ivB64, tagB64, ctB64] = stored.split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed sealed value')

  const decipher = createDecipheriv(ALGORITHM, secretKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function sealEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, sealValue(v)]))
}

export function openEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, openValue(v)]))
}

/** Keys stay visible; values never leave the process. */
export function maskEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(env).map((k) => [k, '••••••••']))
}
