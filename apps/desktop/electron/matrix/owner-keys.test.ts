import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import {
  forgetMatrixOwnerKey,
  keptMatrixOwnerKey,
  type MatrixOwnerBinding,
  type MatrixOwnerKeyLegacy,
  matrixOwnerKeyMirrors,
  matrixOwnerKeyRetention,
  MatrixOwnerKeys,
  retainMatrixOwnerKey
} from './owner-keys'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const KEY = 'EsTc 1234 abcd EFGH ijkl MNOP qrst UVWX yz12 3456 789A BCDE'
const OTHER = 'EsTd 9999 abcd EFGH ijkl MNOP qrst UVWX yz12 3456 789A BCDE'
const minh: MatrixOwnerBinding = { issuer: 'https://auth.test/', subject: 'subject-minh', userId: '@minh:test' }

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-owner-keys-'))
  directories.push(directory)
  const file = path.join(directory, 'owner-keys.json')
  let time = 1_000

  const store = new EncryptedStore(file, {
    isEncryptionAvailable: () => true,
    // Reversible stand-in for safeStorage, so the file can be checked for plaintext.
    encryptString: value => Buffer.from(value).reverse(),
    decryptString: value => Buffer.from(value).reverse().toString()
  })

  const keys = new MatrixOwnerKeys(store, () => time)

  return { file, keys, store, tick: () => (time += 1_000) }
}

/** The account record of 0.18.1 and earlier, as account.ts kept it. */
function legacyRecord(initial?: { key: string; custody?: 'device' }) {
  let record = initial
  let written = 0

  const legacy: MatrixOwnerKeyLegacy = {
    read: () => record,
    write: (key, custody) => {
      record = { key, ...(custody ? { custody } : {}) }
    },
    written: () => {
      written += 1
    },
    forget: () => {
      record = undefined
    }
  }

  return { legacy, record: () => record, written: () => written }
}

