import { matrixAgentHoldsLaunch, type MatrixReadiness, type MatrixReadinessStep } from '../../shared/matrix'

/**
 * Readiness of the local assistant (plan 
 * §4.5): the gate that holds the loading screen, then the watch that keeps the chat honest.
 *
 * - The gate runs its steps in order and stops at the first that fails: `blocked`, with
 *   the step and a closed code, retried with backoff (5, 10, 30, 60 s, jittered). There is
 *   no way around it except Try again (`recheck`). A code in `waitsForEvent` (a recovery key,
 *   the person's Reconnect, a new sign-in) is never retried on a timer: nothing changes until
 *   that event, which starts the gate again (2026-10-05: 500 identical `recovery_required`
 *   checks on the Mac mini, and Atum Moon's handshake every two minutes). A retry keeps the
 *   block, and its `since`, on screen until it gets past that step (2026-10-06).
 * - The watch re-checks every 30 s ± 5 s. Two consecutive failures move `ready` to
 *   `degraded`; two consecutive successes move back. A single failure never changes the
 *   phase, so a flapping check never degrades. While degraded, re-checks back off.
 */
export type MatrixReadinessCheck =
  | { ok: true; code?: undefined }
  /** `retryAt`: the platform asked to wait until then (a 429's Retry-After). The gate stays
   * `starting` on this step, with the code, and runs again then: not blocked, not sooner. */
  | { ok: false; code: string; retryAt?: number }

export interface MatrixReadinessProbe {
  step: MatrixReadinessStep
  check(signal: AbortSignal): Promise<MatrixReadinessCheck>
  /** Retry through the normal watch backoff, but never change chat readiness. */
  nonBlocking?: boolean
}

export interface MatrixReadinessTimings {
  watchMs: number
  jitterMs: number
  backoffMs: readonly number[]
}

export const MATRIX_READINESS_TIMINGS: MatrixReadinessTimings = {
  watchMs: 30_000,
  jitterMs: 5_000,
  backoffMs: [5_000, 10_000, 30_000, 60_000]
}

/** Credential expiry first revokes the SDK host synchronously. Re-enrollment
 * must wait for the old Hermes executor to stop, then recheck current ownership.
 * Renewal ahead of expiry is credential-renewal.ts; when it did not land in time, the
 * ordinary gate owns retry/backoff. `stillCurrent` is the same account and executor, still
 * expired or renewed late: either way the gate starts the host again. */
export async function restartMatrixReadinessAfterExpiry(
  stopped: Promise<unknown>,
  stillCurrent: () => boolean,
  restart: () => void
): Promise<void> {
  await stopped

  if (stillCurrent()) {
    restart()
  }
}

/**
 * The line main writes once when an agent stops its gate (or waits on something), so it no
 * longer holds the cold start (shared `matrixAgentHoldsLaunch`): its
 * 8-character prefix and the gate's closed step and code. `undefined` while it still holds the
 * launch, and once it is past the gate (`ready`, or the watch's `degraded`).
 */
export function matrixLaunchExclusionLine(label: string, readiness: MatrixReadiness): string | undefined {
  if (
    readiness.phase === 'ready' ||
    readiness.phase === 'degraded' ||
    matrixAgentHoldsLaunch({ readiness })
  ) {
    return undefined
  }

  return `[Matrix] launch gate excludes agent ${label.slice(0, 8)} step=${readiness.step ?? 'none'} code=${readiness.code ?? 'unexpected'}`
}

export interface MatrixReadinessOptions {
  gate: readonly MatrixReadinessProbe[]
  watch: readonly MatrixReadinessProbe[]
  /** Blocked codes that only an event can change: the gate waits for `start`/`recheck`. */
  waitsForEvent?: ReadonlySet<string>
  onChange(readiness: MatrixReadiness): void
  log?(line: string): void
  now?(): number
  random?(): number
  timings?: MatrixReadinessTimings
}

/**
 * A cloud-only agent's local readiness work is the cloud's: Hermes, Atum's model and the
 * answering lease pass without touching this Mac. The signed-in step still needs the owner
 * here, and a `nonBlocking` probe never holds the gate, so both keep their real checks.
 * Used for the gate and the watch alike so a healthy cloud-only agent never reads blocked or
 * degraded for a local writer it intentionally does not have.
 */
