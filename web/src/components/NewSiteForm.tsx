import { useState } from 'react'
import { ApiError, api, type CreateSiteInput } from '../api'
import type { JSX, FormEvent } from 'react'

interface Props {
  onCreated: (siteId: string, deploymentId: string | null) => void
  onCancel: () => void
}

/** `KEY=value` lines to an object; blank lines and `#` comments ignored. */
function parseEnv(text: string): { env: Record<string, string>; bad: string[] } {
  const env: Record<string, string> = {}
  const bad: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      bad.push(line)
      continue
    }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return { env, bad }
}

export function NewSiteForm({ onCreated, onCancel }: Props): JSX.Element {
  const [sourceType, setSourceType] = useState<'git' | 'local'>('git')
  const [name, setName] = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [localPath, setLocalPath] = useState('')
  const [dockerfilePath, setDockerfilePath] = useState('')
  const [containerPort, setContainerPort] = useState(3000)
  const [healthPath, setHealthPath] = useState('/')
  const [envText, setEnvText] = useState('')
  const [deployNow, setDeployNow] = useState(true)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)

    const { env, bad } = parseEnv(envText)
    if (bad.length > 0) {
      setError(`Environment lines must be KEY=value: ${bad.join(', ')}`)
      return
    }

    const input: CreateSiteInput = {
      name,
      sourceType,
      branch,
      containerPort,
      healthPath,
      env,
      deployNow,
      ...(subdomain ? { subdomain } : {}),
      ...(dockerfilePath ? { dockerfilePath } : {}),
      ...(sourceType === 'git' ? { repoUrl } : { localPath }),
    }

    setSubmitting(true)
    try {
      const site = await api.createSite(input)
      onCreated(site.id, site.deploymentId)
    } catch (err) {
      if (err instanceof ApiError && err.issues) {
        const issues = err.issues as { path?: (string | number)[]; message: string }[]
        setError(issues.map((i) => `${i.path?.join('.') ?? 'input'}: ${i.message}`).join('; '))
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      {error && (
        <div className="notice error">
          <strong>Could not create the site</strong>
          {error}
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="blog"
            required
          />
          <span className="hint">Lowercase, hyphens allowed. Used for container and image names.</span>
        </div>
        <div className="field">
          <label htmlFor="subdomain">Subdomain</label>
          <input
            id="subdomain"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            placeholder={name || 'blog'}
          />
          <span className="hint">Defaults to the name.</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="sourceType">Source</label>
        <select
          id="sourceType"
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as 'git' | 'local')}
        >
          <option value="git">Git repository</option>
          <option value="local">Local path on the server</option>
        </select>
      </div>

      {sourceType === 'git' ? (
        <div className="row">
          <div className="field">
            <label htmlFor="repoUrl">Repository URL</label>
            <input
              id="repoUrl"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="git@github.com:you/blog.git"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="branch">Branch</label>
            <input id="branch" value={branch} onChange={(e) => setBranch(e.target.value)} required />
          </div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="localPath">Path</label>
          <input
            id="localPath"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/srv/sites/blog"
            required
          />
          <span className="hint">Must exist on the machine running the deployer.</span>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor="containerPort">Container port</label>
          <input
            id="containerPort"
            type="number"
            min={1}
            max={65535}
            value={containerPort}
            onChange={(e) => setContainerPort(Number(e.target.value))}
            required
          />
          <span className="hint">What the app listens on inside the container. 80 for static sites.</span>
        </div>
        <div className="field">
          <label htmlFor="healthPath">Health path</label>
          <input
            id="healthPath"
            value={healthPath}
            onChange={(e) => setHealthPath(e.target.value)}
            required
          />
          <span className="hint">Any response under HTTP 500 counts as healthy.</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="dockerfilePath">Dockerfile path (optional)</label>
        <input
          id="dockerfilePath"
          value={dockerfilePath}
          onChange={(e) => setDockerfilePath(e.target.value)}
          placeholder="leave blank to detect or generate one"
        />
      </div>

      <div className="field">
        <label htmlFor="env">Environment</label>
        <textarea
          id="env"
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={'NODE_ENV=production\nAPI_URL=https://example.com'}
        />
        <span className="hint">One KEY=value per line. Stored unencrypted for now.</span>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={deployNow} onChange={(e) => setDeployNow(e.target.checked)} />
        Deploy immediately
      </label>

      <div className="actions">
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create site'}
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  )
}
