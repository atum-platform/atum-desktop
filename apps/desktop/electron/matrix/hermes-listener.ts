import type {
  MatrixInvocationHint,
  MatrixInvocationResult,
  MatrixInvocationWatch,
  MatrixListeningState
} from '../../shared/matrix'

/**
 * A turn's outcome as the listener reads it, beyond what the window shows: `deferred` when
 * something refused it before dispatch (nothing ran and the claim stays, so it may be offered
 * again), and an unknown outcome that says the turn `failed` after dispatch (a closed code).
 * invokeMatrixHermes returns it; the window only ever sees MatrixInvocationResult. Kept here,
 * with no imports beyond shared types, so the renderer's tests can load the listener alone.
 */
export type MatrixTurnOutcome = MatrixInvocationResult | MatrixDeferredTurn | { state: 'unknown'; failed: string }

/**
 * A turn refused before dispatch, with what bounds its retries when known: `claimUntil`, when the
 * claim it keeps lapses (the platform's 120 s; a retry within it reuses that claim, one after it
 * takes a fresh one), and `retryBefore`, the end of its message's window (15 minutes for
 * automatic answering), past which a retry would only be refused.
 */
export interface MatrixDeferredTurn {
  state: 'deferred'
  reason: string
  claimUntil?: number
  retryBefore?: number
  /**
   * The message's window has already passed (a late phone message is answered, not refused): the
   * deferral reports no `retryBefore` on purpose, and a horizon an earlier attempt stored is
   * stale — reusing it would exhaust the count-bounded retries on the spot (invocation.ts;
   * hermes-listener.ts `defer`).
   */
  windowClosed?: true
  /**
   * The closed code of a run that failed after dispatch and was queued again (invocation.ts,
   * "resume instead of refuse"): unlike a refusal before dispatch it is a failure of this Mac's run,
   * counted toward stepping aside (`onTrouble`), so a Mac that keeps failing hands its agent over.
   */
  failed?: string
}

/**
 * A turn that ended without an answer, as the listener tells its owner (the lease lane's
 * failover): `deferred_exhausted` when a turn refused before dispatch ran out of retries,
 * `failed` when a turn failed after dispatch. `streak` counts such turns since the last
 * answered one; an answered turn resets it and says nothing.
 */
export interface MatrixListenerTrouble {
  kind: 'deferred_exhausted' | 'failed'
  streak: number
}

/**
 * A message's place in this Mac's line, handed to its turn (invocation.ts
 * `matrixAutomaticWindowEnd`): `queuedAt`, when this attempt began waiting (the watch received the
 * message, or it came back for a retry), and `windowEnd`, the end of its window an earlier attempt
 * reported. Time a phone message spends waiting behind the agent's other turns does not count
 * against its window: one that reached this Mac in time is answered in order, however long the
 * turns ahead of it take.
 */
export interface MatrixTurnLine {
  queuedAt: number
  windowEnd?: number
  /** Retries this message has already had in this watch (the next wait is MATRIX_DEFERRED_RETRY_MS[spent]). */
  spent?: number
  /** The claim an earlier attempt reported, which defer() also weighs on the last retry. */
  claimUntil?: number
}

/** A message in the listener's line, with when it began waiting there (MatrixTurnLine). */
interface MatrixQueuedHint extends MatrixInvocationHint {
  queuedAt: number
}

export interface MatrixHermesListenerOptions {
  /** Called on the listener's own thread after the outcome is recorded; it never throws into it. */
  onTrouble?: (event: MatrixListenerTrouble) => void
}

/**
 * How long a turn refused before dispatch waits before it is offered again, one entry per retry.
 * Together they fit inside the claim the first attempt took (120 s), so a round of attempts holds
 * one claim and, once it runs out, that claim lapses soon after for another Mac.
 */
export const MATRIX_DEFERRED_RETRY_MS = [5_000, 15_000, 45_000] as const

/**
 * A retry starts only with this much left of its message's window, and the last of a round only
 * with this much left of its claim: enough to reach dispatch on a slow link (invocation.ts still
 * refuses to dispatch on a claim about to lapse).
 */
export const MATRIX_DEFERRED_START_MARGIN_MS = 30_000

/** Temporary room admission + serial handoff, not a durable invocation ledger.
 * Actual authorization, deduplication and outcomes remain in invokeMatrixHermes. */
