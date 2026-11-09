import { ipcErrorMessage } from '@/lib/ipc-error'

/**
 * What the person is told when this Mac could not be enrolled for cloud agents. Main logs the
 * closed code (`[Device] this Mac was not enrolled: <code>`); the renderer says what to do.
 */
export type CloudEnrollFailure =
  | 'signed_out'
  | 'not_ready'
  | 'key_unreadable'
  | 'cancelled'
  | 'no_prompt'
  | 'unavailable'
  | 'offline'
  | 'refused'
  | 'keys'
  | 'generic'

/** The closed code inside a refusal from main (as it crosses IPC, or in a move outcome). */
export function cloudFailureCode(error: unknown): string {
  return ipcErrorMessage(error).trim()
}

const ENROLL: readonly [RegExp, CloudEnrollFailure][] = [
  [/^matrix_signed_out$/, 'signed_out'],
  [/^(?:device_owner_not_ready|matrix_not_ready|matrix_sdk_unavailable)$/, 'not_ready'],
  [/^device_owner_fingerprint_unavailable$/, 'key_unreadable'],
  [/^(?:device_enrollment_approval_(?:denied|timeout)|device_enrollment_timeout)$/, 'cancelled'],
  [/^device_enrollment_approval_unavailable$/, 'no_prompt'],
  [/^device_unavailable$/, 'unavailable'],
  [/^(?:device_enrollment_unavailable|device_registry_(?:0|5\d\d)(?:_|$))/, 'offline'],
  [/^device_enrollment_refused\b/, 'refused'],
  [/^device_enrollment_keys_unavailable$/, 'keys']
]

export function cloudEnrollFailure(error: unknown): CloudEnrollFailure {
  const code = cloudFailureCode(error)

  return ENROLL.find(([pattern]) => pattern.test(code))?.[1] ?? 'generic'
}

/** The cloud refused for want of cloud access (`403 entitlement_required`): the trial may help. */
export function needsCloudEntitlement(codeOrError: unknown): boolean {
  return /\bdevice_registry_403_entitlement_required\b/.test(
    typeof codeOrError === 'string' ? codeOrError : cloudFailureCode(codeOrError)
  )
}