describe('the recovery key kept for the person on this Mac', () => {
  it('survives the account record: one entry per person, encrypted, the person never in the clear', () => {
    const { file, keys } = fixture()
    keys.retain(minh, KEY, { source: 'typed', keyId: 'qwen3.5-plus' })

    expect(keys.current(minh)).toEqual({ key: KEY, keyId: 'qwen3.5-plus', source: 'typed', savedAt: 1_000 })

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain('@minh:test')
    expect(raw).not.toContain('subject-minh')
  })

  it('is never handed to another account on the same Mac', () => {
    const { keys } = fixture()
    keys.retain(minh, KEY, { source: 'typed' })

    expect(keys.current({ ...minh, subject: 'subject-someone-else' })).toBeUndefined()
    expect(keys.current({ ...minh, userId: '@someone:test' })).toBeUndefined()
    expect(keys.current({ ...minh, issuer: 'https://other-auth.test/' })).toBeUndefined()
  })

  it('keeps one key per person: only a typed key replaces it, and only a quiet one is "on this Mac only"', () => {
    const { keys, tick } = fixture()
    keys.retain(minh, KEY, { source: 'created', custody: 'device' })
    expect(keys.current(minh)?.custody).toBe('device')

    tick()
    keys.retain(minh, OTHER, { source: 'typed' })
    expect(keys.current(minh)).toEqual({ key: OTHER, source: 'typed', savedAt: 2_000 })
  })

  it('never lets a key from anywhere but the person replace the kept one, even one gone stale', () => {
    const { keys, tick } = fixture()
    keys.retain(minh, KEY, { source: 'created', custody: 'device', keyId: 'old' })
    tick()

    // Another device's approval, iCloud Keychain, a quiet first-Mac key, the record's old copy.
    for (const source of ['approved', 'icloud', 'created', 'migrated'] as const) {
      expect(() => keys.retain(minh, OTHER, { source, keyId: 'new' })).toThrow('matrix_recovery_kept')
    }

    expect(keys.current(minh)).toEqual({ key: KEY, keyId: 'old', source: 'created', custody: 'device', savedAt: 1_000 })

    // The same key again (iCloud's copy got here first) writes nothing but a key id learned now:
    // it stays the quietly made key, not yet written down.
    expect(keys.retain(minh, KEY, { source: 'approved', keyId: 'new' })).toEqual({
      key: KEY,
      keyId: 'new',
      source: 'created',
      custody: 'device',
      savedAt: 1_000
    })

    // A recovery the person made themselves in Settings (the SDK makes one only on an account
    // that has none) replaces it.
    keys.retain(minh, OTHER, { source: 'created', byPerson: true })
    expect(keys.current(minh)).toEqual({ key: OTHER, source: 'created', savedAt: 2_000 })
  })

  it('states the rule on its own: keep, same, or refuse', () => {
    expect(matrixOwnerKeyRetention(undefined, KEY, { source: 'approved' })).toBe('keep')
    expect(matrixOwnerKeyRetention({ key: KEY }, KEY, { source: 'icloud' })).toBe('same')
    expect(matrixOwnerKeyRetention({ key: KEY }, OTHER, { source: 'icloud' })).toBe('refuse')
    expect(matrixOwnerKeyRetention({ key: KEY }, OTHER, { source: 'approved' })).toBe('refuse')
    expect(matrixOwnerKeyRetention({ key: KEY }, OTHER, { source: 'typed' })).toBe('keep')
    expect(matrixOwnerKeyRetention({ key: KEY }, OTHER, { source: 'created', byPerson: true })).toBe('keep')
  })

  it('learns the key id, clears the "not written down" mark, and forgets only on request', () => {
    const { keys } = fixture()
    keys.retain(minh, KEY, { source: 'created', custody: 'device' })

    keys.noteKeyId(minh, 'key-1')
    expect(keys.current(minh)).toMatchObject({ keyId: 'key-1', custody: 'device' })

    keys.markWritten(minh)
    expect(keys.current(minh)).toEqual({ key: KEY, keyId: 'key-1', source: 'created', savedAt: 1_000 })

    keys.forget({ ...minh, subject: 'subject-someone-else' })
    expect(keys.current(minh)?.key).toBe(KEY)

    keys.forget(minh)
    expect(keys.current(minh)).toBeUndefined()
  })

  it('refuses what is not a recovery key, and a binding with no person', () => {
    const { keys } = fixture()

    for (const bad of ['', 'key\nwith newline', 'k'.repeat(257), 'ключ']) {
      expect(() => keys.retain(minh, bad, { source: 'typed' })).toThrow('matrix_recovery_invalid')
    }

    expect(() => keys.retain({ ...minh, subject: '' }, KEY, { source: 'typed' })).toThrow('matrix_recovery_stale')
    expect(keys.current({ ...minh, userId: 'minh' })).toBeUndefined()
  })

  it('says the vault is unavailable rather than "no key" when it cannot be read', () => {
    const { file, keys } = fixture()
    keys.retain(minh, KEY, { source: 'typed' })

    const locked = new MatrixOwnerKeys(
      new EncryptedStore(file, {
        isEncryptionAvailable: () => false,
        encryptString: value => Buffer.from(value),
        decryptString: value => value.toString()
      })
    )

    expect(() => locked.current(minh)).toThrow('matrix_vault_unavailable')
  })

  it('lets the person’s typed key replace an entry that can’t be decrypted, and nothing else', () => {
    const { file, keys } = fixture()
    keys.retain(minh, KEY, { source: 'approved' })

    // The Keychain item that decrypts this entry is gone (a restored Mac, say): encrypting works.
    const undecryptable = new MatrixOwnerKeys(
      new EncryptedStore(file, {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(value).reverse(),
        decryptString: () => {
          throw new Error('decrypt failed')
        }
      })
    )

    for (const source of ['approved', 'icloud', 'created', 'migrated'] as const) {
      expect(() => undecryptable.retain(minh, OTHER, { source })).toThrow('matrix_vault_unavailable')
    }

    expect(keys.current(minh)).toMatchObject({ key: KEY, source: 'approved' })

    // The account record's carry-over step never stops the typed key either.
    retainMatrixOwnerKey(undecryptable, minh, legacyRecord({ key: KEY }).legacy, OTHER, { source: 'typed' })
    expect(keys.current(minh)).toMatchObject({ key: OTHER, source: 'typed' })
    // A recovery the person made in Settings likewise.
    undecryptable.retain(minh, KEY, { source: 'created', byPerson: true })
    expect(keys.current(minh)).toMatchObject({ key: KEY, source: 'created' })
  })

  it('counts an entry it can’t read as kept: never "no key", never written over but by a typed key', () => {
    const items = new Map<string, string>()

    // A plain stand-in for the vault, so an entry can be edited as a newer release would write it.
    const store = {
      getItem: (name: string) => items.get(name) ?? null,
      setItem: (name: string, value: string) => void items.set(name, value),
      removeItem: (name: string) => void items.delete(name),
      failureCode: () => null
    } as unknown as EncryptedStore

    const keys = new MatrixOwnerKeys(store, () => 1_000)
    keys.retain(minh, KEY, { source: 'typed', keyId: 'qwen3.5-plus' })
    const [name, raw] = [...items][0]!

    for (const unreadable of [
      JSON.stringify({ ...JSON.parse(raw), source: 'passkey' }),
      JSON.stringify({ ...JSON.parse(raw), v: 2 }),
      '{not json'
    ]) {
      items.set(name, unreadable)

      expect(() => keys.current(minh)).toThrow('matrix_vault_unavailable')

      for (const source of ['approved', 'icloud', 'created'] as const) {
        expect(() => keys.retain(minh, OTHER, { source })).toThrow('matrix_vault_unavailable')
      }

      // The account record's old copy is never carried over it.
      const old = legacyRecord({ key: OTHER })
      expect(() => keptMatrixOwnerKey(keys, minh, old.legacy)).toThrow('matrix_vault_unavailable')
      expect(() => retainMatrixOwnerKey(keys, minh, old.legacy, OTHER, { source: 'approved' })).toThrow(
        'matrix_vault_unavailable'
      )
      expect(items.get(name)).toBe(unreadable)
    }

    // The person's typed key replaces it.
    keys.retain(minh, OTHER, { source: 'typed' })
    expect(keys.current(minh)).toMatchObject({ key: OTHER, source: 'typed' })

    // A key id this store could not read back is never written.
    keys.noteKeyId(minh, 'key id with spaces')
    expect(keys.current(minh)?.keyId).toBeUndefined()
  })
})

