/**
 * The answering-executor lease (platform migration 0145; plan
 * ). One executor answers an assistant at a
 * time. Explicit local turns may keep their record locally (local-authority.ts).
 * Automatic remote turns additionally use the shared per-event dispatch ledger
 * with this lease's v2 fencing token (platform migration 0148).
 *
 * The holder renews in the background. When no renewal succeeds in time, the session's
 * signal aborts before the lease could lapse, so a revoked or unreachable executor
 * stops its running turn within the lease term.
 *
 * Idle non-listening clients do not compete. Local interactive turns can use
 * per-message grants when another Mac holds the lease; remote incoming work
 * requires both explicit listening and a held lease.
 */
export type MatrixLeaseStatus =
  | { state: 'held'; acquiredAt: number; expiresAt: number; leaseToken?: string; boundary?: number }
  /** A higher-priority destination is taking over. Existing work keeps its signal until release
   * or deadline, but `held` returns null so no new claim can start on this Mac. */
  | { state: 'yielding'; acquiredAt: number; expiresAt: number; leaseToken: string; boundary: number }
  /** Another executor holds it, or the platform holds the agent out of contention for this one.
   * `reason` is the one closed refusal that is not another holder: the cloud-first agent's owner
   * has no cloud access (0238), so no Mac takes it silently; the Mac keeps asking and the plan's
   * return ends the hold on the next attempt. */
  | { state: 'elsewhere'; until?: number; reason?: 'entitlement_required' }
  /** Terminal reasons prevent retrying the same executor session after either
   * a protocol upgrade or a confirmed authority withdrawal. */
  | { state: 'unavailable'; reason?: 'upgrade_required' | 'authority_withdrawn' }
  | { state: 'idle' }
  | { state: 'acquiring' }
  | { state: 'stopped' }

export interface MatrixExecutorLeaseOptions {
  request(
    operation: 'acquire' | 'release',
    executorId: string,
    metadata?: { protocol: 2; leaseToken?: string }
  ): Promise<unknown>
  onChange?(status: MatrixLeaseStatus): void
  now?(): number
  /** Renew this often while held (the platform term is 90 s). */
  renewMs?: number
  /** Retry this soon after a failed renewal while the lease cannot lapse yet. */
  retryMs?: number
  /** Try again this often while another executor holds it or the platform is unreachable. */
  idleRetryMs?: number
  /** Give the lease up this long before it could lapse without a renewal. */
  lossMarginMs?: number
  /** A server grant whose start is farther ahead than this is not safe to use. */
  clockSkewMs?: number
  /** Randomness for the ±20% jitter on renewals and retries (tests pin it). */
  random?(): number
  /** Closed-code observability for a held term that this Mac stops trusting. */
  onLost?(reason: MatrixLeaseLostReason): void
}

