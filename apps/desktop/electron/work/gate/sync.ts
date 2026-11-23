import {
  WORK_SETTLEMENT_REPORTS_MAX,
  WORK_SETTLEMENT_RETENTION_DAYS,
  type WorkEnrollmentFacts,
  WorkEnrollmentFactsSchema,
  WorkRelaySyncPageSchema,
  WorkStopReportSchema,
  type WorkSyncChange,
  WorkSyncPageSchema
} from './contract'
import type { WorkGate } from './gate'
import type { GateLedger } from './ledger'
import type { StopReport, WorkPlatform } from './ports'

// The revocation sync client (plan §6.4 "Made on the platform", contract `work.sync.*`). The Mac pulls the platform's
// changes since its applied sequence, applies them in order with no gap, durably, and only then acknowledges; it
// reports `settledSeq` only when every row in scope is stopped or settled (step 6). A page whose head is behind the
// applied sequence is a regression and makes the list stale. A Mac that was offline applies everything it missed
// before the gate serves anything: the gate is stale until the first good pull.

export interface WorkSyncOptions {
  gate: WorkGate
  ledger: GateLedger
  platform: WorkPlatform
  accountId: string
  deviceServiceId: string
  now?(): number
  /** Gate 4a: the plan fact (G9). Checked at the end of every cycle; `final` runs in the last, bounded flush before sign-out. */
  planFact?: { tick(): Promise<void>; final(): Promise<void> }
  /** The Mac's reported socket path (plan §11.2: the platform writes the tunnel's ingress from it). */
  socketPath(): string
  log?(event: string, fields?: Record<string, string | number | boolean | null>): void
}

// Settlement delivery retries: the first retry waits one base step, then doubles, capped. In memory on purpose: a restart
// retries at once, and nothing is lost either way (a report is cleared only on the platform's acknowledgement).
const SETTLEMENT_BACKOFF_BASE_MS = 30_000
const SETTLEMENT_BACKOFF_CAP_MS = 15 * 60_000
const SETTLEMENT_RETENTION_MS = WORK_SETTLEMENT_RETENTION_DAYS * 86_400_000
// A report the platform refuses on its own (a 400 for that one report) is offered again on its own schedule, so rejected rows never
// stand in front of reports the platform would take: 30 s, doubling, six hours at most.
const REJECTED_BACKOFF_BASE_MS = 30_000
const REJECTED_BACKOFF_CAP_MS = 6 * 3_600_000

// What the Mac believes about the platform's route is a cache. A rotation with no agent announced, or a platform rollback and
// re-apply, close the route there without any change reaching this Mac, so the cache is re-read from the platform now and then
// (an idempotent `route_opened`, whose reply names the state the platform holds) and dropped the moment a grant is refused for it.
const ROUTE_CONFIRM_MS = 5 * 60_000
// A grant refused for a reason the route cannot fix (an agent that is not eligible) must not make every cycle enroll again.
const ROUTE_RECOVERY_BACKOFF_BASE_MS = 30_000
const ROUTE_RECOVERY_BACKOFF_CAP_MS = 15 * 60_000
// A platform that does not know contract 1.2 answers a `contract: "1.2"` pull with 400. The Mac then pulls as in 1.1 (revocation keeps
// working; there is simply no consent snapshot, so every plan launch is refused stale) and asks for 1.2 again after this long.
const CONTRACT_12_RETRY_MS = 60 * 60_000

/** The platform's answers to a carry that name the route or its enrollment: closed route (403), no route (404), stale enrollment (409). */
const routeRefusal = (error: unknown): boolean => [403, 404, 409].includes((error as { status?: number } | null)?.status ?? 0)

/** A 4xx that says "I will not take this one" (as opposed to signed out, rate limited, or a server that is down). */
const definiteRefusal = (error: unknown): boolean => [400, 409, 410, 412, 422].includes((error as { status?: number } | null)?.status ?? 0)

