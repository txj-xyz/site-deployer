import { useState } from 'react'
import { api, type SiteWithCurrent } from '../api'
import { isActive } from '../hooks'
import { StatusPill } from './StatusPill'
import type { JSX } from 'react'

interface Props {
  site: SiteWithCurrent
  cloudflareEnabled: boolean
  onOpen: () => void
  onChanged: () => void
}

export function SiteCard({ site, cloudflareEnabled, onOpen, onChanged }: Props): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const deployment = site.currentDeployment
  const running = isActive(deployment?.status)

  const act = async (label: string, fn: () => Promise<unknown>, confirmMessage?: string) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return
    setBusy(label)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>
          <a
            href={`#/sites/${site.id}`}
            onClick={(e) => {
              e.preventDefault()
              onOpen()
            }}
          >
            {site.name}
          </a>
        </h3>
        <StatusPill status={deployment?.status ?? null} />
      </div>

      <dl className="meta">
        <dt>Host</dt>
        <dd>
          {site.hostname && cloudflareEnabled ? (
            <a href={`https://${site.hostname}`} target="_blank" rel="noreferrer">
              {site.hostname}
            </a>
          ) : (
            <span className="dim">{site.hostname ?? `${site.subdomain}.…`}</span>
          )}
        </dd>

        <dt>Source</dt>
        <dd>{site.sourceType === 'git' ? `${site.repoUrl} @ ${site.branch}` : site.localPath}</dd>

        {deployment?.commitSha && (
          <>
            <dt>Commit</dt>
            <dd>{deployment.commitSha.slice(0, 8)}</dd>
          </>
        )}

        {deployment?.hostPort != null && (
          <>
            <dt>Port</dt>
            <dd>{deployment.hostPort}</dd>
          </>
        )}
      </dl>

      {deployment?.status === 'failed' && deployment.error && (
        <div className="notice error">
          <strong>Last deploy failed</strong>
          {deployment.error.split('\n')[0]}
        </div>
      )}

      {error && (
        <div className="notice error">
          <strong>Action failed</strong>
          {error}
        </div>
      )}

      <div className="actions">
        <button
          className="primary"
          disabled={busy !== null || running}
          onClick={() => act('deploy', () => api.deploySite(site.id))}
        >
          {running ? 'Deploying…' : busy === 'deploy' ? 'Starting…' : 'Deploy'}
        </button>
        <button disabled={busy !== null} onClick={() => act('stop', () => api.stopSite(site.id))}>
          {busy === 'stop' ? 'Stopping…' : 'Stop'}
        </button>
        <button
          className="danger"
          disabled={busy !== null}
          onClick={() =>
            act(
              'delete',
              () => api.deleteSite(site.id),
              `Delete "${site.name}"? This removes its containers, images, checkout and route.`,
            )
          }
        >
          {busy === 'delete' ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  )
}
