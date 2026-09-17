import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { config, LABELS } from '../config.js'
import { db } from '../db/index.js'
import { deployments, sites, type DeployStatus, type Deployment, type Site } from '../db/schema.js'
import { buildImage, imageTag } from '../docker/build.js'
import { docker } from '../docker/client.js'
import { detectBuild } from '../docker/detect.js'
import { createAndStart, pruneSiteImages, stopAndRemove, waitForHealthy } from '../docker/run.js'
import { hostnameFor, originServiceFor, router } from '../cloudflare/router.js'
import type { IngressRule } from '../cloudflare/tunnel.js'
import { resolveSource } from '../git/source.js'
import { openEnv } from '../secrets/crypto.js'
import { appendLog, flushLogs } from '../logs/bus.js'
import { allocateHostPort } from '../util/ports.js'
import { runSaga, SagaError, type SagaStep } from '../util/saga.js'

interface Ctx {
  site: Site
  deploymentId: string
  log: (line: string) => void

  sourceDir?: string
  commitSha?: string | null
  dockerfile?: string
  tag?: string
  hostPort?: number
  containerId?: string
  containerName?: string

  hostname?: string
  originService?: string
  dnsCreated?: boolean
  dnsRecordId?: string | null
  /** Ingress list as it was before we edited it, for rollback. */
  ingressBefore?: IngressRule[]

  previousDeploymentId?: string | null
  /** Set once promote has pointed the site at the new deployment. */
  promoted?: boolean
}

/** Updates deployment fields without touching its status. */
function patchDeployment(deploymentId: string, patch: Partial<Deployment>): void {
  db.update(deployments).set(patch).where(eq(deployments.id, deploymentId)).run()
}

function setStatus(deploymentId: string, status: DeployStatus, patch: Partial<Deployment> = {}): void {
  db.update(deployments)
    .set({ status, ...patch })
    .where(eq(deployments.id, deploymentId))
    .run()
}

const STEP_STATUS: Record<string, DeployStatus> = {
  'resolve-source': 'cloning',
  'build-image': 'building',
  'start-container': 'starting',
  'health-check': 'health_check',
  'ensure-dns': 'routing',
  'route-ingress': 'routing',
}

