import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { deployments, sites } from '../db/schema.js'
import { hostnameFor, originServiceFor, router, routerStatus } from '../cloudflare/router.js'

export async function routeRoutes(app: FastifyInstance): Promise<void> {
  /** What Cloudflare currently believes, next to what we intend. Drift shows up here. */
  app.get('/api/routes', async (_req, reply) => {
    const status = routerStatus()

    let live: unknown
    try {
      live = await router.listIngress()
    } catch (err) {
      return reply.code(502).send({
        ...status,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const intended = db
      .select()
      .from(sites)
      .all()
      .filter((site) => site.desiredState === 'running' && site.currentDeploymentId)
      .map((site) => {
        const deployment = db
          .select()
          .from(deployments)
          .where(eq(deployments.id, site.currentDeploymentId as string))
          .get()
        return {
          site: site.name,
          hostname: site.hostname ?? hostnameFor(site),
          service:
            deployment?.originService ??
            (deployment?.containerName && deployment.hostPort !== null
              ? originServiceFor(site, deployment.containerName, deployment.hostPort)
              : null),
        }
      })

    return { ...status, intended, live }
  })
}
