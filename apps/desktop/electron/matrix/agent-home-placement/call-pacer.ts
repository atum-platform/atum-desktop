/**
 * How often each background call to the platform may be made.
 *
 * The owner-scoped buckets behind `atum.agent-home/2.5` (read, mutation, catalog) are shared by every agent on every
 * device of the owner, so no loop here may beat at a fixed short interval: a call that succeeded says when it is next
 * worth making, a call that failed backs off exponentially (and never sooner than the platform's own `Retry-After`),
 * and a fleet of Macs is spread out with a little jitter.
 */
export interface CallPacerOptions {
  now?(): number
  random?(): number
  /** First retry delay after a failure. */
  baseMs?: number
  /** The longest a failing call waits between tries. */
  maxMs?: number
}

interface Slot {
  notBefore: number
  failures: number
}

const DEFAULT_BASE_MS = 15_000
const DEFAULT_MAX_MS = 10 * 60_000
const JITTER = 0.1

export class CallPacer {
  private readonly slots = new Map<string, Slot>()

  constructor(private readonly options: CallPacerOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private jitter(ms: number): number {
    const random = this.options.random?.() ?? Math.random()

    return Math.round(ms * (1 + (random * 2 - 1) * JITTER))
  }

  /** Whether the call is worth making now. */
  due(key: string): boolean {
    return (this.slots.get(key)?.notBefore ?? 0) <= this.now()
  }

  /** The call went through: the next one is due in about `nextInMs`. */
  ok(key: string, nextInMs: number): void {
    this.slots.set(key, { notBefore: this.now() + this.jitter(nextInMs), failures: 0 })
  }

  /** The call failed: back off from `baseMs` doubling to `maxMs`, and wait at least as long as the platform asked. */
  failed(key: string, retryAfterMs?: number): void {
    const failures = (this.slots.get(key)?.failures ?? 0) + 1
    const backoff = Math.min(this.options.maxMs ?? DEFAULT_MAX_MS, (this.options.baseMs ?? DEFAULT_BASE_MS) * 2 ** (failures - 1))

    this.slots.set(key, { notBefore: this.now() + Math.max(this.jitter(backoff), retryAfterMs ?? 0), failures })
  }

  /** Worth asking again at once (something just happened that the answer depends on). Keeps the failure count. */
  wake(key: string): void {
    const slot = this.slots.get(key)

    if (slot) {this.slots.set(key, { ...slot, notBefore: 0 })}
  }

  forget(key: string): void {
    this.slots.delete(key)
  }

  /** Forget every key that starts with the prefix (an agent that is gone, an account that changed). */
  forgetPrefix(prefix: string): void {
    for (const key of [...this.slots.keys()]) {
      if (key.startsWith(prefix)) {this.slots.delete(key)}
    }
  }

  clear(): void {
    this.slots.clear()
  }
}
