import { config, LABELS } from '../config.js'
import type { Site } from '../db/schema.js'
import { docker } from './client.js'

export interface StartOptions {
  site: Site
  deploymentId: string
  imageTag: string
  hostPort: number
}

export function containerName(siteName: string, deploymentId: string): string {
  return `sd-${siteName}-${deploymentId.slice(0, 8)}`
}

export async function createAndStart(o: StartOptions): Promise<{ id: string; name: string }> {
  const name = containerName(o.site.name, o.deploymentId)
  const portKey = `${o.site.containerPort}/tcp`

  const container = await docker.createContainer({
    name,
    Image: o.imageTag,
    // PORT is the near-universal convention; set it so most apps bind the port we expose.
    Env: Object.entries({ PORT: String(o.site.containerPort), ...o.site.env }).map(([k, v]) => `${k}=${v}`),
    Labels: {
      [LABELS.managed]: 'true',
      [LABELS.site]: o.site.name,
      [LABELS.siteId]: o.site.id,
      [LABELS.deployment]: o.deploymentId,
    },
    ExposedPorts: { [portKey]: {} },
    HostConfig: {
      // Bound to PUBLISH_HOST_IP, loopback by default, so nothing is reachable
      // from the LAN. Phase 2 points the tunnel ingress rule at this port.
      PortBindings: { [portKey]: [{ HostIp: config.publishHostIp, HostPort: String(o.hostPort) }] },
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: config.dockerNetwork,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  })

  await container.start()
  return { id: container.id, name }
}

export async function stopAndRemove(idOrName: string, timeoutSec = 10): Promise<void> {
  const container = docker.getContainer(idOrName)
  try {
    await container.stop({ t: timeoutSec })
  } catch (err) {
    // 304 = already stopped, 404 = already gone. Neither is a failure here.
    const status = (err as { statusCode?: number }).statusCode
    if (status !== 304 && status !== 404) throw err
  }
  try {
    await container.remove({ v: false, force: true })
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err
  }
}

export async function containerState(idOrName: string): Promise<{ running: boolean; exitCode: number } | null> {
  try {
    const info = await docker.getContainer(idOrName).inspect()
    return { running: info.State.Running, exitCode: info.State.ExitCode }
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null
    throw err
  }
}

export async function tailContainerLogs(idOrName: string, lines = 50): Promise<string> {
  try {
    const buf = (await docker.getContainer(idOrName).logs({
      stdout: true,
      stderr: true,
      tail: lines,
    })) as unknown as Buffer
    // Multiplexed stream framing puts an 8-byte header on each chunk. Strip
    // control bytes rather than demultiplexing properly - this output is only
    // ever shown in an error message.
    return buf
      .toString('utf8')
      .split('\n')
      .map((line) => line.replace(/[^\t\x20-\x7e -￿]/g, ''))
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

export interface HealthOptions {
  hostPort: number
  healthPath: string
  containerId: string
  timeoutMs: number
  intervalMs: number
  onLog: (line: string) => void
}

/**
 * Waits for the container to answer HTTP on its published port. Any status below
 * 500 counts as healthy - a 404 still proves the server is up, and we do not want
 * to force every site to serve something at the probe path.
 */
export async function waitForHealthy(o: HealthOptions): Promise<void> {
  const path = o.healthPath.startsWith('/') ? o.healthPath : `/${o.healthPath}`
  const url = `http://${config.probeHost}:${o.hostPort}${path}`
  const deadline = Date.now() + o.timeoutMs
  let lastError = 'no attempt made'

  o.onLog(`probing ${url} (timeout ${Math.round(o.timeoutMs / 1000)}s)`)

  while (Date.now() < deadline) {
    const state = await containerState(o.containerId)
    if (state === null) throw new Error('container disappeared while waiting for health check')
    if (!state.running) {
      const logs = await tailContainerLogs(o.containerId)
      throw new Error(`container exited with code ${state.exitCode} before becoming healthy\n${logs}`)
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'manual' })
      if (res.status < 500) {
        o.onLog(`healthy: HTTP ${res.status}`)
        return
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }

    await new Promise((r) => setTimeout(r, o.intervalMs))
  }

  const logs = await tailContainerLogs(o.containerId)
  throw new Error(`health check timed out after ${Math.round(o.timeoutMs / 1000)}s (last: ${lastError})\n${logs}`)
}

/** Drops old images for a site, keeping the newest `keep`. Images still in use are skipped. */
export async function pruneSiteImages(siteName: string, keep: number, onLog: (line: string) => void): Promise<void> {
  const images = await docker.listImages({
    filters: JSON.stringify({ label: [`${LABELS.site}=${siteName}`] }),
  })
  const stale = images.sort((a, b) => b.Created - a.Created).slice(keep)
  for (const image of stale) {
    const ref = image.RepoTags?.[0] ?? image.Id
    try {
      await docker.getImage(image.Id).remove({ force: false })
      onLog(`pruned image ${ref}`)
    } catch {
      // In use by a running container, or referenced by another tag. Leave it.
    }
  }
}
