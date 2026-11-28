import { z } from 'zod'

import type { WorkAgentPlans } from '../../../shared/matrix-work'
import {
  WORK_RELAY_EFFORTS,
  WORK_RELAY_PLANS,
  type WorkRelayEffort,
  type WorkRelayMachine,
  workRelayMachineKind,
  type WorkRelayPlan
} from '../../../shared/matrix-work-relay'

import { WorkRelaySelectionSchema, type WorkSubscriptionState, WorkSubscriptionStateSchema } from './plan-contract'
import { deviceServiceCall, type DeviceServicePlatformOptions } from './platform'

/**
 * The selection read. `efforts` (the levels the platform keeps with a plan selection) is read when
 * the platform sends it, so the picker offers a thinking column for plan models only once a level
 * can be saved; until then the reply carries no such field and the column stays away.
 */
const selectionSnapshot = z.object({
  revision: z.number().int().nonnegative(),
  selection: WorkRelaySelectionSchema.omit({ revision: true }).nullable(),
  efforts: z.array(z.enum(WORK_RELAY_EFFORTS)).max(WORK_RELAY_EFFORTS.length).optional()
}).strict()

/**
 * A Mac's plan fact is re-sent at least hourly while its Work runs (plan-facts.ts REFRESH_MS, checked
 * every minute). Silence for longer than this means the Mac is asleep, quit or off the network.
 */
export const WORK_RELAY_MACHINE_FRESH_MS = 90 * 60_000

/** The owner's Macs that report one plan, as the picker shows them: non-secret identity and state only. */
export function workRelayMachines(state: WorkSubscriptionState, now: number): WorkRelayMachine[] {
  const consent = state.consent
  // Once the owner chose which Macs may answer with the plan, only those serve it.
  const allowed = consent.state === 'on' && consent.devices.length ? new Set(consent.devices) : undefined

  return state.facts
    .filter(fact => !allowed || allowed.has(fact.deviceServiceId))
    .map(fact => ({
      id: fact.deviceServiceId,
      name: fact.displayName ?? '',
      kind: workRelayMachineKind(fact.displayName),
      online: fact.status === 'connected' && (fact.observedAt === undefined || now - fact.observedAt <= WORK_RELAY_MACHINE_FRESH_MS),
      ...(fact.models ? { models: fact.models.map(model => model.id) } : {})
    }))
}

/** The native plan catalog and the existing owner-scoped selection protocol. */
export function createOwnerRelay(
  readCatalog: () => Promise<Omit<WorkAgentPlans, 'selection'> | null>,
  platform: () => DeviceServicePlatformOptions,
  now: () => number = Date.now
) {
  async function readSelection(call: ReturnType<typeof deviceServiceCall>, principal: string) {
    return selectionSnapshot.parse(await call('work_selection_read', { agentPrincipal: principal }))
  }

  /** Each plan's account read. A plan whose read fails shows no Macs; nothing else changes. */
  async function readAccountPlans(call: ReturnType<typeof deviceServiceCall>) {
    const rows = await Promise.all(WORK_RELAY_PLANS.map(async plan => {
      try {
        const state = WorkSubscriptionStateSchema.parse(await call('work_subscription_read', { provider: plan }))

        return state.consent.provider === plan && state.facts.every(fact => fact.provider === plan)
          ? [plan, state] as const
          : undefined
      } catch {
        return undefined
      }
    }))

    return new Map(rows.filter(row => row !== undefined))
  }

  return {
    async readPlans(principal: string): Promise<WorkAgentPlans | null> {
      const catalog = await readCatalog()

      if (!catalog) {return null}

      const call = deviceServiceCall(platform())
      const [{ revision, selection, efforts }, account] = await Promise.all([readSelection(call, principal), readAccountPlans(call)])
      const at = now()
      const machines: NonNullable<WorkAgentPlans['machines']> = {}

      for (const [plan, state] of account) {
        const rows = workRelayMachines(state, at)

        if (rows.length) {machines[plan] = rows}
      }

      return {
        ...withAccountModels(catalog, account, machines),
        selection: selection && { ...selection, revision },
        ...(machines && Object.keys(machines).length ? { machines } : {}),
        ...(efforts && efforts.length > 1 ? { efforts } : {})
      }
    },
    async select(principal: string, model: string, plan: WorkRelayPlan = 'codex', effort?: WorkRelayEffort) {
      const options = platform()
      // The read, write and possible retry all belong to the same signed-in owner.
      const bearer = await options.bearer()
      const call = deviceServiceCall({ ...options, bearer: async () => bearer })

      const write = async (expectedRevision: number) => WorkRelaySelectionSchema.parse(
        await call('work_selection_set', {
          agentPrincipal: principal, expectedRevision, selection: { provider: 'atum-work', plan, model, ...(effort ? { effort } : {}) }
        })
      )

      const { revision } = await readSelection(call, principal)

      try {
        return await write(revision)
      } catch (error) {
        // The selection write's only 409 is a revision conflict. A concurrent pick can win again.
        if (!(error instanceof Error && 'status' in error && error.status === 409)) {
          throw error
        }

        const latest = await readSelection(call, principal)

        if (latest.revision === revision) {
          throw error
        }

        return write(latest.revision)
      }
    }
  }
}

/**
 * A plan another of the owner's Macs serves is a real choice even when this Mac lacks it: the
 * platform checks the pick against every Mac's facts (0540 `work_selection_set`). This Mac's own
 * catalog wins; another Mac's signed-in plan fills in what this Mac does not list.
 */
function withAccountModels(
  catalog: Omit<WorkAgentPlans, 'selection'>,
  account: ReadonlyMap<WorkRelayPlan, WorkSubscriptionState>,
  machines: NonNullable<WorkAgentPlans['machines']>
): Omit<WorkAgentPlans, 'selection'> {
  const plans = { ...catalog.plans }

  for (const plan of WORK_RELAY_PLANS) {
    const own = plans[plan]
    const online = new Set(machines[plan]?.filter(machine => machine.online).map(machine => machine.id))

    if ((own?.state === 'connected' && own.models?.length) || !online.size) {continue}

    const models = (account.get(plan)?.facts ?? [])
      .filter(fact => online.has(fact.deviceServiceId))
      .flatMap(fact => fact.models ?? [])
      .filter((model, index, all) => all.findIndex(each => each.id === model.id) === index)

    if (models.length) {
      plans[plan] = { state: 'connected', models }
    }
  }

  return { ...catalog, plans }
}
