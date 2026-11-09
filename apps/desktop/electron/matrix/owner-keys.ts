import { createHash } from 'node:crypto'

import type { EncryptedStore } from '../encrypted-store'

/**
 * The person's recovery key on this Mac, kept for them rather than for one sign-in
 * .
 *
 * Until 0.18.1 the key lived in the account record (`matrix-account`, account.ts) and left with
 * it at every sign-out, so signing in again on the same Mac (or after the sign-in server ended
 * the session) always stopped on "enter your recovery key" and the history stayed locked. Here
 * it lives in its own file (`owner-keys.json`: a damaged `credentials.json` can't take it down),
 * one entry per person, bound to the sign-in server, the person's subject there and their
 * Matrix user. The same person signing in again unlocks by themselves; another account on this
 * Mac never sees it. It goes only when the person asks (Forget the key on this Mac, when
 * signing out).
 *
 * Each value is encrypted by safeStorage with a key the macOS Keychain holds for this app only,
 * like the account vault. The key is never logged and leaves main only to the person's own SDK,
 * or to the person's window when they ask to see it.
 */
export interface MatrixOwnerBinding {
  /** The sign-in server. */
  issuer: string
  /** The person's subject there. */
  subject: string
  /** Their Matrix user. */
  userId: string
}

/**
 * Where a kept key came from: made quietly on a first Mac (`created`), typed by the person
 * (`typed`), sent by another of their devices after they approved this one (`approved`), read
 * from iCloud Keychain (`icloud`), or carried over from the account record of 0.18.1 and
 * earlier (`migrated`).
 */
export type MatrixOwnerKeySource = 'created' | 'typed' | 'approved' | 'icloud' | 'migrated'

/** How a key is offered to be kept (`MatrixOwnerKeys.retain`, the one guard below). */
export interface MatrixOwnerKeyRetain {
  source: MatrixOwnerKeySource
  keyId?: string
  /** `device`: made quietly on this first Mac, not written down yet. */
  custody?: 'device'
  /** The person made this recovery themselves, here, in Settings, and saw its key. The SDK makes
   * one only on an account that has none (security.ts `safeToCreate`), so a key kept before it
   * opens nothing. Never set for a key that arrived from anywhere else. */
  byPerson?: true
}

/**
 * The one rule for what becomes the key this Mac keeps, enforced in `MatrixOwnerKeys.retain`,
 * which every path that keeps a key goes through (typed, made here, approved by another device,
 * iCloud Keychain, carried over from 0.18.1).
 *
 * Only a typed key replaces a kept key, or a new recovery the person made themselves in Settings
 * (`byPerson`). A key from anywhere else (another device's approval, iCloud Keychain, a quiet
 * first-Mac key, the account record's old copy) never replaces a different one, even one gone
 * stale: a stale key means the account's recovery was changed elsewhere, and a key that opens
 * the new one says nothing about who changed it. Keeping it would sign this Mac into whatever
 * identity the server serves now, and lose a key that may exist nowhere else.
 *
 * `keep`: nothing is kept yet, or the person did it; `same`: this key is already kept (nothing to
 * write); `refuse`: another key is kept and this one did not come from the person.
 */
export function matrixOwnerKeyRetention(
  kept: Pick<MatrixOwnerKey, 'key'> | undefined,
  key: string,
  options: Pick<MatrixOwnerKeyRetain, 'source' | 'byPerson'>
): 'keep' | 'same' | 'refuse' {
  if (!kept || options.source === 'typed' || options.byPerson === true) {
    return 'keep'
  }

  return kept.key === key ? 'same' : 'refuse'
}

/** Sources of a key the person has or had themselves (`matrixOwnerKeyMirrors`). */
const MIRRORED = new Set<MatrixOwnerKeySource>(['created', 'typed', 'icloud', 'migrated'])

/**
 * Whether the kept key may be copied to iCloud Keychain, where every Mac on the person's Apple ID
 * that keeps no key adopts it without a tap (owner-unlock.ts). Only a key the person has or had
 * themselves: typed, made quietly here, carried over from 0.18.1, or iCloud's own copy (put back
 * when the person turns iCloud Keychain on again). Never a key another device sent after an
 * approval (`approved`): one mistaken "I picked them" while the identity was replaced elsewhere
 * would otherwise spread that key to every such Mac, including Macs that forgot theirs at sign-out
 * and every future one. The approving device already copied the same key from its own side.
 */
export function matrixOwnerKeyMirrors(kept: Pick<MatrixOwnerKey, 'source'> | undefined): boolean {
  return kept !== undefined && MIRRORED.has(kept.source)
}

export interface MatrixOwnerKey {
  key: string
  /** The account's secret-storage key id it unlocked when last checked (public). */
  keyId?: string
  source: MatrixOwnerKeySource
  /** `device`: made quietly on this first Mac and not written down yet. */
  custody?: 'device'
  savedAt: number
}

