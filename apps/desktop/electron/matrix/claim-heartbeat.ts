export const MATRIX_CLAIM_HEARTBEAT_MS = 30_000
export const MATRIX_CLAIM_HEARTBEAT_RETRY_MS = 5_000

export interface MatrixClaimHeartbeatGrant {
  invocationId: string
  state: string
  expiresAt: number
}

export interface MatrixClaimHeartbeat {
  readonly signal: AbortSignal
  readonly expiresAt: number
  stop(): Promise<void>
}

/**
 * Re-arm one dispatched claim without changing its fence. The first heartbeat is awaited so a
 * client meeting an older platform can retain the old static deadline. Once supported, transport
 * failures retry inside the last acknowledged claim; silence past that bound aborts the run and
 * lets the existing settlement path recover it.
 */
export async function startMatrixClaimHeartbeat(
  invocationId: string,
  rearm: () => Promise<MatrixClaimHeartbeatGrant>,
  options: { heartbeatMs?: number; retryMs?: number } = {}
): Promise<MatrixClaimHeartbeat> {
  const heartbeatMs = options.heartbeatMs ?? MATRIX_CLAIM_HEARTBEAT_MS
  const retryMs = options.retryMs ?? MATRIX_CLAIM_HEARTBEAT_RETRY_MS

  if (![heartbeatMs, retryMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('matrix_invocation_claim_heartbeat_invalid')
  }

  const accepted = async () => {
    const grant = await rearm()

    if (
      grant.invocationId !== invocationId ||
      grant.state !== 'dispatched' ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= Date.now()
    ) {
      throw new Error('matrix_invocation_claim_heartbeat_invalid')
    }

    return grant.expiresAt
  }

  let expiresAt = await accepted()
  let stopped = false
  let wake: ReturnType<typeof setTimeout> | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let active: Promise<void> = Promise.resolve()
  const lapsed = new AbortController()

  const clear = () => {
    if (wake !== undefined) {
      clearTimeout(wake)
    }
    if (expiry !== undefined) {
      clearTimeout(expiry)
    }
    wake = undefined
    expiry = undefined
  }

  const abortExpired = () => {
    if (!stopped && !lapsed.signal.aborted) {
      lapsed.abort(new Error('matrix_invocation_claim_expired'))
    }
  }

  const armExpiry = () => {
    if (expiry !== undefined) {
      clearTimeout(expiry)
    }
    expiry = setTimeout(abortExpired, Math.max(1, expiresAt - Date.now()))
    expiry.unref?.()
  }

  const schedule = (delayMs: number) => {
    if (stopped || lapsed.signal.aborted) {
      return
    }
    wake = setTimeout(
      () => {
        active = tick()
      },
      Math.max(1, Math.min(delayMs, expiresAt - Date.now()))
    )
    wake.unref?.()
  }

  const tick = async () => {
    wake = undefined

    if (stopped || lapsed.signal.aborted) {
      return
    }

    try {
      const nextExpiresAt = await accepted()

      if (stopped || lapsed.signal.aborted) {
        return
      }
      expiresAt = nextExpiresAt
      armExpiry()
      schedule(heartbeatMs)
    } catch {
      if (Date.now() >= expiresAt) {
        abortExpired()
      } else {
        schedule(retryMs)
      }
    }
  }

  armExpiry()
  schedule(heartbeatMs)

  return {
    signal: lapsed.signal,
    get expiresAt() {
      return expiresAt
    },
    async stop() {
      if (stopped) {
        return active
      }
      stopped = true
      clear()
      await active
    }
  }
}
