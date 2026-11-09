import { describe, expect, it, vi } from 'vitest'

import { type AdmittedGrant, GrantTable } from './service'
import { DeviceStopFence } from './stop'

function liveGrant(grantId: string): AdmittedGrant {
  return {
    body: { grantId } as AdmittedGrant['body'],
    status: 'live',
    lastSeq: 0,
    effectiveScopes: ['terminal'],
    authorityUntil: Number.MAX_SAFE_INTEGER
  }
}

function harness(reason: 'local_stop' | 'sign_out' = 'local_stop') {
  const grants = new GrantTable()
  grants.set(liveGrant('g1'))
  grants.set(liveGrant('g2'))
  let accountEpoch = 7
  const order: string[] = []

  const deps = {
    grants,
    setStopped: vi.fn(() => order.push('setStopped')),
    voidApprovals: vi.fn(() => order.push('voidApprovals')),
    bumpConnectionEpoch: vi.fn(() => order.push('bumpConnectionEpoch')),
    bumpAccountEpoch: vi.fn(() => {
      accountEpoch += 1
      order.push('bumpAccountEpoch')
    }),
    ownedProcessGroups: () => [111, 222],
    killProcessGroup: vi.fn((pgid: number) => order.push(`kill:${pgid}`)),
    closeBroker: vi.fn(async () => {
      order.push('closeBroker')
    }),
    sendStop: vi.fn(async () => {
      order.push('sendStop')
    }),
    accountEpoch: () => accountEpoch
  }

  return { deps, grants, order, fence: new DeviceStopFence(deps) }
}

describe('DeviceStopFence', () => {
  it('refuses, stops grants, voids approvals and kills groups synchronously before any await', async () => {
    const h = harness()
    const promise = h.fence.fence('local_stop')

    // Synchronous half has already run by the time fence() returns the (pending) cleanup promise.
    expect(h.deps.setStopped).toHaveBeenCalledWith(true)
    expect(h.grants.live()).toHaveLength(0)
    expect(h.deps.voidApprovals).toHaveBeenCalledOnce()
    expect(h.deps.bumpConnectionEpoch).toHaveBeenCalledOnce()
    expect(h.deps.killProcessGroup).toHaveBeenCalledWith(111)
    expect(h.deps.killProcessGroup).toHaveBeenCalledWith(222)
    // The async cleanup has not necessarily run yet.
    expect(h.deps.sendStop).not.toHaveBeenCalled()

    await promise
    expect(h.deps.closeBroker).toHaveBeenCalledOnce()
    expect(h.deps.sendStop).toHaveBeenCalledWith('local_stop', 7, ['g1', 'g2'])
  })

  it('sign-out bumps the account epoch; local stop does not', async () => {
    const signOut = harness()
    await signOut.fence.fence('sign_out')
    expect(signOut.deps.bumpAccountEpoch).toHaveBeenCalledOnce()
    // Stop carries the bumped epoch.
    expect(signOut.deps.sendStop).toHaveBeenCalledWith('sign_out', 8, ['g1', 'g2'])

    const local = harness()
    await local.fence.fence('local_stop')
    expect(local.deps.bumpAccountEpoch).not.toHaveBeenCalled()
  })

  it('a process-group kill that throws does not break the fence', async () => {
    const h = harness()
    h.deps.killProcessGroup.mockImplementation(() => {
      throw new Error('ESRCH')
    })
    await expect(h.fence.fence('local_stop')).resolves.toBeUndefined()
    expect(h.grants.live()).toHaveLength(0)
  })

  it('an offline Stop send does not reject the fence', async () => {
    const h = harness()
    h.deps.sendStop.mockRejectedValue(new Error('offline'))
    await expect(h.fence.fence('sleep')).resolves.toBeUndefined()
    expect(h.deps.setStopped).toHaveBeenCalledWith(true)
  })
})
