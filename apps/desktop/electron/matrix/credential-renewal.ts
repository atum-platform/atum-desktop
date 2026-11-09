import type { MatrixEnrollment, MatrixIdentity, MatrixInvocationWatch } from '../../shared/matrix'

import { MatrixEnrollmentRateLimited } from './enrollment'

/**
 * Keeps one agent's executor credential renewed ahead of its expiry, so the agent keeps
 * answering through it (launch checklist G1-12, G1-30; stream RT, slice 2).
 *
 * An executor credential is a MAS personal session of at most an hour. Before this, its
 * expiry stopped the agent's host and Hermes, and the readiness gate enrolled again: the
 * agent could not answer for about 10–35 s every hour. Now main renews it through the
 * platform's rotation of the same executor (0146's `rotate`), which keeps the session and
 * the device, and hands the new token to the running SDK. Expiry stays the backstop: if no
 * renewal lands in time, the host still ends at the credential's expiry, as before.
 *
 * - **When:** half an hour ahead, plus up to four minutes of jitter so one Mac's agents do
 *   not renew together. That is about two rotations an hour per agent; the platform allows
 *   300 an hour per owner (0150). It is not tied to how long a turn runs: a turn keeps going
 *   as long as activity does (LOCAL_TURN_LIMIT_MS is quiet time, not a wall clock), longer
 *   than one credential lasts, so it runs across renewals.
 *   The SDK takes each new token in place, and a turn's steps on the platform happen at its
 *   start and its end, not in between.
 * - **Not mid-turn, if it can wait:** the platform refuses the executor's invocation steps while
 *   it rotates, for about a second. A renewal that falls due while the agent is busy waits for
 *   it to be idle, checking every five seconds, for at most two minutes, then renews anyway,
 *   well before the expiry.
 * - **Failures:** retried after 15 s, 30 s, 1 min, 2 min, then every 5 min, ±20%. A refusal
 *   under 0150's bounds waits exactly its Retry-After. Nothing starts in the last two minutes
 *   before expiry, where a request could still be in flight when the credential ends.
 * - **Stops for good** when the platform denies the executor (revoked, retired, suspended),
 *   when the answer is not the same agent and device, or when the agent or account is gone.
 *   Expiry then ends the host as before.
 * - **After sleep:** Node's timers do not count time asleep on macOS, so `resume()`
 *   schedules again from the wall clock.
 * - **A refused token (`expedite()`):** when the server refuses the host's token and main
 *   has nothing newer (the platform rotated but the answer never arrived, as after a quit
 *   mid-renewal), a renewal that is already due runs at once, without waiting for the agent
 *   to be idle: the token it replaces is dead anyway. Never before main's own schedule, and
 *   at most once a minute, so the host's SDK cannot make main rotate more often.
 * - **Behind an enrollment:** a renewal refused because the agent's enrollment or revocation
 *   is running looks again later, from the credential as it then is; it never retries a
 *   rotation for a credential that the enrollment already renewed.
 */
export const MATRIX_CREDENTIAL_RENEWAL = {
  leadMs: 30 * 60_000,
  jitterMs: 4 * 60_000,
  busyCheckMs: 5_000,
  busyDeferMs: 2 * 60_000,
  lastAttemptMs: 2 * 60_000,
  expediteMs: 60_000,
  backoffMs: [15_000, 30_000, 60_000, 120_000, 300_000] as readonly number[]
}

export type MatrixCredentialRenewalTimings = typeof MATRIX_CREDENTIAL_RENEWAL

/** Refusals that no retry of the same credential can fix. */
const FINAL = new Set([
  'matrix_enrollment_denied',
  'matrix_enrollment_invalid',
  'matrix_agent_unavailable',
  'matrix_domain_signed_out',
  'matrix_domain_connection_required',
  'matrix_login_cancelled',
  'matrix_vault_invalid'
])

export interface MatrixCredentialRenewalOptions {
  /** Names the agent in log lines (`assistant`, `agent 1a2b3c4d`). Never a token. */
  label: string
  /** The credential's current expiry; undefined when there is nothing to renew. */
  expiresAt(): number | undefined
  /** One renewal: the platform re-issues the credential and the caller hands it to the host.
   * Rejects with a closed code, or with MatrixEnrollmentRateLimited. */
  renew(): Promise<unknown>
  /** The agent is in a turn or a setup step. */
  busy?(): boolean
  log(line: string): void
  now?(): number
  random?(): number
  timings?: MatrixCredentialRenewalTimings
}

