import { cloudflareEnabled, config, missingCloudflareVars } from '../config.js'
import type { Site } from '../db/schema.js'
import { deleteRecord, ensureTunnelCname, findRecord } from './dns.js'
import { getTunnelConfig, mutateIngress, putTunnelConfig, removeRule, upsertRule, type IngressRule } from './tunnel.js'

export type Log = (line: string) => void

export interface DnsResult {
  recordId: string | null
  /** True only when we created the record, which is what makes it ours to delete. */
  created: boolean
}

export interface Router {
  readonly enabled: boolean
  ensureDns(site: Site, log: Log): Promise<DnsResult>
  removeDns(fqdn: string, recordId: string | null, log: Log): Promise<void>
  /** Points `hostname` at `service`, returning the ingress list as it was before. */
  pointAt(hostname: string, service: string, log: Log): Promise<IngressRule[]>
  removeHostname(hostname: string, log: Log): Promise<void>
  restoreIngress(before: IngressRule[], log: Log): Promise<void>
  listIngress(): Promise<IngressRule[]>
}

export function hostnameFor(site: Site): string {
  return `${site.subdomain}.${config.cloudflare.baseDomain ?? '<BASE_DOMAIN>'}`
}

/**
 * The origin a tunnel ingress rule sends traffic to. In container mode this
 * embeds the per-deployment container name, so replacing the rule is precisely
 * the cutover from old deployment to new.
 */
export function originServiceFor(site: Site, containerName: string, hostPort: number): string {
  return config.originMode === 'hostport'
    ? `http://${config.tunnelOriginHost}:${hostPort}`
    : `http://${containerName}:${site.containerPort}`
}

class CloudflareRouter implements Router {
  readonly enabled = true

  async ensureDns(site: Site, log: Log): Promise<DnsResult> {
    const fqdn = hostnameFor(site)
    const { record, created } = await ensureTunnelCname(fqdn)
    log(created ? `created DNS CNAME ${fqdn} -> tunnel` : `DNS CNAME ${fqdn} already present`)
    return { recordId: record.id, created }
  }

  async removeDns(fqdn: string, recordId: string | null, log: Log): Promise<void> {
    const id = recordId ?? (await findRecord(fqdn))?.id
    if (!id) {
      log(`no DNS record for ${fqdn} to remove`)
      return
    }
    await deleteRecord(id)
    log(`deleted DNS record ${fqdn}`)
  }

  async pointAt(hostname: string, service: string, log: Log): Promise<IngressRule[]> {
    const { before } = await mutateIngress((rules) => upsertRule(rules, { hostname, service }))
    log(`tunnel ingress: ${hostname} -> ${service}`)
    return before
  }

  async removeHostname(hostname: string, log: Log): Promise<void> {
    await mutateIngress((rules) => removeRule(rules, hostname))
    log(`removed tunnel ingress for ${hostname}`)
  }

  async restoreIngress(before: IngressRule[], log: Log): Promise<void> {
    const current = await getTunnelConfig()
    await putTunnelConfig({ ...current, ingress: before })
    log('rolled back: tunnel ingress restored')
  }

  async listIngress(): Promise<IngressRule[]> {
    return (await getTunnelConfig()).ingress
  }
}

/**
 * Stand-in used when Cloudflare credentials are absent. Every call logs the
 * request it would have made and succeeds, so deploys work end to end against a
 * local Docker host with no Cloudflare account attached.
 */
class PlanOnlyRouter implements Router {
  readonly enabled = false

  private plan(log: Log, line: string): void {
    log(`[cloudflare: plan only] ${line}`)
  }

  async ensureDns(site: Site, log: Log): Promise<DnsResult> {
    this.plan(log, `POST /zones/<ZONE_ID>/dns_records  CNAME ${hostnameFor(site)} -> <TUNNEL_ID>.cfargotunnel.com (proxied)`)
    return { recordId: null, created: false }
  }

  async removeDns(fqdn: string, recordId: string | null, log: Log): Promise<void> {
    this.plan(log, `DELETE /zones/<ZONE_ID>/dns_records/${recordId ?? `<id of ${fqdn}>`}`)
  }

  async pointAt(hostname: string, service: string, log: Log): Promise<IngressRule[]> {
    this.plan(log, `PUT tunnel configurations  ingress += { hostname: ${hostname}, service: ${service} }`)
    return []
  }

  async removeHostname(hostname: string, log: Log): Promise<void> {
    this.plan(log, `PUT tunnel configurations  ingress -= { hostname: ${hostname} }`)
  }

  async restoreIngress(_before: IngressRule[], log: Log): Promise<void> {
    this.plan(log, 'PUT tunnel configurations  (restore previous ingress)')
  }

  async listIngress(): Promise<IngressRule[]> {
    return []
  }
}

export const router: Router = cloudflareEnabled ? new CloudflareRouter() : new PlanOnlyRouter()

export function routerStatus(): { enabled: boolean; missing: string[]; originMode: string } {
  return { enabled: cloudflareEnabled, missing: missingCloudflareVars(), originMode: config.originMode }
}
