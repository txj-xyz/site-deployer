import Docker from 'dockerode'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * docker-modem reads DOCKER_HOST but has no notion of docker contexts, so on a
 * Docker Desktop machine the default /var/run/docker.sock may not exist. Fall
 * back to the per-user socket before giving up.
 */
function resolveOptions(): Docker.DockerOptions | undefined {
  if (process.env.DOCKER_HOST) return undefined
  const candidates = ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock')]
  const found = candidates.find((p) => existsSync(p))
  return found ? { socketPath: found } : undefined
}

export const docker = new Docker(resolveOptions())

export async function pingDocker(): Promise<string> {
  const info = (await docker.version()) as { Version?: string }
  return info.Version ?? 'unknown'
}

/** Creates the shared bridge network if it is missing. Idempotent. */
export async function ensureNetwork(name: string): Promise<void> {
  const existing = await docker.listNetworks({ filters: JSON.stringify({ name: [name] }) })
  if (existing.some((n) => n.Name === name)) return
  try {
    await docker.createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true })
  } catch (err) {
    // Another process may have won the race; only rethrow if it still is not there.
    const after = await docker.listNetworks({ filters: JSON.stringify({ name: [name] }) })
    if (!after.some((n) => n.Name === name)) throw err
  }
}
