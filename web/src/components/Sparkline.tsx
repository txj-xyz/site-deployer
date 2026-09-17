import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

export type Point = [number, number | null]

export interface SparkSeries {
  label: string
  points: Point[]
  /** CSS custom property name holding this series' colour. */
  colorVar: string
}

interface Props {
  series: SparkSeries[]
  format: (value: number) => string
  height?: number
  /** Forces the y-axis to start at zero. Right for rates, wrong for latency. */
  zeroBased?: boolean
}

/** Width of the element, tracked so the SVG can use real pixel coordinates. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** Splits on nulls so a gap in the data renders as a gap, not a straight line across it. */
function segments(points: Point[]): { i: number; v: number }[][] {
  const out: { i: number; v: number }[][] = []
  let run: { i: number; v: number }[] = []
  points.forEach(([, value], i) => {
    if (value === null) {
      if (run.length > 0) out.push(run)
      run = []
    } else {
      run.push({ i, v: value })
    }
  })
  if (run.length > 0) out.push(run)
  return out
}

export function Sparkline({ series, format, height = 64, zeroBased = true }: Props): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const width = useWidth(wrapRef)
  const [hover, setHover] = useState<number | null>(null)

  const length = Math.max(...series.map((s) => s.points.length), 0)
  const finite = series.flatMap((s) => s.points.map(([, v]) => v).filter((v): v is number => v !== null))

  if (length === 0 || finite.length === 0) {
    return (
      <div className="spark-empty" style={{ height }}>
        no data yet
      </div>
    )
  }

  const rawMax = Math.max(...finite)
  const rawMin = zeroBased ? Math.min(0, ...finite) : Math.min(...finite)
  // A flat series would divide by zero; give it a band so the line sits mid-height.
  const span = rawMax - rawMin || Math.abs(rawMax) || 1
  const max = rawMax + span * 0.1
  const min = zeroBased ? rawMin : rawMin - span * 0.1

  const pad = 2
  const plotH = height - pad * 2
  const x = (i: number) => (length === 1 ? width / 2 : (i / (length - 1)) * width)
  const y = (v: number) => pad + plotH - ((v - min) / (max - min)) * plotH

  const onMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (width === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    setHover(Math.max(0, Math.min(length - 1, Math.round(ratio * (length - 1)))))
  }

  const timestamps = series[0]?.points ?? []
  const hoverTime = hover !== null ? timestamps[hover]?.[0] : undefined

  return (
    <div
      className="spark"
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ height }}
    >
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(', ')}>
          {series.map((s) => {
            const runs = segments(s.points)
            return (
              <g key={s.label}>
                {runs.map((run, index) => {
                  const line = run.map((p) => `${x(p.i)},${y(p.v)}`).join(' L ')
                  const first = run[0]
                  const last = run.at(-1)
                  if (!first || !last) return null
                  const baseline = y(zeroBased ? Math.max(min, 0) : min)
                  return (
                    <g key={index}>
                      <path
                        d={`M ${x(first.i)},${baseline} L ${line} L ${x(last.i)},${baseline} Z`}
                        fill={`var(${s.colorVar})`}
                        fillOpacity={0.08}
                      />
                      <path
                        d={`M ${line}`}
                        fill="none"
                        stroke={`var(${s.colorVar})`}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  )
                })}
              </g>
            )
          })}

          {hover !== null && (
            <>
              <line x1={x(hover)} y1={0} x2={x(hover)} y2={height} className="spark-crosshair" />
              {series.map((s) => {
                const value = s.points[hover]?.[1]
                if (value === null || value === undefined) return null
                return (
                  <circle
                    key={s.label}
                    cx={x(hover)}
                    cy={y(value)}
                    r={4}
                    fill={`var(${s.colorVar})`}
                    // 2px surface ring keeps the marker legible over the fill.
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                )
              })}
            </>
          )}
        </svg>
      )}

      {hover !== null && (
        <div
          className="spark-tip"
          style={{
            left: `${Math.min(Math.max(x(hover), 8), Math.max(width - 8, 8))}px`,
          }}
        >
          {hoverTime !== undefined && (
            <div className="spark-tip-time">{new Date(hoverTime * 1000).toLocaleTimeString()}</div>
          )}
          {series.map((s) => {
            const value = s.points[hover]?.[1]
            return (
              <div key={s.label} className="spark-tip-row">
                <span className="swatch" style={{ background: `var(${s.colorVar})` }} />
                <span className="spark-tip-label">{s.label}</span>
                <span className="spark-tip-value">
                  {value === null || value === undefined ? '—' : format(value)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
