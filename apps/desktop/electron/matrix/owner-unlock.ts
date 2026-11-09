import type { MatrixOwnerRestore, MatrixOwnerStatus, MatrixRecoveryCheck } from '../../shared/matrix-security'

import type { MatrixOwnerKey, MatrixOwnerKeySource } from './owner-keys'

/**
 * This Mac unlocks the person's encrypted messages and assistants by itself
 * ( WS-A): after the person's first sync, when a key
 * arrives (typed, approved from another device, from iCloud Keychain) and before any agent's
 * trust step.
 *
 * - `unknown`: the account's recovery is not known before the first sync; never guessed.
 * - `no_recovery`: the account has none yet (a first Mac): owner-recovery.ts makes one, quietly,
 *   when an assistant first needs it.
 * - `needs_key`: nothing on this Mac unlocks it (`none`: no key kept and none in iCloud Keychain
 *   yet; `stale`: the key kept here, or iCloud Keychain's copy when nothing is kept, no longer
 *   opens the account's recovery, which happens only if it was changed elsewhere). The person
 *   approves this Mac from another device (`none` only), or uses their key (`complete`: this
 *   device is already signed and reads its history, as after an approval from Element X; only
 *   the assistants still need the key).
 * - `unlocked`: this device is signed by the person's identity and has the key backup; `restored`
 *   when this call did that work (the history then restores in the background).
 *
 * The SDK does all cryptography (security.ts `ownerStatus`, `recoveryCheck`, `ownerRestore`);
 * this only decides which key to use and when. The key never leaves main except to the SDK.
 */
export type MatrixOwnerUnlock =
  | { state: 'unknown' }
  | { state: 'no_recovery' }
  | { state: 'needs_key'; complete: boolean; reason: 'none' | 'stale' }
  | {
      state: 'unlocked'
      key: string
      source: MatrixOwnerKeySource
      restored: boolean
      signed: boolean
      backup: boolean
    }

/**
 * Whether this Mac may ask the person's other devices for the key (device-approval.ts), and look
 * for it in iCloud Keychain again: only when it never had one. A key that no longer opens the
 * account's recovery (`stale`: kept here, or iCloud Keychain's copy) means the recovery was
 * changed from another device or sign-in, and Atum never changes it by itself: an approval could
 * then only let this Mac into whatever identity the server serves now, so the person types their
 * key instead (only a typed key replaces a kept key: owner-keys.ts `matrixOwnerKeyRetention`).
 */
export function matrixMayAskOtherDevices(result: MatrixOwnerUnlock | undefined): boolean {
  return result?.state === 'needs_key' && result.reason === 'none'
}

export interface MatrixOwnerUnlockPort {
  status(): Promise<MatrixOwnerStatus>
  /** The key kept for this person on this Mac (owner-keys.ts), if any. */
  kept(): MatrixOwnerKey | undefined
  /** iCloud Keychain's copy (icloud-keychain.ts), when that is available on this Mac. Read only
   * while this Mac keeps no key. */
  icloud?(): Promise<string | undefined>
  check(key: string): Promise<MatrixRecoveryCheck>
  restore(key: string): Promise<MatrixOwnerRestore>
  /** Keeps iCloud Keychain's key on a Mac that keeps none, or the key id learned for the kept
   * one; never another key over a kept one (owner-keys.ts refuses that too). */
  retain(key: string, options: { source: MatrixOwnerKeySource; keyId?: string }): void
  /** Throws once the account, device or SDK this belongs to has changed. */
  assertCurrent(): void
  log(line: string): void
  now?(): number
}

function validStatus(value: unknown): value is MatrixOwnerStatus {
  const status = value as MatrixOwnerStatus | null

  return Boolean(
    status &&
    typeof status === 'object' &&
    typeof status.signing === 'boolean' &&
    typeof status.deviceSigned === 'boolean' &&
    typeof status.backup === 'boolean' &&
    (status.storage === undefined || status.storage === 'present' || status.storage === 'absent') &&
    (status.keyId === undefined || typeof status.keyId === 'string')
  )
}

