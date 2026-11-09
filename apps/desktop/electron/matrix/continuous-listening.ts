import type { MatrixListeningState } from '../../shared/matrix'

type PauseReason = NonNullable<MatrixListeningState['reason']>
export interface ContinuousListeningPreference {
  version: 1
  binding: string
  roomId: string
  enabledAt: number
  requiresResume?: 'unavailable' | 'overflow'
}

export type ContinuousListeningContext =
  | { state: 'ready' }
  | { state: 'waiting'; reason: PauseReason }
  | { state: 'foreign' }

interface Options {
  automatic?: boolean
  store: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
  }
  context(preference: ContinuousListeningPreference): ContinuousListeningContext
  /** True while a new watch must wait without ending anything: a host whose sync is reconnecting
   * (host-health.ts). A watch already armed keeps listening; nothing here retries by itself, so
   * the owner calls `reconcile` when it turns false. */
  holdArm?(): boolean
  arm(preference: ContinuousListeningPreference, signal: AbortSignal): Promise<void>
  stop(): void
  listener(): MatrixListeningState | undefined
  changed(): void
  /** Automatic listening is retrying after a failure (an overflowing watch, an incomplete
   * catch-up, an unexplained arm failure, a watch stopped unavailable). main's failover counts
   * these: a Mac stuck re-arming holds the agent's lease while answering nothing. */
  recovering?(reason: 'overflow' | 'unavailable'): void
  /** A watch armed: the recoveries above start over. */
  armed?(): void
  /** The arm was refused for a reason every Mac would meet the same (the room is an earlier
   * conversation and no main is named): it is tried again later, each refusal in a row waiting
   * longer, but never counted as this Mac's recovery, since handing the agent to another Mac
   * cannot help. main moves listening to the main when it can. */
  refused?(error: unknown): boolean
}

