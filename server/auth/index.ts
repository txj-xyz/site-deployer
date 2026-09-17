import { createPublicKey, createVerify, timingSafeEqual, type JsonWebKey } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'

export type AuthMode = 'cloudflare-access' | 'token' | 'none'

export function authMode(): AuthMode {
  if (config.access.teamDomain && config.access.aud) return 'cloudflare-access'
  if (config.dashboardToken) return 'token'
  return 'none'
}

const COOKIE = 'sd_session'

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

// --- Cloudflare Access ---------------------------------------------------

interface Jwk {
  kid: string
  kty: string
  alg?: string
  n?: string
  e?: string
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null
const JWKS_TTL_MS = 60 * 60_000

async function fetchJwks(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys

  const url = `https://${config.access.teamDomain}/cdn-cgi/access/certs`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`could not fetch Access certs: HTTP ${res.status}`)

  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = body.keys ?? []
  if (keys.length === 0) throw new Error('Access certs response contained no keys')

  jwksCache = { keys, fetchedAt: Date.now() }
  return keys
}

function base64UrlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * Verifies a Cloudflare Access JWT.
 *
 * Done with node:crypto rather than a JWT library: Access only ever issues RS256,
 * and Node can import a JWK directly, so the whole check is a signature verify
 * plus three claim comparisons. Fewer dependencies in the auth path is worth more
 * than generality here.
 */
async function verifyAccessJwt(token: string): Promise<{ email?: string; sub?: string }> {
  const [headerB64, payloadB64, signatureB64] = token.split('.')
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error('malformed token')

  const header = JSON.parse(base64UrlToBuffer(headerB64).toString('utf8')) as { kid?: string; alg?: string }
  if (header.alg !== 'RS256') throw new Error(`unexpected algorithm ${header.alg}`)

  const keys = await fetchJwks()
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error('token was signed by an unknown key')

  const publicKey = createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' })
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${headerB64}.${payloadB64}`)
  verifier.end()

  if (!verifier.verify(publicKey, base64UrlToBuffer(signatureB64))) {
    throw new Error('signature does not verify')
  }

  const payload = JSON.parse(base64UrlToBuffer(payloadB64).toString('utf8')) as {
    aud?: string | string[]
    iss?: string
    exp?: number
    nbf?: number
    email?: string
    sub?: string
  }

  const now = Math.floor(Date.now() / 1000)
  if (payload.exp !== undefined && payload.exp < now) throw new Error('token has expired')
  if (payload.nbf !== undefined && payload.nbf > now + 60) throw new Error('token is not yet valid')

  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
  if (!audiences.includes(config.access.aud as string)) throw new Error('token audience does not match')

  const expectedIssuer = `https://${config.access.teamDomain}`
  if (payload.iss !== expectedIssuer) throw new Error('token issuer does not match')

  return { email: payload.email, sub: payload.sub }
}

// --- plugin --------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    identity?: { email?: string; sub?: string } | { token: true }
  }
}

/**
 * Liveness only - safe to leave open so a health check does not need
 * credentials. `/metrics` joins it because Prometheus scrapes it and a scrape
 * config has no way to read the dashboard token; it carries site names and
 * their resource usage, nothing more.
 */
const OPEN_PATHS = new Set(['/healthz', '/metrics'])

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const mode = authMode()

  app.get('/healthz', async () => ({ ok: true }))

  if (mode === 'token') {
    // Lets a browser authenticate once instead of attaching a header to every
    // request. The cookie is HttpOnly and SameSite=Strict; it carries the token
    // itself, which is acceptable only because it never leaves this host.
    app.post('/api/login', async (req, reply) => {
      const body = (req.body ?? {}) as { token?: string }
      if (!body.token || !constantTimeEqual(body.token, config.dashboardToken as string)) {
        return reply.code(401).send({ error: 'invalid token' })
      }
      reply.header(
        'Set-Cookie',
        `${COOKIE}=${encodeURIComponent(body.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
      )
      return { ok: true }
    })
  }

  if (mode === 'none') {
    app.log.warn(
      'no authentication configured - set ACCESS_TEAM_DOMAIN + ACCESS_AUD, or DASHBOARD_TOKEN. Do not expose this service.',
    )
    return
  }

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (OPEN_PATHS.has(req.url.split('?')[0] ?? '')) return
    if (mode === 'token' && req.method === 'POST' && req.url.startsWith('/api/login')) return

    if (mode === 'cloudflare-access') {
      const token =
        (req.headers['cf-access-jwt-assertion'] as string | undefined) ??
        readCookie(req.headers.cookie, 'CF_Authorization')

      if (!token) {
        return reply.code(401).send({ error: 'missing Cloudflare Access assertion' })
      }
      try {
        req.identity = await verifyAccessJwt(token)
      } catch (err) {
        req.log.warn({ err }, 'rejected Access token')
        return reply.code(401).send({ error: 'invalid Cloudflare Access token' })
      }
      return
    }

    const header = req.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null
    const supplied = bearer ?? readCookie(req.headers.cookie, COOKIE)

    if (!supplied || !constantTimeEqual(supplied, config.dashboardToken as string)) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    req.identity = { token: true }
  })
}
