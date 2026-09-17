import { config } from '../config.js'

export type Point = [number, number | null]

export interface Series {
  metric: Record<string, string>
  values: Point[]
}

interface PromEnvelope<T> {
  status: 'success' | 'error'
  data: T
  error?: string
  errorType?: string
}

export class PrometheusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrometheusError'
  }
}

async function promFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${config.prometheusUrl.replace(/\/$/, '')}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw new PrometheusError(
      `cannot reach Prometheus at ${config.prometheusUrl}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const body = (await res.json().catch(() => null)) as PromEnvelope<T> | null
  if (!res.ok || !body || body.status !== 'success') {
    throw new PrometheusError(body?.error ?? `Prometheus returned HTTP ${res.status}`)
  }
  return body.data
}

/** Prometheus encodes NaN and staleness as the string "NaN"; the UI wants a gap. */
function toPoint(raw: [number, string]): Point {
  const value = Number(raw[1])
  return [raw[0], Number.isFinite(value) ? value : null]
}

export async function queryRange(
  query: string,
  startSec: number,
  endSec: number,
  stepSec: number,
): Promise<Series[]> {
  const data = await promFetch<{ result: { metric: Record<string, string>; values: [number, string][] }[] }>(
    '/api/v1/query_range',
    {
      query,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec),
    },
  )
  return data.result.map((r) => ({ metric: r.metric, values: r.values.map(toPoint) }))
}

export async function queryInstant(query: string): Promise<{ metric: Record<string, string>; value: Point }[]> {
  const data = await promFetch<{ result: { metric: Record<string, string>; value: [number, string] }[] }>(
    '/api/v1/query',
    { query },
  )
  return data.result.map((r) => ({ metric: r.metric, value: toPoint(r.value) }))
}

/** First value of the first series, or null when the query matched nothing. */
export async function scalar(query: string): Promise<number | null> {
  const result = await queryInstant(query)
  return result[0]?.value[1] ?? null
}

export async function prometheusUp(): Promise<boolean> {
  try {
    await promFetch<unknown>('/api/v1/query', { query: '1' })
    return true
  } catch {
    return false
  }
}
