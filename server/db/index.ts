import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config.js'
import { migrations } from './migrations.js'
import * as schema from './schema.js'

mkdirSync(dirname(config.dbPath), { recursive: true })

const sqlite = new Database(config.dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('busy_timeout = 5000')

function migrate(): string[] {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      idx INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)
  const applied = new Set(
    sqlite.prepare('SELECT idx FROM schema_migrations').all().map((r) => (r as { idx: number }).idx),
  )
  const ran: string[] = []
  for (const [idx, m] of migrations.entries()) {
    if (applied.has(idx)) continue
    sqlite.transaction(() => {
      sqlite.exec(m.sql)
      sqlite
        .prepare('INSERT INTO schema_migrations (idx, name, applied_at) VALUES (?, ?, ?)')
        .run(idx, m.name, Date.now())
    })()
    ran.push(m.name)
  }
  return ran
}

export const appliedMigrations = migrate()
export const db = drizzle(sqlite, { schema })
export { sqlite, schema }
