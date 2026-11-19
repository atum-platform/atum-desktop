import { WORK_SUBSCRIPTION_FACT_REFRESH_SECONDS, type WorkPlanProvider } from './contract'
import type { GateLedger } from './ledger'
import type { WorkPlatform } from './ports'

// Gate 4a: the plan fact (contract 1.2 G9, `work_subscription_report`). One boolean and a time: whether T3 says the plan (Codex) is
// connected on THIS Mac. It is read from T3's own provider status (`T3Port.planProvider`) and never from the login: the token lives in
// the maker's own store on the Mac, and nothing here opens it, names it or sends anything derived from it (no e-mail, no plan name,
// no account id: the platform refuses any other key, 400).
//
// When it is reported: on a change T3 shows (connect, disconnect, and so a switch of the login, which T3 shows as a disconnect
// followed by a connect), at least every `WORK_SUBSCRIPTION_FACT_REFRESH_SECONDS` while the gate runs (the platform reads an older
// connected fact as `stale`), by `refresh()` when main knows something just changed (the connect screen closed), and as
// `disconnected` in the last bounded flush of a sign-out, an account switch and Work off, because from then on this Mac serves no one.
//
// What is kept is the state the platform last ACKNOWLEDGED and when: a report that failed (offline, signed out, a stale epoch) is
// simply owed again at the next check, with a fresh `observedAt` (the platform takes the time forward only).

export interface PlanFactOptions {
  ledger: GateLedger
  platform: Pick<WorkPlatform, 'reportSubscription'>
  accountId: string
  deviceServiceId: string
  provider?: WorkPlanProvider
  /** T3's own word, through main's owner session. `unknown`: it could not be asked, so nothing may be claimed either way. */
  status(): Promise<'connected' | 'disconnected' | 'unknown'>
  now?(): number
  log?(event: string, fields?: Record<string, string | number | boolean | null>): void
}

export type PlanFactState = 'connected' | 'disconnected'

const KEY = 'plan_fact'
const REPORTING_KEY = 'plan_fact_reporting'

export class PlanFact {
  private readonly now: () => number
  private running: Promise<void> | undefined
  private again = false

  constructor(private readonly options: PlanFactOptions) {
    this.now = options.now ?? Date.now
  }

  /** The state the platform last acknowledged for this Mac, and when this Mac observed it. */
  reported(): { state: PlanFactState; at: number } | undefined {
    const raw = this.options.ledger.meta(KEY)

    try {
      const value = raw ? (JSON.parse(raw) as { state?: unknown; at?: unknown }) : undefined

      return value && (value.state === 'connected' || value.state === 'disconnected') && typeof value.at === 'number'
        ? { state: value.state, at: value.at }
        : undefined
    } catch {
      return undefined
    }
  }

  /** What this Mac last saw T3 say, for the screen: `unknown` until the first read. */
  private seen: PlanFactState | 'unknown' = 'unknown'

  current(): PlanFactState | 'unknown' {
    return this.seen
  }

  /** Read T3's status and report it when it changed or when the last acknowledged report is due for its hourly refresh. */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true

      return this.running
    }

    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.check()
        } while (this.again)
      } finally {
        this.running = undefined
      }
    })()

    return this.running
  }

  /** Main knows the connect screen just changed something: read now, do not wait for the next cycle. */
  refresh(): Promise<void> {
    return this.tick()
  }

  reportingEnabled(): boolean {
    return this.options.ledger.meta(REPORTING_KEY) !== 'off'
  }

  /** A device disconnect stays in effect across ticks and Work restarts. */
  async setReportingEnabled(enabled: boolean): Promise<void> {
    this.options.ledger.setMeta(REPORTING_KEY, enabled ? 'on' : 'off')

    // Reconcile through tick so any in-flight connected report settles before the withdrawal.
    if (!enabled) {
      await this.tick()

      if (this.reported()?.state === 'connected') {
        throw new Error('work_plan_fact_cleanup_pending')
      }
    }
  }

  /** The last flush before this Mac stops serving the account: `disconnected`, within the caller's bound. Never throws. */
  async final(): Promise<void> {
    this.seen = 'unknown'
    await this.send('disconnected').catch(() => undefined)
  }

  private async check(): Promise<void> {
    if (!this.reportingEnabled()) {
      this.seen = 'disconnected'

      if (this.reported()?.state === 'connected') {
        await this.send('disconnected').catch(() => undefined)
      }

      return
    }

    const state = await this.options.status().catch((): 'unknown' => 'unknown')

    if (state === 'unknown') {
      return
    }

    this.seen = state
    const last = this.reported()
    const due = !last || last.state !== state || this.now() - last.at >= WORK_SUBSCRIPTION_FACT_REFRESH_SECONDS * 1000

    if (due) {
      await this.send(state).catch(error => {
        // The status is the only thing worth a line: offline, signed out, a stale epoch and a platform that does not know 1.2 all
        // look alike, and all are retried at the next check.
        this.options.log?.('plan_fact_failed', { status: (error as { status?: number } | null)?.status ?? 0 })
      })
    }
  }

  private async send(state: PlanFactState): Promise<void> {
    const { ledger, platform, accountId, deviceServiceId } = this.options
    const observedAt = Math.max(this.now(), (this.reported()?.at ?? 0) + 1)

    if (!platform.reportSubscription) {
      return
    }

    await platform.reportSubscription({
      deviceServiceId,
      accountId,
      routeEpoch: ledger.routeEpoch(),
      provider: this.options.provider ?? 'codex',
      state,
      observedAt
    })
    ledger.setMeta(KEY, JSON.stringify({ state, at: observedAt }))
  }
}
