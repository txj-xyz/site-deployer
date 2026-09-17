import { config } from '../config.js'

interface CloudflareEnvelope<T> {
  success: boolean
  errors: { code: number; message: string }[]
  messages: { code: number; message: string }[]
  result: T
}

export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly errors: { code: number; message: string }[],
    readonly path: string,
  ) {
    const detail = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${status}`
    super(`Cloudflare ${path} failed - ${detail}`)
    this.name = 'CloudflareError'
  }

  /** 10000 is Cloudflare's catch-all for "your token cannot do this". */
  get isAuthProblem(): boolean {
    return this.status === 401 || this.status === 403 || this.errors.some((e) => e.code === 10000)
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])

/**
 * Thin wrapper over the Cloudflare v4 API. Retries rate limits and transient 5xx
 * with backoff; everything else fails fast, because a 4xx here means the config
 * is wrong and retrying will not fix it.
 */
export async function cf<T>(
  path: string,
  init: { method?: string; body?: unknown; attempts?: number } = {},
): Promise<T> {
  const attempts = init.attempts ?? 3
  const url = `${config.cloudflare.apiBase}${path}`
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${config.cloudflare.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      lastError = err
      if (attempt === attempts) throw err
      await backoff(attempt)
      continue
    }

    const text = await res.text()
    let envelope: CloudflareEnvelope<T> | null = null
    try {
      envelope = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : null
    } catch {
      // Non-JSON body: fall through to the status-based error below.
    }

    if (res.ok && envelope?.success) return envelope.result

    const errors = envelope?.errors?.length
      ? envelope.errors
      : [{ code: res.status, message: text.slice(0, 300) || res.statusText }]

    if (RETRYABLE.has(res.status) && attempt < attempts) {
      lastError = new CloudflareError(res.status, errors, path)
      await backoff(attempt, res.headers.get('retry-after'))
      continue
    }

    throw new CloudflareError(res.status, errors, path)
  }

  throw lastError instanceof Error ? lastError : new Error(`Cloudflare ${path} failed`)
}

function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  const headerMs = retryAfter ? Number(retryAfter) * 1000 : NaN
  const ms = Number.isFinite(headerMs) ? headerMs : Math.min(2 ** attempt * 250, 5_000)
  return new Promise((r) => setTimeout(r, ms))
}
