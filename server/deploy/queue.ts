/**
 * Serializes work per key. Deployments for one site must not overlap - they
 * share a git checkout and would fight over container names - but deployments
 * for different sites run concurrently.
 */
const chains = new Map<string, Promise<unknown>>()

export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  // Swallow the predecessor's rejection: one failed deploy must not cancel the next.
  const result = previous.then(task, task)
  const settled = result.catch(() => undefined)
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return result
}

export function queueDepth(key: string): boolean {
  return chains.has(key)
}
