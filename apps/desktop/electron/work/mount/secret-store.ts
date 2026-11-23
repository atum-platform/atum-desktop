import { join } from 'node:path'

import { EncryptedStore, type SafeStorageLike } from '../../encrypted-store'
import type { SecretStore } from '../gate/sessions'

// The gate's secrets: each agent's T3 bearer and main's owner session (plan §6.5: "Main's memory and the macOS
// Keychain"). The app's own secure storage is `EncryptedStore`: every value is encrypted with Electron's safeStorage
// (the Keychain-held key) and the file is an atomic mode-0600 index. This is only an adapter from that store to the
// gate's synchronous `SecretStore` port; no new dependency and no second mechanism.
//
// Fail closed: when safeStorage cannot encrypt, `set` throws (a session is then not issued, and nothing is written in
// the clear); when a value cannot be decrypted, `get` answers "none", so the gate issues a fresh session instead of
// using a value it cannot read, and the stable failure code is reported once through `onFailure`.

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
