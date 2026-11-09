import { EventShieldColour, EventShieldReason } from 'matrix-js-sdk/lib/crypto-api'
import type { DeviceVerificationStatus, EventEncryptionInfo } from 'matrix-js-sdk/lib/crypto-api'

/** Policy over maintained SDK evidence, not an alternate crypto implementation. */
export function trustedMatrixSender(
  trust: DeviceVerificationStatus | null | undefined,
  info: EventEncryptionInfo | null
): boolean {
  if (!trust?.isVerified() || !info) {
    return false
  }

  // Explicit out-of-band fingerprint verification is allowed before cross-signing.
  // Never waive forwarded/imported keys, mismatched senders or unknown devices.
  return (
    (info.shieldColour === EventShieldColour.NONE && info.shieldReason === null) ||
    (trust.localVerified === true && info.shieldReason === EventShieldReason.UNSIGNED_DEVICE)
  )
}
