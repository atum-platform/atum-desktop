import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../../shared/matrix'
import type { MatrixCheckoutSnapshot } from '../../../shared/matrix-checkout'

import { $matrixStoreShelfRequest, matrixInAppTopUp, openMatrixTopUp } from './top-up'

const checkout: MatrixCheckoutSnapshot = {
  state: 'ready',
  packs: [],
  checkoutOpen: true,
  order: null,
  reconciliationPending: false,
  intent: null
}

const apps: NonNullable<MatrixSnapshot['apps']> = { state: 'ready', apps: [], connections: {} }

let bridge: { command: ReturnType<typeof vi.fn>; openTopUp: ReturnType<typeof vi.fn> }

beforeEach(() => {
  bridge = { command: vi.fn(async () => null), openTopUp: vi.fn(async () => {}) }
  window.atumMatrix = bridge as unknown as typeof window.atumMatrix
})

afterEach(() => {
  $matrixStoreShelfRequest.set(null)
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the one top-up', () => {
  it('opens the Store on its top-up when the build has the Store and its checkout', async () => {
    expect(matrixInAppTopUp({ apps, checkout })).toBe(true)
    await openMatrixTopUp({ apps, checkout })
    expect(bridge.command).toHaveBeenCalledWith({ kind: 'discoverApps' })
    expect($matrixStoreShelfRequest.get()).toBe('topups')
    expect(bridge.openTopUp).not.toHaveBeenCalled()
  })

  it.each([
    ['no checkout', { apps }],
    ['no Store destination', { checkout }]
  ])('keeps Atum’s payments page with %s', async (_name, snapshot) => {
    expect(matrixInAppTopUp(snapshot)).toBe(false)
    await openMatrixTopUp(snapshot)
    expect(bridge.openTopUp).toHaveBeenCalledOnce()
    expect(bridge.command).not.toHaveBeenCalled()
    expect($matrixStoreShelfRequest.get()).toBeNull()
  })

  it('drops the shelf request when the Store could not open', async () => {
    bridge.command.mockRejectedValueOnce(new Error('matrix_app_unavailable'))
    await expect(openMatrixTopUp({ apps, checkout })).rejects.toThrow('matrix_app_unavailable')
    expect($matrixStoreShelfRequest.get()).toBeNull()
  })
})
