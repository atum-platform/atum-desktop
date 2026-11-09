import { type MatrixClient, MatrixEvent } from 'matrix-js-sdk'

import { matrixDecryptionReason } from '../../shared/matrix-decryption-reason'

export const MATRIX_TIMELINE_KEY_RETRY_MS = 2_000

/** One public-SDK retry for a visible missing key. This changes display only.
 * The SDK continues its normal session-download/event handling after the bound. */
export function matrixTimelineKeyRetry(client: MatrixClient, changed: () => void) {
  let active = true
  const attempts = new WeakMap<MatrixEvent, { replacement?: MatrixEvent }>()
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const joined = (event: MatrixEvent) => {
    const roomId = event.getRoomId()

    return !!roomId && client.getRoom(roomId)?.getMyMembership() === 'join'
  }

  return {
    project(event: MatrixEvent): MatrixEvent {
      if (
        !active ||
        !event.isDecryptionFailure() ||
        event.isRedacted() ||
        !joined(event) ||
        matrixDecryptionReason(event.decryptionFailureReason) !== 'waiting_for_key'
      ) {
        return event
      }

      const previous = attempts.get(event)

      if (previous) {
        return previous.replacement ?? event
      }

      const attempt: { replacement?: MatrixEvent } = {}
      attempts.set(event, attempt)

      const timer = setTimeout(() => {
        timers.delete(timer)

        if (
          !active ||
          !joined(event) ||
          matrixDecryptionReason(event.decryptionFailureReason) !== 'waiting_for_key' ||
          !event.isDecryptionFailure() ||
          event.isRedacted()
        ) {
          return
        }

        // Cached bad cleartext is not retried by decryptEventIfNeeded. Keep the
        // SDK timeline event intact and project a successful fresh decrypt only.
        const retry = new MatrixEvent(structuredClone(event.event))
        void client
          .decryptEventIfNeeded(retry)
          .then(() => {
            if (
              !active ||
              !joined(event) ||
              matrixDecryptionReason(event.decryptionFailureReason) !== 'waiting_for_key' ||
              event.isRedacted() ||
              retry.isDecryptionFailure()
            ) {
              return
            }

            attempt.replacement = retry
            changed()
          })
          .catch(() => {})
      }, MATRIX_TIMELINE_KEY_RETRY_MS)

      timers.add(timer)

      return event
    },
    stop() {
      active = false

      for (const timer of timers) {
        clearTimeout(timer)
      }

      timers.clear()
    }
  }
}