function validCheck(value: unknown): value is MatrixRecoveryCheck {
  const check = value as MatrixRecoveryCheck | null

  return Boolean(
    check && typeof check.valid === 'boolean' && (check.keyId === undefined || typeof check.keyId === 'string')
  )
}

function validRestore(value: unknown): value is MatrixOwnerRestore {
  const restored = value as MatrixOwnerRestore | null

  return Boolean(
    restored &&
    typeof restored.keyId === 'string' &&
    typeof restored.signed === 'boolean' &&
    typeof restored.backup === 'boolean'
  )
}

export async function unlockMatrixOwner(port: MatrixOwnerUnlockPort): Promise<MatrixOwnerUnlock> {
  const now = port.now ?? Date.now
  const started = now()
  port.assertCurrent()
  const status = await port.status()
  port.assertCurrent()

  if (!validStatus(status)) {
    throw new Error('matrix_recovery_invalid')
  }

  if (status.storage === undefined) {
    return { state: 'unknown' }
  }

  if (status.storage === 'absent') {
    return { state: 'no_recovery' }
  }

  const complete = status.signing && status.deviceSigned && status.backup
  let key: string | undefined
  let source: MatrixOwnerKeySource | undefined
  let reason: 'none' | 'stale' = 'none'
  const kept = port.kept()

  if (kept) {
    // A key already checked against this recovery needs no second look on a device that is
    // already unlocked: every later launch costs nothing.
    if (complete && kept.keyId && kept.keyId === status.keyId) {
      return { state: 'unlocked', key: kept.key, source: kept.source, restored: false, signed: true, backup: true }
    }

    const check = await port.check(kept.key)
    port.assertCurrent()

    if (!validCheck(check)) {
      throw new Error('matrix_recovery_invalid')
    }

    if (check.valid) {
      key = kept.key
      source = kept.source

      if (check.keyId && check.keyId !== kept.keyId) {
        port.retain(kept.key, { source: kept.source, keyId: check.keyId })
      }
    } else {
      // Changed elsewhere since it was kept: ignored, never deleted (the person decides).
      reason = 'stale'
      port.log('[Matrix] owner unlock: the key kept on this Mac no longer opens the account’s recovery')
    }
  }

  // Only a typed key replaces a kept key: iCloud Keychain is read only when this Mac keeps none.
  // A kept key gone stale stays `stale` whatever iCloud holds (another of the person's Macs may
  // have mirrored a key that opens a recovery someone else made).
  if (!kept && port.icloud) {
    let fromCloud: string | undefined

    try {
      fromCloud = await port.icloud()
    } catch {
      fromCloud = undefined
    }

    port.assertCurrent()

    if (fromCloud) {
      const check = await port.check(fromCloud)
      port.assertCurrent()

      if (!validCheck(check)) {
        throw new Error('matrix_recovery_invalid')
      }

      if (check.valid) {
        key = fromCloud
        source = 'icloud'
        port.retain(fromCloud, { source: 'icloud', ...(check.keyId ? { keyId: check.keyId } : {}) })
      } else {
        // The person's own copy no longer opens the account's recovery: changed elsewhere, exactly
        // like a kept key gone stale. No other device is asked; the person types their key.
        reason = 'stale'
        port.log('[Matrix] owner unlock: iCloud Keychain’s key no longer opens the account’s recovery')
      }
    }
  }

  if (!key || !source) {
    return { state: 'needs_key', complete, reason }
  }

  if (complete) {
    return { state: 'unlocked', key, source, restored: false, signed: true, backup: true }
  }

  const restored = await port.restore(key)
  port.assertCurrent()

  if (!validRestore(restored)) {
    throw new Error('matrix_recovery_invalid')
  }

  port.log(
    `[Matrix] owner unlock source=${source} ok=${restored.signed && restored.backup} signed=${restored.signed} backup=${restored.backup} ms=${now() - started}`
  )

  // A valid recovery key and a reachable backup do not prove device continuity. In
  // particular, a lost crypto store under an existing device ID cannot be signed.
  // Never cache that result as unlocked or use it to begin agent verification.
  if (!restored.signed) {
    throw new Error('matrix_owner_device_unsigned')
  }
  return { state: 'unlocked', key, source, restored: true, signed: restored.signed, backup: restored.backup }
}