const steps: SagaStep<Ctx>[] = [
  {
    name: 'resolve-source',
    run: async (ctx) => {
      const { dir, sha } = await resolveSource(ctx.site, ctx.log)
      ctx.sourceDir = dir
      ctx.commitSha = sha
      setStatus(ctx.deploymentId, 'cloning', { commitSha: sha })
    },
  },
  {
    name: 'build-image',
    run: async (ctx) => {
      const contextDir = ctx.sourceDir
      if (!contextDir) throw new Error('no source directory')

      const detected = detectBuild(contextDir, {
        dockerfilePath: ctx.site.dockerfilePath,
        containerPort: ctx.site.containerPort,
      })
      ctx.dockerfile = detected.dockerfile
      ctx.log(`dockerfile: ${detected.dockerfile} (${detected.reason})`)

      const ref = ctx.commitSha ? ctx.commitSha.slice(0, 12) : `d-${ctx.deploymentId.slice(0, 8)}`
      const tag = imageTag(ctx.site.name, ref)
      ctx.tag = tag
      setStatus(ctx.deploymentId, 'building', { imageTag: tag })

      await buildImage({
        contextDir,
        dockerfile: detected.dockerfile,
        tag,
        siteName: ctx.site.name,
        buildArgs: ctx.site.buildArgs,
        onLog: ctx.log,
      })
    },
    compensate: async (ctx) => {
      if (!ctx.tag) return
      try {
        await docker.getImage(ctx.tag).remove({ force: false })
        ctx.log(`rolled back: removed image ${ctx.tag}`)
      } catch {
        // Image may not exist, or a previous deployment may share the tag.
      }
    },
  },
  {
    name: 'start-container',
    run: async (ctx) => {
      if (!ctx.tag) throw new Error('no image tag')
      const hostPort = await allocateHostPort()
      ctx.hostPort = hostPort
      ctx.log(`allocated host port ${hostPort} -> container port ${ctx.site.containerPort}`)

      const { id, name } = await createAndStart({
        // Values are decrypted here and nowhere else - they exist in plaintext
        // only in this call and in the container's own environment.
        site: { ...ctx.site, env: openEnv(ctx.site.env) },
        deploymentId: ctx.deploymentId,
        imageTag: ctx.tag,
        hostPort,
      })
      ctx.containerId = id
      ctx.containerName = name
      ctx.log(`started container ${name} (${id.slice(0, 12)})`)
      setStatus(ctx.deploymentId, 'starting', { containerId: id, containerName: name, hostPort })
    },
    compensate: async (ctx) => {
      const ref = ctx.containerId ?? ctx.containerName
      if (!ref) return
      await stopAndRemove(ref)
      ctx.log(`rolled back: removed container ${ctx.containerName ?? ref}`)
    },
  },
  {
    name: 'health-check',
    run: async (ctx) => {
      if (!ctx.containerId || ctx.hostPort === undefined) throw new Error('container not started')
      await waitForHealthy({
        hostPort: ctx.hostPort,
        healthPath: ctx.site.healthPath,
        containerId: ctx.containerId,
        timeoutMs: config.healthTimeoutMs,
        intervalMs: config.healthIntervalMs,
        onLog: ctx.log,
      })
    },
  },
  {
    name: 'ensure-dns',
    run: async (ctx) => {
      const hostname = hostnameFor(ctx.site)
      ctx.hostname = hostname

      // The subdomain may have been edited since the last deploy. Retire the old
      // route first, or it leaks an ingress rule and a DNS record forever.
      const previous = ctx.site.hostname
      if (previous && previous !== hostname) {
        ctx.log(`hostname changed: ${previous} -> ${hostname}`)
        await router.removeHostname(previous, ctx.log)
        if (ctx.site.dnsRecordOwned) await router.removeDns(previous, ctx.site.dnsRecordId, ctx.log)
      }

      const { recordId, created } = await router.ensureDns(ctx.site, ctx.log)
      ctx.dnsCreated = created
      ctx.dnsRecordId = recordId

      db.update(sites)
        .set({
          hostname,
          dnsRecordId: recordId ?? ctx.site.dnsRecordId,
          dnsRecordOwned: created || ctx.site.dnsRecordOwned,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, ctx.site.id))
        .run()
    },
    compensate: async (ctx) => {
      // A record that already existed is not ours to delete - something else may
      // depend on it. Only undo a record this deployment created.
      if (!ctx.dnsCreated || !ctx.hostname) return
      await router.removeDns(ctx.hostname, ctx.dnsRecordId ?? null, ctx.log)
      db.update(sites)
        .set({ dnsRecordId: null, dnsRecordOwned: false, updatedAt: new Date() })
        .where(eq(sites.id, ctx.site.id))
        .run()
    },
  },
  {
    name: 'route-ingress',
    run: async (ctx) => {
      if (!ctx.hostname || !ctx.containerName || ctx.hostPort === undefined) {
        throw new Error('cannot route before the container is running')
      }
      const service = originServiceFor(ctx.site, ctx.containerName, ctx.hostPort)
      ctx.originService = service
      // Traffic moves here, while the previous container is still up. It is only
      // removed in promote, so the cutover has no gap.
      ctx.ingressBefore = await router.pointAt(ctx.hostname, service, ctx.log)
      patchDeployment(ctx.deploymentId, { originService: service })
    },
    compensate: async (ctx) => {
      if (!ctx.ingressBefore) return
      await router.restoreIngress(ctx.ingressBefore, ctx.log)
    },
  },
  {
    name: 'promote',
    run: async (ctx) => {
      // Point the site at the new deployment first, so a crash mid-promote leaves
      // the DB describing the container that is actually healthy.
      db.update(sites)
        .set({ currentDeploymentId: ctx.deploymentId, updatedAt: new Date() })
        .where(eq(sites.id, ctx.site.id))
        .run()
      ctx.promoted = true

      if (ctx.previousDeploymentId) {
        setStatus(ctx.previousDeploymentId, 'superseded', { finishedAt: new Date() })
      }

      // Remove every other container we own for this site: the previous
      // deployment plus any orphans left by an earlier crashed deploy.
      await removeOtherContainers(ctx.site, ctx.deploymentId, ctx.log)
      await pruneSiteImages(ctx.site.name, config.keepImagesPerSite, ctx.log)
    },
    compensate: async (ctx) => {
      if (!ctx.promoted) return
      db.update(sites)
        .set({ currentDeploymentId: ctx.previousDeploymentId ?? null, updatedAt: new Date() })
        .where(eq(sites.id, ctx.site.id))
        .run()
      ctx.log('rolled back: site still points at the previous deployment')
    },
  },
]

