import type { MatrixSdkCommand } from '../../shared/matrix'
import type { MatrixRecoveryKey } from '../../shared/matrix-security'

/**
 * The owner's recovery key on a first Mac (golden path §3 step 0; owner decision
 * 2026-10-04): made quietly the first time the assistant needs it, kept in this Mac's
 * protected storage (the account vault, encrypted by safeStorage with a key the macOS
 * Keychain holds for this app only), so the first hello is never held behind a recovery
 * step. The person writes it down later: Settings › Privacy & Security, or before signing
 * out (sign-out.tsx). A second Mac still asks for it, because the account already has one.
 *
 * Matrix owns the key's cryptography: the human SDK's own `recoveryCreateKey` and
 * `recoverySetUp`, which refuse to replace any recovery, signing identity or key backup the
 * account already has. The key is never logged, printed or sent anywhere but the SDK.
 */
export interface MatrixOwnerRecoveryPort {
  /** The key this Mac already keeps for the account, if any. */
  remembered(): string | undefined
  /** Whether the account has a recovery key on the server (synced account data); unknown
   * until the person's first sync. */
  storage(): 'present' | 'absent' | undefined
  /** The human SDK (main → SDK only). */
  command(value: MatrixSdkCommand): Promise<unknown>
  /** Keeps a quietly made key on this Mac, marked as not yet written down. */
  remember(key: string): void
  /** Throws once the account, device or SDK this work belongs to has changed. */
  assertCurrent(): void
}

/** The longest key the SDK's recovery format produces, with room to spare. */
const KEY_MAX = 256

/**
 * The owner's key for the assistant's trust step: the one this Mac keeps, or (on a first
 * Mac, whose account has no recovery yet) a new one made and kept now. `undefined` means the
 * account's key lives elsewhere: the person enters it on this Mac (recovery_required).
 */
export async function ensureMatrixOwnerRecovery(port: MatrixOwnerRecoveryPort): Promise<string | undefined> {
  port.assertCurrent()
  const remembered = port.remembered()

  if (remembered) {
    return remembered
  }

  const storage = port.storage()

  if (storage === undefined) {
    // Not synced yet: never guess "first Mac" (that would offer to replace a real key).
    throw new Error('matrix_recovery_unknown')
  }

  if (storage === 'present') {
    return undefined
  }

  let made: MatrixRecoveryKey | null

  try {
    made = (await port.command({ kind: 'recoveryCreateKey' })) as MatrixRecoveryKey | null
  } catch (error) {
    // The account already has a signing identity or a key backup this Mac cannot see the key
    // for: never replaced. The person uses their key here instead (recovery_required).
    if (error instanceof Error && error.message === 'matrix_recovery_exists') {
      return undefined
    }

    throw error
  }

  port.assertCurrent()

  if (
    !made ||
    typeof made.id !== 'string' ||
    !made.id ||
    typeof made.key !== 'string' ||
    !made.key ||
    made.key.length > KEY_MAX
  ) {
    throw new Error('matrix_recovery_invalid')
  }

  try {
    // The SDK sets up signing, secret storage and key backup under the new key, then reads
    // it back against the server before handing it over.
    const confirmed = await port.command({ kind: 'ownerRecovery', command: { kind: 'recoverySetUp', id: made.id } })
    port.assertCurrent()

    if (confirmed !== made.key) {
      throw new Error('matrix_recovery_incomplete')
    }
  } catch (error) {
    // A key that was never set up is forgotten in the SDK too.
    await port.command({ kind: 'recoveryDiscard' }).catch(() => {})

    if (error instanceof Error && error.message === 'matrix_recovery_exists') {
      return undefined
    }

    throw error
  }

  port.remember(made.key)

  return made.key
}
