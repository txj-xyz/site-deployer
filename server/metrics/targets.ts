import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { cloudflareEnabled, config } from '../config.js'
import { db } from '../db/index.js'
import { deployments, sites } from '../db/schema.js'

export interface TargetGroup {
  targets: string[]
  labels: Record<string, string>
}

const FILE_NAME = 'sites.json'

/**
 * Builds the blackbox probe target list.
 *
 * Every running site gets an `internal` target addressing its container directly,
 * which works whether or not Cloudflare is configured and measures the site
 * rather than the path to it. Sites with a published hostname also get a `public`
 * target, so a working container behind a broken tunnel is distinguishable from
 * a broken container.
 */
export function buildTargets(): TargetGroup[] {
  const groups: TargetGroup[] = []

  for (const site of db.select().from(sites).all()) {
    if (site.desiredState !== 'running' || !site.currentDeploymentId) continue

    const deployment = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, site.currentDeploymentId))
      .get()
    if (!deployment || deployment.status !== 'live' || !deployment.containerName) continue

    const path = site.healthPath.startsWith('/') ? site.healthPath : `/${site.healthPath}`

    groups.push({
      targets: [`http://${deployment.containerName}:${site.containerPort}${path}`],
      labels: { site: site.name, scope: 'internal' },
    })

    if (cloudflareEnabled && site.hostname) {
      groups.push({
        targets: [`https://${site.hostname}${path}`],
        labels: { site: site.name, scope: 'public' },
      })
    }
  }

  return groups
}

/**
 * Writes the target file atomically. Prometheus polls this path, and a partial
 * read of a half-written file would drop every probe for that interval, so the
 * content lands under a temporary name and is renamed into place.
 */
export function writeTargets(): { path: string; groups: number } {
  mkdirSync(config.prometheusTargetsDir, { recursive: true })
  const path = join(config.prometheusTargetsDir, FILE_NAME)
  const tmp = `${path}.tmp`
  const groups = buildTargets()

  writeFileSync(tmp, `${JSON.stringify(groups, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)

  return { path, groups: groups.length }
}

let timer: NodeJS.Timeout | null = null
let lastSerialized = ''

/**
 * Rewrites the target file on an interval rather than hooking every mutation.
 * Deploys, teardowns and crashes all converge on the same correct file without
 * the deploy path needing to know metrics exist.
 */
export function startTargetWriter(log: (line: string) => void): void {
  if (timer) return

  const tick = () => {
    try {
      const groups = buildTargets()
      const serialized = JSON.stringify(groups)
      if (serialized === lastSerialized) return
      lastSerialized = serialized
      writeTargets()
      log(`probe targets updated: ${groups.length} group(s)`)
    } catch (err) {
      log(`could not write probe targets: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  tick()
  timer = setInterval(tick, config.targetsRefreshMs)
  timer.unref()
}

export function stopTargetWriter(): void {
  if (timer) clearInterval(timer)
  timer = null
}
