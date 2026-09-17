import net from 'node:net'
import { and, inArray, isNotNull } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { deployments } from '../db/schema.js'

/** Deployment statuses that still hold a claim on their allocated host port. */
const HOLDING_STATUSES = ['queued', 'cloning', 'building', 'starting', 'health_check', 'routing', 'live'] as const

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Picks a loopback port for a new deployment: not claimed by another live or
 * in-flight deployment, and not currently bound by anything else on the host.
 *
 * There is an inherent race between probing and Docker binding the port. Docker
 * fails loudly in that case and the deploy is retried, which is the right
 * trade-off versus holding a global lock across a multi-minute build.
 */
export async function allocateHostPort(): Promise<number> {
  const claimed = new Set(
    db
      .select({ port: deployments.hostPort })
      .from(deployments)
      .where(and(isNotNull(deployments.hostPort), inArray(deployments.status, [...HOLDING_STATUSES])))
      .all()
      .map((r) => r.port as number),
  )

  const span = config.hostPortMax - config.hostPortMin + 1
  if (span <= 0) throw new Error('HOST_PORT_MIN must be <= HOST_PORT_MAX')

  const offset = Math.floor(Math.random() * span)
  for (let i = 0; i < span; i++) {
    const port = config.hostPortMin + ((offset + i) % span)
    if (claimed.has(port)) continue
    if (await probe(port)) return port
  }
  throw new Error(`No free host port in range ${config.hostPortMin}-${config.hostPortMax}`)
}
