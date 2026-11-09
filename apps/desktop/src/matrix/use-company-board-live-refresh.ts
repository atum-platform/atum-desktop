import { useCallback, useEffect, useRef, useState } from 'react'

export const COMPANY_BOARD_POLL_INTERVAL_MS = 15_000
export const COMPANY_BOARD_POLL_MAX_BACKOFF_MS = 120_000

interface CompanyBoardLiveRefreshOptions<Value> {
  active: boolean
  apply(value: Value): void
  busy: boolean
  currentRevision: number | undefined
  identity: string
  readRevision(): Promise<number>
  refetch(): Promise<Value>
  revisionOf(value: Value): number
}

/**
 * `live`: the last background check reached the platform. `stale`: it didn't, so what is on screen may
 * be behind (shown, with a retry). `lost`: the platform said this person may no longer read the board
 * (signed out, removed, the company gone): checks stop and the board must not keep showing it.
 */
export type CompanyBoardFreshness = 'live' | 'stale' | 'lost'

/** The native refusals that are an answer about access, not a failed attempt (`MatrixCompanyNativeErrorCode`). */
const DEFINITIVE = new Set(['authentication', 'denied', 'missing'])

function definitive(error: unknown): boolean {
  return error instanceof Error && DEFINITIVE.has(error.message)
}

function foreground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Reconciles server-owned board state while this mounted board is in the foreground.
 * Revision reads are cheap; a page read happens only after the revision moves.
 */
export function useCompanyBoardLiveRefresh<Value>(options: CompanyBoardLiveRefreshOptions<Value>): {
  freshness: CompanyBoardFreshness
  retry(): void
} {
  const [freshness, setFreshness] = useState<CompanyBoardFreshness>('live')
  const optionsRef = useRef(options)
  const revisionRef = useRef(options.currentRevision)
  const pendingRef = useRef(false)
  const wakeRef = useRef<() => void>(() => {})

  optionsRef.current = options
  revisionRef.current = options.currentRevision

  useEffect(() => {
    setFreshness('live')

    if (!options.active) {
      pendingRef.current = false

      return
    }

    let alive = true
    let lost = false
    let running = false
    let queued = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = COMPANY_BOARD_POLL_INTERVAL_MS

    const clear = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    const schedule = (delay: number) => {
      clear()

      if (alive && optionsRef.current.active && foreground()) {
        timer = setTimeout(() => void check(), delay)
      }
    }

    const reconcile = async () => {
      if (optionsRef.current.busy) {
        pendingRef.current = true

        return
      }

      const value = await optionsRef.current.refetch()

      if (!alive) {
        return
      }

      // An edit or drag may have begun while the page request was in flight. Discard
      // that answer and re-read after the interaction so it can never overwrite intent.
      if (optionsRef.current.busy) {
        pendingRef.current = true

        return
      }

      optionsRef.current.apply(value)
      revisionRef.current = optionsRef.current.revisionOf(value)
      pendingRef.current = false
    }

    const check = async () => {
      timer = undefined

      if (!alive || lost || !optionsRef.current.active || !foreground()) {
        return
      }

      if (running) {
        queued = true

        return
      }

      running = true
      let succeeded = false

      try {
        if (pendingRef.current) {
          if (!optionsRef.current.busy) {
            await reconcile()
          }
        } else {
          const revision = await optionsRef.current.readRevision()

          if (!alive) {
            return
          }

          if (revision !== revisionRef.current) {
            if (optionsRef.current.busy) {
              pendingRef.current = true
            } else {
              await reconcile()
            }
          }
        }

        succeeded = true

        if (alive) {
          setFreshness('live')
        }
      } catch (error) {
        // The board stays usable on a failed check, but says it may be behind; the next check backs
        // off to at most two minutes. A refusal about access ends the checks for good.
        if (alive) {
          lost = definitive(error)
          setFreshness(lost ? 'lost' : 'stale')
        }
      } finally {
        running = false

        if (alive && !lost) {
          retryDelay = succeeded
            ? COMPANY_BOARD_POLL_INTERVAL_MS
            : Math.min(retryDelay * 2, COMPANY_BOARD_POLL_MAX_BACKOFF_MS)
          const delay = queued ? 0 : retryDelay
          queued = false
          schedule(delay)
        }
      }
    }

    const wake = () => {
      clear()

      if (!alive || lost || !optionsRef.current.active || !foreground()) {
        return
      }

      if (running) {
        queued = true
      } else {
        schedule(0)
      }
    }

    const pause = () => clear()
    const visibility = () => (document.visibilityState === 'visible' ? wake() : pause())

    // Future Matrix company-room push can call this same wake-up seam; the revision
    // read remains authoritative so a dropped or duplicated signal cannot corrupt state.
    wakeRef.current = wake
    window.addEventListener('focus', wake)
    window.addEventListener('blur', pause)
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', visibility)
    schedule(COMPANY_BOARD_POLL_INTERVAL_MS)

    return () => {
      alive = false
      pendingRef.current = false
      wakeRef.current = () => {}

      clear()
      window.removeEventListener('focus', wake)
      window.removeEventListener('blur', pause)
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [options.active, options.identity])

  useEffect(() => {
    if (!options.busy && pendingRef.current) {
      wakeRef.current()
    }
  }, [options.busy])

  // Retry checks at once, whatever the backoff; a foreground focus does the same.
  const retry = useCallback(() => wakeRef.current(), [])

  return { freshness, retry }
}