/** Stops and removes containers labelled for this site other than `keepDeploymentId`. */
async function removeOtherContainers(
  site: Site,
  keepDeploymentId: string,
  log: (line: string) => void,
): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABELS.site}=${site.name}`] }),
  })
  for (const c of containers) {
    if (c.Labels?.[LABELS.deployment] === keepDeploymentId) continue
    await stopAndRemove(c.Id)
    log(`removed previous container ${c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12)}`)
  }
}

/** Creates the deployment row up front so the caller can stream its logs immediately. */
export function createDeploymentRecord(siteId: string, trigger: Deployment['trigger']): string {
  const id = nanoid()
  db.insert(deployments)
    .values({ id, siteId, status: 'queued', trigger, createdAt: new Date() })
    .run()
  return id
}

export async function runDeployment(deploymentId: string): Promise<void> {
  const deployment = db.select().from(deployments).where(eq(deployments.id, deploymentId)).get()
  if (!deployment) throw new Error(`no such deployment: ${deploymentId}`)
  const site = db.select().from(sites).where(eq(sites.id, deployment.siteId)).get()
  if (!site) throw new Error(`no such site: ${deployment.siteId}`)

  const log = (line: string) => appendLog(deploymentId, 'build', line)
  const ctx: Ctx = {
    site,
    deploymentId,
    log,
    previousDeploymentId: site.currentDeploymentId,
  }

  setStatus(deploymentId, 'queued', { startedAt: new Date() })
  appendLog(deploymentId, 'system', `deploying site "${site.name}" (trigger: ${deployment.trigger})`)

  try {
    await runSaga(ctx, steps, {
      onStepStart: (name) => {
        appendLog(deploymentId, 'system', `--- ${name} ---`)
        const status = STEP_STATUS[name]
        if (status) setStatus(deploymentId, status)
      },
    })
    setStatus(deploymentId, 'live', { finishedAt: new Date() })
    const where = router.enabled && ctx.hostname ? `https://${ctx.hostname}` : `${config.probeHost}:${ctx.hostPort}`
    appendLog(deploymentId, 'system', `deployment live at ${where}`)
  } catch (err) {
    const message =
      err instanceof SagaError
        ? [
            err.message,
            ...err.compensationErrors.map(
              (c) => `rollback of "${c.step}" also failed: ${c.error instanceof Error ? c.error.message : String(c.error)}`,
            ),
          ].join('\n')
        : err instanceof Error
          ? err.message
          : String(err)

    setStatus(deploymentId, 'failed', { error: message, finishedAt: new Date() })
    appendLog(deploymentId, 'system', `FAILED: ${message}`)
    throw err
  } finally {
    flushLogs()
  }
}

/** Teardown has no deployment to attach logs to, so it goes to the server log. */
function teardownLog(line: string): void {
  console.log(`[teardown] ${line}`)
}

/** Stops a site's containers without deleting the site. */
export async function stopSite(siteId: string): Promise<void> {
  const site = db.select().from(sites).where(eq(sites.id, siteId)).get()
  if (!site) throw new Error(`no such site: ${siteId}`)

  // Withdraw the route first: a hostname pointing at a container that is gone
  // serves a tunnel error, whereas no rule at all falls through to the catch-all.
  if (site.hostname) {
    await router.removeHostname(site.hostname, teardownLog)
  }

  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABELS.site}=${site.name}`] }),
  })
  for (const c of containers) await stopAndRemove(c.Id)

  db.update(sites)
    .set({ desiredState: 'stopped', currentDeploymentId: null, updatedAt: new Date() })
    .where(eq(sites.id, siteId))
    .run()

  db.update(deployments)
    .set({ status: 'superseded', finishedAt: new Date() })
    .where(and(eq(deployments.siteId, siteId), inArray(deployments.status, ['live', 'queued'])))
    .run()
}

/** Removes all traces of a site: containers, images, workspace, db rows. */
export async function destroySite(siteId: string): Promise<void> {
  const site = db.select().from(sites).where(eq(sites.id, siteId)).get()
  if (!site) throw new Error(`no such site: ${siteId}`)

  await stopSite(siteId)

  // DNS outlives stop() - a stopped site keeps its hostname - so it is only
  // removed on destroy, and only if we were the one that created it.
  if (site.hostname && site.dnsRecordOwned) {
    await router.removeDns(site.hostname, site.dnsRecordId, teardownLog)
  }

  await pruneSiteImages(site.name, 0, () => {})

  const { removeWorkspace } = await import('../git/source.js')
  removeWorkspace(site.name)

  // deployments and deployment_logs cascade from the site row.
  db.delete(sites).where(eq(sites.id, siteId)).run()
}
