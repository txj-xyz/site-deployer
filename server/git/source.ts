import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'
import type { Site } from '../db/schema.js'
import { run } from '../util/exec.js'

export interface ResolvedSource {
  /** Directory to use as the docker build context. */
  dir: string
  /** Commit that was checked out, or null for a local path with no git history. */
  sha: string | null
}

function checkoutDir(siteName: string): string {
  return join(config.workspacesDir, siteName)
}

async function isRepoFor(dir: string, repoUrl: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false
  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir })
    return stdout.trim() === repoUrl
  } catch {
    return false
  }
}

/**
 * Produces a clean build context for a deployment.
 *
 * Git sites keep one long-lived checkout per site rather than a fresh clone per
 * deploy, so fetches stay incremental. Deploys for a single site are serialized
 * by the queue, so sharing the directory is safe. `git clean -fdx` before each
 * build guarantees the context matches the commit - including removing the
 * Dockerfile we generate ourselves on a previous run.
 *
 * Credentials come from the ambient git environment (ssh agent, ssh config,
 * credential helper). Per-site deploy keys arrive in a later phase.
 */
export async function resolveSource(
  site: Site,
  onLog: (line: string) => void,
): Promise<ResolvedSource> {
  if (site.sourceType === 'local') {
    const dir = site.localPath
    if (!dir) throw new Error('site has sourceType "local" but no localPath')
    if (!existsSync(dir)) throw new Error(`localPath does not exist: ${dir}`)
    onLog(`using local path ${dir}`)
    return { dir, sha: await headSha(dir) }
  }

  const repoUrl = site.repoUrl
  if (!repoUrl) throw new Error('site has sourceType "git" but no repoUrl')

  mkdirSync(config.workspacesDir, { recursive: true })
  const dir = checkoutDir(site.name)

  if (existsSync(dir) && !(await isRepoFor(dir, repoUrl))) {
    onLog(`workspace at ${dir} is not a checkout of ${repoUrl}; recreating it`)
    rmSync(dir, { recursive: true, force: true })
  }

  if (!existsSync(dir)) {
    onLog(`cloning ${repoUrl} (branch ${site.branch})`)
    await run('git', ['clone', '--branch', site.branch, '--single-branch', repoUrl, dir])
  } else {
    onLog(`fetching ${repoUrl} (branch ${site.branch})`)
    await run('git', ['fetch', '--prune', 'origin', site.branch], { cwd: dir })
    await run('git', ['checkout', '--force', '-B', site.branch, `origin/${site.branch}`], { cwd: dir })
  }

  await run('git', ['reset', '--hard', `origin/${site.branch}`], { cwd: dir })
  await run('git', ['clean', '-fdx'], { cwd: dir })

  const sha = await headSha(dir)
  onLog(`checked out ${sha ?? 'unknown'}`)
  return { dir, sha }
}

export async function headSha(dir: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir })
    return stdout.trim()
  } catch {
    return null
  }
}

/** Cheap "has anything changed?" check - no clone. Used by the git poller in phase 4. */
export async function remoteHeadSha(repoUrl: string, branch: string): Promise<string | null> {
  const { stdout } = await run('git', ['ls-remote', repoUrl, `refs/heads/${branch}`], {
    timeoutMs: 30_000,
  })
  const sha = stdout.trim().split(/\s+/)[0]
  return sha && sha.length >= 7 ? sha : null
}

export function removeWorkspace(siteName: string): void {
  rmSync(checkoutDir(siteName), { recursive: true, force: true })
}
