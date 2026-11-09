/**
 * One Hermes turn at a time (plan  §4.3,
 * "the room lock"). This Mac runs one Hermes executor, which serves one turn at a time,
 * so the lock is global: it serializes local turns, the listening watch, an explicit
 * "Run Hermes" and the model configuration that restarts the executor. A second turn
 * waits in FIFO order; it never surfaces as an unknown outcome.
 */
export class MatrixHermesTurnLock {
  private held?: { roomId: string; label: string; since: number }
  private readonly queue: Array<{
    roomId: string
    label: string
    grant: () => void
    signal?: AbortSignal
    abort?: () => void
  }> = []

  /** What holds the lock (for logs and the UI's waiting state), if anything. */
  get holder(): { roomId: string; label: string; since: number } | undefined {
    return this.held ? { ...this.held } : undefined
  }

  get waiting(): number {
    return this.queue.length
  }

  /** Resolves with a release function once this caller holds the lock; rejects if aborted first. */
  acquire(roomId: string, label: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()

    return new Promise((resolve, reject) => {
      const entry = {
        roomId,
        label,
        signal,
        grant: () => {
          if (entry.abort) {
            signal?.removeEventListener('abort', entry.abort)
          }

          resolve(this.grantTo(roomId, label))
        },
        abort: undefined as (() => void) | undefined
      }

      if (signal) {
        entry.abort = () => {
          const index = this.queue.indexOf(entry)

          if (index >= 0) {
            this.queue.splice(index, 1)
            reject(signal.reason ?? new Error('aborted'))
          }
        }

        signal.addEventListener('abort', entry.abort, { once: true })
      }

      this.queue.push(entry)

      if (!this.held) {
        this.next()
      }
    })
  }

  /**
   * The lock if it is free this instant, else null: it never waits, and a lock that is free always has an empty queue (a release
   * hands the lock straight to the first waiter). For the one caller that must not queue behind a turn: a checkpoint holding the
   * home's writers still for the moment it takes a snapshot (agent-home-placement/at-rest.ts `agentHoldWrites`). A turn that asks
   * while it is held is not refused, only kept waiting in FIFO order until it is let go.
   */
  tryAcquire(roomId: string, label: string): (() => void) | null {
    return this.held ? null : this.grantTo(roomId, label)
  }

  /** Make the caller the holder, and hand back the release that lets the next waiter in (a second call does nothing). */
  private grantTo(roomId: string, label: string): () => void {
    this.held = { roomId, label, since: Date.now() }
    let released = false

    return () => {
      if (!released) {
        released = true
        this.held = undefined
        this.next()
      }
    }
  }

  private next(): void {
    const entry = this.queue.shift()
    entry?.grant()
  }
}
