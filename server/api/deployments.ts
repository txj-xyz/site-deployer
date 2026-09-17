import type { FastifyInstance } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { deployments, TERMINAL_STATUSES } from '../db/schema.js'
import { readLogs, subscribeLogs, type LogLine } from '../logs/bus.js'

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.select().from(deployments).where(eq(deployments.id, id)).get()
    if (!row) return reply.code(404).send({ error: 'deployment not found' })
    return row
  })

  app.get('/api/deployments', async (req) => {
    const { siteId, limit } = req.query as { siteId?: string; limit?: string }
    const take = Math.min(Number(limit) || 50, 200)
    // drizzle's builder requires where() before orderBy(), so branch rather than reuse.
    return siteId
      ? db
          .select()
          .from(deployments)
          .where(eq(deployments.siteId, siteId))
          .orderBy(desc(deployments.createdAt))
          .limit(take)
          .all()
      : db.select().from(deployments).orderBy(desc(deployments.createdAt)).limit(take).all()
  })

  /**
   * Live build log as Server-Sent Events. Replays everything already stored
   * (optionally from `?after=<lastId>` on reconnect), then streams new lines,
   * and closes itself once the deployment reaches a terminal status.
   */
  app.get('/api/deployments/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { after } = req.query as { after?: string }

    const deployment = db.select().from(deployments).where(eq(deployments.id, id)).get()
    if (!deployment) return reply.code(404).send({ error: 'deployment not found' })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (event: string, data: unknown, lineId?: number) => {
      if (reply.raw.writableEnded) return
      if (lineId !== undefined) reply.raw.write(`id: ${lineId}\n`)
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    let lastId = Number(after) || 0
    for (const line of readLogs(id, lastId)) {
      lastId = line.id
      send('log', line, line.id)
    }

    // Lines that land between the replay above and the subscription below would
    // otherwise be lost, so drain once more after subscribing.
    const onLine = (line: LogLine) => {
      if (line.id <= lastId) return
      lastId = line.id
      send('log', line, line.id)
    }
    const unsubscribe = subscribeLogs(id, onLine)
    for (const line of readLogs(id, lastId)) onLine(line)

    const keepAlive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n')
    }, 15_000)

    // The log bus carries lines, not status, so poll for the terminal transition.
    const statusWatch = setInterval(() => {
      const current = db
        .select({ status: deployments.status })
        .from(deployments)
        .where(eq(deployments.id, id))
        .get()
      if (current && TERMINAL_STATUSES.includes(current.status)) {
        for (const line of readLogs(id, lastId)) onLine(line)
        send('status', { status: current.status })
        close()
      }
    }, 1_000)

    const close = () => {
      clearInterval(keepAlive)
      clearInterval(statusWatch)
      unsubscribe()
      if (!reply.raw.writableEnded) reply.raw.end()
    }

    req.raw.on('close', close)

    if (TERMINAL_STATUSES.includes(deployment.status)) {
      send('status', { status: deployment.status })
      close()
    }

    return reply
  })
}
