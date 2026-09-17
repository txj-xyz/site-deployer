import { join } from 'node:path'
import { config, LABELS } from '../config.js'
import { spawnStream } from '../util/exec.js'

export interface BuildOptions {
  contextDir: string
  /** Dockerfile path relative to contextDir. */
  dockerfile: string
  tag: string
  siteName: string
  buildArgs: Record<string, string>
  onLog: (line: string) => void
  signal?: AbortSignal
}

export function imageTag(siteName: string, ref: string): string {
  return `${config.imagePrefix}/${siteName}:${ref}`
}

/**
 * Builds via the `docker build` CLI rather than the Engine API's /build endpoint.
 * Two reasons: it gets BuildKit (layer caching, cache mounts, secrets) which the
 * classic API builder does not, and it honours .dockerignore natively instead of
 * us reimplementing that matcher. Cost is a docker CLI dependency in our image.
 */
export async function buildImage(o: BuildOptions): Promise<void> {
  const args = [
    'build',
    '--progress=plain',
    '--file',
    join(o.contextDir, o.dockerfile),
    '--tag',
    o.tag,
    '--label',
    `${LABELS.managed}=true`,
    '--label',
    `${LABELS.site}=${o.siteName}`,
  ]

  for (const [key, value] of Object.entries(o.buildArgs)) {
    args.push('--build-arg', `${key}=${value}`)
  }
  args.push(o.contextDir)

  o.onLog(`$ docker ${args.join(' ')}`)
  await spawnStream('docker', args, {
    cwd: o.contextDir,
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
    onLine: o.onLog,
    signal: o.signal,
  })
}
