import {
  ACCOUNT_PLANS,
  type AccountConnection,
  type AccountConnectionsView,
  type AccountPlan,
  type AccountPlanConnection
} from '../../../shared/account-connections'
import { WORK_RELAY_PLANS } from '../../../shared/matrix-work-relay'

/**
 * Account connections as the window draws them. Pure: from the one registry read to rows, lines and the picker's rule. No copy
 * here beyond the names a caller passes in.
 */

export type AccountPlanState = 'connected' | 'stale' | 'not_connected' | 'needs_attention'

export interface AccountPlanMac {
  id: string
  name: string
  thisMac: boolean
  stale: boolean
}

export interface AccountPlanRow {
  plan: AccountPlan
  state: AccountPlanState
  macs: AccountPlanMac[]
  models: { id: string; displayName: string }[]
  /** Connected (fresh) on this Mac: Work can run it natively right here. */
  here: boolean
}

function planRow(connection: AccountPlanConnection | undefined, plan: AccountPlan, view?: AccountConnectionsView | null): AccountPlanRow {
  if (!connection) {
    return { plan, state: 'not_connected', macs: [], models: [], here: false }
  }

  const macs = connection.devices.map(device => ({
    id: device.deviceServiceId,
    name: device.displayName,
    thisMac: device.deviceServiceId === view?.thisDevice,
    stale: device.status === 'stale'
  }))
  const enrollingHere = view?.localPlans?.includes(plan) === true

  // This Mac first, then fresh Macs, then stale ones.
  macs.sort((left, right) => Number(right.thisMac) - Number(left.thisMac) || Number(left.stale) - Number(right.stale))

  const state: AccountPlanState =
    enrollingHere
      ? 'connected'
      : connection.status === 'needs_attention'
      ? 'needs_attention'
      : connection.status === 'not_connected' || macs.length === 0
        ? 'not_connected'
        : macs.every(mac => mac.stale)
          ? 'stale'
          : 'connected'

  return {
    plan,
    state,
    macs,
    models: state === 'not_connected' ? [] : connection.models.map(({ id, displayName }) => ({ id, displayName })),
    here: enrollingHere || macs.some(mac => mac.thisMac && !mac.stale)
  }
}

/** Every plan, always (connected or not), in the order the picker and Settings share: connected, then last seen, then the rest. */
export function accountPlanRows(view: AccountConnectionsView | null | undefined): AccountPlanRow[] {
  const byPlan = new Map(
    (view?.connections ?? [])
      .filter((connection): connection is AccountPlanConnection => connection.kind === 'plan')
      .map(connection => [connection.id, connection])
  )

  const rank: Record<AccountPlanState, number> = { connected: 0, needs_attention: 1, stale: 2, not_connected: 3 }

  return ACCOUNT_PLANS.map(plan => planRow(byPlan.get(plan), plan, view)).sort(
    (left, right) => rank[left.state] - rank[right.state]
  )
}

export function accountPlanRow(view: AccountConnectionsView | null | undefined, plan: AccountPlan): AccountPlanRow {
  return accountPlanRows(view).find(row => row.plan === plan) ?? planRow(undefined, plan)
}

/** The Mac names a plan row reads, "this Mac" for this one, joined with commas. */
export function accountPlanMacNames(row: AccountPlanRow, thisMac: string): string {
  const names = row.macs.map(mac => (mac.thisMac ? thisMac : mac.name))

  if (row.here && !row.macs.some(mac => mac.thisMac)) {names.unshift(thisMac)}

  return names.join(', ')
}

/** Cloud rows the pane lists itself (Google keeps its own sign-in section). Owner chats always, home hubs as the registry has them. */
export function accountToolRows(view: AccountConnectionsView | null | undefined): AccountConnection[] {
  const rows = (view?.connections ?? []).filter(
    connection => connection.id === 'owner_chats' || connection.id.startsWith('home_hub:')
  )

  return rows.some(row => row.id === 'owner_chats')
    ? rows
    : [
        { id: 'owner_chats', kind: 'tools', provider: 'owner_chats', custody: 'cloud', status: 'connected', reach: { chat: 'direct', work: 'none', agents: 'all' } },
        ...rows
      ]
}

/** `home_hub:strap-hub` → "Strap hub". */
export function homeHubName(id: string): string {
  const name = id.replace(/^home_hub:/u, '').replace(/-/gu, ' ')

  return name.charAt(0).toLocaleUpperCase() + name.slice(1)
}

/**
 * The picker's rule for one plan in a cloud assistant's list (relay plan §3.1, coordinator 11-23):
 * - not connected anywhere: no rows, the rail mark is hollow, the list is one Connect state;
 * - connected (fresh or last seen) and the relay carries this plan: ChatGPT's rows follow the relay's own view (`relay`);
 * - connected, but the relay does not carry this plan yet: its models are listed greyed with one line (`in_work`).
 * An asleep or offline Mac never greys a plan: that turn answers on Nguyệt Thực before dispatch.
 */
export type AccountPickerPlan =
  | { plan: AccountPlan; kind: 'connect' }
  | { plan: AccountPlan; kind: 'relay'; models: AccountPlanRow['models'] }
  | { plan: AccountPlan; kind: 'in_work'; models: AccountPlanRow['models'] }

export function accountPickerPlans(view: AccountConnectionsView | null | undefined): AccountPickerPlan[] {
  return accountPlanRows(view).map(row => {
    if (row.state === 'not_connected' || row.state === 'needs_attention') {
      return { plan: row.plan, kind: 'connect' }
    }

    return WORK_RELAY_PLANS.includes(row.plan as never)
      ? { plan: row.plan, kind: 'relay', models: row.models }
      : { plan: row.plan, kind: 'in_work', models: row.models }
  })
}

/** The picker's provider id for a plan (`openai-codex` is the id every ChatGPT route already carries). */
export const ACCOUNT_PLAN_PICKER_PROVIDER: Record<AccountPlan, string> = {
  codex: 'openai-codex',
  claude: 'claude-plan',
  antigravity: 'antigravity'
}

export function accountPlanOfPickerProvider(provider: string | undefined): AccountPlan | undefined {
  return ACCOUNT_PLANS.find(plan => ACCOUNT_PLAN_PICKER_PROVIDER[plan] === provider)
}