export function matrixCloudOnlyReadiness(
  probes: readonly MatrixReadinessProbe[],
  cloudOnly: () => boolean
): MatrixReadinessProbe[] {
  return probes.map(probe =>
    probe.step === 'signed_in' || probe.nonBlocking
      ? probe
      : {
          ...probe,
          check: (signal: AbortSignal) =>
            cloudOnly() ? Promise.resolve({ ok: true as const }) : probe.check(signal)
        }
  )
}

/** Consecutive results that change the watch's phase (plan: 2 and 2). */
const FLAP = 2

export class MatrixReadinessMonitor {
  private state: MatrixReadiness
  private generation = 0
  private timer?: ReturnType<typeof setTimeout>
  private abort?: AbortController
  private running = false
  private again = false
  private attempts = 0
  private failures = 0
  private successes = 0
  private gates = 0

  constructor(private readonly options: MatrixReadinessOptions) {
    this.state = { phase: 'starting', since: this.now() }
  }

  get current(): MatrixReadiness {
    return { ...this.state }
  }

  /** (Re)runs the gate from its first step: launch, sign-in, re-enrollment. */
  start(): void {
    this.cancel()
    this.attempts = 0
    this.failures = 0
    this.successes = 0
    this.set({ phase: 'starting', since: this.now() })
    this.run('gate')
  }

  /** Try again, power resume or a network change: check now instead of waiting. */
  recheck(): void {
    if (this.running) {
      this.again = true

      return
    }

    this.clearTimer()
    this.run(this.state.phase === 'ready' || this.state.phase === 'degraded' ? 'watch' : 'gate')
  }

  /** Signed out or quitting: nothing runs until the next start. */
  stop(): void {
    this.cancel()
    this.set({ phase: 'starting', since: this.now() })
  }

