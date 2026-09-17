export type DeployStatus =
  | 'queued'
  | 'cloning'
  | 'building'
  | 'starting'
  | 'health_check'
  | 'routing'
  | 'live'
  | 'failed'
  | 'cancelled'
  | 'superseded'

export const ACTIVE_STATUSES: DeployStatus[] = [
  'queued',
  'cloning',
  'building',
  'starting',
  'health_check',
  'routing',
]

export interface Deployment {
  id: string
  siteId: string
  status: DeployStatus
  trigger: 'manual' | 'git' | 'reconcile'
  commitSha: string | null
  imageTag: string | null
  containerId: string | null
  containerName: string | null
  hostPort: number | null
  originService: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface Site {
  id: string
  name: string
  subdomain: string
  sourceType: 'git' | 'local'
  repoUrl: string | null
  branch: string
  localPath: string | null
  dockerfilePath: string | null
  containerPort: number
  healthPath: string
  env: Record<string, string>
  buildArgs: Record<string, string>
  autoDeploy: boolean
  desiredState: 'running' | 'stopped'
  currentDeploymentId: string | null
  hostname: string | null
  dnsRecordId: string | null
  dnsRecordOwned: boolean
  lastPolledAt: string | null
  nextPollAt: string | null
  lastSeenSha: string | null
  lastAttemptedSha: string | null
  pollError: string | null
  pollFailures: number
  createdAt: string
  updatedAt: string
}

export interface SiteWithCurrent extends Site {
  currentDeployment: Deployment | null
}

export interface SiteDetail extends Site {
  deployments: Deployment[]
}

export type PollOutcome =
  | { action: 'deployed'; sha: string; deploymentId: string }
  | { action: 'up-to-date'; sha: string }
  | { action: 'already-attempted'; sha: string }
  | { action: 'busy' }
  | { action: 'skipped'; reason: string }
  | { action: 'error'; message: string }

export type MetricPoint = [number, number | null]

export interface MetricsResponse {
  enabled: boolean
  error?: string
  window: string
  step: number
  series: Record<string, MetricPoint[]>
  summary: {
    availability: number | null
    avgLatency: number | null
    bytesIn: number | null
    bytesOut: number | null
    cpu: number | null
    memory: number | null
  }
}

export interface RouterStatus {
  enabled: boolean
  missing: string[]
  originMode: string
}

export interface RoutesReport extends RouterStatus {
  intended?: { site: string; hostname: string; service: string | null }[]
  live?: { hostname?: string; service: string }[]
  error?: string
}

export interface Health {
  ok: boolean
  docker: string | { error: string }
  network: string
  cloudflare: RouterStatus
  auth: 'cloudflare-access' | 'token' | 'none'
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let unauthorizedHandler: (() => void) | null = null

/** Lets the app show a login prompt from anywhere a 401 surfaces. */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  })

  if (res.status === 204) return undefined as T

  const text = await res.text()
  const body = text ? (JSON.parse(text) as unknown) : null

  if (!res.ok) {
    const err = body as { error?: string; issues?: unknown } | null
    if (res.status === 401 && !path.endsWith('/login')) unauthorizedHandler?.()
    throw new ApiError(res.status, err?.error ?? `HTTP ${res.status}`, err?.issues)
  }
  return body as T
}

export interface CreateSiteInput {
  name: string
  subdomain?: string
  sourceType: 'git' | 'local'
  repoUrl?: string
  branch?: string
  localPath?: string
  dockerfilePath?: string
  containerPort?: number
  healthPath?: string
  env?: Record<string, string>
  autoDeploy?: boolean
  deployNow?: boolean
}

export const api = {
  health: () => request<Health>('/api/health'),
  login: (token: string) =>
    request<{ ok: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ token }) }),
  listSites: () => request<SiteWithCurrent[]>('/api/sites'),
  getSite: (id: string) => request<SiteDetail>(`/api/sites/${id}`),
  createSite: (input: CreateSiteInput) =>
    request<Site & { deploymentId: string | null }>('/api/sites', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deploySite: (id: string) =>
    request<{ deploymentId: string }>(`/api/sites/${id}/deploy`, { method: 'POST' }),
  checkSite: (id: string) =>
    request<{ site: string; outcome: PollOutcome }>(`/api/sites/${id}/check`, { method: 'POST' }),
  stopSite: (id: string) => request<{ stopped: boolean }>(`/api/sites/${id}/stop`, { method: 'POST' }),
  deleteSite: (id: string) => request<void>(`/api/sites/${id}`, { method: 'DELETE' }),
  getDeployment: (id: string) => request<Deployment>(`/api/deployments/${id}`),
  routes: () => request<RoutesReport>('/api/routes'),
  siteMetrics: (id: string, window: string, scope: 'internal' | 'public') =>
    request<MetricsResponse>(`/api/sites/${id}/metrics?window=${window}&scope=${scope}`),
}
