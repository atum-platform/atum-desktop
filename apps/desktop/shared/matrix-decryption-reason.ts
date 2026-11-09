import { type MatrixDecryptionFailureCode, matrixDecryptionFailureCode } from './matrix-undecryptable'

/** Closed display reasons. Cryptographic trust remains with the SDK. */
export const MATRIX_DECRYPTION_REASONS = [
  'sender_unverified',
  'this_device_unverified',
  'withheld',
  'waiting_for_key',
  'restore_possible',
  'restoring',
  'no_backup',
  'before_joined',
  'sender_identity_changed',
  'generic'
] as const

export type MatrixDecryptionReason = (typeof MATRIX_DECRYPTION_REASONS)[number]
export type MatrixDecryptionAction = 'devices' | 'verify' | 'review' | 'restore' | 'none'

const REASONS: Record<MatrixDecryptionFailureCode, MatrixDecryptionReason> = {
  UNSIGNED_SENDER_DEVICE: 'sender_unverified',
  MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE: 'this_device_unverified',
  MEGOLM_KEY_WITHHELD: 'withheld',
  MEGOLM_UNKNOWN_INBOUND_SESSION_ID: 'waiting_for_key',
  OLM_UNKNOWN_MESSAGE_INDEX: 'waiting_for_key',
  HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED: 'restore_possible',
  HISTORICAL_MESSAGE_WORKING_BACKUP: 'restoring',
  HISTORICAL_MESSAGE_NO_KEY_BACKUP: 'no_backup',
  HISTORICAL_MESSAGE_USER_NOT_JOINED: 'before_joined',
  SENDER_IDENTITY_PREVIOUSLY_VERIFIED: 'sender_identity_changed',
  UNKNOWN_SENDER_DEVICE: 'generic',
  UNKNOWN_ERROR: 'generic'
}

export function matrixDecryptionReason(code: unknown): MatrixDecryptionReason {
  return REASONS[matrixDecryptionFailureCode(code)]
}

/** Accept only projected closed values, including when an older bridge has no field. */
export function matrixMessageDecryptionReason(message: { decryptionFailed: boolean }): MatrixDecryptionReason {
  const reason = (message as { decryptionReason?: unknown }).decryptionReason

  return typeof reason === 'string' && MATRIX_DECRYPTION_REASONS.includes(reason as MatrixDecryptionReason)
    ? (reason as MatrixDecryptionReason)
    : 'generic'
}

export function matrixDecryptionAction(
  reason: MatrixDecryptionReason,
  backupAvailable: boolean
): MatrixDecryptionAction {
  switch (reason) {
    case 'sender_unverified':
      return 'devices'

    case 'this_device_unverified':
      return 'verify'

    case 'sender_identity_changed':
      return 'review'

    case 'restore_possible':
      return 'restore'

    case 'generic':
      return backupAvailable ? 'restore' : 'none'

    default:
      return 'none'
  }
}

/** An explicit SDK projection, never inferred from secret storage or a kept recovery key. */
export function matrixMessageBackupAvailable(security: unknown): boolean {
  return (
    !!security && typeof security === 'object' && (security as { backupAvailable?: unknown }).backupAvailable === true
  )
}