export class MatrixCredentialRenewal {
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0
  private running = false
  private stopped = true
  private attempts = 0
  private jitter = 0
  private busySince?: number
  /** A retry of a failed renewal: it runs then, whatever the schedule says. */
  private retryAt?: number
  /** Look again no sooner than this (behind an enrollment), from the schedule. */
  private notBefore?: number
  private expedited = Number.NEGATIVE_INFINITY

  constructor(private readonly options: MatrixCredentialRenewalOptions) {}

  /** Schedules the next renewal from the credential's current expiry. Safe to repeat. */
  start(): void {
    this.stopped = false
    this.attempts = 0
    this.busySince = undefined
    this.retryAt = undefined
    this.notBefore = undefined
    this.jitter = Math.round(this.random() * this.timings.jitterMs)
    this.schedule()
  }

  /** The Mac woke: timers slept with it, so schedule again from the wall clock. A retry that
   * was waiting keeps its time. */
  resume(): void {
    if (!this.stopped) {
      this.busySince = undefined
      this.schedule()
    }
  }

  /**
   * The server refused the host's token and main has nothing newer. A renewal that is due
   * runs now, without the idle wait; one already running is left to finish. Returns the
   * attempt to wait for, or nothing when none is due, the last was under a minute ago, or
   * renewal stopped.
   */
  expedite(): Promise<void> | undefined {
    const expiresAt = this.options.expiresAt()
    const now = this.now()

    if (
      this.stopped ||
      this.running ||
      expiresAt === undefined ||
      now < this.due(expiresAt) ||
      now - this.expedited < this.timings.expediteMs
    ) {
      return undefined
    }

    this.expedited = now
    this.clear()

    return this.attempt(this.generation, true)
  }

  /** The host ended, or the agent is gone: nothing more runs, and a late answer is ignored. */
  stop(): void {
    this.stopped = true
    this.running = false
    this.generation += 1
    this.clear()
  }

  private get timings(): MatrixCredentialRenewalTimings {
    return this.options.timings ?? MATRIX_CREDENTIAL_RENEWAL
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private random(): number {
    return this.options.random?.() ?? Math.random()
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(): void {
    this.clear()

    if (this.stopped || this.running) {
      return
    }

    const expiresAt = this.options.expiresAt()

    if (expiresAt === undefined) {
      return
    }

    this.arm(Math.max(0, this.due(expiresAt) - this.now()))
  }

  private due(expiresAt: number): number {
    return Math.max(this.retryAt ?? expiresAt - this.timings.leadMs - this.jitter, this.notBefore ?? 0)
  }

  private arm(ms: number): void {
    const generation = this.generation
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = undefined

      if (generation === this.generation) {
        void this.attempt(generation)
      }
    }, ms)
    this.timer.unref?.()
  }

  private async attempt(generation: number, expedited = false): Promise<void> {
    const expiresAt = this.options.expiresAt()
    const now = this.now()

    if (this.stopped || this.running || expiresAt === undefined) {
      return
    }

    // Not due (yet): a credential renewed meanwhile, by an enrollment for instance, is
    // scheduled from its new expiry instead of rotated again.
    if (now < this.due(expiresAt)) {
      this.schedule()

      return
    }

    // Too late to start one safely: the credential's own expiry takes over.
    if (expiresAt - now <= this.timings.lastAttemptMs) {
      this.stopped = true
      this.options.log(`[Matrix] ${this.options.label} credential not renewed in time; it ends at its expiry`)

      return
    }

    if (!expedited && this.options.busy?.()) {
      this.busySince ??= now

      if (now - this.busySince < this.timings.busyDeferMs) {
        this.arm(this.timings.busyCheckMs)

        return
      }
    }

    this.busySince = undefined
    this.retryAt = undefined
    this.notBefore = undefined
    this.running = true

    try {
      await this.options.renew()

      if (generation !== this.generation) {
        return
      }

      this.attempts = 0
      this.jitter = Math.round(this.random() * this.timings.jitterMs)
      this.options.log(`[Matrix] ${this.options.label} credential renewed ms=${this.now() - now}`)
    } catch (error) {
      if (generation !== this.generation) {
        return
      }

      this.failed(error)
    } finally {
      if (generation === this.generation) {
        this.running = false
        this.schedule()
      }
    }
  }

