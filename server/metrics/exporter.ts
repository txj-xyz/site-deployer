import { LABELS } from '../config.js'
import { docker } from '../docker/client.js'

/**
 * Per-container CPU, memory and network counters in Prometheus exposition format.
 *
 * This stands in for cAdvisor, which cannot collect anything against Docker
 * Desktop's `overlayfs` storage driver: its Docker handler resolves every
 * container's read-write layer under `image/<driver>/layerdb/`, a tree the
 * containerd-backed image store never creates, and it aborts handler setup when
 * that lookup fails - so no per-container series are emitted at all. Reading the
 * Docker API's own stats endpoint works on any storage driver, and drops a
 * privileged container from the stack as a side effect.
 *
 * The metric names are deliberately cAdvisor's, so the provisioned dashboard
 * keeps working unchanged. Only the metrics the dashboard charts are exported;
 * this is not a general-purpose cAdvisor replacement.
 */

/** Only the fields we read; the stats payload is very large. */
interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number } }
  memory_stats?: { usage?: number; stats?: Record<string, number> }
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>
}

interface Sample {
  site: string
  name: string
  cpuSeconds: number
  memoryBytes: number
  rxBytes: number
  txBytes: number
}

const STATS_TIMEOUT_MS = 5_000

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Working set is resident memory minus the page cache that could be reclaimed
 * under pressure, which is what cAdvisor reports and what the dashboard's
 * Memory panel expects. The counter is named `inactive_file` under cgroup v2 and
 * `total_inactive_file` under v1.
 */
function workingSet(memory: DockerStats['memory_stats']): number {
  const usage = num(memory?.usage)
  const stats = memory?.stats ?? {}
  const inactiveFile = num(stats.inactive_file ?? stats.total_inactive_file)
  return Math.max(0, usage - inactiveFile)
}

/** A container may have several interfaces; the dashboard charts the total. */
function networkTotals(networks: DockerStats['networks']): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
  for (const iface of Object.values(networks ?? {})) {
    rx += num(iface.rx_bytes)
    tx += num(iface.tx_bytes)
  }
  return { rx, tx }
}

/**
 * `one-shot` skips the second sample Docker otherwise collects to compute CPU
 * percentages. We export the raw cumulative counter and let Prometheus do the
 * rate(), so waiting a full second per container would buy nothing.
 */
async function readStats(id: string): Promise<DockerStats | null> {
  const container = docker.getContainer(id)
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), STATS_TIMEOUT_MS).unref())

  const read = (async () => {
    const raw = (await container.stats({ stream: false, 'one-shot': true } as never)) as unknown
    // dockerode hands back the parsed object for a non-streaming read, but older
    // modem versions resolve with the raw body instead.
    if (typeof raw === 'string') return JSON.parse(raw) as DockerStats
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf8')) as DockerStats
    return raw as DockerStats
  })()

  try {
    return await Promise.race([read, timeout])
  } catch {
    // A container that exits mid-scrape is normal, not an error worth failing on.
    return null
  }
}

export async function collect(): Promise<Sample[]> {
  const containers = await docker.listContainers({
    filters: JSON.stringify({ label: [`${LABELS.managed}=true`] }),
  })

  const samples = await Promise.all(
    containers.map(async (info): Promise<Sample | null> => {
      const stats = await readStats(info.Id)
      if (!stats) return null

      const { rx, tx } = networkTotals(stats.networks)
      return {
        site: info.Labels?.[LABELS.site] ?? '',
        name: info.Names?.[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12),
        cpuSeconds: num(stats.cpu_stats?.cpu_usage?.total_usage) / 1e9,
        memoryBytes: workingSet(stats.memory_stats),
        rxBytes: rx,
        txBytes: tx,
      }
    }),
  )

  return samples.filter((s): s is Sample => s !== null && s.site !== '')
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function metric(name: string, help: string, type: 'counter' | 'gauge', samples: Sample[], value: (s: Sample) => number): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`]
  for (const s of samples) {
    lines.push(`${name}{site="${escapeLabel(s.site)}",name="${escapeLabel(s.name)}"} ${value(s)}`)
  }
  return lines.join('\n')
}

export function render(samples: Sample[]): string {
  const blocks = [
    metric(
      'container_cpu_usage_seconds_total',
      'Cumulative CPU time consumed by the container, in seconds.',
      'counter',
      samples,
      (s) => s.cpuSeconds,
    ),
    metric(
      'container_memory_working_set_bytes',
      'Container memory in use, excluding reclaimable page cache.',
      'gauge',
      samples,
      (s) => s.memoryBytes,
    ),
    metric(
      'container_network_receive_bytes_total',
      'Cumulative bytes received over all of the container network interfaces.',
      'counter',
      samples,
      (s) => s.rxBytes,
    ),
    metric(
      'container_network_transmit_bytes_total',
      'Cumulative bytes sent over all of the container network interfaces.',
      'counter',
      samples,
      (s) => s.txBytes,
    ),
  ]
  return `${blocks.join('\n')}\n`
}

export async function exposition(): Promise<string> {
  return render(await collect())
}