/** Events of one family describe the same state, so a newer one makes an older one obsolete. */
function eventKind(payload: string): string | undefined {
  try {
    const kind = (JSON.parse(payload) as { kind?: unknown }).kind

    return typeof kind === 'string' ? kind : undefined
  } catch {
    return undefined
  }
}

function eventFamily(payload: string): string | undefined {
  try {
    const event = JSON.parse(payload) as { kind?: unknown; agentPrincipal?: unknown }

    if (event.kind === 'route_closed' || event.kind === 'route_opened') {
      return 'route'
    }

    return typeof event.agentPrincipal === 'string' ? `agent:${event.agentPrincipal}` : undefined
  } catch {
    return undefined
  }
}

export type TickResult = 'ok' | 'offline' | 'regressed' | 'gap' | 'invalid' | 'not_enrolled'

const FACTS = 'facts'

/** The enrollment facts the platform gave this Mac, kept in the gate's own store so a restart needs no network. */
export function readFacts(ledger: GateLedger): WorkEnrollmentFacts | undefined {
  const raw = ledger.meta(FACTS)

  if (!raw) {
    return undefined
  }

  try {
    const parsed = WorkEnrollmentFactsSchema.safeParse(JSON.parse(raw))

    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export class WorkSync {
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<TickResult> | undefined
  private settlementFailures = 0
  private settlementRetryAt = 0
  private routeConfirmedAt = 0
  private routeRecoveries = 0
  private routeRecoveryAt = 0
  private contract12Retry = 0
  private planConsentRetry = 0
  private contract13Retry = 0

  constructor(private readonly options: WorkSyncOptions) {
    this.now = options.now ?? Date.now
  }

  /** Report the Mac's facts and read the platform's. The facts are stored only when they parse. */
  async enroll(): Promise<WorkEnrollmentFacts | null> {
    const { gate, ledger } = this.options
    const accepted = ledger.meta('work_grant_accepted_at')

    const reply = await this.options.platform.enroll({
      deviceServiceId: this.options.deviceServiceId,
      socketPath: this.options.socketPath(),
      gateId: gate.gateId(),
      ...(accepted ? { workGrant: { acceptedAt: Number(accepted), routeEpoch: Number(ledger.meta('work_grant_epoch') ?? ledger.routeEpoch()) } } : {})
    })

    const facts = WorkEnrollmentFactsSchema.safeParse(reply.work)

    if (!facts.success) {
      return null
    }

    ledger.setMeta(FACTS, JSON.stringify(facts.data))

    return facts.data
  }

  start(intervalMs: number): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  stop(): void {
    this.stopDelivery()

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** One pull, apply, acknowledge, grant and outbox cycle. Overlapping calls share one run. */
  tick(): Promise<TickResult> {
    this.running ??= this.cycle().finally(() => {
      this.running = undefined
    })

    return this.running
  }

  private async cycle(): Promise<TickResult> {
    const { gate, ledger, platform, accountId, deviceServiceId } = this.options
    let result: TickResult = 'ok'

    for (let pages = 0; pages < 64; pages++) {
      let raw: unknown

      try {
        raw = await this.pull()
      } catch {
        result = 'offline'

        break
      }

      const relayPage = WorkRelaySyncPageSchema.safeParse(raw)
      const page = relayPage.success ? relayPage : WorkSyncPageSchema.safeParse(raw)

      if (!page.success || page.data.deviceServiceId !== deviceServiceId || page.data.accountId !== accountId) {
        result = 'invalid'

        break
      }

      const outcome = this.apply(page.data, relayPage.success ? relayPage.data : undefined)

      if (outcome !== 'ok') {
        result = outcome

        break
      }

      if (!page.data.hasMore) {
        break
      }
    }

    if (result === 'ok') {
      gate.noteGoodSync()
    }

    // A stop that failed on a transient error or a declined restart stays owed in the ledger; every tick is a retry
    // (the gate serializes it, and it is a no-op when nothing is owed). Before the ack: `settledSeq` must be current.
    if (ledger.owedRows().length > 0 || ledger.openRevocations().length > 0) {
      await gate.scheduleSettle().catch(() => undefined)
    }

    let acked = false

    if (result === 'ok' || result === 'offline') {
      acked = await this.ack().then(
        () => true,
        () => false
      )
    }

    // After a cutoff (a key rotation, a removal) the platform holds the route closed until this Mac has applied it, confirmed the
    // ack, enrolled again and reported the route open: in that order, and only while its consent and switch still say open.
    if (result === 'ok' && acked) {
      await this.reconcileRoute().catch(() => undefined)
    }

    // Events first: a grant carried before a queued close would be deleted by it.
    await this.flush().catch(() => undefined)

    if (result === 'ok' && acked) {
      await this.ensureGrants()
    }

    // The plan fact is independent of the pull: it says what T3 reports on this Mac, and is owed whether or not the platform answered.
    await this.options.planFact?.tick().catch(() => undefined)

    return result
  }

  /**
   * Make the platform's route state agree with this Mac's. Its state is unknown after a platform-made removal or a restart. When
   * consent and the switch say open: enroll again (idempotent; this re-binds a rotated key), then queue `route_opened` unless one
   * is already waiting. The open stays queued until the platform's reply says `open` (see `flush`).
   */
  private async reconcileRoute(): Promise<void> {
    const { gate, ledger } = this.options
    const intentOpen = gate.workGrantAccepted() && gate.routeOpen() && ledger.meta('switch_on') !== '0'

    if (!intentOpen) {
      return
    }

    const waiting = ledger.pending('mac_event').some(row => eventKind(row.payload) === 'route_opened')

    if (ledger.platformRoute() === 'open') {
      // Believed open: ask again now and then. The reply to this event is the platform's own word; `closed` sends the next cycle
      // through the enrollment below.
      if (!waiting && this.now() - this.routeConfirmedAt >= ROUTE_CONFIRM_MS) {
        this.routeConfirmedAt = this.now()
        ledger.enqueueMacEvent({ kind: 'route_opened', routeEpoch: ledger.routeEpoch() })
      }

      return
    }

    await this.enroll()
    this.routeConfirmedAt = this.now()

    if (!waiting) {
      ledger.enqueueMacEvent({ kind: 'route_opened', routeEpoch: ledger.routeEpoch() })
    }
  }

  /** Negotiate 1.3 selections, then 1.2 consent, then legacy revocation on explicit unsupported-contract replies. */
  private async pull(): Promise<unknown> {
    const { ledger, platform, accountId, deviceServiceId } = this.options
    const base = { deviceServiceId, accountId, appliedSeq: ledger.appliedSeq(), routeEpoch: ledger.routeEpoch() }

    if (this.now() < this.contract12Retry) {
      this.options.gate.invalidateConsent()

      return platform.pull(base)
    }

    if (this.now() >= this.contract13Retry) {
      if (this.now() >= this.planConsentRetry) {
        try {
          return await platform.pull({ ...base, contract: '1.3', planConsent: true })
        } catch (error) {
          if ((error as { status?: number } | null)?.status !== 400) {throw error}
          this.planConsentRetry = this.now() + CONTRACT_12_RETRY_MS
        }
      }

      try {
        return await platform.pull({ ...base, contract: '1.3' })
      } catch (error) {
        if ((error as { status?: number } | null)?.status !== 400) {throw error}
        this.contract13Retry = this.now() + CONTRACT_12_RETRY_MS
      }
    }

    ledger.setMeta('relay_selections', '[]')

    try {
      return await platform.pull({ ...base, contract: '1.2' })
    } catch (error) {
      if ((error as { status?: number } | null)?.status !== 400) {
        throw error
      }

      this.contract12Retry = this.now() + CONTRACT_12_RETRY_MS
      this.options.log?.('contract_1_2_unavailable')
      // The platform cannot carry consent now: the snapshot held stops authorising plan launches at once.
      this.options.gate.invalidateConsent()

      return platform.pull(base)
    }
  }

  /** Apply one page durably. Returns 'ok' only when the page was applied in order and its head is not behind ours. */
  private apply(page: ReturnType<typeof WorkSyncPageSchema.parse>, relay?: ReturnType<typeof WorkRelaySyncPageSchema.parse>): TickResult {
    const { gate, ledger } = this.options
    const applied = ledger.appliedSeq()

    if (relay && relay.issuedAt < Number(ledger.meta('relay_selection_issued_at') ?? 0)) {
      gate.noteHeadRegressed()

      return 'regressed'
    }

    if (page.headSeq < applied) {
      gate.noteHeadRegressed()

      return 'regressed'
    }

    const changes = [...page.changes].sort((a, b) => a.seq - b.seq)
    let expect = applied + 1

    for (const change of changes) {
      if (change.seq !== expect) {
        return 'gap'
      }

      expect++
    }

    const finish: (() => void)[] = []

    ledger.tx(() => {
      for (const change of changes) {
        this.applyChange(change, finish)
        ledger.setAppliedSeq(change.seq)
      }

      if (!page.hasMore) {
        this.reconcileEntitled(page.entitled, page.headSeq, finish)
        ledger.setAppliedSeq(page.headSeq)
      }

      // Gate 4b: the consent snapshot is applied durably in the SAME step as the page, and the plan threads of every assistant it no
      // longer names are cut off in that step too. Its age on this Mac's monotonic clock starts only once the step is committed.
      ledger.setMeta('relay_selections', JSON.stringify(relay?.selections ?? []))
      ledger.setMeta('relay_selection_issued_at', relay?.issuedAt ?? 0)
      const consent = page.consent

      if (relay?.planConsents && consent) {
        // The legacy acknowledgement still belongs to the legacy Codex record.
        ledger.setConsent(consent)

        for (const snapshot of relay.planConsents) {
          const results = gate.beginConsent(snapshot)
          finish.push(() => gate.finishConsent(snapshot, results))
        }
      } else if (consent) {
        ledger.clearPlanConsents()
        const results = gate.beginConsent(consent)
        finish.push(() => {
          gate.invalidateConsent()
          gate.finishConsent(consent, results)
        })
      }
    })

    for (const done of finish) {
      done()
    }

    return 'ok'
  }

  private applyChange(change: WorkSyncChange, finish: (() => void)[]): void {
    const { gate, ledger } = this.options

    if (change.kind === 'agent_added') {
      ledger.setEntitled(change.agentPrincipal, true)

      return
    }

    if (change.kind === 'agent_removed' || change.kind === 'device_revoked') {
      // A platform-made removal may be a key rotation, which closed the route there: what it holds is no longer known.
      ledger.setPlatformRoute('unknown')
    }

    if (change.kind === 'agent_removed') {
      const input = { scope: 'agent', principal: change.agentPrincipal, reason: change.scope === 'owner' ? 'agent_removed_owner' : 'agent_removed_this_mac', sourceSeq: change.seq } as const
      const result = gate.beginRevoke(input)

      ledger.setEntitled(change.agentPrincipal, false)
      finish.push(() => gate.finishRevoke(input, result))

      return
    }

    const input = { scope: 'route', reason: 'device_revoked', sourceSeq: change.seq } as const
    const result = gate.beginRevoke(input)

    for (const agent of ledger.agents()) {
      ledger.setEntitled(agent.principal, false)
    }

    ledger.setMeta('route_open', '0')
    finish.push(() => gate.finishRevoke(input, result))
  }

  /** The page's list is authoritative at its head: an agent it does not name is removed here; one it names is entitled. */
  private reconcileEntitled(entitled: string[], headSeq: number, finish: (() => void)[]): void {
    const { gate, ledger } = this.options
    const named = new Set(entitled)

    for (const agent of ledger.agents()) {
      if (agent.entitled && !named.has(agent.principal)) {
        const input = { scope: 'agent', principal: agent.principal, reason: 'agent_removed_this_mac', sourceSeq: headSeq } as const
        const result = gate.beginRevoke(input)

        ledger.setEntitled(agent.principal, false)
        finish.push(() => gate.finishRevoke(input, result))
      }
    }

    for (const principal of named) {
      if (!ledger.agent(principal)?.entitled) {
        ledger.setEntitled(principal, true)
      }
    }
  }

  /** Acknowledge AFTER the cutoff is durable; `settledSeq` only when every row in scope is settled. */
  async ack(): Promise<void> {
    const { ledger, platform, accountId, deviceServiceId } = this.options

    await platform.ack({
      deviceServiceId,
      accountId,
      appliedSeq: ledger.appliedSeq(),
      settledSeq: ledger.settledSeq(),
      routeEpoch: ledger.routeEpoch(),
      appliedAt: this.now(),
      // the revision of the snapshot this Mac durably applied; omitted until one was (a 1.1 platform never sends one)
      ...(this.options.gate.consentRevision() !== undefined && this.now() >= this.contract12Retry
        ? { consentRevision: this.options.gate.consentRevision() }
        : {})
    })
  }

  /** A grant for every entitled agent that has no live, carried one. The Mac mints; the platform only carries. */
  async ensureGrants(): Promise<void> {
    const { gate, ledger, platform, accountId, deviceServiceId } = this.options

    // Only on a route the platform has confirmed open and with no event of this Mac still waiting: a grant carried before a queued
    // close or reopen would be deleted by the close, or refused while the route is closed.
    if (!gate.routeOpen() || !gate.workGrantAccepted() || ledger.platformRoute() !== 'open' || ledger.pending('mac_event').length > 0) {
      return
    }

    for (const agent of ledger.agents()) {
      const live = ledger.liveGrant(agent.principal)

      if (!agent.entitled || (live?.carried && live.expiresAt > this.now() + 86_400_000)) {
        continue
      }

      let minted: ReturnType<WorkGate['mintGrant']>

      try {
        minted = gate.mintGrant(agent.principal)
      } catch {
        continue
      }

      try {
        await platform.carryGrant({
          gateId: { deviceServiceId, accountId, routeEpoch: ledger.routeEpoch() },
          agentPrincipal: agent.principal,
          grant: minted.bearer,
          agentGeneration: minted.generation,
          mintedAt: minted.mintedAt,
          expiresAt: minted.expiresAt
        })
        ledger.markGrantCarried(minted.hash)
        this.routeRecoveries = 0
      } catch (error) {
        // an uncarried grant is unusable: drop it and mint again on the next pull
        ledger.killGrant(minted.hash)

        if (routeRefusal(error) && this.now() >= this.routeRecoveryAt) {
          // The platform says the route is closed or bound to an older enrollment while this Mac thinks it is open: forget what it
          // last confirmed, so the next cycle enrolls again and reopens before anything else is carried. Bounded: repeated refusals
          // that enrolling does not cure are retried on a growing delay, not every cycle.
          this.routeRecoveryAt = this.now() + Math.min(ROUTE_RECOVERY_BACKOFF_CAP_MS, ROUTE_RECOVERY_BACKOFF_BASE_MS * 2 ** Math.min(this.routeRecoveries, 20))
          this.routeRecoveries++
          ledger.setPlatformRoute('unknown')
          this.options.log?.('route_confirmation_dropped', { status: (error as { status?: number }).status ?? 0 })

          return
        }
      }
    }
  }

  /** The content-free reports owed to the platform: Mac events and request-correlated stop reports (R4-1). */
  async flush(options: { ignoreBackoff?: boolean } = {}): Promise<void> {
    const { ledger, platform, accountId, deviceServiceId } = this.options
    const events = ledger.pending('mac_event')

    for (const row of events) {
      ledger.attempted(row.id)
      const kind = eventKind(row.payload)

      try {
        const reply = await platform.macEvent({ deviceServiceId, accountId, ...JSON.parse(row.payload) })
        const state = reply ? reply.routeState : undefined
        const route = kind === 'route_opened' || kind === 'route_closed'
        const want = kind === 'route_opened' ? 'open' : 'closed'

        if (route && state !== undefined && state !== want) {
          // The platform ANSWERED, but did not take it: a reopen is held until this Mac's ack and enrollment are in (and the
          // route stays closed there until then), a close that reads `open` was older than an event the platform already holds.
          const family = eventFamily(row.payload)
          const newer = events.some(later => later.id > row.id && eventFamily(later.payload) === family)

          if (newer) {
            ledger.delivered(row.id)
          } else if (kind === 'route_opened') {
            ledger.setPlatformRoute(state)
            this.options.log?.('route_open_pending', { id: row.id })
          } else {
            // A close is never left unsaid: it is reissued with a newer time and the old one is cleared.
            ledger.tx(() => {
              ledger.delivered(row.id)
              ledger.enqueueMacEvent(JSON.parse(row.payload))
            })
          }

          continue
        }

        ledger.tx(() => {
          ledger.delivered(row.id)

          if (route) {
            ledger.setPlatformRoute(state ?? want)
          }
        })
      } catch (error) {
        if (!definiteRefusal(error)) {
          // offline, signed out, rate limited or a server error: nothing was decided, so try again in order
          break
        }

        // The platform ANSWERED that it cannot take this event (its epoch moved on while this Mac was away). If a newer
        // event of the same family is queued it says the same thing better, so this one is superseded; the newest of a
        // family is kept. Either way the events behind it are not held back (they were wedged here before).
        const family = eventFamily(row.payload)

        if (family && events.some(later => later.id > row.id && eventFamily(later.payload) === family)) {
          ledger.delivered(row.id)
          this.options.log?.('mac_event_superseded', { id: row.id })
        }
      }
    }

    await this.flushSettlements(options.ignoreBackoff === true)
  }

  /**
   * One last, bounded delivery before the owner's credential goes away (sign-out, switch, Work off): the cutoff's
   * events, the settled stop reports and the acknowledgement. Never throws and never waits longer than `ms`.
   */
  async flushBounded(ms: number): Promise<void> {
    const work = (async () => {
      await this.options.planFact?.final().catch(() => undefined)
      await this.flush({ ignoreBackoff: true })
      await this.ack().catch(() => undefined)
    })().catch(() => undefined)

    let timer: ReturnType<typeof setTimeout> | undefined

    await Promise.race([work, new Promise<void>(resolve => void (timer = setTimeout(resolve, ms)))])
    clearTimeout(timer)
  }

  /**
   * Stop reports (contract 1.1 `work.mac.settlements`): in the order queued, at most 64 a call, each cleared only when the
   * platform acknowledges its batch. A failure backs off (30 s, doubling, 15 min at most) and keeps everything queued. A
   * platform 400 isolates the bad row: the batch is retried one report at a time, the accepted ones are cleared and the
   * refused one stays (an old platform that does not know the operation also answers 400, so nothing is thrown away on that
   * word alone). A report that cannot be sent from here (it fails the contract, or is past the platform's retention) is
   * dropped with a log line: nothing can ever acknowledge it.
   */
  private async flushSettlements(ignoreBackoff = false): Promise<void> {
    const { ledger, platform, accountId, deviceServiceId } = this.options
    const send = platform.reportSettlements?.bind(platform)

    if (!send || (!ignoreBackoff && this.now() < this.settlementRetryAt)) {
      return
    }

    const routeEpoch = ledger.routeEpoch()
    const sendable: { id: number; report: StopReport; attempts: number }[] = []

    for (const row of ledger.pending('stop_report')) {
      const parsed = (() => {
        try {
          return WorkStopReportSchema.safeParse(JSON.parse(row.payload))
        } catch {
          return undefined
        }
      })()

      if (!parsed?.success || parsed.data.routeEpochAtAdmit > routeEpoch || this.now() - row.createdAt > SETTLEMENT_RETENTION_MS) {
        ledger.delivered(row.id)
        this.options.log?.('stop_report_dropped', { id: row.id, reason: parsed?.success ? 'unsendable' : 'invalid' })

        continue
      }

      // A report the platform refused on its own waits for its own time: it never takes a place in a batch of reports it would accept.
      if (row.retryAt !== null && row.retryAt > this.now()) {
        continue
      }

      if (sendable.length < WORK_SETTLEMENT_REPORTS_MAX) {
        sendable.push({ id: row.id, report: parsed.data, attempts: row.attempts })
      }
    }

    if (sendable.length === 0) {
      return
    }

    const deliver = async (batch: typeof sendable): Promise<'ok' | 'refused' | 'failed'> => {
      try {
        await send({ deviceServiceId, accountId, routeEpoch, reports: batch.map(item => item.report) })

        for (const item of batch) {
          ledger.delivered(item.id)
        }

        return 'ok'
      } catch (error) {
        for (const item of batch) {
          ledger.attempted(item.id)
        }

        return (error as { status?: number }).status === 400 ? 'refused' : 'failed'
      }
    }

    const defer = (item: (typeof sendable)[number]) => {
      ledger.deferRow(item.id, this.now() + Math.min(REJECTED_BACKOFF_CAP_MS, REJECTED_BACKOFF_BASE_MS * 2 ** Math.min(item.attempts, 20)))
      this.options.log?.('stop_report_rejected', { id: item.id })
    }

    let outcome = await deliver(sendable)

    if (outcome === 'refused') {
      if (sendable.length === 1) {
        defer(sendable[0])
        outcome = 'ok'
      } else {
        // The platform refused something in the batch: try them one at a time. A refused report goes on its own schedule and the
        // rest are delivered; only a failure that is not about one report (offline, a server error) backs the whole queue off.
        outcome = 'ok'

        for (const item of sendable) {
          const one = await deliver([item])

          if (one === 'failed') {
            outcome = 'failed'

            break
          }

          if (one === 'refused') {
            defer(item)
          }
        }
      }
    }

    if (outcome === 'ok') {
      this.settlementFailures = 0
      this.settlementRetryAt = 0

      return
    }

    this.settlementFailures++
    this.settlementRetryAt = this.now() + Math.min(SETTLEMENT_BACKOFF_CAP_MS, SETTLEMENT_BACKOFF_BASE_MS * 2 ** (this.settlementFailures - 1))
    this.options.log?.('stop_report_retry', { failures: this.settlementFailures, pending: ledger.pending('stop_report').length })
  }

  /** Whether anything is still owed to the platform: events, reports (a report waiting on its own schedule counts). */
  hasPendingDelivery(): boolean {
    return this.options.ledger.pending().length > 0
  }

  private deliveryTimer: ReturnType<typeof setInterval> | undefined

  /**
   * Deliver what is owed WITHOUT the session server and without the gate (sign-in with a closed gate that still owes the platform
   * a report): one flush now and one on each interval, until nothing is pending. Pulls nothing: a pull can create stops, and
   * stops need the server (`start` is for that).
   */
  resumeDelivery(intervalMs: number, onIdle?: () => void): void {
    this.stopDelivery()

    const step = async () => {
      try {
        await this.flush({ ignoreBackoff: false })
        await this.ack()
      } catch {
        // offline or signed out: the next interval tries again
      }

      try {
        if (this.deliveryTimer && !this.hasPendingDelivery()) {
          this.stopDelivery()
          onIdle?.()
        }
      } catch {
        // the ledger was closed under it (the account retired): nothing is left to deliver from here
        this.stopDelivery()
      }
    }

    this.deliveryTimer = setInterval(() => void step(), intervalMs)
    void step()
  }

  stopDelivery(): void {
    if (this.deliveryTimer) {
      clearInterval(this.deliveryTimer)
      this.deliveryTimer = undefined
    }
  }
}
