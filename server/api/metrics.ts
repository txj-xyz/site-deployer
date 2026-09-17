import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { sites } from '../db/schema.js'
import { exposition } from '../metrics/exporter.js'
import { buildTargets, writeTargets } from '../metrics/targets.js'
import { PrometheusError, queryRange, scalar, type Point } from '../metrics/prometheus.js'

const WINDOWS: Record<string, number> = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
}

interface MetricsResponse {
  enabled: boolean
  error?: string
  window: string
  step: number
  series: Record<string, Point[]>
  summary: {
    availability: number | null
    avgLatency: number | null
    bytesIn: number | null
    bytesOut: number | null
    cpu: number | null
    memory: number | null
  }
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sites/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { window = '6h', scope = 'internal' } = req.query as { window?: string; scope?: string }

    const site = db.select().from(sites).where(eq(sites.id, id)).get()
    if (!site) return reply.code(404).send({ error: 'site not found' })

    const seconds = WINDOWS[window]
    if (!seconds) {
      return reply.code(400).send({ error: `window must be one of ${Object.keys(WINDOWS).join(', ')}` })
    }
    if (scope !== 'internal' && scope !== 'public') {
      return reply.code(400).send({ error: 'scope must be "internal" or "public"' })
    }

    const end = Math.floor(Date.now() / 1000)
    const start = end - seconds
    // ~120 points across the window, and never finer than the 15s scrape interval.
    const step = Math.max(15, Math.round(seconds / 120))
    // Rate windows need several scrapes to be meaningful, hence 4x the step.
    const rate = `${Math.max(60, step * 4)}s`

    // Site names are validated slugs, so they are safe to interpolate into PromQL.
    const s = `site="${site.name}"`
    const probe = `${s}, scope="${scope}"`

    const queries: Record<string, string> = {
      cpu: `sum(rate(container_cpu_usage_seconds_total{${s}}[${rate}]))`,
      memory: `sum(container_memory_working_set_bytes{${s}})`,
      netRx: `sum(rate(container_network_receive_bytes_total{${s}}[${rate}]))`,
      netTx: `sum(rate(container_network_transmit_bytes_total{${s}}[${rate}]))`,
      up: `min(probe_success{${probe}})`,
      latency: `avg(probe_duration_seconds{${probe}})`,
    }

    const empty: MetricsResponse['series'] = {}
    const blankSummary = {
      availability: null,
      avgLatency: null,
      bytesIn: null,
      bytesOut: null,
      cpu: null,
      memory: null,
    }

    try {
      const entries = await Promise.all(
        Object.entries(queries).map(async ([name, query]) => {
          const result = await queryRange(query, start, end, step)
          return [name, result[0]?.values ?? []] as const
        }),
      )

      const [availability, avgLatency, bytesIn, bytesOut, cpu, memory] = await Promise.all([
        scalar(`avg_over_time(probe_success{${probe}}[${window}])`),
        scalar(`avg_over_time(probe_duration_seconds{${probe}}[${window}])`),
        scalar(`sum(increase(container_network_receive_bytes_total{${s}}[${window}]))`),
        scalar(`sum(increase(container_network_transmit_bytes_total{${s}}[${window}]))`),
        scalar(`sum(rate(container_cpu_usage_seconds_total{${s}}[${rate}]))`),
        scalar(`sum(container_memory_working_set_bytes{${s}})`),
      ])

      const response: MetricsResponse = {
        enabled: true,
        window,
        step,
        series: Object.fromEntries(entries),
        summary: { availability, avgLatency, bytesIn, bytesOut, cpu, memory },
      }
      return response
    } catch (err) {
      if (err instanceof PrometheusError) {
        // 200 with enabled:false - Prometheus being absent is a normal state for
        // someone who has not brought the metrics stack up, not an API failure.
        const response: MetricsResponse = {
          enabled: false,
          error: err.message,
          window,
          step,
          series: empty,
          summary: blankSummary,
        }
        return response
      }
      throw err
    }
  })

  /** What we are asking Prometheus to probe, and a way to force a rewrite. */
  app.get('/api/metrics/targets', async () => ({ groups: buildTargets() }))

  app.post('/api/metrics/targets', async () => writeTargets())

  /**
   * Scraped by Prometheus, which is why it is in OPEN_PATHS rather than behind
   * the dashboard token - a scrape config cannot read a secret out of .env. It
   * exposes site names and their resource usage and nothing else, and the
   * deployer is not meant to be publicly reachable in the first place.
   */
  app.get('/metrics', async (_req, reply) => {
    try {
      const body = await exposition()
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body)
    } catch (err) {
      // Docker being down is already visible on /api/health; failing the scrape
      // is the honest signal here, rather than reporting every site as using
      // zero CPU.
      return reply.code(503).send(`# docker unreachable: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  })
}
