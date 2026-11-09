/**
 * How a Matrix client's sync state is read, in one place (reliability program R4,
 * ).
 *
 * matrix-js-sdk reports `RECONNECTING` after a dropped long-poll and `CATCHUP` once the network
 * is back; only `STOPPED`, a refused token or an outage that outlasts its grace is a real
 * outage. Atum used to read every state but `PREPARED`/`SYNCING` as "offline", so a five-second
 * Wi-Fi blip aborted running turns, released the answering lease and dropped every watch (the
 * lost reply of 2026-10-17). Every site that looks at a sync state asks this module instead.
 *
 *   alive     PREPARED, SYNCING, CATCHUP. CATCHUP counts: the first response after a blip is
 *             applied while the state is still CATCHUP, and its events are the ones that matter.
 *   degraded  RECONNECTING, and ERROR, for a grace period counted from the last good state.
 *             Still alive: running work continues and nothing is torn down; only new work waits.
 *   offline   STOPPED, a refused token (M_UNKNOWN_TOKEN), a state this module does not know, no
 *             good state yet, or a degraded stretch that outlasted its grace.
 *
 * The grace also bounds RECONNECTING. The SDK holds it for as long as its keep-alive polls a dead
 * network (sync.ts onSyncError waits for the keep-alive before it can count a third failure into
 * ERROR), so without a bound a Mac with no network would stay "degraded" for good.
 *
 * Pure and SDK-free: the desktop renderer, the cloud controller and the browser client all
 * import it by relative path.
 */

export type MatrixSyncHealth = 'alive' | 'degraded' | 'offline'

/** How long a degraded sync may last, counted from the last good state, before it is offline. */
export const MATRIX_SYNC_GRACE_MS = 120_000

const ALIVE_STATES: ReadonlySet<string> = new Set(['PREPARED', 'SYNCING', 'CATCHUP'])
const DEGRADED_STATES: ReadonlySet<string> = new Set(['RECONNECTING', 'ERROR'])

export interface MatrixSyncContext {
  /**
   * How long ago the last good state was. Omitted: just now (the first moment of a blip).
   * `null`: there has been none, so there is nothing to carry through a blip.
   */
  sinceGoodMs?: number | null
  /** The homeserver refused the token (see `matrixSyncTokenRefused`): offline whatever the grace. */
  tokenRefused?: boolean
  graceMs?: number
}

/** One sync state, read as health. Pure: the only clock is the context's `sinceGoodMs`. */
export function classifyMatrixSyncState(
  state: string | null | undefined,
  context: MatrixSyncContext = {}
): MatrixSyncHealth {
  if (typeof state !== 'string') {
    return 'offline'
  }

  // A refused token is offline whatever the state: a late CATCHUP must not revive it.
  if (context.tokenRefused === true) {
    return 'offline'
  }

  if (ALIVE_STATES.has(state)) {
    return 'alive'
  }

  if (!DEGRADED_STATES.has(state)) {
    return 'offline'
  }

  if (context.sinceGoodMs === null) {
    return 'offline'
  }

  return (context.sinceGoodMs ?? 0) < (context.graceMs ?? MATRIX_SYNC_GRACE_MS) ? 'degraded' : 'offline'
}

/**
 * The sync event's data says the token was refused (the account signed out elsewhere, or the
 * session ended). The SDK stops syncing on it; nothing about it is a blip.
 */
export function matrixSyncTokenRefused(data: unknown): boolean {
  const error = (data as { error?: unknown } | null | undefined)?.error

  return (
    typeof error === 'object' &&
    error !== null &&
    'errcode' in error &&
    (error as { errcode?: unknown }).errcode === 'M_UNKNOWN_TOKEN'
  )
}

/**
 * A sync response was just applied (`PREPARED` after the saved sync, `SYNCING` after each poll).
 * Not health: a reader that waits for fresh data (a receipt flush after coming back) asks this.
 */
export function matrixSyncApplied(state: string | null | undefined): boolean {
  return state === 'PREPARED' || state === 'SYNCING'
}

/**
 * Whether account data read from the client can be trusted, for a reader that decides on it (a
 * marker, a fence). Only a real sync makes it so (`SYNCING`; `PREPARED` too when the reader may
 * use the saved sync). A blip does not unmake it: RECONNECTING, CATCHUP and ERROR within the
 * grace keep what was true, since nothing changes while the long-poll is down. Offline does.
 */
export function matrixSyncedAfter(
  previous: boolean,
  state: string | null | undefined,
  health: MatrixSyncHealth,
  options: { prepared?: boolean } = {}
): boolean {
  if (health === 'offline') {
    return false
  }

  if (state === 'SYNCING') {
    return true
  }

  if (state === 'PREPARED') {
    return options.prepared === true
  }

  return previous
}

export interface MatrixSyncHealthTracker {
  /** Feed one sync event: the state, and the event's data (for a refused token). */
  observe(state: string | null | undefined, data?: unknown): MatrixSyncHealth
  /** The health right now. A degraded stretch that has outlasted its grace reads offline. */
  current(): MatrixSyncHealth
  dispose(): void
}

export interface MatrixSyncHealthOptions {
  graceMs?: number
  now?: () => number
  /**
   * Called when the health changes, including when a degraded stretch outlasts its grace (a
   * timer is armed for that only when this is given). A reader that merely asks `current` does
   * not need it.
   */
  onChange?: (health: MatrixSyncHealth, previous: MatrixSyncHealth) => void
}

/**
 * Follows one client's sync events as health. Starts offline until a good state is observed.
 * `lastGoodAt` is the last time the state was alive, so a long-poll that has been waiting counts
 * as good until it fails.
 */
export function createMatrixSyncHealth(options: MatrixSyncHealthOptions = {}): MatrixSyncHealthTracker {
  const graceMs = options.graceMs ?? MATRIX_SYNC_GRACE_MS
  const now = options.now ?? (() => Date.now())
  let state: string | null = null
  let lastGoodAt: number | null = null
  let tokenRefused = false
  let published: MatrixSyncHealth = 'offline'
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const evaluate = () =>
    classifyMatrixSyncState(state, {
      sinceGoodMs: lastGoodAt === null ? null : Math.max(0, now() - lastGoodAt),
      tokenRefused,
      graceMs
    })

  const settle = (): MatrixSyncHealth => {
    const next = evaluate()

    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }

    if (next === 'degraded' && options.onChange && !disposed && lastGoodAt !== null) {
      timer = setTimeout(
        () => {
          timer = undefined
          settle()
        },
        Math.max(1, lastGoodAt + graceMs - now())
      )
      ;(timer as { unref?: () => void }).unref?.()
    }

    if (next !== published) {
      const previous = published
      published = next

      if (!disposed) {
        options.onChange?.(next, previous)
      }
    }

    return next
  }

  return {
    observe(next, data) {
      state = typeof next === 'string' ? next : null

      // Only an applied sync response (PREPARED, SYNCING) clears a refused token: the refresh
      // worked. A CATCHUP alone proves only that the network answers.
      if (matrixSyncTokenRefused(data)) {
        tokenRefused = true
      } else if (matrixSyncApplied(state)) {
        tokenRefused = false
      }

      if (!tokenRefused && state !== null && ALIVE_STATES.has(state)) {
        lastGoodAt = now()
      }

      return settle()
    },
    current: evaluate,
    dispose() {
      disposed = true

      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }
}
