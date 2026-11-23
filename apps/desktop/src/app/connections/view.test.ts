import { describe, expect, it } from 'vitest'

import { ACCOUNT_CONNECTIONS_FIXTURE, type AccountConnectionsView } from '../../../shared/account-connections'

import { accountPlanLine } from './connections-section'
import { connectionsCopy } from './copy'
import { accountPickerPlans, accountPlanRow, accountPlanRows, accountToolRows, homeHubName } from './view'

const en = connectionsCopy('en')
const vi = connectionsCopy('vi')

describe('account plan rows', () => {
  it('always lists the three plans: connected first, then last seen, then the ones to connect', () => {
    expect(accountPlanRows(ACCOUNT_CONNECTIONS_FIXTURE).map(row => [row.plan, row.state])).toEqual([
      ['codex', 'connected'],
      ['claude', 'stale'],
      ['antigravity', 'not_connected']
    ])
    expect(accountPlanRows(null).map(row => row.state)).toEqual(['not_connected', 'not_connected', 'not_connected'])
  })

  it('says where each plan runs, calling this Mac by its place, in English and Vietnamese', () => {
    expect(accountPlanLine(accountPlanRow(ACCOUNT_CONNECTIONS_FIXTURE, 'codex'), en)).toBe('On this Mac')
    expect(accountPlanLine(accountPlanRow(ACCOUNT_CONNECTIONS_FIXTURE, 'claude'), en)).toBe('Last seen on Mac mini')
    expect(accountPlanLine(accountPlanRow(ACCOUNT_CONNECTIONS_FIXTURE, 'antigravity'), vi)).toBe('Chưa kết nối')
    expect(accountPlanLine(accountPlanRow(ACCOUNT_CONNECTIONS_FIXTURE, 'codex'), vi)).toBe('Trên máy Mac này')
  })

  it('knows when a plan runs natively right here, and only then', () => {
    expect(accountPlanRow(ACCOUNT_CONNECTIONS_FIXTURE, 'codex').here).toBe(true)
    expect(accountPlanRow(ACCOUNT_CONNECTIONS_FIXTURE, 'claude').here).toBe(false)
  })

  it('reads a plan with no Mac left as not connected, whatever its status says', () => {
    const view: AccountConnectionsView = {
      ...ACCOUNT_CONNECTIONS_FIXTURE,
      connections: ACCOUNT_CONNECTIONS_FIXTURE.connections.map(row => (row.kind === 'plan' ? { ...row, devices: [] } : row))
    }

    expect(accountPlanRows(view).every(row => row.state === 'not_connected' && row.models.length === 0)).toBe(true)
  })
})

describe('the picker rule (relay plan §3.1)', () => {
  it('a plan the relay carries follows the relay; one it does not is greyed in Work; one connected nowhere offers Connect', () => {
    expect(accountPickerPlans(ACCOUNT_CONNECTIONS_FIXTURE).map(pick => [pick.plan, pick.kind])).toEqual([
      ['codex', 'relay'],
      ['claude', 'relay'],
      ['antigravity', 'connect']
    ])
  })

  it('never greys a plan because its Mac is asleep: a last-seen plan keeps its models', () => {
    const claude = accountPickerPlans(ACCOUNT_CONNECTIONS_FIXTURE).find(pick => pick.plan === 'claude')

    expect(claude?.kind === 'relay' && claude.models.map(model => model.id)).toEqual(['claude-sonnet-5-5'])
  })
})

describe('data and tools', () => {
  it('always lists your chats, and the home hubs the registry has', () => {
    expect(accountToolRows(ACCOUNT_CONNECTIONS_FIXTURE).map(row => row.id)).toEqual(['owner_chats', 'home_hub:strap'])
    expect(accountToolRows(null).map(row => row.id)).toEqual(['owner_chats'])
    expect(homeHubName('home_hub:situation-hub')).toBe('Situation hub')
  })
})