  private cancel(): void {
    this.generation += 1
    this.clearTimer()
    this.abort?.abort()
    this.abort = undefined
    this.running = false
    this.again = false
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private run(kind: 'gate' | 'watch'): void {
    const generation = this.generation
    const abort = new AbortController()
    this.abort = abort
    this.running = true

    const work = kind === 'gate' ? this.gate(generation, abort.signal) : this.tick(generation, abort.signal)

    void work
      .catch(() => {})
      .finally(() => {
        if (generation !== this.generation) {
          return
        }

        this.running = false

        if (this.again) {
          this.again = false
          this.clearTimer()
          this.run(this.state.phase === 'ready' || this.state.phase === 'degraded' ? 'watch' : 'gate')
        }
      })
  }

  private async gate(generation: number, signal: AbortSignal): Promise<void> {
    const started = this.now()
    const start = this.gates === 0 ? 'cold' : 'warm'
    let outOfProtons = false
    // A retry keeps its block on screen, with its first `since`, until the gate gets past that
    // step: the window's graces (agent-attention.ts) count from the first failure, not the last
    // retry, and a block that keeps failing never flickers back to `starting`.
    const retrying = this.state.phase === 'blocked' ? { ...this.state } : undefined
    let past = !retrying

    for (const probe of this.options.gate) {
      if (generation !== this.generation) {
        return
      }

      if (past && (this.state.phase !== 'blocked' || this.state.step !== probe.step)) {
        this.set({
          phase: 'starting',
          step: probe.step,
          since: this.state.phase === 'starting' ? this.state.since : this.now()
        })
      }

      const stepStarted = this.now()
      const result = await this.checked(probe, signal)

      if (generation !== this.generation) {
        return
      }

      const retryAt = result.ok === false ? result.retryAt : undefined
      const wait = retryAt !== undefined ? Math.max(1_000, retryAt - this.now()) : 0

      this.options.log?.(
        `[Matrix] readiness gate step=${probe.step} ok=${result.ok}${result.ok ? '' : ` code=${result.code}`} ms=${this.now() - stepStarted} start=${start}${wait ? ` wait=${wait}` : ''}`
      )

      if (!result.ok && wait) {
        // Waiting as asked is not a failure: no backoff step is spent, and the person sees
        // the step still in progress rather than a failure.
        this.set({
          phase: 'starting',
          step: probe.step,
          code: result.code,
          retryAt,
          since: this.state.phase === 'starting' ? this.state.since : this.now()
        })
        this.schedule(generation, 'gate', wait)

        return
      }

      if (!result.ok) {
        // Exhausted credit pauses Atum's model, but must not hide chats, Settings,
        // or the person's own model. Every remaining authority gate still runs.
        if (probe.step === 'ai' && result.code === 'out_of_protons') {
          outOfProtons = true

          continue
        }

        this.set({
          phase: 'blocked',
          step: probe.step,
          code: result.code ?? 'unexpected',
          since:
            retrying && retrying.step === probe.step && retrying.code === (result.code ?? 'unexpected')
              ? retrying.since
              : this.blockedSince(probe.step)
        })

        if (!this.options.waitsForEvent?.has(result.code ?? '')) {
          this.schedule(generation, 'gate', this.backoff(this.attempts++))
        }

        return
      }

      if (retrying && probe.step === retrying.step) {
        past = true
      }
    }

    this.gates += 1
    this.attempts = 0
    this.failures = 0
    this.successes = 0
    this.options.log?.(`[Matrix] readiness gate ready ms=${this.now() - started} start=${start}`)
    this.set(outOfProtons
      ? { phase: 'degraded', step: 'ai', code: 'out_of_protons', since: this.now() }
      : { phase: 'ready', since: this.now() })
    this.schedule(generation, 'watch', this.watchInterval())
  }

  private async tick(generation: number, signal: AbortSignal): Promise<void> {
    let failed: { step: MatrixReadinessStep; code: string } | undefined
    let nonBlockingFailed = false

    for (const probe of this.options.watch) {
      const result = await this.checked(probe, signal)

      if (generation !== this.generation) {
        return
      }

      if (!result.ok) {
        if (probe.nonBlocking) {
          nonBlockingFailed = true

          continue
        }

        failed = { step: probe.step, code: result.code ?? 'unexpected' }

        break
      }
    }

    if (failed) {
      this.failures += 1
      this.successes = 0

      if (this.state.phase === 'ready' && this.failures >= FLAP) {
        this.options.log?.(`[Matrix] readiness watch degraded step=${failed.step} code=${failed.code}`)
        this.attempts = 0
        this.set({ phase: 'degraded', step: failed.step, code: failed.code, since: this.now() })
      } else if (
        this.state.phase === 'degraded' &&
        (this.state.step !== failed.step || this.state.code !== failed.code)
      ) {
        this.set({ ...this.state, step: failed.step, code: failed.code })
      }
    } else {
      this.successes += 1
      this.failures = 0

      if (this.state.phase === 'degraded' && this.successes >= FLAP) {
        this.options.log?.('[Matrix] readiness watch recovered')
        this.attempts = 0
        this.set({ phase: 'ready', since: this.now() })
      }
    }

    if (!failed && !nonBlockingFailed && this.state.phase === 'ready') {
      this.attempts = 0
    }

    this.schedule(
      generation,
      'watch',
      this.state.phase === 'degraded' || this.failures > 0 || nonBlockingFailed
        ? this.backoff(this.attempts++)
        : this.watchInterval()
    )
  }

  private async checked(probe: MatrixReadinessProbe, signal: AbortSignal): Promise<MatrixReadinessCheck> {
    try {
      return await probe.check(signal)
    } catch {
      return { ok: false, code: 'unexpected' }
    }
  }

  private blockedSince(step: MatrixReadinessStep): number {
    // Blocked on the same step keeps its start, so the screen can tell how long it waited.
    return this.state.phase === 'blocked' && this.state.step === step ? this.state.since : this.now()
  }

  private backoff(attempt: number): number {
    const steps = (this.options.timings ?? MATRIX_READINESS_TIMINGS).backoffMs
    const base = steps[Math.min(attempt, steps.length - 1)]!

    // ±20% jitter so a fleet of Macs never probes in lockstep.
    return Math.round(base * (0.8 + 0.4 * (this.options.random?.() ?? Math.random())))
  }

  private watchInterval(): number {
    const timings = this.options.timings ?? MATRIX_READINESS_TIMINGS

    return Math.round(timings.watchMs + (2 * (this.options.random?.() ?? Math.random()) - 1) * timings.jitterMs)
  }

  private schedule(generation: number, kind: 'gate' | 'watch', ms: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined

      if (generation === this.generation && !this.running) {
        this.run(kind)
      }
    }, ms)
    this.timer.unref?.()
  }

  private set(next: MatrixReadiness): void {
    const previous = this.state

    if (
      previous.phase === next.phase &&
      previous.step === next.step &&
      previous.code === next.code &&
      previous.retryAt === next.retryAt &&
      previous.since === next.since
    ) {
      return
    }

    this.state = next
    this.options.onChange(this.current)
  }
}
