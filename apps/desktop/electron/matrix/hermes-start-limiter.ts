/**
 * A small abortable gate around the expensive Python import/bind phase of `hermes serve`.
 *
 * Starting every rostered agent at once made six copies discover plugins and import the
 * gateway together. On the 0.19.2 candidate that resource stampede left one child alive but
 * unable to announce its port for the full 90-second backend deadline, after which main
 * killed it and retried. Two concurrent cold starts keep the machine busy without turning
 * startup into that retry cliff. The permit is released as soon as the port is announced;
 * running agents are not limited.
 */
interface HermesStartWaiter {
  resolve: (release: () => void) => void
  reject: (reason?: unknown) => void
  signal: AbortSignal
  abort: () => void
}

export class HermesStartLimiter {
  private active = 0
  private readonly waiting: HermesStartWaiter[] = []

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('matrix_hermes_start_limit_invalid')
    }
  }

  acquire(signal: AbortSignal): (() => void) | Promise<() => void> {
    signal.throwIfAborted()

    if (this.active < this.limit) {
      this.active += 1

      // Keep an available permit synchronous. `openMatrixHermes` historically spawned before
      // returning its promise; wrapping the fast path in an already-resolved Promise introduces
      // a microtask in which an immediate caller abort can win before the child and its shutdown
      // listener exist. Queued starts still await the real capacity boundary below.
      return this.releaseOnce()
    }

    return new Promise((resolve, reject) => {
      let waiter: HermesStartWaiter

      waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiting.indexOf(waiter)

          if (index >= 0) {
            this.waiting.splice(index, 1)
          }

          reject(signal.reason ?? new Error('matrix_hermes_runtime_stopped'))
        }
      }

      this.waiting.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
    })
  }

  private releaseOnce(): () => void {
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.active -= 1
      this.next()
    }
  }

  private next(): void {
    while (this.active < this.limit) {
      const waiter = this.waiting.shift()

      if (!waiter) {
        return
      }

      waiter.signal.removeEventListener('abort', waiter.abort)

      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error('matrix_hermes_runtime_stopped'))
        continue
      }

      this.active += 1
      waiter.resolve(this.releaseOnce())
    }
  }
}

/** Shared only by this Electron main process. A permit covers startup, not process life. */
export const matrixHermesStarts = new HermesStartLimiter(2)
