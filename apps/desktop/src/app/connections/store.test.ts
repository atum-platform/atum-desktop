import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $workActive, resetWorkStoreForTests } from '@/app/work/store'

import { ACCOUNT_CONNECTIONS_FIXTURE, type AccountConnectionsView } from '../../../shared/account-connections'
import type { MatrixWorkPlanConsent } from '../../../shared/matrix-work'

import {
  $accountConnect,
  $accountConnections,
  $accountConnectProgress,
  ACCOUNT_CONNECT_POLL_MS,
  ACCOUNT_CONNECT_WAIT_MS,
  continueAccountConnect,
  grantAccountPlanUse,
  loadAccountConnections,
  openAccountConnect,
  resetAccountConnectionsForTest
} from './store'

const THIS_MAC = ACCOUNT_CONNECTIONS_FIXTURE.thisDevice!
const RIN = '00000000-0000-4000-8000-00000000b001'
const LUNA = '00000000-0000-4000-8000-00000000b002'

const NOTHING: AccountConnectionsView = {
  ...ACCOUNT_CONNECTIONS_FIXTURE,
  connections: ACCOUNT_CONNECTIONS_FIXTURE.connections.map(row => (row.kind === 'plan' ? { ...row, status: 'not_connected', devices: [] } : row))
}

const CONSENT: MatrixWorkPlanConsent = {
  state: 'off',
  agents: [],
  eligible: [RIN, LUNA],
  macs: [{ id: THIS_MAC, thisMac: true, named: false }],
  alsoWhenScheduled: false
}

function bridge(reads: AccountConnectionsView[]) {
  let index = 0

  return {
    readConnections: vi.fn(async () => reads[Math.min(index++, reads.length - 1)] ?? null),
    openPlanConnect: vi.fn(async () => {}),
    readPlanConsent: vi.fn(async () => CONSENT),
    setPlanConsent: vi.fn(async () => ({ ...CONSENT, state: 'on' as const })),
    setPlan: vi.fn(async () => {})
  }
}

it('keeps an all-owner grant intact during automatic Connect consent', async () => {
  const b = bridge([])
  b.readPlanConsent.mockResolvedValue({ ...CONSENT, state: 'on', allOwnerAgents: true })
  await expect(grantAccountPlanUse(b, 'codex')).resolves.toBe(true)
  expect(b.setPlanConsent).not.toHaveBeenCalled()
  expect(b.setPlan).toHaveBeenCalledWith(true)
})

it.each(['allow', 'renew'] as const)('finishes %s with an existing all-owner grant', async mode => {
  const b = bridge([])
  b.readPlanConsent.mockResolvedValue({ ...CONSENT, state: 'on', allOwnerAgents: true })

  await continueAccountConnect({ plan: 'codex', mode }, b)

  expect($accountConnectProgress.get()).toEqual({ plan: 'codex', phase: 'done' })
  expect(b.setPlanConsent).not.toHaveBeenCalled()
  expect(b.setPlan).toHaveBeenCalledWith(true)
})

it('reports failure if the Mac switch cannot enable an existing all-owner grant', async () => {
  const b = bridge([])
  b.readPlanConsent.mockResolvedValue({ ...CONSENT, state: 'on', allOwnerAgents: true })
  b.setPlan.mockRejectedValue(new Error('offline'))

  await expect(grantAccountPlanUse(b, 'codex')).resolves.toBe(false)
  expect(b.setPlanConsent).not.toHaveBeenCalled()
})

beforeEach(() => {
  vi.useFakeTimers()
  resetAccountConnectionsForTest()
  resetWorkStoreForTests()
})

afterEach(() => {
  resetAccountConnectionsForTest()
  vi.useRealTimers()
})

