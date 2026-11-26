import { join } from 'node:path'

import { EncryptedStore, type SafeStorageLike } from '../../encrypted-store'

import type { SecretStore } from './t3-mcp-session'

// Retain the storage namespace so published Connect sessions can still be revoked after upgrade.
export function workSecretsPath(account: { root: string }): string {
  return join(account.root, 'work', 'gate', 'secrets.json')
}

export function createKeychainSecretStore(input: {
  account: { root: string }
  safeStorage: SafeStorageLike
  onFailure?(code: string): void
}): SecretStore {
  // One file per account: signing out of one account never exposes or deletes another account's secrets.
  const store = new EncryptedStore(workSecretsPath(input.account), input.safeStorage, 'work-gate:')

  return {
    get(key) {
      const value = store.getItem(key)
      const failure = store.failureCode()

      if (value === null && failure) {
        input.onFailure?.(failure)
      }

      return value ?? undefined
    },
    set(key, value) {
      store.setItem(key, value)
    },
    delete(key) {
      store.removeItem(key)
    }
  }
}
