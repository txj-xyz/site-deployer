import { config } from '../config.js'
import { enqueue } from '../deploy/queue.js'
import { cf } from './client.js'

export interface IngressRule {
  hostname?: string
  path?: string
  service: string
  originRequest?: Record<string, unknown>
}

export interface TunnelConfig {
  ingress: IngressRule[]
  'warp-routing'?: { enabled: boolean }
  originRequest?: Record<string, unknown>
}

interface ConfigurationResponse {
  tunnel_id: string
  version: number
  config: TunnelConfig | null
}

/** cloudflared requires the last rule to be a catch-all with no hostname. */
const CATCH_ALL: IngressRule = { service: 'http_status:404' }

function configPath(): string {
  return `/accounts/${config.cloudflare.accountId}/cfd_tunnel/${config.cloudflare.tunnelId}/configurations`
}

export async function getTunnelConfig(): Promise<TunnelConfig> {
  const res = await cf<ConfigurationResponse>(configPath())
  const ingress = res.config?.ingress ?? []
  return { ...res.config, ingress: ingress.length > 0 ? ingress : [CATCH_ALL] }
}

export async function putTunnelConfig(next: TunnelConfig): Promise<void> {
  await cf(configPath(), { method: 'PUT', body: { config: normalize(next) } })
}

/** Guarantees exactly one catch-all, in last position. */
function normalize(cfg: TunnelConfig): TunnelConfig {
  const specific = cfg.ingress.filter((r) => r.hostname)
  const existingCatchAll = cfg.ingress.find((r) => !r.hostname)
  return { ...cfg, ingress: [...specific, existingCatchAll ?? CATCH_ALL] }
}

/**
 * Read-modify-write of the tunnel's ingress list.
 *
 * The whole list is one document, so every mutation serializes through a single
 * in-process lock. That is sufficient because this service is assumed to be the
 * only writer - the API has no compare-and-swap, so a second writer (you, in the
 * Cloudflare dashboard, mid-deploy) can still lose an update.
 */
export function mutateIngress(
  mutate: (rules: IngressRule[]) => IngressRule[],
): Promise<{ before: IngressRule[]; after: IngressRule[] }> {
  return enqueue('cloudflare:ingress', async () => {
    const current = await getTunnelConfig()
    const before = current.ingress
    const after = normalize({ ...current, ingress: mutate([...before]) }).ingress
    await putTunnelConfig({ ...current, ingress: after })
    return { before, after }
  })
}

export function upsertRule(rules: IngressRule[], rule: IngressRule): IngressRule[] {
  const without = rules.filter((r) => r.hostname !== rule.hostname)
  return [...without.filter((r) => r.hostname), rule, ...without.filter((r) => !r.hostname)]
}

export function removeRule(rules: IngressRule[], hostname: string): IngressRule[] {
  return rules.filter((r) => r.hostname !== hostname)
}

export { CATCH_ALL }
