import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EncryptedStore, type SafeStorageLike } from '../../encrypted-store'

import { DEVICE_ACCOUNT_EPOCH_KEY, DeviceEpochs, readBootSessionId } from './epochs'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function vault(available = { value: true }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-epochs-'))
  directories.push(directory)

  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => available.value,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  }

  return { file: path.join(directory, 'device-service.json'), safeStorage, available }
}

const boot = '00000000-0000-4000-8000-354570cd5e97'

describe('the account epoch', () => {
  it('starts at 1 and only ever moves forward, across restarts', () => {
    const { file, safeStorage } = vault()
    const first = new DeviceEpochs({ store: new EncryptedStore(file, safeStorage), bootId: () => boot })

    expect(first.accountEpoch()).toBe(1)
    expect(first.bumpAccountEpoch()).toBe(2)
    expect(first.bumpAccountEpoch()).toBe(3)

    // A restart reads the stored value: never back to 1.
    const restarted = new DeviceEpochs({ store: new EncryptedStore(file, safeStorage), bootId: () => boot })
    expect(restarted.accountEpoch()).toBe(3)
    expect(restarted.bumpAccountEpoch()).toBe(4)
  })

  it('moves on in memory when the vault refuses the write, and writes it once the vault is back', () => {
    const { file, safeStorage, available } = vault()
    const store = new EncryptedStore(file, safeStorage)
    const epochs = new DeviceEpochs({ store, bootId: () => boot })
    expect(epochs.accountEpoch()).toBe(1)

    available.value = false
    // Sign-out still fences: the epoch moves on synchronously even though nothing could be written.
    expect(epochs.bumpAccountEpoch()).toBe(2)

    available.value = true
    expect(epochs.accountEpoch()).toBe(2)
    expect(new EncryptedStore(file, safeStorage).getItem(DEVICE_ACCOUNT_EPOCH_KEY)).toBe('2')
  })

  it('refuses to name an epoch it cannot read, rather than start again from 1', () => {
    const { file, safeStorage, available } = vault()
    const store = new EncryptedStore(file, safeStorage)
    store.setItem(DEVICE_ACCOUNT_EPOCH_KEY, '7')
    available.value = false

    const epochs = new DeviceEpochs({ store: new EncryptedStore(file, safeStorage), bootId: () => boot })
    expect(() => epochs.accountEpoch()).toThrow('device_epoch_store_unavailable')

    // A corrupt record is not "no record": it never restarts the epoch at 1 either.
    available.value = true
    store.setItem(DEVICE_ACCOUNT_EPOCH_KEY, 'x')
    expect(() => new DeviceEpochs({ store: new EncryptedStore(file, safeStorage) }).accountEpoch()).toThrow(
      'device_epoch_store_unavailable'
    )
  })
})

describe('boot and local generation', () => {
  it('reads the boot session UUID in the contract form and refuses anything else', () => {
    expect(readBootSessionId(() => `${boot}\n`)).toBe(boot.toUpperCase())
    expect(readBootSessionId(() => 'not-a-uuid')).toBeNull()
    expect(
      readBootSessionId(() => {
        throw new Error('sysctl missing')
      })
    ).toBeNull()

    const { file, safeStorage } = vault()
    expect(() =>
      new DeviceEpochs({ store: new EncryptedStore(file, safeStorage), bootId: () => null }).bootId()
    ).toThrow('device_epoch_boot_unavailable')
  })

  it('reads the real boot session on this Mac', () => {
    if (process.platform !== 'darwin') {
      return
    }

    expect(readBootSessionId()).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
  })

  it('bumps the local generation on sleep or stop', () => {
    const { file, safeStorage } = vault()
    const epochs = new DeviceEpochs({ store: new EncryptedStore(file, safeStorage), bootId: () => boot })
    const before = epochs.localGeneration()

    expect(epochs.bumpLocalGeneration()).toBe(before + 1)
    expect(epochs.localGeneration()).toBe(before + 1)
  })
})