const KEY = 'matrix-continuous-listening-v1'
const RETRY_MS = 10_000
/** A refusal every Mac meets waits longer after each one in a row (10 s doubling), up to this. */
const REFUSED_RETRY_MAX_MS = 2 * 60_000

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export class MatrixContinuousListening {
  private preference?: ContinuousListeningPreference
  private generation = 0
  private opening?: AbortController
  private closed = false
  private blocked = false
  private disablePending = false
  private stopping = false
  private reason: PauseReason = 'renewing'
  private retry?: ReturnType<typeof setTimeout>
  /** Nothing stored: nobody chose here yet. */
  private unset = false
  /** The person's Stop is pending or saved: save it as a durable off, never a removal. */
  private optedOut = false
  /** Refusals every Mac meets, in a row: each waits longer. A watch that arms, or a new room,
   * starts over. */
  private refusals = 0

  constructor(private readonly options: Options) {
    try {
      const saved = options.store.getItem(KEY)
      this.unset = saved === null
      const value = JSON.parse(saved ?? 'null') as Partial<ContinuousListeningPreference> | null

      if (
        value?.version === 1 &&
        typeof value.binding === 'string' &&
        /^[a-f0-9]{64}$/.test(value.binding) &&
        typeof value.roomId === 'string' &&
        value.roomId.startsWith('!') &&
        value.roomId.length > 1 &&
        value.roomId.length <= 1024 &&
        typeof value.enabledAt === 'number' &&
        Number.isFinite(value.enabledAt) &&
        (value.requiresResume === undefined ||
          value.requiresResume === 'unavailable' ||
          value.requiresResume === 'overflow')
      ) {
        const { requiresResume, ...rest } = value as ContinuousListeningPreference

        // Only a resume the person can still give holds listening back (not automatic).
        if (requiresResume && !options.automatic) {
          this.preference = value as ContinuousListeningPreference
          this.blocked = true
          this.reason = requiresResume
        } else {
          this.preference = rest
        }
      }
    } catch {
      // An unreadable preference must never become implicit consent.
    }
  }

  get enabled(): boolean {
    return Boolean(this.preference) && !this.closed
  }

  /** Nobody chose here yet: main may turn keep listening on for the agent's own chat. */
  get awaitsDefault(): boolean {
    return this.unset && !this.preference && !this.closed
  }

  get roomId(): string | undefined {
    return this.enabled ? this.preference?.roomId : undefined
  }

  /** A failed/uncertain dispatch waits for explicit resume (never automatic), not lease ownership. */
  get wantsLease(): boolean {
    return this.enabled && !this.blocked && !this.disablePending
  }

  enable(binding: string, roomId: string): void {
    if (this.closed) {
      throw new Error('matrix_listener_closed')
    }

    if (!/^[a-f0-9]{64}$/.test(binding) || !roomId.startsWith('!') || roomId.length < 2 || roomId.length > 1024) {
      throw new Error('matrix_listener_invalid')
    }

    const preference: ContinuousListeningPreference = { version: 1, binding, roomId, enabledAt: Date.now() }
    // Persist before doing anything that can admit a message. A failed write
    // leaves the old preference and never grants a new room.
    this.options.store.setItem(KEY, JSON.stringify(preference))
    this.pause('busy')
    this.preference = preference
    this.refusals = 0
    this.unset = false
    this.optedOut = false
    this.blocked = false
    this.disablePending = false
    this.options.changed()
    this.reconcile()
  }

  /** The person's Stop: saved as a durable off, so the default never turns it back on. */
  switchOff(): void {
    this.optedOut = true
    this.unset = false
    this.disable()
  }

  disable(): void {
    this.pause('cancelled')
    this.blocked = true
    this.disablePending = true

    try {
      this.saveDisabled()
    } catch (error) {
      // Both disk operations failed: Stop is effective now, but was not saved.
      // Keep that failed choice visible and retryable rather than claiming off.
      this.reason = 'storage'
      throw error
    } finally {
      this.options.changed()
    }
  }

  private saveDisabled(): void {
    if (this.optedOut) {
      // Null is a durable off marker in the same encrypted store. A failed write stays
      // pending and is retried, never replaced by a removal the default would undo.
      this.options.store.setItem(KEY, 'null')
    } else {
      try {
        this.options.store.removeItem(KEY)
        this.unset = true
      } catch {
        // A replacement may succeed where deletion failed (an off the default respects).
        this.options.store.setItem(KEY, 'null')
      }
    }

    this.preference = undefined
    this.blocked = false
    this.disablePending = false
  }

  private context(preference: ContinuousListeningPreference): ContinuousListeningContext {
    try {
      return this.options.context(preference)
    } catch {
      return { state: 'waiting', reason: 'unavailable' }
    }
  }

  private holding(): boolean {
    try {
      return this.options.holdArm?.() === true
    } catch {
      return false
    }
  }

  /** Internal interruption keeps intent; failed/uncertain dispatch requires an
   * explicit confirmed resume, not a readiness/publish-driven retry loop. Automatic
   * listening instead retries after ten seconds: bounded, and never a publish loop. */
  pause(reason: PauseReason, requireResume = false): void {
    if (this.retry) {
      clearTimeout(this.retry)
    }

    const gate = requireResume && !this.options.automatic
    this.retry = undefined
    this.generation += 1
    this.opening?.abort()
    this.opening = undefined
    this.reason = reason
    this.blocked ||= gate
    this.stopping = true

    try {
      this.options.stop()
    } finally {
      this.stopping = false
    }

    if (requireResume && this.options.automatic && this.preference) {
      this.retryLater()
      this.tell(() => this.options.recovering?.(reason === 'overflow' ? 'overflow' : 'unavailable'))
    }

    if (gate && this.preference && (reason === 'unavailable' || reason === 'overflow')) {
      this.preference = { ...this.preference, requiresResume: reason }

      try {
        this.options.store.setItem(KEY, JSON.stringify(this.preference))
      } catch {
        // Keep the local pause even if storage becomes unavailable. Existing
        // invocation outcomes independently fence uncertain events on restart.
        console.warn('[Matrix] could not persist continuous-listening pause')
      }
    }
  }

  listenerChanged(): void {
    const current = this.options.listener()

    if (this.stopping || !this.enabled || current?.state !== 'stopped') {
      return
    }

    if (current.reason === 'unavailable' || current.reason === 'overflow') {
      // Automatic listening retries after ten seconds (pause); a manual one waits for resume.
      this.pause(current.reason, true)
    } else if (current.reason === 'expired') {
      this.pause('renewing')
    }
  }

  dispose(): void {
    this.closed = true
    this.pause('cancelled')

    if (this.disablePending) {
      try {
        this.saveDisabled()
      } catch {
        /* Already surfaced; no execution authority remains. */
      }
    }
  }

  private refusedEverywhere(error: unknown): boolean {
    try {
      return this.options.refused?.(error) === true
    } catch {
      return false
    }
  }

  /** The owner's failover hears; nothing it does reaches this controller. */
  private tell(run: () => void): void {
    try {
      run()
    } catch {
      /* The lease and the next reconcile own recovery. */
    }
  }

  private retryLater(delayMs = RETRY_MS): void {
    if (this.closed || this.retry) {
      return
    }

    this.retry = setTimeout(() => {
      this.retry = undefined
      this.reconcile()
    }, delayMs)
    this.retry.unref?.()
  }

  snapshot(): MatrixListeningState | undefined {
    if (!this.enabled || !this.preference) {
      return undefined
    }

    const current = this.options.listener()
    const sameRoom = current?.roomId === this.preference.roomId ? current : undefined

    if (current?.state === 'listening' && current.roomId === this.preference.roomId) {
      return { ...current, mode: 'continuous' }
    }

    return {
      mode: 'continuous',
      state: 'paused',
      roomId: this.preference.roomId,
      expiresAt: sameRoom?.expiresAt ?? 0,
      queued: 0,
      reason: this.reason,
      ...(sameRoom?.result ? { result: sameRoom.result } : {}),
      ...(sameRoom?.interruptedEventId ? { interruptedEventId: sameRoom.interruptedEventId } : {})
    }
  }

  reconcile(): void {
    if (this.disablePending && !this.closed) {
      try {
        this.saveDisabled()
        this.options.changed()
      } catch {
        /* Retry only on a later lifecycle event, never a publish loop. */
      }

      return
    }

    const preference = this.preference

    if (!preference || this.closed || this.blocked || this.retry) {
      return
    }

    const context = this.context(preference)

    if (context.state === 'foreign') {
      this.disable()

      return
    }

    if (context.state === 'waiting') {
      const changed =
        this.reason !== context.reason || Boolean(this.opening) || this.options.listener()?.state === 'listening'

      if (changed) {
        this.pause(context.reason)
        this.options.changed()
      }

      return
    }

    if (this.opening || this.options.listener()?.state === 'listening') {
      return
    }

    // Context says ready, but a host's sync is reconnecting: wait, and neither pause nor fail.
    if (this.holding()) {
      return
    }

    const generation = ++this.generation
    const abort = new AbortController()
    this.opening = abort
    void this.options
      .arm(preference, abort.signal)
      .then(
        () => {
          if (this.generation === generation && !this.closed) {
            this.refusals = 0
            this.tell(() => this.options.armed?.())
          }
        },
        error => {
          if (this.generation !== generation || this.closed) {
            return
          }

          const current = this.context(preference)

          if (current.state === 'foreign') {
            try {
              this.disable()
            } catch {
              /* Pending Stop remains fenced and visible. */
            }
          } else if (current.state === 'waiting') {
            this.pause(current.reason)
          } else if (this.options.automatic && this.refusedEverywhere(error)) {
            // Tried again like any automatic failure, but not this Mac's to hand over: no recovery
            // is counted. Each refusal in a row waits longer (10 s, 20 s ... 2 min), since each
            // arm is a full server read; a re-point to the main (enable) arms at once.
            this.refusals += 1
            this.pause('unavailable')
            this.retryLater(Math.min(REFUSED_RETRY_MAX_MS, RETRY_MS * 2 ** (this.refusals - 1)))
          }
          // An unexplained failure while still ready needs explicit resume (automatic
          // listening retries after ten seconds); publish-driven retries would otherwise
          // spin without a backoff.
          else {
            this.pause('unavailable', true)
          }
        }
      )
      .finally(() => {
        if (this.generation === generation) {
          this.opening = undefined
        }

        this.options.changed()
      })
  }
}
