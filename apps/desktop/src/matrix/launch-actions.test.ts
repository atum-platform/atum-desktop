import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'

import { runMatrixReadinessAction } from './launch-actions'

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'MAC' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}
afterEach(() => Reflect.deleteProperty(window, 'atumMatrix'))
describe('the damaged human launch action', () => {
  it.each([{}, { deviceDamaged: true }, { ownerDeviceRepair: { state: 'resume_pending' } }] as const)(
    'uses main evidence to route %j',
    async extra => {
      const bridge = {
        signOut: vi.fn(async () => {}),
        signIn: vi.fn(async () => {}),
        repairOwnerDevice: vi.fn(async () => ({ state: 'repaired' }))
      }
      Object.defineProperty(window, 'atumMatrix', { configurable: true, value: bridge })
      await runMatrixReadinessAction('sign_in_again', { ...snapshot, ...extra })
      const repair = 'deviceDamaged' in extra || 'ownerDeviceRepair' in extra
      expect(bridge.repairOwnerDevice).toHaveBeenCalledTimes(repair ? 1 : 0)
      expect(bridge.signOut).toHaveBeenCalledTimes(repair ? 0 : 1)
      expect(bridge.signIn).toHaveBeenCalledTimes(repair ? 0 : 1)
    }
  )

  it('never retries a failed assistant backend as a substitute for ChatGPT recovery', async () => {
    const retryReadiness = vi.fn(async () => {})
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { retryReadiness } })

    await runMatrixReadinessAction('plan_sign_in', snapshot)
    expect(retryReadiness).not.toHaveBeenCalled()
  })
})
