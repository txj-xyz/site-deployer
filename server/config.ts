import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * Load .env before anything reads a variable.
 *
 * This has to happen here rather than in the entrypoint: ESM imports are
 * evaluated before the importing module's body runs, so by the time index.ts
 * executes a line, this module has already computed `config`. Every other module
 * reads env through here, so this is the one place that is guaranteed to be
 * first.
 *
 * Real environment variables win over the file, which is what you want when
 * overriding a single setting for one run.
 */
const envFile = resolve(process.env.ENV_FILE ?? '.env')
if (existsSync(envFile)) {
  process.loadEnvFile(envFile)
}
export const envFileLoaded = existsSync(envFile) ? envFile : null

function str(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback
  if (v === undefined) throw new Error(`Missing required env var ${key}`)
  return v
}

/** Returns undefined for unset or empty vars, so placeholders can be left blank. */
function optional(key: string): string | undefined {
  const v = process.env[key]
  return v === undefined || v.trim() === '' ? undefined : v.trim()
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

function num(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  const v = Number(raw)
  if (!Number.isFinite(v)) throw new Error(`Env var ${key} must be a number, got ${raw}`)
  return v
}

const dataDir = resolve(str('DATA_DIR', './data'))

export const config = {
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),

  dataDir,
  dbPath: join(dataDir, 'site-deployer.db'),
  workspacesDir: join(dataDir, 'workspaces'),

  dockerNetwork: str('DOCKER_NETWORK', 'site-deployer'),
  imagePrefix: str('IMAGE_PREFIX', 'sitedeployer'),
  /**
   * Host interface the per-deployment port is published on. Loopback in
   * production (nothing reachable from the LAN); set to 0.0.0.0 only when the
   * deployer runs somewhere other than the Docker host, e.g. local development
   * against a remote server.
   */
  publishHostIp: str('PUBLISH_HOST_IP', '127.0.0.1'),
  /** Host the health check dials. Matches publishHostIp unless Docker is remote. */
  probeHost: str('PROBE_HOST', '127.0.0.1'),

  hostPortMin: num('HOST_PORT_MIN', 40000),
  hostPortMax: num('HOST_PORT_MAX', 49999),
  keepImagesPerSite: num('KEEP_IMAGES_PER_SITE', 3),

  healthTimeoutMs: num('HEALTH_TIMEOUT_MS', 60_000),
  healthIntervalMs: num('HEALTH_INTERVAL_MS', 1_000),

  /**
   * How a tunnel ingress rule addresses a site.
   *  container - http://<container-name>:<containerPort>, requires cloudflared to
   *              be attached to DOCKER_NETWORK. Preferred: the container name
   *              changes per deployment, so flipping ingress IS the traffic swap.
   *  hostport  - http://<TUNNEL_ORIGIN_HOST>:<hostPort>, for a cloudflared that
   *              lives outside our network or runs on the host directly.
   */
  originMode: str('ORIGIN_MODE', 'container') as 'container' | 'hostport',
  tunnelOriginHost: str('TUNNEL_ORIGIN_HOST', 'host.docker.internal'),

  prometheusUrl: str('PROMETHEUS_URL', 'http://localhost:9090'),
  /**
   * Directory of Prometheus file_sd target files that the deployer owns. Mounted
   * read-only into the Prometheus container; file_sd re-reads it on change, so
   * adding or removing a site needs no reload.
   */
  prometheusTargetsDir: str('PROMETHEUS_TARGETS_DIR', join(dataDir, 'prometheus-targets')),
  targetsRefreshMs: num('TARGETS_REFRESH_MS', 15_000),

  /** How often a git-backed site is checked for new commits. 0 disables polling. */
  gitPollIntervalMs: num('GIT_POLL_INTERVAL_MS', 60_000),
  /** How many repos are checked at once per tick. */
  gitPollConcurrency: num('GIT_POLL_CONCURRENCY', 3),

  /** Shared secret for the dashboard when Cloudflare Access is not in front of it. */
  dashboardToken: optional('DASHBOARD_TOKEN'),
  access: {
    /** e.g. yourteam.cloudflareaccess.com */
    teamDomain: optional('ACCESS_TEAM_DOMAIN'),
    /** The Access application's Audience tag. */
    aud: optional('ACCESS_AUD'),
  },

  /** How often desired state is compared with Docker and Cloudflare. 0 disables. */
  reconcileIntervalMs: num('RECONCILE_INTERVAL_MS', 120_000),
  /**
   * Whether the reconciler may delete tunnel ingress rules under BASE_DOMAIN that
   * no site claims. Off by default: those rules may belong to something else you
   * run through the same tunnel.
   */
  reconcilePruneIngress: bool('RECONCILE_PRUNE_INGRESS', false),

  cloudflare: {
    apiBase: str('CLOUDFLARE_API_BASE', 'https://api.cloudflare.com/client/v4'),
    apiToken: optional('CLOUDFLARE_API_TOKEN'),
    accountId: optional('CLOUDFLARE_ACCOUNT_ID'),
    zoneId: optional('CLOUDFLARE_ZONE_ID'),
    tunnelId: optional('CLOUDFLARE_TUNNEL_ID'),
    baseDomain: optional('BASE_DOMAIN'),
  },
} as const

/**
 * Cloudflare calls are skipped, and logged instead, unless every credential is
 * present. Lets the deploy path run end to end without an account.
 */
export const cloudflareEnabled: boolean = Boolean(
  config.cloudflare.apiToken &&
    config.cloudflare.accountId &&
    config.cloudflare.zoneId &&
    config.cloudflare.tunnelId &&
    config.cloudflare.baseDomain,
)

export function missingCloudflareVars(): string[] {
  const required = {
    CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken,
    CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId,
    CLOUDFLARE_ZONE_ID: config.cloudflare.zoneId,
    CLOUDFLARE_TUNNEL_ID: config.cloudflare.tunnelId,
    BASE_DOMAIN: config.cloudflare.baseDomain,
  }
  return Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k)
}

/** Labels stamped on every container we create, so the reconciler can find our own work. */
export const LABELS = {
  managed: 'sitedeployer.managed',
  site: 'sitedeployer.site',
  siteId: 'sitedeployer.site-id',
  deployment: 'sitedeployer.deployment',
} as const
