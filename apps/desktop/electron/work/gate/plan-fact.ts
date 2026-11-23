import { ACCOUNT_PLAN_PROVIDERS, type AccountPlanProvider } from '../plan-providers'

import { WORK_SUBSCRIPTION_FACT_REFRESH_SECONDS, type WorkSubscriptionReport } from './contract'
import type { GateLedger } from './ledger'
import type { WorkPlatform } from './ports'

type Capability = Pick<WorkSubscriptionReport, 'state' | 'models'>
export type PlanCapabilities = Partial<Record<AccountPlanProvider, Capability>>

export interface PlanFactOptions {
  ledger: GateLedger
  platform: Pick<WorkPlatform, 'reportSubscription'>
  accountId: string
  deviceServiceId: string
  /** One native snapshot for all plans. Omit any whose status could not be determined. */
  read(): Promise<PlanCapabilities>
  now?(): number
  log?(event: string, fields?: Record<string, string | number | boolean | null>): void
}

interface ReportedCapability extends Capability {
  at: number
}

const key = (provider: AccountPlanProvider) => provider === 'codex' ? 'plan_fact' : `plan_fact:${provider}`
const REPORTING_KEY = 'plan_fact_reporting'

export class PlanFact {
  private readonly now: () => number
  private readonly attempted = new Map<AccountPlanProvider, number>()
  private running: Promise<void> | undefined
  private closing = false
  private seen: PlanCapabilities = {}

  constructor(private readonly options: PlanFactOptions) {
    this.now = options.now ?? Date.now
  }

  reported(provider: AccountPlanProvider = 'codex'): ReportedCapability | undefined {
    const raw = this.options.ledger.meta(key(provider))

    if (raw) {
      try {
        const value = JSON.parse(raw) as ReportedCapability

        if (value && (value.state === 'connected' || value.state === 'disconnected') && Number.isSafeInteger(value.at)) {
          return value
        }
      } catch {
        // A malformed local acknowledgement can be replaced by the next report.
      }
    }
  }

  current(provider: AccountPlanProvider = 'codex'): Capability['state'] | 'unknown' {
    return this.seen[provider]?.state ?? 'unknown'
  }

  tick(): Promise<void> {
    if (this.closing) {return Promise.resolve()}

    this.running ??= this.check().finally(() => { this.running = undefined })

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

      if (ACCOUNT_PLAN_PROVIDERS.some(provider => this.reported(provider)?.state === 'connected')) {
        throw new Error('work_plan_fact_cleanup_pending')
      }
    }
  }

  /** The last flush before this Mac stops serving the account: `disconnected`, within the caller's bound. Never throws. */
  async final(): Promise<void> {
    this.closing = true
    this.seen = {}
    await Promise.allSettled(ACCOUNT_PLAN_PROVIDERS.map(provider => this.send(provider, { state: 'disconnected' })))
  }

  private async check(): Promise<void> {
    if (!this.reportingEnabled()) {
      this.seen = Object.fromEntries(ACCOUNT_PLAN_PROVIDERS.map(provider => [provider, { state: 'disconnected' as const }]))

      if (ACCOUNT_PLAN_PROVIDERS.some(provider => this.reported(provider)?.state === 'connected')) {
        await Promise.allSettled(ACCOUNT_PLAN_PROVIDERS.map(provider => this.send(provider, { state: 'disconnected' })))
      }

      return
    }

    const snapshot = await this.options.read().catch((): PlanCapabilities => ({}))

    if (this.closing) {return}

    this.seen = snapshot
    await Promise.all(ACCOUNT_PLAN_PROVIDERS.map(async provider => {
      const capability = snapshot[provider]

      if (!capability) {return}

      const last = this.reported(provider)
      const modelsChanged = capability.models !== undefined && JSON.stringify(capability.models) !== JSON.stringify(last?.models)

      const due = !last || last.state !== capability.state || modelsChanged
        || this.now() - last.at >= WORK_SUBSCRIPTION_FACT_REFRESH_SECONDS * 1000

      if (due) {
        await this.send(provider, capability).catch(error => {
          this.options.log?.('plan_fact_failed', { provider, status: (error as { status?: number } | null)?.status ?? 0 })
        })
      }
    }))
  }

  private async send(provider: AccountPlanProvider, capability: Capability): Promise<void> {
    const { ledger, platform, accountId, deviceServiceId } = this.options

    if (!platform.reportSubscription) {return}

    const last = this.reported(provider)
    const observedAt = Math.max(this.now(), (this.attempted.get(provider) ?? 0) + 1, (last?.at ?? 0) + 1)

    this.attempted.set(provider, observedAt)
    await platform.reportSubscription({
      deviceServiceId, accountId, routeEpoch: ledger.routeEpoch(), provider, observedAt, ...capability
    })

    if (this.attempted.get(provider) === observedAt) {
      const models = capability.state === 'connected' ? capability.models ?? last?.models : undefined

      ledger.setMeta(key(provider), JSON.stringify({ state: capability.state, at: observedAt, models }))
    }
  }
}
