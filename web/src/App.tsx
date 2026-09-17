import { useCallback, useEffect, useState } from 'react'
import { api, onUnauthorized } from './api'
import { usePoll, useHashRoute } from './hooks'
import { LoginGate } from './components/LoginGate'
import { NewSiteForm } from './components/NewSiteForm'
import { SiteCard } from './components/SiteCard'
import { SiteDetail } from './components/SiteDetail'
import type { JSX } from 'react'

function HealthBadges(): JSX.Element {
  const { data } = usePoll(api.health, 15000)
  if (!data) return <div className="env-badges" />

  const dockerOk = typeof data.docker === 'string'
  const cf = data.cloudflare

  return (
    <div className="env-badges">
      <span className={`badge ${dockerOk ? 'ok' : 'err'}`}>
        {dockerOk ? `docker ${data.docker as string}` : 'docker unreachable'}
      </span>
      <span className={`badge ${cf.enabled ? 'ok' : 'warn'}`}>
        {cf.enabled ? `cloudflare · ${cf.originMode}` : 'cloudflare · plan only'}
      </span>
    </div>
  )
}

function SiteList({
  cloudflareEnabled,
  navigate,
}: {
  cloudflareEnabled: boolean
  navigate: (to: string) => void
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  // Sites carry in-flight deployment status, so poll often enough to feel live.
  const { data: sites, error, refresh } = usePoll(api.listSites, 4000)

  return (
    <>
      <div className="card-head">
        <h2 style={{ margin: 0, fontSize: 20 }}>Sites</h2>
        {!creating && (
          <button className="primary" onClick={() => setCreating(true)}>
            New site
          </button>
        )}
      </div>

      {error && (
        <div className="notice error">
          <strong>Could not reach the deployer API</strong>
          {error}
        </div>
      )}

      {creating && (
        <section className="section">
          <div className="card">
            <NewSiteForm
              onCancel={() => setCreating(false)}
              onCreated={(siteId) => {
                setCreating(false)
                refresh()
                navigate(`/sites/${siteId}`)
              }}
            />
          </div>
        </section>
      )}

      <section className="section">
        {sites === null ? (
          <div className="empty-state">Loading…</div>
        ) : sites.length === 0 ? (
          <div className="empty-state">
            No sites yet. Create one to build it, run it and route a subdomain to it.
          </div>
        ) : (
          <div className="grid">
            {sites.map((site) => (
              <SiteCard
                key={site.id}
                site={site}
                cloudflareEnabled={cloudflareEnabled}
                onOpen={() => navigate(`/sites/${site.id}`)}
                onChanged={refresh}
              />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

export function App(): JSX.Element {
  const { path, navigate } = useHashRoute()
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    onUnauthorized(() => setLocked(true))
    return () => onUnauthorized(null)
  }, [])

  const { data: health } = usePoll(api.health, 30000)
  const cloudflareEnabled = health?.cloudflare.enabled ?? false

  const back = useCallback(() => navigate('/'), [navigate])

  const siteMatch = /^\/sites\/([\w-]+)$/.exec(path)

  if (locked) {
    return (
      <div className="app">
        <LoginGate onAuthenticated={() => window.location.reload()} />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <a href="#/" style={{ color: 'inherit' }}>
            site-deployer
          </a>
          <small>home lab</small>
        </div>
        <HealthBadges />
      </header>

      {health && !health.cloudflare.enabled && (
        <div className="notice">
          <strong>Cloudflare is in plan-only mode</strong>
          DNS and tunnel calls are logged, not sent. Missing:{' '}
          <code>{health.cloudflare.missing.join(', ')}</code>
        </div>
      )}

      {siteMatch?.[1] ? (
        <SiteDetail siteId={siteMatch[1]} cloudflareEnabled={cloudflareEnabled} onBack={back} />
      ) : (
        <SiteList cloudflareEnabled={cloudflareEnabled} navigate={navigate} />
      )}
    </div>
  )
}
