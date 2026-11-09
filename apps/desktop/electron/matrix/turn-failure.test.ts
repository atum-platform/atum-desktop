import { describe, expect, it } from 'vitest'

import { MATRIX_TURN_STOPPED, matrixFailureRpc, matrixTurnFailure, matrixTurnStopped } from './turn-failure'

describe('a failure’s closed code', () => {
  it('names the innermost code, a timeout or an abort as such, and Hermes’s RPC code', () => {
    const cause = Object.assign(new Error('raw provider detail'), { name: 'GatewayRpcError', code: 4007 })
    expect(matrixTurnFailure(new Error('matrix_hermes_outcome_unknown', { cause }))).toEqual({
      code: 'matrix_hermes_outcome_unknown',
      rpcCode: 4007
    })
    expect(matrixFailureRpc({ rpcCode: 4007 })).toBe(' rpc=4007')
    expect(matrixTurnFailure(new DOMException('late', 'TimeoutError'))).toEqual({ code: 'matrix_turn_timeout' })
    expect(matrixTurnFailure(new DOMException('stopped', 'AbortError'))).toEqual({ code: 'matrix_turn_aborted' })
    expect(matrixTurnFailure('anything else')).toEqual({ code: 'unexpected' })
  })
})

describe('a turn the owner stopped', () => {
  it('is found anywhere in the chain main wraps, and nowhere else', () => {
    const run = new Error('matrix_hermes_outcome_unknown', { cause: new DOMException('stopped', 'AbortError') })
    expect(matrixTurnStopped(new Error(MATRIX_TURN_STOPPED, { cause: run }))).toBe(true)
    expect(matrixTurnStopped(new Error('wrapper', { cause: new Error(MATRIX_TURN_STOPPED) }))).toBe(true)
    expect(matrixTurnStopped(run)).toBe(false)
    expect(matrixTurnStopped(undefined)).toBe(false)
    expect(matrixTurnStopped('matrix_turn_stopped')).toBe(false)
  })

  it('does not hide what ended the turn from the log line', () => {
    const wrapped = new Error(MATRIX_TURN_STOPPED, { cause: new Error('matrix_hermes_outcome_unknown') })
    expect(matrixTurnFailure(wrapped).code).toBe('matrix_hermes_outcome_unknown')
  })
})
