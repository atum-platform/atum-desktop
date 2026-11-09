import { type MatrixClient, type MatrixEvent, MatrixEventEvent } from 'matrix-js-sdk'

import { matrixDecryptionFailureCode, type MatrixUndecryptableObservation } from '../../shared/matrix-undecryptable'

/**
 * Every message this SDK tried and failed to decrypt, offered to the host as its room and the
 * SDK's reason only (shared/matrix-undecryptable.ts): the owner's own client timeline and each
 * agent's rooms alike. Main rate-limits and hashes before it writes a line
 * (electron/matrix/undecryptable-log.ts). Returns the unsubscribe.
 */
export function observeMatrixUndecryptable(
  client: Pick<MatrixClient, 'on' | 'off'>,
  offer: (value: MatrixUndecryptableObservation) => void
): () => void {
  const decrypted = (event: MatrixEvent) => {
    const roomId = event.getRoomId()

    if (!event.isDecryptionFailure() || !roomId) {
      return
    }

    try {
      offer({ roomId, code: matrixDecryptionFailureCode(event.decryptionFailureReason) })
    } catch {
      // A diagnostic never disturbs the SDK's own event handling.
    }
  }

  client.on(MatrixEventEvent.Decrypted, decrypted)

  return () => client.off(MatrixEventEvent.Decrypted, decrypted)
}
