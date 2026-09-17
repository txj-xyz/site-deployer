export interface SagaStep<C> {
  name: string
  run: (ctx: C) => Promise<void>
  /**
   * Undo this step's side effects. Runs in reverse order when a later step fails,
   * and also for the step that threw - so a compensator must tolerate partial
   * state (e.g. a container that was created but never started) and must not throw
   * merely because there is nothing to undo.
   */
  compensate?: (ctx: C) => Promise<void>
}

export class SagaError extends Error {
  constructor(
    readonly step: string,
    override readonly cause: unknown,
    readonly compensationErrors: { step: string; error: unknown }[],
  ) {
    super(`step "${step}" failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SagaError'
  }
}

export async function runSaga<C>(
  ctx: C,
  steps: SagaStep<C>[],
  hooks: { onStepStart?: (name: string) => Promise<void> | void } = {},
): Promise<void> {
  const entered: SagaStep<C>[] = []
  try {
    for (const step of steps) {
      await hooks.onStepStart?.(step.name)
      entered.push(step)
      await step.run(ctx)
    }
  } catch (cause) {
    const failed = entered.at(-1)
    const compensationErrors: { step: string; error: unknown }[] = []
    for (const step of [...entered].reverse()) {
      if (!step.compensate) continue
      try {
        await step.compensate(ctx)
      } catch (error) {
        compensationErrors.push({ step: step.name, error })
      }
    }
    throw new SagaError(failed?.name ?? 'unknown', cause, compensationErrors)
  }
}
