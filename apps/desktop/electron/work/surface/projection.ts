import type { AccountPlan } from '../../../shared/account-connections'
import type { MatrixWorkPlanConsent } from '../../../shared/matrix-work'
import { PLAN_PROVIDER_BY_INSTANCE } from '../plan-providers'

import type { WorkSubscriptionState } from './plan-contract'

/** The same screen on each plan's built-in instance (`PLAN_PROVIDER_BY_INSTANCE`, reversed). */
export function workPlanConnectPath(plan: AccountPlan = 'codex'): string {
  const instance = (Object.keys(PLAN_PROVIDER_BY_INSTANCE) as (keyof typeof PLAN_PROVIDER_BY_INSTANCE)[]).find(
    id => PLAN_PROVIDER_BY_INSTANCE[id] === plan
  )

  return `/settings/providers?instanceId=${instance ?? 'codex'}`
}

/**
 * The owner page's view of the consent record: who is named, which Macs can be named (this one first, then the owner's other Macs
 * whose plan fact is connected, plus any Mac the record already names), and when it was granted. A Mac the read does not list and the
 * record does not name is not offered: the platform refuses a Mac with no Work route.
 */
export function projectWorkConsent(
  read: WorkSubscriptionState,
  thisMac: string | undefined,
  entitled: readonly string[] = []
): MatrixWorkPlanConsent {
  const record = read.consent
  const on = record.state === 'on'
  const named = new Set(on ? record.devices : [])
  const names = new Map(read.facts.flatMap(fact => (fact.displayName ? [[fact.deviceServiceId, fact.displayName] as const] : [])))

  const ids = [
    ...(thisMac ? [thisMac] : []),
    ...read.facts.filter(fact => fact.status === 'connected').map(fact => fact.deviceServiceId),
    ...named
  ].filter((id, index, all) => all.indexOf(id) === index)

  return {
    state: record.state,
    ...(record.agents === 'all' ? { allOwnerAgents: true } : {}),
    agents: on ? [...(record.agents === 'all' ? entitled : record.agents)] : [],
    eligible: [...entitled, ...(on && record.agents !== 'all' ? record.agents : [])].filter((id, index, all) => all.indexOf(id) === index),
    macs: ids.map(id => ({
      id,
      thisMac: id === thisMac,
      named: named.has(id),
      ...(names.has(id) ? { name: names.get(id) } : {})
    })),
    alsoWhenScheduled: on && record.alsoWhenScheduled,
    ...(record.grantedAt !== undefined ? { grantedAt: record.grantedAt } : {})
  }
}
