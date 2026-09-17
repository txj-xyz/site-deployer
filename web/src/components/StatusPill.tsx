import type { DeployStatus } from '../api'
import { isActive } from '../hooks'
import type { JSX } from 'react'

const LABELS: Record<DeployStatus, string> = {
  queued: 'queued',
  cloning: 'cloning',
  building: 'building',
  starting: 'starting',
  health_check: 'health check',
  routing: 'routing',
  live: 'live',
  failed: 'failed',
  cancelled: 'cancelled',
  superseded: 'superseded',
}

export function StatusPill({ status }: { status: DeployStatus | null | undefined }): JSX.Element {
  if (!status) return <span className="pill">no deployment</span>

  const tone = status === 'live' ? 'live' : status === 'failed' ? 'failed' : isActive(status) ? 'active' : ''

  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {LABELS[status]}
    </span>
  )
}
