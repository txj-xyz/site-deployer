import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { deployments, sites, type Site } from '../db/schema.js'
import { createDeploymentRecord, runDeployment } from '../deploy/engine.js'
import { enqueue } from '../deploy/queue.js'
import { remoteHeadSha } from './source.js'

export type PollOutcome =
  | { action: 'deployed'; sha: string; deploymentId: string }
  | { action: 'up-to-date'; sha: string }
  | { action: 'already-attempted'; sha: string }
  | { action: 'busy' }
  | { action: 'skipped'; reason: string }
  | { action: 'error'; message: string }

export interface PollResult {
  site: string
  outcome: PollOutcome
}

const ACTIVE_STATUSES = ['queued', 'cloning', 'building', 'starting', 'health_check', 'routing'] as const

function hasActiveDeployment(siteId: string): boolean {
  const row = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.siteId, siteId), inArray(deployments.status, [...ACTIVE_STATUSES])))
    .get()
  return row !== undefined
}

/** The commit currently serving, which is what "up to date" is measured against. */
function deployedSha(site: Site): string | null {
  if (!site.currentDeploymentId) return null
  const row = db
    .select({ sha: deployments.commitSha })
    .from(deployments)
    .where(eq(deployments.id, site.currentDeploymentId))
    .get()
  return row?.sha ?? null
}

/**
 * Failures push the next poll out exponentially, capped, so an unreachable repo
 * or a bad credential does not mean a `git ls-remote` every minute forever.
 */
function backoffMs(failures: number): number {
  return config.gitPollIntervalMs * Math.min(2 ** failures, 32)
}

function schedule(siteId: string, patch: Partial<typeof sites.$inferInsert>): void {
  db.update(sites).set(patch).where(eq(sites.id, siteId)).run()
}

/**
 * Checks one site's remote for new commits and starts a deploy if there are any.
 *
 * Uses `git ls-remote` rather than fetching: it is a single round trip that
 * transfers no objects, so polling every site every minute stays cheap.
 */
export async function pollSite(site: Site, log: (line: string) => void): Promise<PollOutcome> {
  if (site.sourceType !== 'git' || !site.repoUrl) {
    return { action: 'skipped', reason: 'not a git site' }
  }
  if (!site.autoDeploy) return { action: 'skipped', reason: 'auto-deploy is off' }
  if (site.desiredState !== 'running') return { action: 'skipped', reason: 'site is stopped' }
  if (hasActiveDeployment(site.id)) return { action: 'busy' }

  const now = new Date()

  let remote: string | null
  try {
    remote = await remoteHeadSha(site.repoUrl, site.branch)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failures = site.pollFailures + 1
    schedule(site.id, {
      lastPolledAt: now,
      nextPollAt: new Date(Date.now() + backoffMs(failures)),
      pollError: message,
      pollFailures: failures,
    })
    log(`poll failed for ${site.name}: ${message}`)
    return { action: 'error', message }
  }

  if (!remote) {
    const message = `branch "${site.branch}" not found on the remote`
    const failures = site.pollFailures + 1
    schedule(site.id, {
      lastPolledAt: now,
      nextPollAt: new Date(Date.now() + backoffMs(failures)),
      pollError: message,
      pollFailures: failures,
    })
    return { action: 'error', message }
  }

  const base = {
    lastPolledAt: now,
    nextPollAt: new Date(Date.now() + config.gitPollIntervalMs),
    lastSeenSha: remote,
    pollError: null,
    pollFailures: 0,
  }

  if (remote === deployedSha(site)) {
    schedule(site.id, base)
    return { action: 'up-to-date', sha: remote }
  }

  // Already tried this exact commit and it did not end up serving. Wait for a new
  // one rather than rebuilding a broken commit on every tick.
  if (remote === site.lastAttemptedSha) {
    schedule(site.id, base)
    return { action: 'already-attempted', sha: remote }
  }

  schedule(site.id, { ...base, lastAttemptedSha: remote, updatedAt: now })
  const deploymentId = createDeploymentRecord(site.id, 'git')
  log(`${site.name}: new commit ${remote.slice(0, 8)} on ${site.branch}, deploying`)
  void enqueue(site.id, () => runDeployment(deploymentId)).catch(() => {
    // runDeployment records its own failure on the deployment row.
  })

  return { action: 'deployed', sha: remote, deploymentId }
}

/** Sites whose next poll is due (or which have never been polled). */
function dueSites(): Site[] {
  const now = new Date()
  return db
    .select()
    .from(sites)
    .where(
      and(
        eq(sites.sourceType, 'git'),
        eq(sites.autoDeploy, true),
        eq(sites.desiredState, 'running'),
        or(isNull(sites.nextPollAt), lte(sites.nextPollAt, now)),
      ),
    )
    .all()
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (item !== undefined) await worker(item)
    }
  })
  await Promise.all(runners)
}

export async function pollAll(log: (line: string) => void): Promise<PollResult[]> {
  const due = dueSites()
  const results: PollResult[] = []
  await pool(due, config.gitPollConcurrency, async (site) => {
    results.push({ site: site.name, outcome: await pollSite(site, log) })
  })
  return results
}

let timer: NodeJS.Timeout | null = null
let ticking = false

/**
 * Ticks faster than the per-site interval; which sites are actually checked is
 * decided by their `nextPollAt`. That keeps backoff per-site rather than global.
 */
export function startGitPoller(log: (line: string) => void): boolean {
  if (config.gitPollIntervalMs <= 0) return false
  if (timer) return true

  const tickMs = Math.max(5_000, Math.min(config.gitPollIntervalMs, 30_000))
  timer = setInterval(() => {
    if (ticking) return
    ticking = true
    void pollAll(log)
      .catch((err) => log(`git poller tick failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        ticking = false
      })
  }, tickMs)
  timer.unref()
  return true
}

export function stopGitPoller(): void {
  if (timer) clearInterval(timer)
  timer = null
}
