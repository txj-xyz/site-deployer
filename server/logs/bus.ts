import { EventEmitter } from 'node:events'
import { asc, eq, gt, and } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { deploymentLogs } from '../db/schema.js'

export interface LogLine {
  id: number
  ts: number
  stream: 'build' | 'system' | 'container'
  line: string
}

const emitter = new EventEmitter()
emitter.setMaxListeners(0)

type Pending = { deploymentId: string; ts: number; stream: LogLine['stream']; line: string }

let buffer: Pending[] = []
let flushTimer: NodeJS.Timeout | null = null

const insert = sqlite.prepare(
  'INSERT INTO deployment_logs (deployment_id, ts, stream, line) VALUES (?, ?, ?, ?)',
)
const insertMany = sqlite.transaction((rows: Pending[]) => {
  const ids: number[] = []
  for (const r of rows) ids.push(Number(insert.run(r.deploymentId, r.ts, r.stream, r.line).lastInsertRowid))
  return ids
})

/**
 * Build output arrives in bursts of hundreds of lines. Batching the writes into
 * one transaction every 100ms keeps a noisy `npm ci` from turning into hundreds
 * of individual WAL commits, while still feeling live in the UI.
 */
function flush(): void {
  flushTimer = null
  if (buffer.length === 0) return
  const rows = buffer
  buffer = []
  const ids = insertMany(rows)
  rows.forEach((row, i) => {
    const payload: LogLine = { id: ids[i] ?? 0, ts: row.ts, stream: row.stream, line: row.line }
    emitter.emit(row.deploymentId, payload)
  })
}

export function appendLog(deploymentId: string, stream: LogLine['stream'], text: string): void {
  const ts = Date.now()
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    buffer.push({ deploymentId, ts, stream, line })
  }
  if (!flushTimer && buffer.length > 0) flushTimer = setTimeout(flush, 100)
}

/** Forces pending lines to disk. Call before reporting a deployment terminal. */
export function flushLogs(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flush()
}

export function readLogs(deploymentId: string, afterId = 0): LogLine[] {
  return db
    .select()
    .from(deploymentLogs)
    .where(and(eq(deploymentLogs.deploymentId, deploymentId), gt(deploymentLogs.id, afterId)))
    .orderBy(asc(deploymentLogs.id))
    .all()
    .map((r) => ({ id: r.id, ts: r.ts.getTime(), stream: r.stream, line: r.line }))
}

export function subscribeLogs(deploymentId: string, onLine: (line: LogLine) => void): () => void {
  emitter.on(deploymentId, onLine)
  return () => emitter.off(deploymentId, onLine)
}