export class MatrixHermesListener {
  private active?: {
    watch: MatrixInvocationWatch
    abort: AbortController
    targets: MatrixQueuedHint[]
    committed: boolean
    running?: string
    stopped?: MatrixListeningState
    timer: ReturnType<typeof setTimeout>
    /** A deferred turn waiting for its retry: the queue holds behind it, so answers keep order. */
    retry?: { target: MatrixQueuedHint; timer: ReturnType<typeof setTimeout> }
    /** Stop admitting now, but let the one already executing finish under its captured fence. */
    draining?: { reason: MatrixListeningState['reason'] }
    /** Per message in this watch: retries spent in this round, and the bounds the turn last
     * reported (MatrixDeferredTurn). */
    deferrals: Map<string, { spent: number; claimUntil?: number; retryBefore?: number }>
    /** Messages whose round ran out: hints do not take them up again in this watch. */
    exhausted: Set<string>
    /** Exhausted messages waiting for their claim to lapse before another round. */
    revisits: Map<string, ReturnType<typeof setTimeout>>
    /** Per message in this watch, the end of its window its turn last reported (MatrixTurnLine),
     * kept across rounds until it has an outcome. */
    windows: Map<string, number>
  }
  private view?: MatrixListeningState
  /** Turns ended without an answer since the last answered one (MatrixListenerTrouble). */
  private streak = 0

  constructor(
    private readonly execute: (
      target: { roomId: string; eventId: string },
      watch: MatrixInvocationWatch,
      signal: AbortSignal,
      line: MatrixTurnLine
    ) => Promise<MatrixTurnOutcome>,
    private readonly changed: () => void,
    private readonly options: MatrixHermesListenerOptions = {}
  ) {}

  snapshot() {
    return this.view ? { ...this.view } : undefined
  }

  /** Logout ends consent AND forgets the previous account's room metadata. */
  clear() {
    this.stop()
    this.streak = 0

    if (this.view) {
      this.view = undefined
      this.changed()
    }
  }

  /**
   * Admit only the SDK watch's bounded hints until the SDK has acknowledged it.
   * A hint is never execution authority, and a late acknowledgement cannot
   * revive a superseded preparation.
   */
  prepare(watch: MatrixInvocationWatch) {
    this.stop()
    const abort = new AbortController()
    this.active = {
      watch,
      abort,
      targets: [],
      committed: false,
      timer: setTimeout(() => this.stop('expired'), Math.max(0, watch.until - Date.now())),
      deferrals: new Map(),
      exhausted: new Set(),
      revisits: new Map(),
      windows: new Map()
    }
  }

  /** Commits exactly one prepared SDK watch and drains only its queued hints. */
  commit(watchId: string) {
    const current = this.active

    if (!current || current.committed || current.watch.id !== watchId) {
      return false
    }

    if (Date.now() >= current.watch.until) {
      this.stop('expired')

      return false
    }

    current.committed = true
    this.view = { state: 'listening', roomId: current.watch.roomId, expiresAt: current.watch.until, queued: 0 }
    this.view.queued = current.targets.length
    this.changed()

    if (current.targets.length) {
      void this.drain(current)
    }

    return true
  }

  /**
   * The credential that admits this watch was renewed: the same executor and device, a later
   * expiry (credential-renewal.ts). The watch's end moves to `until(watch)`, never earlier.
   * It changes in place, so a turn already running reads the new end, and the watch that
   * comes back is the one to hand the SDK. Nothing changes when no watch is active or the
   * end would not move.
   */
  extend(until: (watch: Readonly<MatrixInvocationWatch>) => number): MatrixInvocationWatch | undefined {
    const current = this.active

    if (!current) {
      return undefined
    }

    const next = until(current.watch)

    if (!Number.isFinite(next) || next <= current.watch.until || next <= Date.now()) {
      return undefined
    }

    current.watch.until = next
    clearTimeout(current.timer)
    current.timer = setTimeout(() => this.stop('expired'), Math.max(0, next - Date.now()))

    if (current.committed && this.view) {
      this.view.expiresAt = next
      this.changed()
    }

    return { ...current.watch }
  }

  /** Existing callers receive the original immediate-listening behavior. */
  start(watch: MatrixInvocationWatch) {
    this.prepare(watch)
    this.commit(watch.id)
  }

  /** Recovered history precedes live hints received during the scan. Nothing
   * can execute until the exact watch is committed after readiness rechecks. */
  backfill(watchId: string, hints: unknown[]) {
    const current = this.active

    if (!current || current.committed || current.watch.id !== watchId) {
      return
    }

    const live = current.targets
    current.targets = []
    const now = Date.now()

    for (const hint of hints) {
      this.admit(hint, now)
    }

    // Live hints keep the time they began waiting.
    for (const hint of live) {
      this.admit(hint, hint.queuedAt)
    }
  }

  stop(reason: MatrixListeningState['reason'] = 'cancelled', result?: MatrixInvocationResult['state']) {
    const current = this.active

    if (!current) {
      return
    }

    this.active = undefined
    clearTimeout(current.timer)
    clearTimeout(current.retry?.timer)
    current.retry = undefined

    for (const timer of current.revisits.values()) {
      clearTimeout(timer)
    }

    current.revisits.clear()
    current.abort.abort()
    current.targets.length = 0
    const interruptedEventId = this.view?.roomId === current.watch.roomId ? this.view.interruptedEventId : undefined
    this.view = {
      state: 'stopped',
      roomId: current.watch.roomId,
      expiresAt: current.watch.until,
      queued: 0,
      reason,
      result,
      ...(interruptedEventId ? { interruptedEventId } : {})
    }
    current.stopped = this.view
    this.changed()
  }

