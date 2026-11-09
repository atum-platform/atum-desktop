export interface MatrixRosterScope {
  accountKey: string
  generation: number
}

export type MatrixRosterSync<T> =
  | { state: 'idle' }
  | { state: 'cancelled' }
  | { state: 'failed' }
  | { state: 'synced'; roster: T; generation: number; scope: MatrixRosterScope }

export interface MatrixRosterRecoveryOptions<T> {
  scope(): MatrixRosterScope | null
  fetch(signal: AbortSignal): Promise<T>
}

function sameScope(left: MatrixRosterScope | null, right: MatrixRosterScope | null): boolean {
  return left?.accountKey === right?.accountKey && left?.generation === right?.generation
}

/**
 * A small owner-fenced roster fetch. Read failures leave the last authoritative roster
 * intact; only a successful fetch is handed back to main for reconciliation.
 */
export class MatrixRosterRecovery<T> {
  private generation = 0
  private requestGeneration = 0
  private wanted = true
  private running?: Promise<MatrixRosterSync<T>>
  private abort?: AbortController

  /** Ask for a new authoritative read; normal watch ticks are no-ops once it succeeds. */
  request(): void {
    this.wanted = true
    this.requestGeneration += 1
  }

  /** Sign-out/account replacement invalidates an in-flight response and aborts its read. */
  invalidate(): void {
    this.generation += 1
    this.wanted = true
    this.abort?.abort()
  }

  isCurrent(result: Extract<MatrixRosterSync<T>, { state: 'synced' }>, scope: MatrixRosterScope | null): boolean {
    return result.generation === this.generation && sameScope(result.scope, scope)
  }

  sync(options: MatrixRosterRecoveryOptions<T>): Promise<MatrixRosterSync<T>> {
    if (!this.wanted) {
      return Promise.resolve({ state: 'idle' })
    }

    if (this.running) {
      return this.running
    }

    const scope = options.scope()

    if (!scope) {
      return Promise.resolve({ state: 'cancelled' })
    }

    const generation = this.generation
    const requestGeneration = this.requestGeneration
    const abort = new AbortController()
    this.abort = abort

    const running = (async (): Promise<MatrixRosterSync<T>> => {
      try {
        const roster = await options.fetch(abort.signal)

        if (abort.signal.aborted || generation !== this.generation || !sameScope(scope, options.scope())) {
          return { state: 'cancelled' }
        }

        // A manual refresh requested while this read was in flight gets the next watch
        // slot. It never starts a competing request, and it is not silently consumed.
        this.wanted = requestGeneration !== this.requestGeneration

        return { state: 'synced', roster, generation, scope }
      } catch {
        // Cancellation and account replacement are not transport failures. In either case
        // main must not interpret the absence of a response as an empty roster.
        return abort.signal.aborted || generation !== this.generation || !sameScope(scope, options.scope())
          ? { state: 'cancelled' }
          : { state: 'failed' }
      } finally {
        if (this.abort === abort) {
          this.abort = undefined
        }
      }
    })()

    this.running = running
    void running.finally(() => {
      if (this.running === running) {
        this.running = undefined
      }
    })

    return running
  }
}

/** The two wakes that can mean the Mac moved: sleep/wake and lock/unlock (A38). */
export interface MatrixRosterWakeSource {
  on(event: 'resume' | 'unlock-screen', listener: () => void): unknown
}

/**
 * Ask for one authoritative roster read on wake and let the caller's existing watch path
 * carry it. There is no timer here and no second read: a read already running coalesces.
 */
export function refreshMatrixRosterOnWake(
  source: MatrixRosterWakeSource,
  roster: Pick<MatrixRosterRecovery<unknown>, 'request'>,
  sync: () => void
): void {
  const refresh = () => {
    roster.request()
    sync()
  }

  source.on('resume', refresh)
  source.on('unlock-screen', refresh)
}
