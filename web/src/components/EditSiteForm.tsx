import { useState } from 'react'
import { ApiError, api, type Site, type UpdateSiteInput } from '../api'
import { parseEnv } from './NewSiteForm'
import { DiscordEmbedField, type EmbedDraft } from './DiscordEmbedField'
import type { JSX } from 'react'

interface Props {
  site: Site
  cloudflareEnabled: boolean
  onSaved: (deploymentId: string | null) => void
  onCancel: () => void
}

/**
 * Edits a site in place. Only fields that differ from the loaded site are sent,
 * and env values are never shown: an existing key is kept unless a new value is
 * typed or it is marked for removal. Changes take effect on the next deploy.
 */
export function EditSiteForm({ site, cloudflareEnabled, onSaved, onCancel }: Props): JSX.Element {
  const [subdomain, setSubdomain] = useState(site.subdomain)
  const [sourceType, setSourceType] = useState(site.sourceType)
  const [repoUrl, setRepoUrl] = useState(site.repoUrl ?? '')
  const [branch, setBranch] = useState(site.branch)
  const [localPath, setLocalPath] = useState(site.localPath ?? '')
  const [dockerfilePath, setDockerfilePath] = useState(site.dockerfilePath ?? '')
  const [containerPort, setContainerPort] = useState(site.containerPort)
  const [healthPath, setHealthPath] = useState(site.healthPath)
  const [autoDeploy, setAutoDeploy] = useState(site.autoDeploy)
  const [embedEnabled, setEmbedEnabled] = useState(site.discordEmbedEnabled)
  const [embed, setEmbed] = useState<EmbedDraft | null>(site.discordEmbed)

  const existingKeys = Object.keys(site.env)
  const [replaced, setReplaced] = useState<Record<string, string>>({})
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [addText, setAddText] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const buildPatch = (): UpdateSiteInput | string => {
    const patch: UpdateSiteInput = {}
    if (subdomain !== site.subdomain) patch.subdomain = subdomain
    if (sourceType !== site.sourceType) patch.sourceType = sourceType
    if (sourceType === 'git') {
      if (repoUrl !== (site.repoUrl ?? '')) patch.repoUrl = repoUrl || null
      if (branch !== site.branch) patch.branch = branch
      if (autoDeploy !== site.autoDeploy) patch.autoDeploy = autoDeploy
    } else if (localPath !== (site.localPath ?? '')) {
      patch.localPath = localPath || null
    }
    if (dockerfilePath !== (site.dockerfilePath ?? '')) patch.dockerfilePath = dockerfilePath || null
    if (containerPort !== site.containerPort) patch.containerPort = containerPort
    if (healthPath !== site.healthPath) patch.healthPath = healthPath

    if (embedEnabled !== site.discordEmbedEnabled) patch.discordEmbedEnabled = embedEnabled
    if (embedEnabled && embed !== null) {
      if (typeof embed === 'string') return embed
      if (JSON.stringify(embed) !== JSON.stringify(site.discordEmbed)) patch.discordEmbed = embed
    }

    const { env: added, bad } = parseEnv(addText)
    if (bad.length > 0) return `New variables must be KEY=value: ${bad.join(', ')}`

    const env: Record<string, string | null> = {}
    for (const key of removed) env[key] = null
    for (const [key, value] of Object.entries(replaced)) {
      if (value !== '' && !removed.has(key)) env[key] = value
    }
    Object.assign(env, added)
    if (Object.keys(env).length > 0) patch.env = env

    return patch
  }

  const save = async (deploy: boolean) => {
    setError(null)
    const patch = buildPatch()
    if (typeof patch === 'string') {
      setError(patch)
      return
    }
    if (Object.keys(patch).length === 0 && !deploy) {
      onCancel()
      return
    }

    setSaving(true)
    try {
      const res = await api.updateSite(site.id, { ...patch, deploy })
      onSaved(res.deploymentId)
    } catch (err) {
      if (err instanceof ApiError && err.issues) {
        const issues = err.issues as { path?: (string | number)[]; message: string }[]
        setError(issues.map((i) => `${i.path?.join('.') ?? 'input'}: ${i.message}`).join('; '))
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSaving(false)
    }
  }

  const toggleRemoved = (key: string) => {
    setRemoved((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        void save(true)
      }}
    >
      {error && (
        <div className="notice error">
          <strong>Could not save</strong>
          {error}
        </div>
      )}

      <div className="field">
        <label htmlFor="edit-subdomain">Subdomain</label>
        <input
          id="edit-subdomain"
          value={subdomain}
          onChange={(e) => setSubdomain(e.target.value)}
          required
        />
        {cloudflareEnabled && subdomain !== site.subdomain && site.hostname && (
          <span className="hint">
            {site.hostname} keeps serving until the next deploy goes live, then its route is removed.
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="edit-sourceType">Source</label>
        <select
          id="edit-sourceType"
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as 'git' | 'local')}
        >
          <option value="git">Git repository</option>
          <option value="local">Local path on the server</option>
        </select>
      </div>

      {sourceType === 'git' ? (
        <>
          <div className="row">
            <div className="field">
              <label htmlFor="edit-repoUrl">Repository URL</label>
              <input id="edit-repoUrl" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="edit-branch">Branch</label>
              <input id="edit-branch" value={branch} onChange={(e) => setBranch(e.target.value)} required />
            </div>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={autoDeploy} onChange={(e) => setAutoDeploy(e.target.checked)} />
            Deploy automatically when the branch changes
          </label>
        </>
      ) : (
        <div className="field">
          <label htmlFor="edit-localPath">Path</label>
          <input id="edit-localPath" value={localPath} onChange={(e) => setLocalPath(e.target.value)} required />
          <span className="hint">Must exist on the machine running the deployer.</span>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor="edit-containerPort">Container port</label>
          <input
            id="edit-containerPort"
            type="number"
            min={1}
            max={65535}
            value={containerPort}
            onChange={(e) => setContainerPort(Number(e.target.value))}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="edit-healthPath">Health path</label>
          <input id="edit-healthPath" value={healthPath} onChange={(e) => setHealthPath(e.target.value)} required />
        </div>
      </div>

      <div className="field">
        <label htmlFor="edit-dockerfilePath">Dockerfile path (optional)</label>
        <input
          id="edit-dockerfilePath"
          value={dockerfilePath}
          onChange={(e) => setDockerfilePath(e.target.value)}
          placeholder="leave blank to detect or generate one"
        />
      </div>

      <DiscordEmbedField
        enabled={embedEnabled}
        value={embed}
        siteUrl={site.hostname ? `https://${site.hostname}` : 'https://example.com'}
        onEnabledChange={setEmbedEnabled}
        onChange={setEmbed}
      />

      {existingKeys.length > 0 && (
        <div className="field">
          <label>Environment</label>
          {existingKeys.map((key) => (
            <div key={key} className={`env-row ${removed.has(key) ? 'removed' : ''}`}>
              <code>{key}</code>
              <input
                aria-label={`New value for ${key}`}
                value={replaced[key] ?? ''}
                onChange={(e) => setReplaced((prev) => ({ ...prev, [key]: e.target.value }))}
                placeholder="unchanged"
                disabled={removed.has(key)}
              />
              <button type="button" className="ghost danger" onClick={() => toggleRemoved(key)}>
                {removed.has(key) ? 'Keep' : 'Remove'}
              </button>
            </div>
          ))}
          <span className="hint">Current values are never shown. Type a value to replace one.</span>
        </div>
      )}

      <div className="field">
        <label htmlFor="edit-env-add">{existingKeys.length > 0 ? 'Add variables' : 'Environment'}</label>
        <textarea
          id="edit-env-add"
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          placeholder={'NODE_ENV=production\nAPI_URL=https://example.com'}
        />
        <span className="hint">One KEY=value per line. A key that already exists is replaced.</span>
      </div>

      <div className="actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save and redeploy'}
        </button>
        <button type="button" disabled={saving} onClick={() => void save(false)}>
          Save only
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      <span className="hint dim" style={{ fontSize: 11 }}>
        Saved changes apply on the next deploy.
      </span>
    </form>
  )
}
