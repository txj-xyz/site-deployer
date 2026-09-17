import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { api, type MetricsResponse } from '../api'
import { usePoll } from '../hooks'
import { Sparkline, type Point } from './Sparkline'

const WINDOWS = ['1h', '6h', '24h', '7d'] as const

function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.abs(value)
  let unit = 0
  while (v >= 1024 && unit < units.length - 1) {
    v /= 1024
    unit++
  }
  return `${v < 10 && unit > 0 ? v.toFixed(1) : Math.round(v)} ${units[unit]}`
}

const bytesPerSec = (v: number) => `${bytes(v)}/s`
const seconds = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`)
const cores = (v: number) => (v < 0.01 ? `${(v * 1000).toFixed(1)} m` : v.toFixed(2))
const percent = (v: number) => `${(v * 100).toFixed(2)}%`

/** Availability is a state, so it gets a status colour plus a word - never colour alone. */
function availabilityTone(value: number | null): { tone: string; label: string } {
  if (value === null) return { tone: '', label: 'no data' }
  if (value >= 0.995) return { tone: 'ok', label: 'healthy' }
  if (value >= 0.95) return { tone: 'warn', label: 'degraded' }
  return { tone: 'err', label: 'unhealthy' }
}

function StatTile({
  label,
  value,
  tone = '',
  note,
}: {
  label: string
  value: string
  tone?: string
  note?: string
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone}`}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  )
}

function SparkCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="spark-card">
      <div className="spark-head">
        <span className="spark-title">{title}</span>
        {description && <span className="spark-desc">{description}</span>}
      </div>
      {children}
    </div>
  )
}

function lastValue(points: Point[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i]?.[1]
    if (v !== null && v !== undefined) return v
  }
  return null
}

export function Metrics({ siteId }: { siteId: string }): JSX.Element {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>('6h')
  const [scope, setScope] = useState<'internal' | 'public'>('internal')
  const [showTable, setShowTable] = useState(false)

  const fetcher = useCallback(() => api.siteMetrics(siteId, window, scope), [siteId, window, scope])
  const { data, error } = usePoll<MetricsResponse>(fetcher, 30000, [siteId, window, scope])

  const filters = (
    <div className="viz-filters">
      <div className="seg" role="group" aria-label="Time range">
        {WINDOWS.map((w) => (
          <button key={w} className={w === window ? 'on' : ''} onClick={() => setWindow(w)}>
            {w}
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Probe scope">
        <button className={scope === 'internal' ? 'on' : ''} onClick={() => setScope('internal')}>
          origin
        </button>
        <button className={scope === 'public' ? 'on' : ''} onClick={() => setScope('public')}>
          public
        </button>
      </div>
      <button className="ghost" onClick={() => setShowTable((v) => !v)}>
        {showTable ? 'Show charts' : 'Show numbers'}
      </button>
    </div>
  )

  if (error && !data) {
    return (
      <>
        {filters}
        <div className="notice error">
          <strong>Could not load metrics</strong>
          {error}
        </div>
      </>
    )
  }

  if (!data) return <div className="empty-state">Loading metrics…</div>

  if (!data.enabled) {
    return (
      <>
        {filters}
        <div className="notice">
          <strong>The metrics stack is not running</strong>
          {data.error} — bring it up with{' '}
          <code>docker compose -f stack/compose.yaml --env-file .env up -d</code>.
        </div>
      </>
    )
  }

  const { summary, series } = data
  const availability = availabilityTone(summary.availability)

  const rows: { label: string; value: string }[] = [
    { label: 'Availability', value: summary.availability === null ? '—' : percent(summary.availability) },
    { label: 'Average response', value: summary.avgLatency === null ? '—' : seconds(summary.avgLatency) },
    { label: `Data in (${window})`, value: summary.bytesIn === null ? '—' : bytes(summary.bytesIn) },
    { label: `Data out (${window})`, value: summary.bytesOut === null ? '—' : bytes(summary.bytesOut) },
    { label: 'CPU now', value: summary.cpu === null ? '—' : `${cores(summary.cpu)} cores` },
    { label: 'Memory now', value: summary.memory === null ? '—' : bytes(summary.memory) },
  ]

  return (
    <div className="viz-root">
      {filters}

      <div className="stats">
        <StatTile
          label="Availability"
          value={summary.availability === null ? '—' : percent(summary.availability)}
          tone={availability.tone}
          note={availability.label}
        />
        <StatTile
          label="Average response"
          value={summary.avgLatency === null ? '—' : seconds(summary.avgLatency)}
          note={scope === 'public' ? 'through Cloudflare' : 'origin only'}
        />
        <StatTile
          label={`Data in · ${window}`}
          value={summary.bytesIn === null ? '—' : bytes(summary.bytesIn)}
        />
        <StatTile
          label={`Data out · ${window}`}
          value={summary.bytesOut === null ? '—' : bytes(summary.bytesOut)}
        />
      </div>

      {showTable ? (
        <table className="viz-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>
                  <code>{row.value}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="spark-grid">
          <SparkCard
            title="Network"
            description="in / out — the closest stand-in for traffic volume"
          >
            <div className="legend">
              <span className="legend-item">
                <span className="swatch" style={{ background: 'var(--series-1)' }} />
                in {lastValue(series.netRx ?? []) !== null && bytesPerSec(lastValue(series.netRx ?? []) as number)}
              </span>
              <span className="legend-item">
                <span className="swatch" style={{ background: 'var(--series-2)' }} />
                out{' '}
                {lastValue(series.netTx ?? []) !== null && bytesPerSec(lastValue(series.netTx ?? []) as number)}
              </span>
            </div>
            <Sparkline
              format={bytesPerSec}
              series={[
                { label: 'in', points: series.netRx ?? [], colorVar: '--series-1' },
                { label: 'out', points: series.netTx ?? [], colorVar: '--series-2' },
              ]}
            />
          </SparkCard>

          <SparkCard title="Response time" description={scope === 'public' ? 'public probe' : 'origin probe'}>
            <Sparkline
              format={seconds}
              zeroBased={false}
              series={[{ label: 'response', points: series.latency ?? [], colorVar: '--series-1' }]}
            />
          </SparkCard>

          <SparkCard title="CPU" description="cores">
            <Sparkline
              format={cores}
              series={[{ label: 'cpu', points: series.cpu ?? [], colorVar: '--series-1' }]}
            />
          </SparkCard>

          <SparkCard title="Memory" description="working set">
            <Sparkline
              format={bytes}
              series={[{ label: 'memory', points: series.memory ?? [], colorVar: '--series-1' }]}
            />
          </SparkCard>
        </div>
      )}
    </div>
  )
}
