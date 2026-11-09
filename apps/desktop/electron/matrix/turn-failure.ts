/**
 * A failure's closed code for a log line: our own `matrix_…` code, the innermost one an error
 * carries (an executor's `matrix_hermes_outcome_unknown` keeps what it wrapped as its cause), a
 * timeout or an abort as such, and Hermes's RPC code when there is one; never an error's text.
 */
export function matrixTurnFailure(error: unknown): { code: string; rpcCode?: number } {
  let code = 'unexpected'
  let rpcCode: number | undefined
  let current = error

  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const item = current as { name?: unknown; message?: unknown; rpcCode?: unknown; code?: unknown; cause?: unknown }

    const own =
      item.name === 'TimeoutError'
        ? 'matrix_turn_timeout'
        : item.name === 'AbortError'
          ? 'matrix_turn_aborted'
          : typeof item.message === 'string' && /^matrix_[a-z0-9_]{1,80}$/.test(item.message)
            ? item.message
            : undefined

    if (own) {
      code = own
    }

    const rpc =
      typeof item.rpcCode === 'number' ? item.rpcCode : item.name === 'GatewayRpcError' ? item.code : undefined

    if (typeof rpc === 'number' && Number.isSafeInteger(rpc)) {
      rpcCode = rpc
    }

    current = item.cause
  }

  return rpcCode === undefined ? { code } : { code, rpcCode }
}

/** The RPC part of a log line (` rpc=4007`), or nothing. */
export function matrixFailureRpc(failure: { rpcCode?: number }): string {
  return failure.rpcCode === undefined ? '' : ` rpc=${failure.rpcCode}`
}

/** What main throws for a turn the owner stopped on purpose (Stop), so nothing resumes it. */
export const MATRIX_TURN_STOPPED = 'matrix_turn_stopped'

/** Whether any error in the chain says the owner stopped the turn. */
export function matrixTurnStopped(error: unknown): boolean {
  let current = error

  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const item = current as { message?: unknown; cause?: unknown }

    if (item.message === MATRIX_TURN_STOPPED) {
      return true
    }

    current = item.cause
  }

  return false
}
