// @vitest-environment node
import { DeviceIsolationModeKind } from 'matrix-js-sdk/lib/crypto-api'
import { expect, it, vi } from 'vitest'

import { matrixDeviceIsolation, matrixLegacyGroupKeys } from '../../shared/matrix-device-isolation'
import { matrixDeviceIsolationCopy } from '../../shared/matrix-device-isolation-copy'

import { initializeMatrixDeviceIsolation } from './device-isolation'

it('keeps the default legacy policy and the existing key-sharing choice', () => {
  for (const isolation of [undefined, 'all'] as const) {
    for (const keySharing of [undefined, 'verified', 'all'] as const) {
      const crypto = { globalBlacklistUnverifiedDevices: false, setDeviceIsolationMode: vi.fn() }
      initializeMatrixDeviceIsolation(crypto, isolation, keySharing)
      expect(crypto.globalBlacklistUnverifiedDevices).toBe(keySharing !== 'all')
      expect(crypto.setDeviceIsolationMode).not.toHaveBeenCalled()
      expect(matrixLegacyGroupKeys(isolation)).toBe(true)
    }
  }
})
it('signed selects actual SDK isolation without writing the legacy blacklist', () => {
  let written = false

  const crypto = {
    get globalBlacklistUnverifiedDevices() {
      return false
    },
    set globalBlacklistUnverifiedDevices(_value: boolean) {
      written = true
    },
    setDeviceIsolationMode: vi.fn()
  }

  initializeMatrixDeviceIsolation(crypto, 'signed', 'all')
  expect(crypto.setDeviceIsolationMode).toHaveBeenCalledOnce()
  expect(crypto.setDeviceIsolationMode.mock.calls[0]![0].kind).toBe(
    DeviceIsolationModeKind.OnlySignedDevicesIsolationMode
  )
  expect(written).toBe(false)
  expect(matrixLegacyGroupKeys('signed')).toBe(false)
})
it.each(['SIGNED', '', null, false, 1, {}])('invalid persisted policy never silently selects legacy: %j', value => {
  expect(() => matrixDeviceIsolation(value)).toThrow('matrix_device_isolation_invalid')
})
it('provides all actions and group/default qualifications in every supported locale', () => {
  expect(matrixDeviceIsolation(undefined)).toBe('all')

  for (const copy of Object.values(matrixDeviceIsolationCopy)) {
    for (const value of Object.values(copy)) {
      expect(typeof value === 'function' ? value('Person') : value).toBeTruthy()
    }

    expect(copy.identityChanged('Person')).toContain('Person')
    expect(copy.review).not.toBe(copy.continueWithoutVerification)
  }
})
