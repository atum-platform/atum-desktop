import { describe, expect, it, vi } from 'vitest'

import { MatrixOwnerDeviceRepair, type MatrixOwnerDeviceRepairPort } from './owner-device-repair'

const oldOwner = { userId: '@owner:test', deviceId: 'HUMAN_OLD' }
const newOwner = { ...oldOwner, deviceId: 'HUMAN_NEW' }

function fixture() {
  let current = oldOwner
  const port = {
    account: {
      identity: vi.fn(() => current),
      repairOwnerDevice: vi.fn(async () => {
        current = newOwner

        return { domain: true, replaced: oldOwner }
      }),
      cancelOwnerDeviceRepair: vi.fn()
    },
    damaged: vi.fn(() => true),
    resume: vi.fn(async (_replaced: typeof oldOwner) => ({ signed: true, backup: true })),
    log: vi.fn()
  } satisfies MatrixOwnerDeviceRepairPort

  return { port, repair: new MatrixOwnerDeviceRepair(port) }
}

describe('owner repair lifecycle', () => {
  it('requires main-owned damage evidence before authenticating', async () => {
    const { port, repair } = fixture()
    port.damaged.mockReturnValue(false)
    await expect(repair.run()).rejects.toThrow('matrix_owner_repair_not_damaged')
    expect(port.account.repairOwnerDevice).not.toHaveBeenCalled()
    expect(port.resume).not.toHaveBeenCalled()
  })

  it('coalesces clicks and resumes only the replaced human after the durable commit', async () => {
    const { port, repair } = fixture()
    const first = repair.run()
    expect(repair.run()).toBe(first)
    await expect(first).resolves.toEqual({ state: 'repaired' })
    expect(port.account.repairOwnerDevice).toHaveBeenCalledExactlyOnceWith(oldOwner, 'google')
    expect(port.resume).toHaveBeenCalledExactlyOnceWith(oldOwner)
  })

  it('does not stop or clean anything when authentication is cancelled or fails', async () => {
    const { port, repair } = fixture()
    port.account.repairOwnerDevice.mockRejectedValueOnce(new Error('matrix_login_cancelled'))
    await expect(repair.run()).rejects.toThrow('matrix_login_cancelled')
    expect(port.resume).not.toHaveBeenCalled()
    expect(port.account.identity()).toEqual(oldOwner)
    repair.cancel()
    expect(port.account.cancelOwnerDeviceRepair).toHaveBeenCalledOnce()
  })

  it.each(['throw', 'unsigned', 'no-backup'])(
    'retries activation after %s without reauthenticating or rolling back',
    async failure => {
      const { port, repair } = fixture()
      if (failure === 'throw') {
        port.resume.mockRejectedValueOnce(new Error('secret-unsafe-error'))
      } else {
        port.resume.mockResolvedValueOnce({ signed: failure !== 'unsigned', backup: failure !== 'no-backup' })
      }
      await expect(repair.run()).resolves.toEqual({ state: 'resume_pending' })
      expect(port.account.identity()).toEqual(newOwner)
      await expect(repair.run()).resolves.toEqual({ state: 'repaired' })
      expect(port.account.repairOwnerDevice).toHaveBeenCalledOnce()
      expect(port.resume).toHaveBeenCalledTimes(2)
      const logs = JSON.stringify(port.log.mock.calls)
      for (const value of ['secret-unsafe-error', oldOwner.deviceId, newOwner.deviceId, oldOwner.userId]) {
        expect(logs).not.toContain(value)
      }
    }
  )

  it('does not resume a pending replacement into a different account or device', async () => {
    const { port, repair } = fixture()
    port.resume.mockRejectedValueOnce(new Error('offline'))
    await repair.run()
    port.account.identity.mockReturnValue({ userId: '@another:test', deviceId: 'OTHER' })
    await expect(repair.run()).rejects.toThrow('matrix_owner_repair_stale')
    expect(port.resume).toHaveBeenCalledOnce()
  })
})


it('publishes verifying for both device IDs until activation settles, and scopes it to this account', async () => {
  const { repair, port } = fixture()
  let finish!: () => void
  port.resume.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ signed: true, backup: true }) }))
  const running = repair.run()
  expect(repair.snapshot(oldOwner)).toEqual({ state: 'verifying' })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(repair.snapshot(newOwner)).toEqual({ state: 'verifying' })
  expect(repair.replacing(newOwner)).toBe(true)
  expect(repair.snapshot(null)).toBeUndefined()
  finish()
  await running
  expect(repair.snapshot(newOwner)).toBeUndefined()
})
