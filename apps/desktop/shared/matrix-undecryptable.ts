/**
 * Why a message could not be read, as matrix-js-sdk names it (`DecryptionFailureCode`): the
 * same codes, so the diagnostic line today and the reason-specific chat copy and metrics later
 * read one vocabulary. A closed list main checks every observation against; a code the SDK adds
 * later is logged as `UNKNOWN_ERROR` until it is listed here (undecryptable.test.ts keeps the
 * two in step).
 */
export const MATRIX_DECRYPTION_FAILURE_CODES = [
  'MEGOLM_UNKNOWN_INBOUND_SESSION_ID',
  'MEGOLM_KEY_WITHHELD',
  'MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE',
  'OLM_UNKNOWN_MESSAGE_INDEX',
  'HISTORICAL_MESSAGE_NO_KEY_BACKUP',
  'HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED',
  'HISTORICAL_MESSAGE_WORKING_BACKUP',
  'HISTORICAL_MESSAGE_USER_NOT_JOINED',
  'SENDER_IDENTITY_PREVIOUSLY_VERIFIED',
  'UNSIGNED_SENDER_DEVICE',
  'UNKNOWN_SENDER_DEVICE',
  'UNKNOWN_ERROR'
] as const

export type MatrixDecryptionFailureCode = (typeof MATRIX_DECRYPTION_FAILURE_CODES)[number]

/** One message an SDK host could not decrypt: which room and why. Never its content, sender or
 * event; main hashes the room before anything is written. */
export interface MatrixUndecryptableObservation {
  roomId: string
  code: MatrixDecryptionFailureCode
}

const CODES = new Set<string>(MATRIX_DECRYPTION_FAILURE_CODES)

/** The SDK's reason as one of the listed codes. */
export function matrixDecryptionFailureCode(reason: unknown): MatrixDecryptionFailureCode {
  return typeof reason === 'string' && CODES.has(reason) ? (reason as MatrixDecryptionFailureCode) : 'UNKNOWN_ERROR'
}