  /** Policy handback: discard queued/retry work without aborting the one execution already
   * admitted. Once that execution settles, the watch stops and its signal is aborted. */
  drainAndStop(reason: MatrixListeningState['reason'] = 'cancelled'): void {
    const current = this.active

    if (!current) {
      return
    }

    current.draining = { reason }
    current.targets.length = 0
    clearTimeout(current.retry?.timer)
    current.retry = undefined

    for (const timer of current.revisits.values()) {
      clearTimeout(timer)
    }

    current.revisits.clear()

    if (this.view) {
      this.view.queued = 0
      this.changed()
    }

    if (!current.running) {
      this.stop(reason)
    }
  }

  offer(value: unknown) {
    this.admit(value, Date.now())
  }

  /** A hint joins the line, waiting since `queuedAt` (never from the hint itself). */
  private admit(value: unknown, queuedAt: number) {
    const current = this.active
    const hint = value as MatrixInvocationHint | null

    if (
      !current ||
      current.draining ||
      !hint ||
      hint.watchId !== current.watch.id ||
      hint.roomId !== current.watch.roomId ||
      typeof hint.eventId !== 'string' ||
      !hint.eventId.startsWith('$') ||
      hint.eventId.length > 1024
    ) {
      return
    }

    if (Date.now() >= current.watch.until) {
      this.stop('expired')

      return
    }

    if (
      hint.eventId === current.running ||
      hint.eventId === current.retry?.target.eventId ||
      current.exhausted.has(hint.eventId) ||
      current.targets.some(item => item.eventId === hint.eventId)
    ) {
      return
    }

    if (current.targets.length >= (current.watch.automatic ? 256 : 16)) {
      this.stop('overflow')

      return
    }

    current.targets.push({ watchId: hint.watchId, roomId: hint.roomId, eventId: hint.eventId, queuedAt })

    if (current.committed) {
      this.view!.queued = current.targets.length
      this.changed()
    }

    if (current.committed && !current.running && !current.retry) {
      void this.drain(current)
    }
  }

  /** The owner hears of a turn that ended unanswered; nothing it does reaches the listener. */
  private trouble(kind: MatrixListenerTrouble['kind']) {
    this.streak++

    try {
      this.options.onTrouble?.({ kind, streak: this.streak })
    } catch {
      // Failover is the owner's concern; listening goes on.
    }
  }

  /**
   * A turn refused before dispatch (nothing ran; its claim stays): offered again after its next
   * wait, ahead of anything that arrived meanwhile, with no status for the chat (a watch that ends
   * first takes the wait with it; the next watch's catch-up offers the message again).
   *
   * A round ends without a retry when the waits run out, when the retry would start too close to
   * the end of its message's window, or when the last one would start on a claim about to lapse
   * (taking a fresh claim just before giving up would hold another Mac off for a whole claim).
   * Then the owner hears once (onTrouble), the queue goes on, and the claim lapses; once it has,
   * the message comes back for another round while its window lasts. A Mac that keeps failing it
   * so reports again, and the owner's failover moves the agent to another Mac.
   * Returns whether the queue now waits for the retry.
   */
  private defer(
    current: NonNullable<MatrixHermesListener['active']>,
    target: MatrixQueuedHint,
    outcome: MatrixDeferredTurn
  ): boolean {
    const previous = current.deferrals.get(target.eventId)
    const spent = previous?.spent ?? 0
    // What this attempt reported, or else what an earlier one did (a read that failed early says
    // nothing). A late message reports no horizon on purpose — its retries are bounded by their
    // count alone — so the horizon an earlier attempt stored goes with it: it has already passed,
    // and standing in for the report would exhaust the retries on the spot.
    const claimUntil = outcome.claimUntil ?? previous?.claimUntil
    const retryBefore = outcome.windowClosed
      ? undefined
      : outcome.retryBefore ?? previous?.retryBefore ?? current.windows.get(target.eventId)

    if (outcome.windowClosed) {
      current.windows.delete(target.eventId)
    } else if (retryBefore !== undefined) {
      current.windows.set(target.eventId, retryBefore)
    }
    const wait = MATRIX_DEFERRED_RETRY_MS[spent]
    const now = Date.now()

    if (
      wait === undefined ||
      (retryBefore !== undefined && now + wait > retryBefore - MATRIX_DEFERRED_START_MARGIN_MS) ||
      (spent === MATRIX_DEFERRED_RETRY_MS.length - 1 &&
        claimUntil !== undefined &&
        now + wait > claimUntil - MATRIX_DEFERRED_START_MARGIN_MS)
    ) {
      current.deferrals.delete(target.eventId)
      current.exhausted.add(target.eventId)
      // Set before the owner hears: a stop it causes takes the revisit with it.
      this.revisit(current, target, now, claimUntil, retryBefore)
      this.trouble('deferred_exhausted')

      return false
    }

    current.deferrals.set(target.eventId, { spent: spent + 1, claimUntil, retryBefore })
    current.retry = {
      target,
      timer: setTimeout(() => {
        if (this.active !== current || current.retry?.target !== target) {
          return
        }

        current.retry = undefined
        // Back at the front of the line, waiting from now (MatrixTurnLine).
        current.targets.unshift({ ...target, queuedAt: Date.now() })
        this.view!.queued = current.targets.length
        this.changed()
        void this.drain(current)
      }, wait)
    }

    return true
  }

