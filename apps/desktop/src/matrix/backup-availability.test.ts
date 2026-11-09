// @vitest-environment node
import { EventEmitter } from 'node:events'

import { ClientEvent, type MatrixClient } from 'matrix-js-sdk'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api'
import { expect, it, vi } from 'vitest'

import { matrixBackupAvailability } from './backup-availability'

const settled = async () => {
  for (let i = 0; i < 8; i++) {await Promise.resolve()}
}

it('offers generic Restore only after a confirmed backup version and removes it on absence/failure', async () => {
  const getKeyBackupInfo = vi.fn().mockResolvedValue({ version: '1' })
  const client = Object.assign(new EventEmitter(), { getCrypto: () => ({ getKeyBackupInfo }) })
  const changed = vi.fn()
  const view = matrixBackupAvailability(client as unknown as MatrixClient, changed)
  expect(view.available()).toBe(false)
  await settled()
  expect(view.available()).toBe(true)
  getKeyBackupInfo.mockResolvedValue(null)
  client.emit(CryptoEvent.KeyBackupStatus, false)
  await settled()
  expect(view.available()).toBe(false)
  getKeyBackupInfo.mockResolvedValue({ version: '2' })
  client.emit(ClientEvent.Sync, 'PREPARED')
  await settled()
  expect(view.available()).toBe(true)
  getKeyBackupInfo.mockRejectedValue(new Error('private raw error'))
  client.emit(CryptoEvent.KeyBackupStatus, false)
  await settled()
  expect(view.available()).toBe(false)
  expect(changed).toHaveBeenCalledTimes(4)
  view.stop()
})

it('ignores stale/late reads and stops listening without exposing raw backup material', async () => {
  let resolve: (value: unknown) => void = () => {}

  const getKeyBackupInfo = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    .mockResolvedValue(null)

  const client = Object.assign(new EventEmitter(), { getCrypto: () => ({ getKeyBackupInfo }) })
  const changed = vi.fn()
  const view = matrixBackupAvailability(client as unknown as MatrixClient, changed)
  await settled()
  client.emit(CryptoEvent.KeyBackupStatus, false)
  await settled()
  resolve({ version: 'stale', auth_data: { private: 'never projected' } })
  await settled()
  expect(view.available()).toBe(false)
  expect(changed).not.toHaveBeenCalled()
  view.stop()
  client.emit(ClientEvent.Sync, 'PREPARED')
  client.emit(CryptoEvent.KeyBackupStatus, true)
  expect(getKeyBackupInfo).toHaveBeenCalledTimes(2)
})
