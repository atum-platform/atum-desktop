import { Direction, type MatrixClient } from 'matrix-js-sdk'

import type { MatrixRecoveredResult, MatrixResultBinding } from '../../shared/matrix'
import { MATRIX_FIND_TURN } from '../../shared/matrix-turn'

import { confirmedPlainRoom } from './plain-room'
import { readMatrixInvocation } from './read-invocation'

/** Read-only, bounded positive evidence. Never send, change the outbox, or run
 * Hermes. Matrix owns pagination, decryption and verified-device evidence.
 *
 * In a room without end-to-end encryption (0.20) the agent's answer arrives plain and names no
 * device (read-invocation.ts): it is matched on its sender and its invocation and transaction
 * IDs. A room with encryption keeps the device match, and a plaintext answer there is not one. */
export async function readMatrixResult(
  client: MatrixClient,
  binding: MatrixResultBinding
): Promise<MatrixRecoveredResult> {
  const deadline = Date.now() + MATRIX_FIND_TURN.deadlineMs
  let timer: ReturnType<typeof setTimeout> | undefined

  const expired = new Promise<MatrixRecoveredResult>(resolve => {
    timer = setTimeout(() => resolve({ state: 'unknown' }), MATRIX_FIND_TURN.deadlineMs)
  })

  try {
    return await Promise.race([recover(client, binding, deadline), expired])
  } catch {
    // Missing keys, redaction, trust changes or offline: uncertainty is not retry.
    return { state: 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}

async function recover(
  client: MatrixClient,
  binding: MatrixResultBinding,
  deadline: number
): Promise<MatrixRecoveredResult> {
  const found = new Map<string, { body: string; verified: boolean }>()

  // A room this device does not hold counts as encrypted: the rule as before 0.20. Plain only
  // when the crypto store agrees too (`confirmedPlainRoom`), so a room whose encryption state has
  // not synced is still scanned for its ciphertext answers.
  const room = client.getRoom(binding.roomId)
  const wireType = room && (await confirmedPlainRoom(client, room)) ? 'm.room.message' : 'm.room.encrypted'

  const inspect = async (eventId: string) => {
    if (Date.now() >= deadline) {
      throw new Error('matrix_recovery_deadline')
    }

    const event = await readMatrixInvocation(client, { roomId: binding.roomId, eventId })
    const result = event.content.result

    if (
      (event.senderVerified || binding.publishedEvent === eventId) &&
      event.sender === binding.agentUserId &&
      (event.wireType === 'm.room.message' || event.senderDevice === binding.agentDevice) &&
      event.content.msgtype === 'm.text' &&
      result?.rootEventId === binding.eventId &&
      result.invocationId === binding.invocationId &&
      result.transactionId === binding.transactionId
    ) {
      found.set(eventId, { body: event.content.body, verified: event.senderVerified })
    }
  }

  if (binding.publishedEvent) {
    await inspect(binding.publishedEvent)
  } else {
    let from: string | null = null
    const tokens = new Set<string>()

    let reachedRoot = false

    for (let page = 0; page < MATRIX_FIND_TURN.pages && !reachedRoot; page++) {
      if (Date.now() >= deadline) {
        return { state: 'unknown' }
      }

      // m.in_reply_to is deliberately not a thread relation and homeservers
      // need not index it as one. Read a small, fresh server tail instead of
      // inferring a reply from a relation endpoint or SDK cache.
      const batch = await client.createMessagesRequest(
        binding.roomId,
        from,
        MATRIX_FIND_TURN.pageSize,
        Direction.Backward
      )

      if (!Array.isArray(batch.chunk) || batch.chunk.length > MATRIX_FIND_TURN.pageSize) {
        return { state: 'unknown' }
      }

      for (const raw of batch.chunk) {
        // The server timeline is heterogeneous: state, membership and other
        // people's ciphertext are not candidate publications. Never feed those
        // to the strict room-message reader.
        if (raw?.event_id === binding.eventId) {
          reachedRoot = true

          break
        }

        if (
          raw?.type !== wireType ||
          raw.sender !== binding.agentUserId ||
          typeof raw.event_id !== 'string' ||
          !raw.event_id.startsWith('$')
        ) {
          continue
        }

        await inspect(raw.event_id)
      }

      if (found.size > 1) {
        return { state: 'unknown' }
      }

      if (!batch.end) {
        break
      }

      if (tokens.has(batch.end)) {
        return { state: 'unknown' }
      }

      // This is positive-evidence recovery: a single exact, verified match in
      // the bounded fresh tail remains usable even when an active room has more
      // history than the budget. Any duplicate that is actually observed still
      // makes the result unknown above.
      if (page === MATRIX_FIND_TURN.pages - 1) {
        break
      }

      tokens.add(batch.end)
      from = batch.end
    }
  }

  // Membership may have changed while decrypting/paginating.
  if (found.size !== 1 || client.getRoom(binding.roomId)?.getMyMembership() !== 'join') {
    return { state: 'unknown' }
  }

  const [eventId, result] = [...found][0]

  return { state: result.verified ? 'published' : 'unverified', eventId, body: result.body }
}
