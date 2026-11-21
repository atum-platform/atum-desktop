import {
  WORK_SETTLEMENT_REPORTS_MAX,
  WORK_SETTLEMENT_RETENTION_DAYS,
  type WorkEnrollmentFacts,
  WorkEnrollmentFactsSchema,
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
  /** The Mac's reported socket path (plan §11.2: the platform writes the tunnel's ingress from it). */
  socketPath(): string
  log?(event: string, fields?: Record<string, string | number | boolean | null>): void
}

// Settlement delivery retries: the first retry waits one base step, then doubles, capped. In memory on purpose: a restart
// retries at once, and nothing is lost either way (a report is cleared only on the platform's acknowledgement).
const SETTLEMENT_BACKOFF_BASE_MS = 30_000
const SETTLEMENT_BACKOFF_CAP_MS = 15 * 60_000
const SETTLEMENT_RETENTION_MS = WORK_SETTLEMENT_RETENTION_DAYS * 86_400_000

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
        raw = await platform.pull({ deviceServiceId, accountId, appliedSeq: ledger.appliedSeq(), routeEpoch: ledger.routeEpoch() })
      } catch {
        result = 'offline'

        break
      }

      const page = WorkSyncPageSchema.safeParse(raw)

      if (!page.success || page.data.deviceServiceId !== deviceServiceId || page.data.accountId !== accountId) {
        result = 'invalid'

        break
      }

      const outcome = this.apply(page.data)

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

    if (result === 'ok' || result === 'offline') {
      await this.ack().catch(() => undefined)
    }

    if (result === 'ok') {
      await this.ensureGrants()
    }

    await this.flush().catch(() => undefined)

    return result
  }

  /** Apply one page durably. Returns 'ok' only when the page was applied in order and its head is not behind ours. */
  private apply(page: ReturnType<typeof WorkSyncPageSchema.parse>): TickResult {
    const { gate, ledger } = this.options
    const applied = ledger.appliedSeq()

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
      appliedAt: this.now()
    })
  }

  /** A grant for every entitled agent that has no live, carried one. The Mac mints; the platform only carries. */
  async ensureGrants(): Promise<void> {
    const { gate, ledger, platform, accountId, deviceServiceId } = this.options

    if (!gate.routeOpen() || !gate.workGrantAccepted()) {
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
      } catch {
        // an uncarried grant is unusable: drop it and mint again on the next pull
        ledger.killGrant(minted.hash)
      }
    }
  }

  /** The content-free reports owed to the platform: Mac events and request-correlated stop reports (R4-1). */
  async flush(): Promise<void> {
    const { ledger, platform, accountId, deviceServiceId } = this.options

    for (const row of ledger.pending('mac_event')) {
      ledger.attempted(row.id)

      try {
        await platform.macEvent({ deviceServiceId, accountId, ...JSON.parse(row.payload) })
        ledger.delivered(row.id)
      } catch {
        break
      }
    }

    await this.flushSettlements()
  }

  /**
   * Stop reports (contract 1.1 `work.mac.settlements`): in the order queued, at most 64 a call, each cleared only when the
   * platform acknowledges its batch. A failure backs off (30 s, doubling, 15 min at most) and keeps everything queued. A
   * platform 400 isolates the bad row: the batch is retried one report at a time, the accepted ones are cleared and the
   * refused one stays (an old platform that does not know the operation also answers 400, so nothing is thrown away on that
   * word alone). A report that cannot be sent from here (it fails the contract, or is past the platform's retention) is
   * dropped with a log line: nothing can ever acknowledge it.
   */
  private async flushSettlements(): Promise<void> {
    const { ledger, platform, accountId, deviceServiceId } = this.options
    const send = platform.reportSettlements?.bind(platform)

    if (!send || this.now() < this.settlementRetryAt) {
      return
    }

    const routeEpoch = ledger.routeEpoch()
    const sendable: { id: number; report: StopReport }[] = []

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

      if (sendable.length < WORK_SETTLEMENT_REPORTS_MAX) {
        sendable.push({ id: row.id, report: parsed.data })
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

    let outcome = await deliver(sendable)

    if (outcome === 'refused' && sendable.length > 1) {
      outcome = 'ok'

      for (const item of sendable) {
        const one = await deliver([item])

        if (one === 'failed') {
          outcome = 'failed'

          break
        }

        if (one === 'refused') {
          outcome = 'refused'
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
}