  private failed(error: unknown): void {
    const code = error instanceof Error && /^matrix_[a-z_]+$/.test(error.message) ? error.message : 'unexpected'

    if (FINAL.has(code)) {
      this.stopped = true
      this.options.log(`[Matrix] ${this.options.label} credential renewal stopped: ${code}; it ends at its expiry`)

      return
    }

    // Behind the agent's own enrollment or revocation: look again later from the schedule,
    // so a credential that enrollment renewed is not rotated a second time.
    if (code === 'matrix_enrollment_pending') {
      const wait = this.backoff(this.attempts++)
      this.notBefore = this.now() + wait
      this.options.log(
        `[Matrix] ${this.options.label} credential renewal waits for the agent's enrollment; looks again in ${Math.round(wait / 1000)} s`
      )

      return
    }

    const limited = error instanceof MatrixEnrollmentRateLimited
    const wait = limited ? error.retryAfterMs : this.backoff(this.attempts++)
    this.retryAt = this.now() + wait
    this.options.log(
      `[Matrix] ${this.options.label} credential renewal ${limited ? 'asked to wait' : `failed: ${code}`}; next try in ${Math.round(wait / 1000)} s`
    )
  }

  private backoff(attempt: number): number {
    const steps = this.timings.backoffMs
    const base = steps[Math.min(attempt, steps.length - 1)]!

    return Math.round(base * (0.8 + 0.4 * this.random()))
  }
}

/** What one renewal of an agent host needs from main (renewMatrixAgentHost). */
export interface MatrixAgentHostRenewal {
  /** The host is still this agent's current one, and the app and agent are not closing. */
  current(): boolean
  /** The user and device the host was started with. */
  identity: MatrixIdentity
  /** The platform's rotation of the agent's executor (MatrixAccount.renewAgentExecutor). */
  rotate(): Promise<MatrixEnrollment>
  /** Moves the host's end to the renewed credential's expiry. */
  expireAt(expiresAt: number): void
  /** Tells the host's SDK to take the new token (the `renewed` host command). */
  notify(): void
  /** Moves the agent's watch with the credential (matrixRenewedWatchEnd). */
  extend(expiresAt: number): void
  /** Publishes the changed state. */
  changed(): void
}

/**
 * One renewal of an agent host's executor credential. The platform rotates the same executor
 * (the same session and device), and the new token must reach the running host at once: MAS
 * revoked the old one as it issued this. In order, and with nothing awaited between them, so
 * no expiry fires in between: the host's end moves, its SDK is told, its watch moves. The host
 * keeps its device, keys, rooms, lease and Hermes. A host that ended meanwhile takes nothing:
 * the next one starts from the renewed credential.
 */
export async function renewMatrixAgentHost(host: MatrixAgentHostRenewal): Promise<void> {
  if (!host.current()) {
    throw new Error('matrix_agent_unavailable')
  }

  const renewed = await host.rotate()
  const identity = renewed.identity

  if (!host.current() || renewed.state !== 'ready' || !identity) {
    throw new Error('matrix_agent_unavailable')
  }

  if (identity.userId !== host.identity.userId || identity.deviceId !== host.identity.deviceId) {
    throw new Error('matrix_enrollment_invalid')
  }

  host.expireAt(identity.expiresAt)
  host.notify()
  host.extend(identity.expiresAt)
  host.changed()
}

/** A renewed credential's end for the watch it admits (main's armHermesWatch bounds): a
 * continuous watch lasts as the credential does; a temporary one keeps its own quarter hour
 * from when it began, within the credential. */
export function matrixRenewedWatchEnd(
  watch: Pick<MatrixInvocationWatch, 'roomId' | 'since'>,
  expiresAt: number,
  continuousRoomId: string | undefined,
  temporaryMs: number
): number {
  return continuousRoomId === watch.roomId ? expiresAt : Math.min(watch.since + temporaryMs, expiresAt)
}
