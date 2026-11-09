import { describe, expect, it } from 'vitest'

import { backgroundSweepReportedUsage, MatrixBackgroundSweepModelCalls } from './background-sweep-model'

const call = {
  authorizationId: '00000000-0000-4000-8000-463bfa64f08a',
  attributionId: '00000000-0000-4000-8000-5bb08005840f',
  model: 'nguyet-thuc' as const,
  effort: 'medium' as const,
  protection: 'standard' as const,
  maxModelMicroProtons: 114_210_000
}

describe('background sweep model-call admission', () => {
  it('reports bounded usage without trusting a Mac-computed Proton amount', () => {
    expect(
      backgroundSweepReportedUsage({
        computeSeconds: 2.5,
        inputTokens: 300,
        outputTokens: 12,
        modelMicroProtons: 42
      })
    ).toEqual({ computeSeconds: 2.5, modelAttempts: 1, inputTokens: 300, outputTokens: 12, modelMicroProtons: 0 })
    expect(backgroundSweepReportedUsage({ computeSeconds: 121, inputTokens: 1, outputTokens: 1 })).toBeNull()
  })

  it('allows exactly one proxy call and releases only its own registration', () => {
    const calls = new MatrixBackgroundSweepModelCalls()
    const release = calls.begin('agent', call)
    expect(calls.take('agent')).toEqual(call)
    expect(calls.take('agent')).toBeNull()
    release()
    expect(calls.take('agent')).toBeNull()
  })

  it('does not let one run replace another active authorization', () => {
    const calls = new MatrixBackgroundSweepModelCalls()
    const release = calls.begin('agent', call)
    expect(() => calls.begin('agent', { ...call, authorizationId: '00000000-0000-4000-8000-c04e14565e14' })).toThrow(
      'matrix_background_sweep_busy'
    )
    release()
    expect(() => calls.begin('agent', call)).not.toThrow()
  })
})