describe('copying the kept key to iCloud Keychain', () => {
  it('copies only a key the person has or had themselves, never one another device sent', () => {
    expect(matrixOwnerKeyMirrors({ source: 'approved' })).toBe(false)
    expect(matrixOwnerKeyMirrors(undefined)).toBe(false)

    for (const source of ['created', 'typed', 'icloud', 'migrated'] as const) {
      expect(matrixOwnerKeyMirrors({ source })).toBe(true)
    }

    // An approved key kept on a new Mac stays off iCloud until the person types it here.
    const { keys } = fixture()
    keys.retain(minh, KEY, { source: 'approved', keyId: 'qwen3.5-plus' })
    expect(matrixOwnerKeyMirrors(keys.current(minh))).toBe(false)
    keys.retain(minh, KEY, { source: 'typed', keyId: 'qwen3.5-plus' })
    expect(matrixOwnerKeyMirrors(keys.current(minh))).toBe(true)
  })
})

describe('carrying the key over from the account record of 0.18.1', () => {
  it('moves it here once, with its "made on this Mac" mark, and reads this store afterwards', () => {
    const { keys } = fixture()
    const old = legacyRecord({ key: KEY, custody: 'device' })

    expect(keptMatrixOwnerKey(keys, minh, old.legacy)).toEqual({
      key: KEY,
      source: 'migrated',
      custody: 'device',
      savedAt: 1_000
    })
    // The account record goes at sign-out; the key stays.
    expect(keptMatrixOwnerKey(keys, minh, legacyRecord().legacy)?.key).toBe(KEY)
  })

  it('has nothing to carry over when neither holds a key, or the record cannot be read', () => {
    const { keys } = fixture()

    expect(keptMatrixOwnerKey(keys, minh, legacyRecord().legacy)).toBeUndefined()
    expect(
      keptMatrixOwnerKey(keys, minh, {
        read: () => {
          throw new Error('matrix_recovery_stale')
        },
        write: () => {},
        written: () => {},
        forget: () => {}
      })
    ).toBeUndefined()
  })

  it('sees the record’s old copy too: an approval never replaces a key kept only there', () => {
    const { keys } = fixture()
    const old = legacyRecord({ key: KEY })

    expect(() => retainMatrixOwnerKey(keys, minh, old.legacy, OTHER, { source: 'approved' })).toThrow(
      'matrix_recovery_kept'
    )
    expect(keys.current(minh)).toMatchObject({ key: KEY, source: 'migrated' })
    expect(old.record()).toEqual({ key: KEY })
  })

  it('writes both places for one release, so going back to 0.18.1 still finds the key', () => {
    const { keys } = fixture()
    const old = legacyRecord()

    retainMatrixOwnerKey(keys, minh, old.legacy, KEY, { source: 'created', custody: 'device' })
    expect(keys.current(minh)).toMatchObject({ key: KEY, custody: 'device' })
    expect(old.record()).toEqual({ key: KEY, custody: 'device' })

    // A record that can't be written (signing out, another device) never loses the kept key.
    retainMatrixOwnerKey(
      keys,
      minh,
      {
        read: () => undefined,
        write: () => {
          throw new Error('matrix_recovery_stale')
        },
        written: () => {},
        forget: () => {}
      },
      OTHER,
      { source: 'typed' }
    )
    expect(keys.current(minh)?.key).toBe(OTHER)
  })
})

describe('forgetting the key on this Mac at sign-out', () => {
  it('forgets both copies, so nothing reads the key back later in the same sign-out', () => {
    const { keys } = fixture()
    const old = legacyRecord()
    retainMatrixOwnerKey(keys, minh, old.legacy, KEY, { source: 'typed' })

    // Forgetting this store's copy alone: the record's copy comes back as the kept key.
    keys.forget(minh)
    expect(keptMatrixOwnerKey(keys, minh, old.legacy)?.key).toBe(KEY)

    forgetMatrixOwnerKey(keys, minh, old.legacy)
    expect(old.record()).toBeUndefined()
    expect(keptMatrixOwnerKey(keys, minh, old.legacy)).toBeUndefined()
    expect(keys.current(minh)).toBeUndefined()
  })

  it('still forgets this store’s copy when the record cannot be changed, and says it failed', () => {
    const { keys } = fixture()
    keys.retain(minh, KEY, { source: 'typed' })

    expect(() =>
      forgetMatrixOwnerKey(keys, minh, {
        read: () => undefined,
        write: () => {},
        written: () => {},
        forget: () => {
          throw new Error('matrix_recovery_stale')
        }
      })
    ).toThrow('matrix_recovery_stale')
    expect(keys.current(minh)).toBeUndefined()
  })
})
