import type { MatrixEffort, MatrixModelId } from '../../shared/matrix-models'

import type { AgentSweepUsage } from './background-sweep'

/** Internal-only alias: the proxy replaces it from a platform dispatch authorization. */
export const MATRIX_BACKGROUND_SWEEP_MODEL_ALIAS = 'atum-followup-sweep'

export interface MatrixBackgroundSweepManagedCall {
  authorizationId: string
  attributionId: string
  model: MatrixModelId
  effort: MatrixEffort
  protection: 'standard' | 'google_protected'
  maxModelMicroProtons: number
}

/**
 * Preserve bounded provider token/compute facts; Proton charging stays platform-authoritative.
 * A warm-up nudge is funded for 1,800 seconds, a normal sweep for 120.
 */
export function backgroundSweepReportedUsage(value: unknown, maxComputeSeconds = 120): AgentSweepUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const usage = value as Record<string, unknown>
  const computeSeconds = Number(usage.computeSeconds)
  const inputTokens = Number(usage.inputTokens)
  const outputTokens = Number(usage.outputTokens)

  if (
    !Number.isFinite(computeSeconds) || computeSeconds < 0 || computeSeconds > maxComputeSeconds ||
    !Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > 8_000 ||
    !Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > 1_000
  ) {
    return null
  }

  return { computeSeconds, modelAttempts: 1, inputTokens, outputTokens, modelMicroProtons: 0 }
}

interface PendingCall {
  call: MatrixBackgroundSweepManagedCall
  consumed: boolean
}

/** One main-owned authorization per agent; proxy continuations and retries are refused. */
export class MatrixBackgroundSweepModelCalls {
  private readonly calls = new Map<string, PendingCall>()

  begin(agent: string, call: MatrixBackgroundSweepManagedCall): () => void {
    if (this.calls.has(agent)) {
      throw new Error('matrix_background_sweep_busy')
    }

    const pending = { call, consumed: false }
    this.calls.set(agent, pending)

    return () => {
      if (this.calls.get(agent) === pending) {
        this.calls.delete(agent)
      }
    }
  }

  take(agent: string): MatrixBackgroundSweepManagedCall | null {
    const pending = this.calls.get(agent)

    if (!pending || pending.consumed) {
      return null
    }

    pending.consumed = true
    return pending.call
  }
}
