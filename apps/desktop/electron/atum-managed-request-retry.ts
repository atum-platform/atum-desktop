/** Retry admission and recovery of one server-idempotent request, never a new request. */
export const MANAGED_RETRY_DEADLINE_MS = 120_000
export const MANAGED_RETRY_MAX_ATTEMPTS = 60
const MAX_TRANSPORT_ATTEMPTS = 3

interface RetryableError {
  code: string | null
  retryable: boolean
}

export function managedRetryError(value: unknown): RetryableError {
  const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}

  const error = payload.error && typeof payload.error === 'object'
    ? payload.error as Record<string, unknown> : {}

  return {
    code: typeof payload.error === 'string' ? payload.error : typeof error.code === 'string' ? error.code : null,
    retryable: payload.retryable === true || error.retryable === true
  }
}

export function managedResponseCanRetry(status: number, value: unknown): boolean {
  const error = managedRetryError(value)

  // Only the server knows whether an earlier provider attempt has a safe
  // unbilled outcome. A generic 5xx is never proof it is safe to dispatch again.
  return error.retryable && (
    status === 429 || (status === 409 && error.code === 'managed_request_in_progress')
  )
}

export function managedRetryDelay(attempt: number, retryAfter: string | null, now = Date.now()): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
  const date = retryAfter === null ? Number.NaN : Date.parse(retryAfter)

  const serverDelay = Number.isFinite(seconds) ? Math.max(0, seconds * 1_000)
    : Number.isFinite(date) ? Math.max(0, date - now) : 0

  const backoff = Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5))

  return Math.max(serverDelay, Math.round(backoff * (0.75 + Math.random() * 0.5)))
}

export function managedTransportCanRecover(attempt: number): boolean {
  return attempt < MAX_TRANSPORT_ATTEMPTS
}

export async function waitManagedRetry(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}
