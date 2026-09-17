import type { FastifyInstance } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/index.js'
import { deployments, sites } from '../db/schema.js'
import { createDeploymentRecord, destroySite, runDeployment, stopSite } from '../deploy/engine.js'
import { enqueue } from '../deploy/queue.js'
import { pollSite } from '../git/poller.js'
import { maskEnv, sealEnv } from '../secrets/crypto.js'

/** Slug rules are Docker's: it becomes part of a container and image name. */
const slug = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'must be lowercase alphanumeric with internal hyphens')

const envMap = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())

const createSite = z
  .object({
    name: slug,
    subdomain: slug.optional(),
    sourceType: z.enum(['git', 'local']).default('git'),
    repoUrl: z.string().url().or(z.string().regex(/^git@/)).optional(),
    branch: z.string().min(1).default('main'),
    localPath: z.string().min(1).optional(),
    dockerfilePath: z.string().min(1).optional(),
    containerPort: z.number().int().min(1).max(65535).default(3000),
    healthPath: z.string().startsWith('/').default('/'),
    env: envMap.default({}),
    buildArgs: envMap.default({}),
    autoDeploy: z.boolean().default(true),
    deployNow: z.boolean().default(true),
  })
  .refine((v) => (v.sourceType === 'git' ? Boolean(v.repoUrl) : Boolean(v.localPath)), {
    message: 'git sites need repoUrl; local sites need localPath',
  })

const updateSite = createSite.innerType().partial().omit({ name: true, deployNow: true })

/** Env values never leave the process; only their keys are exposed. */
function publicSite<T extends { env: Record<string, string> }>(site: T): T {
  return { ...site, env: maskEnv(site.env) }
}

export async function siteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sites', async () => {
    const rows = db.select().from(sites).orderBy(sites.name).all()
    return rows.map((site) => {
      const current = site.currentDeploymentId
        ? db.select().from(deployments).where(eq(deployments.id, site.currentDeploymentId)).get()
        : null
      return { ...publicSite(site), currentDeployment: current ?? null }
    })
  })

  app.get('/api/sites/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const site = db.select().from(sites).where(eq(sites.id, id)).get()
    if (!site) return reply.code(404).send({ error: 'site not found' })
    const history = db
      .select()
      .from(deployments)
      .where(eq(deployments.siteId, id))
      .orderBy(desc(deployments.createdAt))
      .limit(20)
      .all()
    return { ...publicSite(site), deployments: history }
  })

  app.post('/api/sites', async (req, reply) => {
    const parsed = createSite.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid site', issues: parsed.error.issues })
    const body = parsed.data

    if (db.select().from(sites).where(eq(sites.name, body.name)).get()) {
      return reply.code(409).send({ error: `site "${body.name}" already exists` })
    }

    const now = new Date()
    const site = {
      id: nanoid(),
      name: body.name,
      subdomain: body.subdomain ?? body.name,
      sourceType: body.sourceType,
      repoUrl: body.repoUrl ?? null,
      branch: body.branch,
      localPath: body.localPath ?? null,
      dockerfilePath: body.dockerfilePath ?? null,
      containerPort: body.containerPort,
      healthPath: body.healthPath,
      env: sealEnv(body.env),
      buildArgs: body.buildArgs,
      autoDeploy: body.autoDeploy,
      desiredState: 'running' as const,
      currentDeploymentId: null,
      createdAt: now,
      updatedAt: now,
    }
    db.insert(sites).values(site).run()

    let deploymentId: string | null = null
    if (body.deployNow) {
      deploymentId = createDeploymentRecord(site.id, 'manual')
      void enqueue(site.id, () => runDeployment(deploymentId as string)).catch(() => {})
    }

    return reply.code(201).send({ ...publicSite(site), deploymentId })
  })

  app.patch('/api/sites/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const site = db.select().from(sites).where(eq(sites.id, id)).get()
    if (!site) return reply.code(404).send({ error: 'site not found' })

    const parsed = updateSite.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid patch', issues: parsed.error.issues })

    const patch = { ...parsed.data, updatedAt: new Date() }
    if (parsed.data.env) patch.env = sealEnv(parsed.data.env)

    db.update(sites).set(patch).where(eq(sites.id, id)).run()
    const updated = db.select().from(sites).where(eq(sites.id, id)).get()
    return updated ? publicSite(updated) : updated
  })

  app.post('/api/sites/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string }
    const site = db.select().from(sites).where(eq(sites.id, id)).get()
    if (!site) return reply.code(404).send({ error: 'site not found' })

    const deploymentId = createDeploymentRecord(site.id, 'manual')
    if (site.desiredState !== 'running') {
      db.update(sites).set({ desiredState: 'running', updatedAt: new Date() }).where(eq(sites.id, id)).run()
    }
    void enqueue(site.id, () => runDeployment(deploymentId)).catch(() => {})
    return reply.code(202).send({ deploymentId })
  })

  /** Forces an immediate poll of one site, bypassing its backoff schedule. */
  app.post('/api/sites/:id/check', async (req, reply) => {
    const { id } = req.params as { id: string }
    const site = db.select().from(sites).where(eq(sites.id, id)).get()
    if (!site) return reply.code(404).send({ error: 'site not found' })

    const outcome = await pollSite(site, (line) => req.log.info(line))
    return { site: site.name, outcome }
  })

  app.post('/api/sites/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!db.select().from(sites).where(eq(sites.id, id)).get()) {
      return reply.code(404).send({ error: 'site not found' })
    }
    await enqueue(id, () => stopSite(id))
    return { stopped: true }
  })

  app.delete('/api/sites/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!db.select().from(sites).where(eq(sites.id, id)).get()) {
      return reply.code(404).send({ error: 'site not found' })
    }
    await enqueue(id, () => destroySite(id))
    return reply.code(204).send()
  })
}