  /**
   * Another round for a message whose round ran out, once its claim has lapsed (a fresh claim, a
   * fresh round) and only while its window lasts. A message whose window is unknown (never read)
   * waits for the next watch's catch-up instead.
   */
  private revisit(
    current: NonNullable<MatrixHermesListener['active']>,
    target: MatrixQueuedHint,
    now: number,
    claimUntil: number | undefined,
    retryBefore: number | undefined
  ) {
    const at = Math.max(now, claimUntil ?? now) + MATRIX_DEFERRED_RETRY_MS[0]

    if (retryBefore === undefined || at > retryBefore - MATRIX_DEFERRED_START_MARGIN_MS) {
      current.windows.delete(target.eventId)

      return
    }

    clearTimeout(current.revisits.get(target.eventId))
    current.revisits.set(
      target.eventId,
      setTimeout(() => {
        if (this.active !== current) {
          return
        }

        current.revisits.delete(target.eventId)
        current.exhausted.delete(target.eventId)
        this.offer(target)
      }, at - now)
    )
  }

  private async drain(current: NonNullable<MatrixHermesListener['active']>) {
    while (this.active === current && current.committed && !current.retry && current.targets.length) {
      const target = current.targets.shift()!
      current.running = target.eventId
      this.view!.queued = current.targets.length
      this.changed()

      try {
        current.abort.signal.throwIfAborted()

        const windowEnd = current.windows.get(target.eventId)

        const outcome = await this.execute(
          { roomId: target.roomId, eventId: target.eventId },
          current.watch,
          current.abort.signal,
          {
            queuedAt: target.queuedAt,
            ...(windowEnd !== undefined ? { windowEnd } : {}),
            spent: current.deferrals.get(target.eventId)?.spent ?? 0,
            ...(current.deferrals.get(target.eventId)?.claimUntil !== undefined
              ? { claimUntil: current.deferrals.get(target.eventId)?.claimUntil }
              : {})
          }
        )

        if (outcome.state === 'published') {
          this.streak = 0
        }

        if (this.active !== current) {
          if (outcome.state !== 'deferred' && current.stopped && this.view === current.stopped) {
            this.view.result = outcome.state

            if (current.watch.automatic && outcome.state === 'unknown') {
              this.view.interruptedEventId = target.eventId
            }

            this.changed()
          }

          return
        }

        if (current.draining) {
          this.stop(current.draining.reason, outcome.state === 'deferred' ? undefined : outcome.state)

          return
        }

        if (outcome.state !== 'deferred') {
          current.windows.delete(target.eventId)
        }

        if (outcome.state === 'deferred') {
          current.running = undefined

          // A run that failed and was queued again counts as the failure it was. Reporting it may
          // end this watch (a Mac that steps aside), which takes the queue's retries with it.
          if (outcome.failed && !current.abort.signal.aborted) {
            this.trouble('failed')

            if (this.active !== current) {
              return
            }
          }

          if (this.defer(current, target, outcome)) {
            return
          }

          continue
        }

        this.view!.result = outcome.state
        const failed = 'failed' in outcome && !current.abort.signal.aborted

        if (current.watch.automatic && outcome.state === 'unknown') {
          // The shared ledger fences this event permanently. Later independent
          // questions can still run; retain a typed recovery signal for the UI.
          this.view!.interruptedEventId = target.eventId
          this.changed()

          if (failed) {
            this.trouble('failed')
          }

          continue
        }

        if (outcome.state !== 'published' && outcome.state !== 'ignored') {
          this.stop('unavailable', outcome.state)

          if (failed) {
            this.trouble('failed')
          }

          return
        }
      } catch {
        if (this.active === current) {
          this.stop(current.draining?.reason ?? 'unavailable')
        }

        return
      } finally {
        current.running = undefined
      }

      this.changed()
    }
  }
}