export type MatrixLeaseLostReason = 'expired_wallclock' | 'resume' | 'skew'

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export class MatrixExecutorLease {
  private status: MatrixLeaseStatus = { state: 'stopped' }
  private executorId?: string
  private timer?: ReturnType<typeof setTimeout>
  private lapse?: ReturnType<typeof setTimeout>
  private session?: AbortController
  private since = 0
  private generation = 0
  private readonly requests = new Set<Promise<unknown>>()
  private releasing?: Promise<void>
  private restart?: { executorId: string; protocol?: 2 }
  private protocol?: 2
  /** The platform's lease generation from a policy-selected grant (`selection.generation`): the executor term. */
  private term?: number

  constructor(private readonly options: MatrixExecutorLeaseOptions) {}

  /**
   * What `atum.agent-home/2.1` fences a Mac executor's checkpoint, drain and readiness with, from the exact
   * term this executor holds: the lease token (`leaseId`), the platform's expiry in milliseconds, and the
   * lease generation its policy-selected grant carried (`executorTerm`). Null unless this executor holds, or
   * is handing back, a v2 term whose grant carried a generation. Never a guess: the platform checks all three
   * against its own record, so a term this Mac has stopped trusting is not offered.
   */
  fenceFacts(executorId: string): { leaseId: string; leaseExpiresAtPlatform: number; executorTerm: number } | null {
    this.expireTerm('expired_wallclock')
    const status = this.status

    return (status.state === 'held' || status.state === 'yielding') &&
      this.executorId === executorId &&
      this.protocol === 2 &&
      this.session &&
      !this.session.signal.aborted &&
      typeof status.leaseToken === 'string' &&
      this.term !== undefined
      ? { leaseId: status.leaseToken, leaseExpiresAtPlatform: status.expiresAt, executorTerm: this.term }
      : null
  }

  get current(): MatrixLeaseStatus {
    this.expireTerm('expired_wallclock')

    return this.status
  }

  /** Idle/elsewhere remain routable; yielding stays readiness-safe only for its admitted drain.
   * `held`—never this display/readiness bit—is the gate for a new local claim. */
  get ready(): boolean {
    this.expireTerm('expired_wallclock')

    return ['held', 'yielding', 'elsewhere', 'idle'].includes(this.status.state)
  }

  /** The held session for this executor: when it began on this Mac's clock (a renewal
   * keeps it; any loss starts a new one) and a signal that aborts once it is lost. */
  held(executorId: string): { since: number; signal: AbortSignal; leaseToken?: string; boundary?: number } | null {
    this.expireTerm('expired_wallclock')

    return this.status.state === 'held' &&
      this.executorId === executorId &&
      this.session &&
      !this.session.signal.aborted
      ? {
          since: this.since,
          signal: this.session.signal,
          ...(this.protocol === 2 ? { leaseToken: this.status.leaseToken, boundary: this.status.boundary } : {})
        }
      : null
  }

  /** macOS can freeze timers during sleep. Re-check the database-clock deadline on wake and
   * renew immediately when the old term is still inside its safe window. */
  resume(): void {
    if (!this.executorId || this.status.state === 'stopped' || this.status.state === 'idle') {
      return
    }

    if (this.expireTerm('resume')) {
      return
    }

    if (this.status.state === 'yielding') {
      return
    }

    // A renewal may have been in flight when the Mac slept. Fence its late response so it
    // cannot overwrite the grant obtained after wake with an older deadline. Re-arm the
    // current deadline under the new generation too: a hung wake renewal must not leave the
    // pre-sleep term usable past its margin.
    const held = this.status.state === 'held' ? this.status : undefined
    this.generation += 1

    if (held) {
      this.guard(held.expiresAt, this.generation)
    }

    this.schedule(0, this.generation)
  }

  /**
   * Stop admitting or renewing work while one already-admitted v2 turn drains. The exact held
   * session and its abort signal stay valid only until the original term's safety margin; callers
   * release it when the turn settles. A legacy or non-held lease has no fenced drain state and is
   * released immediately instead.
   */
  drain(): boolean {
    this.expireTerm('expired_wallclock')
    const current = this.status

    if (current.state === 'yielding') {
      return true
    }

    if (
      current.state !== 'held' ||
      this.protocol !== 2 ||
      !this.executorId ||
      !this.session ||
      this.session.signal.aborted ||
      typeof current.leaseToken !== 'string' ||
      typeof current.boundary !== 'number'
    ) {
      void this.release()

      return false
    }

    this.restart = undefined
    this.generation += 1
    this.clear()
    this.set({
      state: 'yielding',
      acquiredAt: current.acquiredAt,
      expiresAt: current.expiresAt,
      leaseToken: current.leaseToken,
      boundary: current.boundary
    })
    this.guard(current.expiresAt, this.generation)

    return true
  }

  start(executorId: string, protocol?: 2): void {
    if (this.releasing) {
      this.restart = { executorId, protocol }

      return
    }

    if (this.executorId === executorId && this.protocol === protocol) {
      return
    }

    if (this.executorId) {
      void this.stop()
      this.start(executorId, protocol)

      return
    }

    this.clear()
    this.lose()
    this.executorId = executorId
    this.protocol = protocol
    this.generation += 1
    this.set({ state: 'acquiring' })
    void this.acquire(this.generation)
  }

  /** No admitted work on this Mac: do not compete with a listening executor. */
  release(): Promise<void> {
    return this.end('idle')
  }

  /** Stops renewing and releases a held lease, best effort (sign-out, quit, re-enrollment). */
  stop(): Promise<void> {
    return this.end('stopped')
  }

  private end(state: 'idle' | 'stopped'): Promise<void> {
    this.restart = undefined
    const executorId = this.executorId
    const protocol = this.protocol
    const heldToken =
      (this.status.state === 'held' || this.status.state === 'yielding') && protocol === 2
        ? this.status.leaseToken
        : undefined
    const release = this.status.state === 'held' || this.status.state === 'yielding' || this.requests.size > 0
    const pending = [...this.requests]
    this.generation += 1
    this.clear()
    this.lose()
    this.executorId = undefined
    this.protocol = undefined

    if (this.status.state !== state) {
      this.set({ state })
    }

    if (this.releasing) {
      return this.releasing
    }

    if (!executorId || !release) {
      return Promise.resolve()
    }

    // A late acquisition must be released too. New demand waits behind this
    // cleanup, so an old release can never erase a newly acquired session.
    this.releasing = Promise.allSettled(pending)
      .then(results => {
        if (protocol !== 2) {
          return [this.options.request('release', executorId)]
        }

        // A v2 release is fenced. Include a late first-acquire token as well as
        // the token we held when stopping: neither can erase a successor.
        const tokens = new Set<string>()

        if (heldToken) {
          tokens.add(heldToken)
        }

        for (const result of results) {
          const value = result.status === 'fulfilled' ? result.value : undefined

          if (this.v2Grant(value, executorId)) {
            tokens.add(value.leaseToken)
          }
        }

        return [...tokens].map(leaseToken => this.options.request('release', executorId, { protocol: 2, leaseToken }))
      })
      .then(releases => Promise.allSettled(releases).then(() => undefined))
      .catch(() => {})
      .then(() => {
        this.releasing = undefined
        const restart = this.restart
        this.restart = undefined

        if (restart) {
          this.start(restart.executorId, restart.protocol)
        }
      })

    return this.releasing
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async acquire(generation: number): Promise<void> {
    const executorId = this.executorId!
    const protocol = this.protocol
    let value: Record<string, unknown> | undefined
    const currentToken = this.status.state === 'held' && protocol === 2 ? this.status.leaseToken : undefined

    const request = Promise.resolve().then(() =>
      protocol === 2
        ? this.options.request('acquire', executorId, {
            protocol: 2,
            ...(currentToken ? { leaseToken: currentToken } : {})
          })
        : this.options.request('acquire', executorId)
    )

    this.requests.add(request)

    try {
      value = (await request) as Record<string, unknown> | undefined
    } catch (error) {
      if (generation === this.generation) {
        if (error instanceof Error && error.message === 'matrix_lease_denied') {
          // A confirmed authority refusal is not an outage. End work now, and
          // fence every earlier response before publishing this terminal state.
          this.generation += 1
          this.clear()
          this.lose()
          this.set({ state: 'unavailable', reason: 'authority_withdrawn' })
        } else {
          this.failed(generation)
        }
      }

      return
    } finally {
      this.requests.delete(request)
    }

    if (generation !== this.generation || protocol !== this.protocol) {
      return
    }

    const now = this.now()

    if (protocol === 2 && value && Object.hasOwn(value, 'selection')) {
      if (this.policyYield(value, executorId)) {
        if (this.skewed(value.acquiredAt as number, value.expiresAt as number, now)) {
          this.lose()
          this.options.onLost?.('skew')
          this.set({ state: 'unavailable' })
          this.releaseGrant(value, executorId, protocol)
          this.schedule(this.idleRetryMs(), generation)

          return
        }

        const held = this.status

        if (held.state !== 'held' || typeof held.boundary !== 'number') {
          this.failed(generation)

          return
        }

        this.set({
          state: 'yielding',
          acquiredAt: value.acquiredAt as number,
          expiresAt: value.expiresAt as number,
          leaseToken: value.leaseToken as string,
          boundary: held.boundary
        })
        this.guard(value.expiresAt as number, generation)

        return
      }

      if (!this.policyGrant(value)) {
        this.failed(generation)

        return
      }
    }

    const shapedGrant =
      value?.held === true &&
      value.executorId === executorId &&
      finite(value.acquiredAt) &&
      finite(value.expiresAt) &&
      value.expiresAt > value.acquiredAt &&
      (protocol !== 2 || this.v2Grant(value, executorId))

    if (shapedGrant && value && this.skewed(value.acquiredAt as number, value.expiresAt as number, now)) {
      this.lose()
      this.options.onLost?.('skew')
      this.set({ state: 'unavailable' })
      this.releaseGrant(value, executorId, protocol)
      this.schedule(this.idleRetryMs(), generation)

      return
    }

    if (shapedGrant && value) {
      const acquiredAt = value.acquiredAt as number
      const expiresAt = value.expiresAt as number
      // v2's token, not acquiredAt, is the lease generation. A same-executor
      // re-acquire can retain its old timestamp while replacing the holder.
      const sameSession =
        this.status.state === 'held' &&
        this.session &&
        (protocol === 2 ? this.status.leaseToken === value.leaseToken : this.status.acquiredAt === acquiredAt)

      if (!sameSession) {
        this.lose()
        this.session = new AbortController()
        this.since = now
      }

      const selected = (value.selection as { generation?: unknown } | undefined)?.generation
      this.term = protocol === 2 && Number.isSafeInteger(selected) && Number(selected) >= 1 ? Number(selected) : undefined

      this.set({
        state: 'held',
        acquiredAt,
        expiresAt,
        ...(protocol === 2 ? { leaseToken: value.leaseToken as string, boundary: value.boundary as number } : {})
      })
      this.schedule(Math.min(this.options.renewMs ?? 30_000, Math.max(1_000, (expiresAt - now) / 3)), generation)
      this.guard(expiresAt, generation)

      return
    }

    if (value?.reason === 'upgrade_required') {
      this.lose()
      this.set({ state: 'unavailable', reason: 'upgrade_required' })

      return
    }

    if (value?.held === false) {
      this.lose()
      this.set({
        state: 'elsewhere',
        ...(finite(value.until) ? { until: value.until } : {}),
        ...(value.reason === 'entitlement_required' ? { reason: 'entitlement_required' as const } : {})
      })
      this.schedule(this.idleRetryMs(), generation)

      return
    }

    this.failed(generation)
  }

  private failed(generation: number): void {
    // Keep a held lease while it cannot lapse yet; give it up in time for running turns to stop.
    if (this.status.state === 'held' && this.status.expiresAt - this.now() > (this.options.lossMarginMs ?? 15_000)) {
      this.schedule(this.options.retryMs ?? 5_000, generation)

      return
    }

    this.lose()
    this.set({ state: 'unavailable' })
    this.schedule(this.idleRetryMs(), generation)
  }

  private deadline(expiresAt: number): number {
    return expiresAt - (this.options.lossMarginMs ?? 15_000)
  }

  /** Returns true when a held session was synchronously invalidated. */
  private expireTerm(reason: Exclude<MatrixLeaseLostReason, 'skew'>): boolean {
    if (
      (this.status.state !== 'held' && this.status.state !== 'yielding') ||
      this.now() < this.deadline(this.status.expiresAt)
    ) {
      return false
    }

    this.generation += 1
    const generation = this.generation
    this.clear()
    this.lose()
    this.options.onLost?.(reason)
    this.set({ state: 'unavailable' })
    this.schedule(this.idleRetryMs(), generation)

    return true
  }

  private skewed(acquiredAt: number, expiresAt: number, now: number): boolean {
    return acquiredAt - now > (this.options.clockSkewMs ?? 5_000) || this.deadline(expiresAt) <= now
  }

  /** A grant this clock cannot safely use must not keep DA's term occupied. V2 releases are
   * fenced by the returned token; the legacy path is retained for pre-v2 servers. */
  private releaseGrant(value: Record<string, unknown>, executorId: string, protocol: 2 | undefined): void {
    const leaseToken =
      protocol === 2 &&
      typeof value.leaseToken === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.leaseToken)
        ? value.leaseToken
        : undefined

    // Protocol 2 is fenced or it is not released. Falling back to the legacy unfenced call for
    // a malformed token could erase a successor term; its normal expiry is the safe cleanup.
    if (protocol === 2 && !leaseToken) {
      return
    }

    const request = Promise.resolve().then(() =>
      protocol === 2 && leaseToken
        ? this.options.request('release', executorId, { protocol: 2, leaseToken })
        : this.options.request('release', executorId)
    )

    this.requests.add(request)
    void request.catch(() => {}).finally(() => this.requests.delete(request))
  }

  /** Whatever a renewal request is doing, the session ends before the lease could lapse. */
  private guard(expiresAt: number, generation: number): void {
    if (this.lapse) {
      clearTimeout(this.lapse)
    }

    this.lapse = setTimeout(
      () => {
        if (
          generation === this.generation &&
          (this.status.state === 'held' || this.status.state === 'yielding') &&
          this.status.expiresAt === expiresAt
        ) {
          this.generation += 1
          const nextGeneration = this.generation
          this.lose()
          this.options.onLost?.('expired_wallclock')
          this.set({ state: 'unavailable' })
          this.schedule(this.idleRetryMs(), nextGeneration)
        }
      },
      Math.max(0, this.deadline(expiresAt) - this.now())
    )
    this.lapse.unref?.()
  }

  private lose(): void {
    if (this.lapse) {
      clearTimeout(this.lapse)
      this.lapse = undefined
    }

    this.session?.abort()
    this.session = undefined
    this.term = undefined
  }

  private schedule(ms: number, generation: number): void {
    this.clear()
    // ±20% jitter: one Mac's many agents, and several Macs, never renew in lockstep.
    const jittered = Math.round(ms * (0.8 + 0.4 * (this.options.random?.() ?? Math.random())))
    this.timer = setTimeout(() => {
      if (generation === this.generation) {
        void this.acquire(generation)
      }
    }, jittered)
    this.timer.unref?.()
  }

  private idleRetryMs(): number {
    return this.protocol === 2 ? 10_000 : (this.options.idleRetryMs ?? 30_000)
  }

  private v2Grant(
    value: unknown,
    executorId: string
  ): value is Record<string, unknown> & { leaseToken: string; boundary: number } {
    const row = value as Record<string, unknown> | undefined

    return (
      row?.held === true &&
      row.executorId === executorId &&
      typeof row.leaseToken === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.leaseToken) &&
      typeof row.boundary === 'number' &&
      Number.isSafeInteger(row.boundary) &&
      row.boundary >= 0
    )
  }

  /** 0224's non-extending handback of this exact held term. It deliberately omits a new
   * boundary: the current v2 term keeps its existing fence while already-started work drains. */
  private policyYield(value: Record<string, unknown>, executorId: string): boolean {
    const current = this.status
    const selection = value.selection as Record<string, unknown> | undefined

    return (
      current.state === 'held' &&
      typeof current.leaseToken === 'string' &&
      typeof current.boundary === 'number' &&
      Object.keys(value).sort().join(',') === 'acquiredAt,executorId,expiresAt,held,leaseToken,selection' &&
      value.held === true &&
      value.executorId === executorId &&
      value.leaseToken === current.leaseToken &&
      value.acquiredAt === current.acquiredAt &&
      value.expiresAt === current.expiresAt &&
      !!selection &&
      Object.keys(selection).sort().join(',') === 'generation,reason,yield' &&
      Number.isSafeInteger(selection.generation) &&
      Number(selection.generation) >= 1 &&
      selection.reason === 'higher_priority' &&
      selection.yield === true
    )
  }

  /** A policy-selected grant remains the reviewed v2 response plus one exact marker.
   * Managed-home servers also used owner_home for the same owner-policy selection. */
  private policyGrant(value: Record<string, unknown>): boolean {
    const selection = value.selection as Record<string, unknown> | undefined

    return (
      Object.keys(value).sort().join(',') === 'acquiredAt,boundary,executorId,expiresAt,held,leaseToken,selection' &&
      !!selection &&
      Object.keys(selection).sort().join(',') === 'generation,reason,yield' &&
      Number.isSafeInteger(selection.generation) &&
      Number(selection.generation) >= 1 &&
      (selection.reason === 'owner_policy' || selection.reason === 'owner_home') &&
      selection.yield === false
    )
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private set(status: MatrixLeaseStatus): void {
    this.status = status
    this.options.onChange?.(status)
  }
}
