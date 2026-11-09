import { type CryptoApi, OnlySignedDevicesIsolationMode } from 'matrix-js-sdk/lib/crypto-api'

import { matrixDeviceIsolation, type MatrixDeviceIsolation } from '../../shared/matrix-device-isolation'

/** Once per fresh client. A setting change rebuilds the SDK host.
 * All preserves the existing default mode/blacklist; signed bypasses the legacy rule. */
export function initializeMatrixDeviceIsolation(
  crypto: Pick<CryptoApi, 'setDeviceIsolationMode' | 'globalBlacklistUnverifiedDevices'>,
  isolation: MatrixDeviceIsolation | undefined,
  keySharing: 'verified' | 'all' | undefined
): void {
  if (matrixDeviceIsolation(isolation) === 'signed') {
    crypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode())
  } else {
    crypto.globalBlacklistUnverifiedDevices = keySharing !== 'all'
  }
}
