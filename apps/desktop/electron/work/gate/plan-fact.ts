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
  status(): Promise<PlanStatus | PlanStatus['status']>
  now?(): number
  log?(event: string, fields?: Record<string, string | number | boolean | null>): void
}

interface PlanStatus { status: 'connected' | 'disconnected' | 'unknown'; models?: string[] }

export type PlanFactState = 'connected' | 'disconnected'

const KEY = 'plan_fact'

export class PlanFact {
  private readonly now: () => number
  private running: Promise<void> | undefined
  private again = false

  constructor(private readonly options: PlanFactOptions) {
    this.now = options.now ?? Date.now
  }

  private key(): string {
    const plan = this.options.provider ?? 'codex'

    return plan === 'codex' ? KEY : `${KEY}:${plan}`
  }

  /** The state the platform last acknowledged for this Mac, and when this Mac observed it. */
  reported(): { state: PlanFactState; at: number; models?: string[] } | undefined {
    const raw = this.options.ledger.meta(this.key())

    try {
      const value = raw ? (JSON.parse(raw) as { state?: unknown; at?: unknown; models?: string[] }) : undefined

      return value && (value.state === 'connected' || value.state === 'disconnected') && typeof value.at === 'number'
        ? { state: value.state, at: value.at, models: value.models }
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

  /** The last flush before this Mac stops serving the account: `disconnected`, within the caller's bound. Never throws. */
  async final(): Promise<void> {
    this.seen = 'unknown'
    await this.send('disconnected').catch(() => undefined)
  }

  private async check(): Promise<void> {
    const value = await this.options.status().catch((): 'unknown' => 'unknown')
    const { status: state, models } = typeof value === 'string' ? { status: value, models: undefined } : value

    if (state === 'unknown') {
      return
    }

    this.seen = state
    const last = this.reported()
    const due = !last || last.state !== state || JSON.stringify(last.models) !== JSON.stringify(models) || this.now() - last.at >= WORK_SUBSCRIPTION_FACT_REFRESH_SECONDS * 1000

    if (due) {
      await this.send(state, models).catch(error => {
        // The status is the only thing worth a line: offline, signed out, a stale epoch and a platform that does not know 1.2 all
        // look alike, and all are retried at the next check.
        this.options.log?.('plan_fact_failed', { status: (error as { status?: number } | null)?.status ?? 0 })
      })
    }
  }

  private async send(state: PlanFactState, models?: string[]): Promise<void> {
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
      observedAt,
      ...(state === 'connected' && models?.length ? { models } : {})
    })
    ledger.setMeta(this.key(), JSON.stringify({ state, at: observedAt, models }))
  }
}
