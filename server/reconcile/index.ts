import { eq, inArray } from 'drizzle-orm'
import { hostnameFor, originServiceFor, router } from '../cloudflare/router.js'
import { cloudflareEnabled, config, LABELS } from '../config.js'
import { db } from '../db/index.js'
import { deployments, sites, type Site } from '../db/schema.js'
import { createDeploymentRecord, runDeployment } from '../deploy/engine.js'
import { enqueue } from '../deploy/queue.js'
import { docker } from '../docker/client.js'
import { containerState, stopAndRemove } from '../docker/run.js'

export interface Drift {
  kind:
    | 'stale-deployment'
    | 'orphan-container'
    | 'missing-container'
    | 'stopped-container'
    | 'ingress-missing'
    | 'ingress-wrong-origin'
    | 'ingress-unknown'
  detail: string
  repaired: boolean
}

const ACTIVE_STATUSES = ['queued', 'cloning', 'building', 'starting', 'health_check', 'routing'] as const

function activeDeploymentIds(): Set<string> {
  return new Set(
    db
      .select({ siteId: deployments.siteId })
      .from(deployments)
      .where(inArray(deployments.status, [...ACTIVE_STATUSES]))
      .all()
      .map((r) => r.siteId),
  )
}

/**
 * Deployments left mid-flight when the process died. Nothing is driving them any
 * more, so they are marked failed at boot rather than sitting "building" forever.
 * Boot-only: during normal running an active status means a live async task.
 */
export function failStaleDeployments(log: (line: string) => void): number {
  const stale = db
    .select()
    .from(deployments)
    .where(inArray(deployments.status, [...ACTIVE_STATUSES]))
    .all()

  for (const deployment of stale) {
    db.update(deployments)
      .set({
        status: 'failed',
        error: 'the deployer restarted while this deployment was running',
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, deployment.id))
      .run()
  }

  if (stale.length > 0) log(`marked ${stale.length} interrupted deployment(s) as failed`)
  return stale.length
}

