import { config } from '../config.js'
import { cf } from './client.js'

export interface DnsRecord {
  id: string
  name: string
  type: string
  content: string
  proxied: boolean
}

/** Every tunnel-routed hostname is a CNAME to this synthetic origin. */
export function tunnelTarget(): string {
  return `${config.cloudflare.tunnelId}.cfargotunnel.com`
}

export async function findRecord(fqdn: string): Promise<DnsRecord | null> {
  const records = await cf<DnsRecord[]>(
    `/zones/${config.cloudflare.zoneId}/dns_records?name=${encodeURIComponent(fqdn)}`,
  )
  return records[0] ?? null
}

export async function createTunnelCname(fqdn: string): Promise<DnsRecord> {
  return cf<DnsRecord>(`/zones/${config.cloudflare.zoneId}/dns_records`, {
    method: 'POST',
    body: {
      type: 'CNAME',
      name: fqdn,
      content: tunnelTarget(),
      // Proxied is required: an unproxied CNAME to cfargotunnel.com does not resolve.
      proxied: true,
      ttl: 1,
      comment: 'managed by site-deployer',
    },
  })
}

export async function deleteRecord(id: string): Promise<void> {
  await cf(`/zones/${config.cloudflare.zoneId}/dns_records/${id}`, { method: 'DELETE' })
}

/**
 * Makes sure `fqdn` is a proxied CNAME at our tunnel.
 *
 * `adopted` means the record already existed and already pointed at this tunnel,
 * so teardown must not delete it - we did not create it and something else may
 * depend on it. A record pointing somewhere else is a hard error rather than a
 * silent overwrite.
 */
export async function ensureTunnelCname(
  fqdn: string,
): Promise<{ record: DnsRecord; created: boolean; adopted: boolean }> {
  const existing = await findRecord(fqdn)
  if (!existing) {
    return { record: await createTunnelCname(fqdn), created: true, adopted: false }
  }

  const target = tunnelTarget()
  if (existing.type !== 'CNAME' || existing.content !== target) {
    throw new Error(
      `DNS record ${fqdn} already exists as ${existing.type} -> ${existing.content}, expected CNAME -> ${target}. ` +
        'Refusing to overwrite it; delete it in Cloudflare or pick another subdomain.',
    )
  }

  return { record: existing, created: false, adopted: true }
}