interface StoredOwnerKey extends MatrixOwnerKey, MatrixOwnerBinding {
  v: 1
}

/** The recovery key format (base58 in groups, with spaces), with room to spare. */
const RECOVERY_KEY = /^[A-Za-z0-9 ]{1,256}$/
const KEY_ID = /^[!-~]{1,255}$/
const SOURCES = new Set<MatrixOwnerKeySource>(['created', 'typed', 'approved', 'icloud', 'migrated'])

function validBinding(binding: MatrixOwnerBinding): boolean {
  return (
    typeof binding?.issuer === 'string' &&
    binding.issuer.length > 0 &&
    typeof binding.subject === 'string' &&
    binding.subject.length > 0 &&
    typeof binding.userId === 'string' &&
    binding.userId.startsWith('@')
  )
}

/** One entry per person: a hash, so the file lists nobody in the clear. */
function entryName(binding: MatrixOwnerBinding): string {
  return `owner-key:${createHash('sha256')
    .update(JSON.stringify(['atum-owner-key/v1', binding.issuer, binding.subject, binding.userId]))
    .digest('hex')}`
}

export class MatrixOwnerKeys {
  constructor(
    private readonly store: EncryptedStore,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The key this Mac keeps for exactly this person, if any. An entry that is there but can't be
   * read (a vault that can't be decrypted, or an entry this release doesn't recognise, such as a
   * newer release's after a downgrade) throws `matrix_vault_unavailable` rather than "no key":
   * nothing but the person's typed key is ever written over it (`retain`).
   */
  current(binding: MatrixOwnerBinding): MatrixOwnerKey | undefined {
    if (!validBinding(binding)) {
      return undefined
    }

    const raw = this.store.getItem(entryName(binding))

    if (this.store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    if (!raw) {
      return undefined
    }

    let value: Partial<StoredOwnerKey>

    try {
      value = JSON.parse(raw) as Partial<StoredOwnerKey>
    } catch {
      throw new Error('matrix_vault_unavailable')
    }

    // Read back exactly the person it was kept for: a hash collision or an edited file
    // never hands one person's key to another, and never reads as "nothing kept" either.
    if (
      value?.v !== 1 ||
      value.issuer !== binding.issuer ||
      value.subject !== binding.subject ||
      value.userId !== binding.userId ||
      typeof value.key !== 'string' ||
      !RECOVERY_KEY.test(value.key) ||
      !SOURCES.has(value.source as MatrixOwnerKeySource) ||
      (value.keyId !== undefined && (typeof value.keyId !== 'string' || !KEY_ID.test(value.keyId))) ||
      (value.custody !== undefined && value.custody !== 'device') ||
      typeof value.savedAt !== 'number'
    ) {
      throw new Error('matrix_vault_unavailable')
    }

    return {
      key: value.key,
      ...(value.keyId ? { keyId: value.keyId } : {}),
      source: value.source as MatrixOwnerKeySource,
      ...(value.custody ? { custody: value.custody } : {}),
      savedAt: value.savedAt
    }
  }

  /**
   * Keeps `key` for this person. Only a typed key replaces a kept key (or a recovery the person
   * made in Settings): `matrixOwnerKeyRetention`, checked here for every path that keeps a key,
   * so no caller can skip it. Any other key that differs from the kept one throws
   * `matrix_recovery_kept`; the same key again writes nothing but a newly learned key id.
   * `custody: 'device'` only for a key made quietly here; any other source is one the person has
   * (or had) themselves.
   */
  retain(binding: MatrixOwnerBinding, key: string, options: MatrixOwnerKeyRetain): MatrixOwnerKey {
    if (!validBinding(binding)) {
      throw new Error('matrix_recovery_stale')
    }

    if (typeof key !== 'string' || !RECOVERY_KEY.test(key) || !SOURCES.has(options.source)) {
      throw new Error('matrix_recovery_invalid')
    }

    if (options.keyId !== undefined && (typeof options.keyId !== 'string' || !KEY_ID.test(options.keyId))) {
      throw new Error('matrix_recovery_invalid')
    }

    // The person's own key replaces whatever is kept, so it needs no read: an entry that can't be
    // read never stops it. Any other key reads first, and a vault or entry that can't be read
    // throws here: never written over what it may hold.
    const fromPerson = options.source === 'typed' || options.byPerson === true
    const current = fromPerson ? undefined : this.current(binding)
    const retention = matrixOwnerKeyRetention(current, key, options)

    if (retention === 'refuse') {
      throw new Error('matrix_recovery_kept')
    }

    if (retention === 'same' && current) {
      if (options.keyId && options.keyId !== current.keyId) {
        const noted = { ...current, keyId: options.keyId }
        this.write(binding, noted)

        return noted
      }

      return current
    }

    const kept: MatrixOwnerKey = {
      key,
      ...(options.keyId ? { keyId: options.keyId } : {}),
      source: options.source,
      ...(options.custody === 'device' ? { custody: 'device' as const } : {}),
      savedAt: this.now()
    }

    const stored: StoredOwnerKey = {
      v: 1,
      issuer: binding.issuer,
      subject: binding.subject,
      userId: binding.userId,
      ...kept
    }

    this.store.setItem(entryName(binding), JSON.stringify(stored))

    return kept
  }

  /** The key id the kept key unlocks, learned on a check: nothing else changes. */
  noteKeyId(binding: MatrixOwnerBinding, keyId: string): void {
    // Never write an entry `current` would then refuse to read.
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) {
      return
    }

    const kept = this.current(binding)

    if (kept && kept.keyId !== keyId) {
      this.write(binding, { ...kept, keyId })
    }
  }

  /** The person wrote the key down: it is no longer this Mac's alone. */
  markWritten(binding: MatrixOwnerBinding): void {
    const kept = this.current(binding)

    if (kept?.custody) {
      const { custody: _done, ...rest } = kept
      this.write(binding, rest)
    }
  }

  /** Forget the key on this Mac (the person's choice when signing out). */
  forget(binding: MatrixOwnerBinding): void {
    if (validBinding(binding)) {
      this.store.removeItem(entryName(binding))
    }
  }

  private write(binding: MatrixOwnerBinding, kept: MatrixOwnerKey): void {
    const stored: StoredOwnerKey = {
      v: 1,
      issuer: binding.issuer,
      subject: binding.subject,
      userId: binding.userId,
      ...kept
    }

    this.store.setItem(entryName(binding), JSON.stringify(stored))
  }
}

/**
 * The account record's copy of 0.18.1 and earlier (account.ts `ownerRecoveryKey`): read once to
 * carry it over, and still written for one release so going back to 0.18.1 keeps working.
 */
export interface MatrixOwnerKeyLegacy {
  read(): { key: string; custody?: 'device' } | undefined
  write(key: string, custody?: 'device'): void
  written(): void
  /** Drops the record's copy (Forget the key on this Mac). */
  forget(): void
}

/** The key kept for the person signed in now: this store's, else the account record's (moved
 * here the first time it is read, only while this store keeps none). */
export function keptMatrixOwnerKey(
  keys: MatrixOwnerKeys,
  binding: MatrixOwnerBinding,
  legacy: MatrixOwnerKeyLegacy
): MatrixOwnerKey | undefined {
  const kept = keys.current(binding)

  if (kept) {
    return kept
  }

  let old: ReturnType<MatrixOwnerKeyLegacy['read']>

  try {
    old = legacy.read()
  } catch {
    return undefined
  }

  if (!old || typeof old.key !== 'string' || !RECOVERY_KEY.test(old.key)) {
    return undefined
  }

  return keys.retain(binding, old.key, { source: 'migrated', ...(old.custody ? { custody: old.custody } : {}) })
}

/**
 * Forget the key on this Mac (the person's choice when signing out): this store's copy and the
 * account record's. The record's copy alone would come back as `migrated` the next time anything
 * reads the kept key, even later in the same sign-out. Both are tried; a failure throws after.
 */
export function forgetMatrixOwnerKey(
  keys: MatrixOwnerKeys | undefined,
  binding: MatrixOwnerBinding,
  legacy: MatrixOwnerKeyLegacy
): void {
  let failure: unknown

  try {
    legacy.forget()
  } catch (error) {
    failure = error
  }

  try {
    keys?.forget(binding)
  } catch (error) {
    failure ??= error
  }

  if (failure) {
    throw failure instanceof Error ? failure : new Error('matrix_recovery_forget_failed')
  }
}

/**
 * Keeps a key for the person, and (for one release) in the account record too. The record's old
 * copy is carried over first, so the rule in `MatrixOwnerKeys.retain` (only a typed key replaces
 * a kept key) sees it too; the record then gets whatever that rule left kept.
 */
export function retainMatrixOwnerKey(
  keys: MatrixOwnerKeys,
  binding: MatrixOwnerBinding,
  legacy: MatrixOwnerKeyLegacy,
  key: string,
  options: MatrixOwnerKeyRetain
): MatrixOwnerKey {
  // The person's own key replaces whatever is kept: nothing to carry over first (and an entry
  // that can't be read never stops it).
  if (options.source !== 'typed' && options.byPerson !== true) {
    keptMatrixOwnerKey(keys, binding, legacy)
  }

  const kept = keys.retain(binding, key, options)

  try {
    legacy.write(kept.key, kept.custody)
  } catch {
    // The kept key is what this release reads; the old field only helps a downgrade.
  }

  return kept
}
