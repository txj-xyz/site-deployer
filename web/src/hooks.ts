import { useCallback, useEffect, useRef, useState } from 'react'
import { ACTIVE_STATUSES, type DeployStatus } from './api'

/**
 * Polls `fetcher` on an interval. Returns the last successful value, so a
 * transient failure leaves the UI showing stale data with an error beside it
 * rather than blanking the page.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const value = await fetcherRef.current()
        if (cancelled) return
        setData(value)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    if (intervalMs <= 0) return () => { cancelled = true }

    const timer = setInterval(load, intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps])

  return { data, error, loading, refresh }
}

export interface LogLine {
  id: number
  ts: number
  stream: 'build' | 'system' | 'container'
  line: string
}

/**
 * Streams a deployment's log over SSE.
 *
 * The server replays stored lines before streaming new ones, and closes the
 * stream itself once the deployment is terminal. EventSource would otherwise
 * reconnect forever on that close, so the `status` event is the signal to stop.
 */
export function useDeploymentLogs(deploymentId: string | null): {
  lines: LogLine[]
  status: DeployStatus | null
  connected: boolean
} {
  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<DeployStatus | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    setLines([])
    setStatus(null)
    setConnected(false)
    if (!deploymentId) return

    const source = new EventSource(`/api/deployments/${deploymentId}/logs`)
    let closed = false

    const close = () => {
      if (closed) return
      closed = true
      source.close()
      setConnected(false)
    }

    source.onopen = () => setConnected(true)

    source.addEventListener('log', (event) => {
      const line = JSON.parse((event as MessageEvent<string>).data) as LogLine
      setLines((prev) => (prev.some((l) => l.id === line.id) ? prev : [...prev, line]))
    })

    source.addEventListener('status', (event) => {
      const { status: next } = JSON.parse((event as MessageEvent<string>).data) as { status: DeployStatus }
      setStatus(next)
      close()
    })

    source.onerror = () => {
      // Browsers fire onerror both for a genuine failure and for the clean close
      // the server performs at the end. Only the former should keep retrying.
      if (source.readyState === EventSource.CLOSED) close()
    }

    return close
  }, [deploymentId])

  return { lines, status, connected }
}

export function isActive(status: DeployStatus | null | undefined): boolean {
  return status ? ACTIVE_STATUSES.includes(status) : false
}

/** Minimal hash router: `#/` and `#/sites/:id`. Avoids a routing dependency. */
export function useHashRoute(): { path: string; navigate: (to: string) => void } {
  const [path, setPath] = useState(() => window.location.hash.slice(1) || '/')

  useEffect(() => {
    const onChange = () => setPath(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((to: string) => {
    window.location.hash = to
  }, [])

  return { path, navigate }
}