/** Containers we own that no site's current deployment claims. */
async function reconcileContainers(busy: Set<string>, log: (line: string) => void): Promise<Drift[]> {
  const drift: Drift[] = []

  const allSites = db.select().from(sites).all()
  const byName = new Map(allSites.map((s) => [s.name, s]))
  const wanted = new Map<string, string>() // container name -> site name
  for (const site of allSites) {
    if (site.desiredState !== 'running' || !site.currentDeploymentId) continue
    const deployment = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, site.currentDeploymentId))
      .get()
    if (deployment?.containerName) wanted.set(deployment.containerName, site.name)
  }

  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABELS.managed}=true`] }),
  })

  for (const info of containers) {
    const name = info.Names?.[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12)
    const siteName = info.Labels?.[LABELS.site]
    if (siteName && busy.has(byName.get(siteName)?.id ?? '')) continue

    if (wanted.has(name)) {
      if (info.State !== 'running') {
        try {
          await docker.getContainer(info.Id).start()
          drift.push({ kind: 'stopped-container', detail: `${name} was not running; started it`, repaired: true })
          log(`restarted ${name}`)
        } catch (err) {
          drift.push({
            kind: 'stopped-container',
            detail: `${name} is not running and could not be started: ${err instanceof Error ? err.message : String(err)}`,
            repaired: false,
          })
        }
      }
      continue
    }

    await stopAndRemove(info.Id)
    drift.push({ kind: 'orphan-container', detail: `removed unclaimed container ${name}`, repaired: true })
    log(`removed orphan container ${name}`)
  }

  return drift
}

/** Sites that should be serving but whose container has vanished. */
async function reconcileMissing(busy: Set<string>, log: (line: string) => void): Promise<Drift[]> {
  const drift: Drift[] = []

  for (const site of db.select().from(sites).all()) {
    if (site.desiredState !== 'running' || !site.currentDeploymentId) continue
    if (busy.has(site.id)) continue

    const deployment = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, site.currentDeploymentId))
      .get()
    if (!deployment || deployment.status !== 'live' || !deployment.containerName) continue

    const state = await containerState(deployment.containerName)
    if (state !== null) continue

    const deploymentId = createDeploymentRecord(site.id, 'reconcile')
    drift.push({
      kind: 'missing-container',
      detail: `${site.name}: container ${deployment.containerName} is gone; redeploying`,
      repaired: true,
    })
    log(`${site.name}: container missing, redeploying`)
    void enqueue(site.id, () => runDeployment(deploymentId)).catch(() => {})
  }

  return drift
}

/** Tunnel ingress compared against what each running site expects. */
async function reconcileIngress(busy: Set<string>, log: (line: string) => void): Promise<Drift[]> {
  if (!cloudflareEnabled) return []

  const drift: Drift[] = []
  const rules = await router.listIngress()
  const byHostname = new Map(rules.filter((r) => r.hostname).map((r) => [r.hostname as string, r]))
  const claimed = new Set<string>()

  for (const site of db.select().from(sites).all()) {
    if (site.desiredState !== 'running' || !site.currentDeploymentId) continue
    if (busy.has(site.id)) continue

    const deployment = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, site.currentDeploymentId))
      .get()
    if (!deployment || deployment.status !== 'live' || !deployment.containerName) continue
    if (deployment.hostPort === null) continue

    const hostname = site.hostname ?? hostnameFor(site)
    claimed.add(hostname)

    const expected = originServiceFor(site as Site, deployment.containerName, deployment.hostPort)
    const actual = byHostname.get(hostname)

    if (!actual) {
      await router.pointAt(hostname, expected, log)
      drift.push({ kind: 'ingress-missing', detail: `added ingress for ${hostname}`, repaired: true })
    } else if (actual.service !== expected) {
      await router.pointAt(hostname, expected, log)
      drift.push({
        kind: 'ingress-wrong-origin',
        detail: `${hostname} pointed at ${actual.service}, expected ${expected}`,
        repaired: true,
      })
    }
  }

  // Rules under our domain that no site claims. These may belong to something
  // else behind the same tunnel, so they are reported and only removed on request.
  const suffix = config.cloudflare.baseDomain ? `.${config.cloudflare.baseDomain}` : null
  if (suffix) {
    for (const rule of rules) {
      const hostname = rule.hostname
      if (!hostname || claimed.has(hostname) || !hostname.endsWith(suffix)) continue

      if (config.reconcilePruneIngress) {
        await router.removeHostname(hostname, log)
        drift.push({ kind: 'ingress-unknown', detail: `removed unclaimed rule ${hostname}`, repaired: true })
      } else {
        drift.push({
          kind: 'ingress-unknown',
          detail: `${hostname} -> ${rule.service} is not claimed by any site (set RECONCILE_PRUNE_INGRESS=true to remove)`,
          repaired: false,
        })
      }
    }
  }

  return drift
}

/**
 * Compares desired state with reality and repairs what it safely can.
 *
 * Sites with a deployment in flight are skipped entirely - mid-deploy there are
 * legitimately two containers and a moving ingress rule, and "repairing" that
 * would fight the deploy saga.
 */
export async function reconcile(log: (line: string) => void): Promise<Drift[]> {
  const busy = activeDeploymentIds()
  const drift: Drift[] = []

  for (const step of [reconcileContainers, reconcileMissing, reconcileIngress]) {
    try {
      drift.push(...(await step(busy, log)))
    } catch (err) {
      log(`reconcile step failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return drift
}

let timer: NodeJS.Timeout | null = null
let running = false

export function startReconciler(log: (line: string) => void): boolean {
  if (config.reconcileIntervalMs <= 0) return false
  if (timer) return true

  timer = setInterval(() => {
    if (running) return
    running = true
    void reconcile(log)
      .then((drift) => {
        if (drift.length > 0) log(`reconciled ${drift.length} difference(s)`)
      })
      .catch((err) => log(`reconcile failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = false
      })
  }, config.reconcileIntervalMs)
  timer.unref()
  return true
}

export function stopReconciler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
