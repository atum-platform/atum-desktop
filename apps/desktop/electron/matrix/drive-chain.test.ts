import { expect, it, vi } from 'vitest'

import type { MatrixDrive } from './drive'
import { DRIVE_CHAINED_SIGN_IN, matrixDriveChain } from './drive-chain'

it('keeps chained Drive sign-in off by default', () => {
  expect(DRIVE_CHAINED_SIGN_IN).toBe(false)
  expect(matrixDriveChain(() => undefined)).toBeUndefined()
})

it('joins preparation and cancellation only when explicitly enabled', async () => {
  const drive = {
    prepareChainedAuthorization: vi.fn(async () => 'https://auth.test/authorize'),
    cancelChainedAuthorization: vi.fn()
  } as unknown as MatrixDrive

  const chain = matrixDriveChain(() => drive, true)!

  await expect(chain.continueTo()).resolves.toBe('https://auth.test/authorize')
  chain.cancel()
  expect(drive.prepareChainedAuthorization).toHaveBeenCalledOnce()
  expect(drive.cancelChainedAuthorization).toHaveBeenCalledOnce()
})
