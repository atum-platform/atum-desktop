import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { z } from 'zod'

import { ACCOUNT_PLAN_PROVIDERS, type AccountPlanProvider } from '../plan-providers'
import { readJson, writeFileDurably } from '../session/files'

import type { WorkSubscriptionReport } from './plan-contract'
import { deviceServiceCall, type DeviceServicePlatformOptions, reportSubscription } from './platform'

type Capability = Pick<WorkSubscriptionReport, 'state' | 'models'>
export type PlanCapabilities = Partial<Record<AccountPlanProvider, Capability>>

const REFRESH_MS = 60 * 60_000
const disconnected = { state: 'disconnected' } as const
const routeEpoch = z.number().int().min(1).max(999_999_999)
const deviceList = z.object({
  deviceServices: z.array(z.object({
    deviceServiceId: z.string(),
    enrollmentEpoch: z.number().int().positive().optional(),
    work: z.object({ gateId: z.object({ accountId: z.string(), deviceServiceId: z.string(), routeEpoch }) }).optional()
  }))
})

export interface PlanFactTarget {
  account: { key: string; root: string; accountId: string }
  deviceServiceId: string
  enrollmentEpoch?: number
  platform: DeviceServicePlatformOptions
  home: string
}

// Read only upgrade metadata. The historical ledger, receipts and thread database remain on disk.
function legacyState(root: string) {
  const path = join(root, 'work', 'gate', 'ledger.sqlite')

  if (!existsSync(path)) {return { enabled: true, epoch: 1 }}

  const db = new DatabaseSync(path, { readOnly: true })

  try {
    const get = db.prepare('SELECT v FROM meta WHERE k = ?')

    return {
      enabled: get.get('plan_fact_reporting')?.v !== 'off',
      epoch: routeEpoch.safeParse(Number(get.get('route_epoch')?.v)).data ?? 1
    }
  } finally {
    db.close()
  }
}

export class WorkPlanFacts {
  private readonly reported = new Map<AccountPlanProvider, Capability & { at: number }>()
  private pending: Promise<void> = Promise.resolve()
  private routeEpoch?: number
  private enrollmentEpoch?: number
  private observedAt = 0
  private readonly path: string
  private readonly state: { enabled: boolean; epoch: number }

  constructor(root: string, private readonly log?: (line: string) => void) {
    this.path = join(root, 'work', 'plan-fact-reporting.json')
    this.state = legacyState(root)
    const saved = readJson(this.path)

    if (typeof saved === 'boolean') {this.state.enabled = saved}
  }

  enabled(): boolean {return this.state.enabled}

  refresh(target: PlanFactTarget, read: () => Promise<PlanCapabilities>): Promise<void> {
    return this.enqueue(async () => {
      if (this.enabled()) {
        await this.send(target, await read())
      } else {
        await this.send(target, this.withdrawals())
      }
    })
  }

  setEnabled(enabled: boolean): void {
    // Persist the opt-out before waiting on in-flight reports. A crash cannot resume publication.
    writeFileDurably(this.path, JSON.stringify(enabled))
    this.state.enabled = enabled
  }

  withdraw(target: PlanFactTarget): Promise<void> {
    return this.enqueue(() => this.send(target, this.withdrawals(), true))
  }

  private withdrawals(): PlanCapabilities {
    return Object.fromEntries(ACCOUNT_PLAN_PROVIDERS.map(provider => [provider, disconnected]))
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.pending.then(run)
    this.pending = next.catch(() => undefined)

    return next
  }

  private async send(target: PlanFactTarget, capabilities: PlanCapabilities, force = false) {
    const { account: { accountId }, deviceServiceId, enrollmentEpoch, platform } = target

    if (this.enrollmentEpoch !== enrollmentEpoch) {
      this.enrollmentEpoch = enrollmentEpoch
      this.reported.clear()
    }
    const call = deviceServiceCall(platform)
    const due = ACCOUNT_PLAN_PROVIDERS.filter(provider => {
      const next = capabilities[provider]
      const last = this.reported.get(provider)

      return next && (force || !last || last.state !== next.state || Date.now() - last.at >= REFRESH_MS ||
        (next.models !== undefined && JSON.stringify(last.models) !== JSON.stringify(next.models)))
    })

    if (!due.length) {return}

    // Finish the batch even when one provider fails. Serialize enrollment repair for the device.
    let repair: Promise<void> | undefined
    const publish = async (provider: AccountPlanProvider) => {
      const capability = capabilities[provider]!
      const last = this.reported.get(provider)
      const at = this.observedAt = Math.max(Date.now(), this.observedAt + 1)
      const send = () => reportSubscription(call, {
        deviceServiceId, accountId, routeEpoch: this.routeEpoch ?? this.state.epoch, provider, observedAt: at, ...capability
      })

      try {
        await send()
      } catch (error) {
        const status = (error as { status?: number }).status

        if (status !== 404 && status !== 409) {throw error}

        repair ??= this.enroll(target, call)
        await repair
        await send()
      }
      this.reported.set(provider, {
        ...capability, at,
        models: capability.state === 'connected' ? capability.models ?? last?.models : undefined
      })
    }

    const results = await Promise.allSettled(due.map(publish))

    if (results.some(result => result.status === 'rejected')) {
      for (const [index, result] of results.entries()) {
        if (result.status !== 'rejected') {continue}
        const status = (result.reason as { status?: number } | null)?.status
        const reason = typeof status === 'number' ? `registry_${status}` : 'registry_request_failed'
        this.log?.(`[atum-work] plan=${due[index]} state=${capabilities[due[index]]?.state} report=${reason}`)
      }

      throw new Error('work_plan_fact_report_failed')
    }
  }

  private async enroll(target: PlanFactTarget, call: ReturnType<typeof deviceServiceCall>) {
    const { account, deviceServiceId, home, platform } = target
    const reply = await (platform.fetch ?? fetch)(platform.endpoint, {
      redirect: 'error', headers: { authorization: `Bearer ${await platform.bearer()}` }, signal: AbortSignal.timeout(20_000)
    })

    if (!reply.ok) {throw new Error('work_plan_fact_device_read_failed')}

    const device = deviceList.parse(await reply.json()).deviceServices.find(row => row.deviceServiceId === deviceServiceId)
    const id = device?.work?.gateId

    if (!device || (target.enrollmentEpoch !== undefined && device.enrollmentEpoch !== target.enrollmentEpoch) ||
        (id && (id.deviceServiceId !== deviceServiceId || id.accountId !== account.accountId))) {
      throw new Error('work_device_changed')
    }
    const epoch = Math.max(this.routeEpoch ?? this.state.epoch, id?.routeEpoch ?? 1)
    // The current platform enrollment schema requires the old address shape. No socket or grant is created here.
    const socketPath = join(home, '.atum', 'w', createHash('sha256').update(account.key).digest('hex').slice(0, 12), 'g')
    const receipt = z.object({ deviceServiceId: z.string(), work: z.unknown() }).parse(await call('work_enroll', {
      deviceServiceId, socketPath, gateId: { deviceServiceId, accountId: account.accountId, routeEpoch: epoch }
    }))

    if (receipt.deviceServiceId !== deviceServiceId) {throw new Error('work_device_changed')}
    this.routeEpoch = epoch
  }
}