describe('the one connect flow', () => {
  it('Continue shows Work on the plan’s own screen, waits for this Mac to report it, then says it is connected and lets every assistant use it', async () => {
    const port = bridge([NOTHING, NOTHING, ACCOUNT_CONNECTIONS_FIXTURE])
    openAccountConnect('codex')

    await continueAccountConnect($accountConnect.get()!, port)
    expect($accountConnect.get()).toBeNull()
    expect($workActive.get()).toBe(true)
    expect(port.openPlanConnect).toHaveBeenCalledWith('codex')
    expect($accountConnectProgress.get()).toEqual({ plan: 'codex', phase: 'signing_in' })

    await vi.advanceTimersByTimeAsync(ACCOUNT_CONNECT_POLL_MS * 3)
    expect($accountConnectProgress.get()).toEqual({ plan: 'codex', phase: 'done' })
    // Q1: the connect sentence is the consent: every assistant Work knows, this Mac, scheduled work too; this Mac's switch on.
    expect(port.setPlanConsent).toHaveBeenCalledWith({ agents: [RIN, LUNA], macs: [THIS_MAC], alsoWhenScheduled: true }, 'codex')
    expect(port.setPlan).toHaveBeenCalledWith(true)

    await vi.advanceTimersByTimeAsync(3_000)
    expect($accountConnectProgress.get()).toBeNull()
  })

  it('Claude connection grants assistants and scheduled work without a separate opt-in', async () => {
    const port = bridge([ACCOUNT_CONNECTIONS_FIXTURE])

    const claudeHere: AccountConnectionsView = {
      ...ACCOUNT_CONNECTIONS_FIXTURE,
      connections: ACCOUNT_CONNECTIONS_FIXTURE.connections.map(row =>
        row.id === 'claude' && row.kind === 'plan'
          ? { ...row, devices: [{ ...row.devices[0]!, deviceServiceId: THIS_MAC, status: 'connected' }] }
          : row
      )
    }

    port.readConnections.mockResolvedValue(claudeHere)

    await continueAccountConnect({ plan: 'claude' }, port)
    await vi.advanceTimersByTimeAsync(ACCOUNT_CONNECT_POLL_MS)

    expect(port.openPlanConnect).toHaveBeenCalledWith('claude')
    expect($accountConnectProgress.get()).toEqual({ plan: 'claude', phase: 'done' })
    expect(port.readPlanConsent).toHaveBeenCalledWith('claude')
    expect(port.setPlanConsent).toHaveBeenCalledWith({ agents: [RIN, LUNA], macs: [THIS_MAC], alsoWhenScheduled: true }, 'claude')
  })

  it('a sign-in that never lands says so once, after the wait', async () => {
    const port = bridge([NOTHING])

    await continueAccountConnect({ plan: 'antigravity' }, port)
    await vi.advanceTimersByTimeAsync(ACCOUNT_CONNECT_WAIT_MS + ACCOUNT_CONNECT_POLL_MS)

    expect($accountConnectProgress.get()).toEqual({ plan: 'antigravity', phase: 'failed' })
  })

  it('Allow (already connected) records the consent and finishes without opening a screen', async () => {
    const port = bridge([ACCOUNT_CONNECTIONS_FIXTURE])

    await continueAccountConnect({ plan: 'codex', mode: 'allow' }, port)

    expect(port.openPlanConnect).not.toHaveBeenCalled()
    expect(port.setPlanConsent).toHaveBeenCalledOnce()
    expect($accountConnectProgress.get()?.phase).toBe('done')
  })

  it('granting preserves named Macs and reports unavailable consent without throwing', async () => {
    const port = bridge([])
    port.readPlanConsent.mockResolvedValueOnce({
      ...CONSENT,
      state: 'on',
      agents: [RIN],
      macs: [{ id: THIS_MAC, thisMac: true, named: false }, { id: '33333333-3333-4333-8333-33333333abcd', thisMac: false, named: true }]
    })
    await grantAccountPlanUse(port, 'codex')
    expect(port.setPlanConsent).toHaveBeenCalledWith({
      agents: [RIN, LUNA],
      macs: ['33333333-3333-4333-8333-33333333abcd', THIS_MAC],
      alsoWhenScheduled: true
    }, 'codex')

    port.readPlanConsent.mockRejectedValueOnce(new Error('offline'))
    await expect(grantAccountPlanUse(port, 'codex')).resolves.toBe(false)
  })
})

describe('loadAccountConnections', () => {
  it('keeps the last good read when a later one fails, and answers null when nothing can be read', async () => {
    await loadAccountConnections({ readConnections: async () => ACCOUNT_CONNECTIONS_FIXTURE })
    await loadAccountConnections({ readConnections: async () => { throw new Error('offline') } })
    expect($accountConnections.get()).toEqual(ACCOUNT_CONNECTIONS_FIXTURE)

    resetAccountConnectionsForTest()
    await loadAccountConnections({})
    expect($accountConnections.get()).toBeNull()
  })
})
