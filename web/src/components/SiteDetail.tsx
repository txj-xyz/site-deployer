import { useCallback, useEffect, useState } from 'react'
import { api, type Deployment, type PollOutcome } from '../api'
import { isActive, usePoll } from '../hooks'
import { LogViewer } from './LogViewer'
import { Metrics } from './Metrics'
import { StatusPill } from './StatusPill'
import type { JSX } from 'react'

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function describeOutcome(outcome: PollOutcome): string {
  switch (outcome.action) {
    case 'deployed':
      return `New commit ${outcome.sha.slice(0, 8)} — deploying now.`
    case 'up-to-date':
      return `Already on ${outcome.sha.slice(0, 8)}.`
    case 'already-attempted':
      return `${outcome.sha.slice(0, 8)} was already tried and did not go live. Push a new commit to retry, or deploy manually.`
    case 'busy':
      return 'A deployment is already running for this site.'
    case 'skipped':
      return `Skipped: ${outcome.reason}.`
    case 'error':
      return `Check failed: ${outcome.message}`
  }
}

function duration(d: Deployment): string {
  if (!d.startedAt) return '—'
  const end = d.finishedAt ? new Date(d.finishedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.round((end - new Date(d.startedAt).getTime()) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function SiteDetail({
  siteId,
  cloudflareEnabled,
  onBack,
}: {
  siteId: string
  cloudflareEnabled: boolean
  onBack: () => void
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<string | null>(null)

  const fetcher = useCallback(() => api.getSite(siteId), [siteId])
  // Poll faster while something is in flight, then back off once it settles.
  const [interval, setIntervalMs] = useState(3000)
  const { data: site, error, refresh } = usePoll(fetcher, interval, [siteId])

  useEffect(() => {
    const active = site?.deployments.some((d) => isActive(d.status)) ?? false
    setIntervalMs(active ? 2000 : 10000)
  }, [site])

  // Default the log pane to the newest deployment, and follow new ones as they start.
  useEffect(() => {
    const newest = site?.deployments[0]
    if (newest && (selected === null || isActive(newest.status))) setSelected(newest.id)
  }, [site, selected])

  if (error && !site) {
    return (
      <>
        <a className="back" href="#/" onClick={onBack}>
          ← all sites
        </a>
        <div className="notice error">
          <strong>Could not load this site</strong>
          {error}
        </div>
      </>
    )
  }

  if (!site) return <div className="empty-state">Loading…</div>

  const selectedDeployment = site.deployments.find((d) => d.id === selected) ?? null

  return (
    <>
      <a
        className="back"
        href="#/"
        onClick={(e) => {
          e.preventDefault()
          onBack()
        }}
      >
        ← all sites
      </a>

      <div className="card-head">
        <h2 style={{ margin: 0, fontSize: 20 }}>{site.name}</h2>
        <StatusPill status={selectedDeployment?.status ?? null} />
      </div>

      <dl className="meta" style={{ maxWidth: 640 }}>
        <dt>Hostname</dt>
        <dd>
          {site.hostname && cloudflareEnabled ? (
            <a href={`https://${site.hostname}`} target="_blank" rel="noreferrer">
              {site.hostname}
            </a>
          ) : (
            <span className="dim">{site.hostname ?? 'not routed yet'}</span>
          )}
        </dd>
        <dt>Source</dt>
        <dd>{site.sourceType === 'git' ? `${site.repoUrl} @ ${site.branch}` : site.localPath}</dd>
        <dt>Container port</dt>
        <dd>{site.containerPort}</dd>
        <dt>Health path</dt>
        <dd>{site.healthPath}</dd>
        <dt>Desired state</dt>
        <dd>{site.desiredState}</dd>
        {site.sourceType === 'git' && (
          <>
            <dt>Auto-deploy</dt>
            <dd>{site.autoDeploy ? 'on' : 'off'}</dd>
            <dt>Last checked</dt>
            <dd>
              {ago(site.lastPolledAt)}
              {site.pollFailures > 0 && (
                <span className="dim"> · {site.pollFailures} failed, backing off</span>
              )}
            </dd>
            <dt>Remote head</dt>
            <dd>{site.lastSeenSha ? site.lastSeenSha.slice(0, 8) : '—'}</dd>
          </>
        )}
      </dl>

      {site.pollError && (
        <div className="notice error">
          <strong>Cannot reach the repository</strong>
          {site.pollError}
        </div>
      )}

      {checkResult && <div className="notice">{checkResult}</div>}

      <div className="actions">
        <button className="primary" onClick={() => void api.deploySite(site.id).then(refresh)}>
          Deploy
        </button>
        <button onClick={() => void api.stopSite(site.id).then(refresh)}>Stop</button>
        {site.sourceType === 'git' && (
          <button
            disabled={checking}
            onClick={() => {
              setChecking(true)
              setCheckResult(null)
              void api
                .checkSite(site.id)
                .then((res) => setCheckResult(describeOutcome(res.outcome)))
                .catch((err: unknown) =>
                  setCheckResult(err instanceof Error ? err.message : String(err)),
                )
                .finally(() => {
                  setChecking(false)
                  refresh()
                })
            }}
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>

      <section className="section">
        <h2>Traffic and resources</h2>
        <Metrics siteId={site.id} />
      </section>

      <section className="section">
        <h2>Deployments</h2>
        {site.deployments.length === 0 ? (
          <div className="empty-state">No deployments yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Trigger</th>
                <th>Commit</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Port</th>
              </tr>
            </thead>
            <tbody>
              {site.deployments.map((d) => (
                <tr
                  key={d.id}
                  className={`selectable ${d.id === selected ? 'selected' : ''}`}
                  onClick={() => setSelected(d.id)}
                >
                  <td>
                    <StatusPill status={d.status} />
                  </td>
                  <td className="dim">{d.trigger}</td>
                  <td>
                    <code>{d.commitSha ? d.commitSha.slice(0, 8) : '—'}</code>
                  </td>
                  <td className="dim">{when(d.startedAt ?? d.createdAt)}</td>
                  <td className="dim">{duration(d)}</td>
                  <td className="dim">{d.hostPort ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Log</h2>
        <LogViewer
          deploymentId={selected}
          fallbackStatus={selectedDeployment?.status ?? null}
          onTerminal={refresh}
        />
        {selectedDeployment?.error && (
          <div className="notice error" style={{ marginTop: 12 }}>
            <strong>Failure</strong>
            <span style={{ whiteSpace: 'pre-wrap' }}>{selectedDeployment.error}</span>
          </div>
        )}
      </section>
    </>
  )
}
