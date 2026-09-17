import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { deploymentRoutes } from './api/deployments.js'
import { metricsRoutes } from './api/metrics.js'
import { routeRoutes } from './api/routes.js'
import { siteRoutes } from './api/sites.js'
import { registerAuth, authMode } from './auth/index.js'
import { routerStatus } from './cloudflare/router.js'
import { config, envFileLoaded } from './config.js'
import { appliedMigrations } from './db/index.js'
import { ensureNetwork, pingDocker } from './docker/client.js'
import { startGitPoller, stopGitPoller } from './git/poller.js'
import { startTargetWriter, stopTargetWriter } from './metrics/targets.js'
import { failStaleDeployments, reconcile, startReconciler, stopReconciler } from './reconcile/index.js'
import { keyDescription } from './secrets/crypto.js'

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 1024 * 1024,
})

app.get('/api/health', async () => {
  let docker: string | { error: string }
  try {
    docker = await pingDocker()
  } catch (err) {
    docker = { error: err instanceof Error ? err.message : String(err) }
  }
  return {
    ok: true,
    docker,
    network: config.dockerNetwork,
    cloudflare: routerStatus(),
    auth: authMode(),
  }
})

await app.register(registerAuth)
await app.register(siteRoutes)
await app.register(deploymentRoutes)
await app.register(routeRoutes)
await app.register(metricsRoutes)

app.post('/api/reconcile', async () => {
  const drift = await reconcile((line) => app.log.info({ source: 'reconcile' }, line))
  return { drift }
})

/**
 * In production the built SPA is served from here. In development Vite serves it
 * on :5173 and proxies /api back to this process, so this block is simply absent.
 */
const webDist = resolve(import.meta.dirname, '../dist-web')
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
    // Anything else is a client-side route; hand back the shell.
    return reply.sendFile('index.html')
  })
}

async function main(): Promise<void> {
  mkdirSync(config.workspacesDir, { recursive: true })
  if (envFileLoaded) {
    app.log.info({ file: envFileLoaded }, 'loaded environment file')
  } else {
    app.log.warn('no .env file found - configuration is coming from the shell environment only')
  }
  if (appliedMigrations.length > 0) {
    app.log.info({ migrations: appliedMigrations }, 'applied database migrations')
  }

  try {
    const version = await pingDocker()
    app.log.info({ version }, 'connected to docker')
    await ensureNetwork(config.dockerNetwork)
    app.log.info({ network: config.dockerNetwork }, 'docker network ready')
  } catch (err) {
    // Start anyway: the API and its health endpoint stay useful for diagnosing
    // exactly this, and docker may come back without us restarting.
    app.log.error({ err }, 'docker is not reachable - deploys will fail until it is')
  }

  const cf = routerStatus()
  if (cf.enabled) {
    app.log.info({ originMode: cf.originMode }, 'cloudflare routing enabled')
  } else {
    app.log.warn(
      { missing: cf.missing },
      'cloudflare credentials incomplete - routing runs in plan-only mode and logs what it would do',
    )
  }

  app.log.info({ key: keyDescription() }, 'secret key loaded')

  // Before anything else touches state: nothing is driving deployments that were
  // running when the process died, so retire them rather than leave them pending.
  failStaleDeployments((line) => app.log.info({ source: 'reconcile' }, line))

  const reconciling = startReconciler((line) => app.log.info({ source: 'reconcile' }, line))
  if (reconciling) {
    app.log.info({ intervalMs: config.reconcileIntervalMs }, 'reconciler started')
  }

  startTargetWriter((line) => app.log.info({ source: 'metrics' }, line))

  const polling = startGitPoller((line) => app.log.info({ source: 'git-poller' }, line))
  if (polling) {
    app.log.info({ intervalMs: config.gitPollIntervalMs }, 'git poller started')
  } else {
    app.log.info('git polling disabled (GIT_POLL_INTERVAL_MS=0)')
  }

  await app.listen({ port: config.port, host: config.host })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`)
    stopGitPoller()
    stopTargetWriter()
    stopReconciler()
    void app.close().then(() => process.exit(0))
  })
}

await main()
