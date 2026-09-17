import { useState } from 'react'
import type { FormEvent, JSX } from 'react'
import { api } from '../api'

/**
 * Shown when the API answers 401 in token mode. Under Cloudflare Access this
 * never appears - Access challenges at the edge, long before a request reaches us.
 */
export function LoginGate({ onAuthenticated }: { onAuthenticated: () => void }): JSX.Element {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(token)
      onAuthenticated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate">
      <form className="card gate-card" onSubmit={submit}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Sign in</h2>
        <p className="dim" style={{ margin: '0 0 14px', fontSize: 13 }}>
          Enter the dashboard token from <code>DASHBOARD_TOKEN</code>.
        </p>

        {error && (
          <div className="notice error">
            <strong>Could not sign in</strong>
            {error}
          </div>
        )}

        <div className="field">
          <label htmlFor="token">Token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div className="actions">
          <button className="primary" type="submit" disabled={busy || token === ''}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  )
}
