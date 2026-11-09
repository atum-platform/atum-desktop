import { type MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'

/** A backup restored just now may import the requested session after the first decrypt. */
export const MATRIX_INVOCATION_KEY_RETRY_MS = 1_000

const MISSING_SESSION = new Set([
  DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
  DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX
])

/** Decrypt once, then at most once more for a missing session. This grants no sender trust. */
export async function decryptMatrixInvocation(client: MatrixClient, event: MatrixEvent): Promise<MatrixEvent> {
  await client.decryptEventIfNeeded(event)

  const reason = event.decryptionFailureReason

  if (!event.isDecryptionFailure() || event.isRedacted() || !reason || !MISSING_SESSION.has(reason)) {
    return event
  }

  await new Promise(resolve => setTimeout(resolve, MATRIX_INVOCATION_KEY_RETRY_MS))

  const roomId = event.getRoomId()

  if (!roomId || client.getRoom(roomId)?.getMyMembership() !== 'join') {
    throw new Error('matrix_invocation_untrusted')
  }

  if (!event.isDecryptionFailure() || event.isRedacted()) {
    return event
  }

  // decryptEventIfNeeded does not retry an event's cached m.bad.encrypted cleartext.
  // A fresh event over the same opaque wire data uses the public SDK path again.
  const retry = new MatrixEvent(structuredClone(event.event))
  await client.decryptEventIfNeeded(retry)

  return retry
}
