import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { SafeStorageAuthStorage, safeStorageAvailability, type SafeStorageLike } from './credential-vault'

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => {
    const decoded = value.toString('utf8')

    if (!decoded.startsWith('sealed:')) {
      throw new Error('not sealed')
    }

    return decoded.slice(7)
  }
}

function temporaryVault(): { directory: string; file: string; storage: SafeStorageAuthStorage } {
  const directory = mkdtempSync(join(tmpdir(), 'atum-official-auth-storage-'))
  const file = join(directory, 'auth.json')

  return { directory, file, storage: new SafeStorageAuthStorage(file, safeStorage) }
}

test('official auth storage encrypts every value and removes only the requested slot', () => {
  const { directory, file, storage } = temporaryVault()

  try {
    storage.setItem('session', '{"refresh_token":"rotating-secret"}')
    storage.setItem('pkce', 'verifier-secret')
    const persisted = readFileSync(file, 'utf8')
    assert.doesNotMatch(persisted, /rotating-secret|verifier-secret/)
    assert.equal(storage.getItem('session'), '{"refresh_token":"rotating-secret"}')

    storage.removeItem('pkce')
    assert.equal(storage.getItem('pkce'), null)
    assert.equal(storage.getItem('session'), '{"refresh_token":"rotating-secret"}')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('corrupt or undecryptable auth storage reports failure without throwing through Auth JS', () => {
  const corrupt = temporaryVault()

  try {
    writeFileSync(corrupt.file, '{"version":2,"entries":[]}', { mode: 0o600 })
    assert.equal(corrupt.storage.getItem('session'), null)
    assert.equal(corrupt.storage.failureCode(), 'auth_storage_corrupt')
    corrupt.storage.clear()
    assert.equal(corrupt.storage.getItem('session'), null)
  } finally {
    rmSync(corrupt.directory, { recursive: true, force: true })
  }

  const unavailableDirectory = mkdtempSync(join(tmpdir(), 'atum-official-auth-storage-unavailable-'))

  try {
    const storage = new SafeStorageAuthStorage(join(unavailableDirectory, 'auth.json'), {
      ...safeStorage,
      isEncryptionAvailable: () => false
    })

    assert.throws(() => storage.setItem('session', 'secret'), /auth_storage_unavailable/)
  } finally {
    rmSync(unavailableDirectory, { recursive: true, force: true })
  }
})

test('boot availability and activation encryption failures remain closed enums', () => {
  assert.equal(safeStorageAvailability(safeStorage), 'available')
  assert.equal(safeStorageAvailability({ ...safeStorage, isEncryptionAvailable: () => false }), 'unavailable')
  assert.equal(
    safeStorageAvailability({
      ...safeStorage,
      isEncryptionAvailable: () => {
        throw new Error('private platform detail')
      }
    }),
    'probe_failed'
  )

  const failing = temporaryVault()

  try {
    const storage = new SafeStorageAuthStorage(failing.file, {
      ...safeStorage,
      encryptString: () => {
        throw new Error('private keychain detail')
      }
    })

    assert.throws(() => storage.setItem('session', 'secret'), /auth_storage_encrypt_failed/u)
    assert.equal(storage.failureCode(), 'auth_storage_encrypt_failed')
  } finally {
    rmSync(failing.directory, { recursive: true, force: true })
  }
})
