import { MATRIX_PLAIN_SENDER_DEVICE, type MatrixInvocationMessage, matrixOwnerWireType, type MatrixSdkCommand } from '../../../shared/matrix'
import type { OwnerEventOutcome, OwnerEventVerifier } from '../gate/ports'

// The Work gate's `OwnerEventVerifier` (plan §11.3 "The owner's request", K35). The launch names one Matrix event;
// this fetches THAT event itself through the owner's own authenticated Matrix SDK and decides, from what the SDK read
// and never from anything the caller said:
//
//   - the event exists in the owner's one conversation with THIS agent (the room comes from the account's agent record
//     and the SDK's room resolver, not from the caller), is not redacted, and arrived joined;
//   - its sender is the signed-in owner, and it came from a device the owner's own crypto trusts (or, in a room without
//     encryption, the homeserver authenticated the sender: the same rule every owner turn already uses);
//   - it is the owner's own plain text message: not an edit, a thread reply, a forward or Google-protected content.
//
// The age bound is the gate's, and the claim ("one owner message, one launch") is the gate's ledger's, in the same
// transaction as the `admitted` row. This verifier decides nothing about either and writes nothing.
//
// It reuses what the app already ships for exactly this question: `readInvocation` (src/matrix/read-invocation.ts)
// fetches the event by id, decrypts it with the app's crypto and projects sender, device trust and plain/encrypted
// state; `findAssistantRoom` (src/matrix/assistant-room.ts) names the owner's room with an agent. Nothing is sent
// anywhere and no plaintext leaves main.
//
// Anything that is not positive evidence against the event is `unreachable` (the gate answers `unavailable`, the helper
// may retry the same id before its deadline): a homeserver outage, a Matrix client still starting, a roster that has
// not loaded, an account that changed while the read was in flight. A typed refusal is permanent for that request id,
// so it is returned only for a specific, stable reason.

export type OwnerEventInvalid = Extract<OwnerEventOutcome, { kind: 'invalid' }>['reason']

/** What the verifier needs from the app's Matrix client. Every method is main-owned; none takes a caller-supplied room. */
export interface OwnerEventSource {
  /** The signed-in owner's Matrix user id, or undefined while the Matrix client is not ready or nobody is signed in. */
  ownerUserId(): string | undefined
  /**
   * The Matrix user of this agent from the account's own agent record. `null`: the record loaded and this principal is
   * not one of the owner's active agents. Throws: the record could not be read (treated as unreachable).
   */
  agentUserId(principal: string): Promise<string | null>
  /** The owner's room with that agent, or null when none exists. */
  assistantRoom(input: { ownerId: string; agentId: string }): Promise<string | null>
  /** The SDK's own read of one event in one room. Throws the SDK's errors. */
  readEvent(input: { roomId: string; eventId: string }): Promise<MatrixInvocationMessage>
}

const EVENT_ID = /^\$[^\s]{1,254}$/u

interface MatrixErrorLike {
  httpStatus?: unknown
  errcode?: unknown
  message?: unknown
  name?: unknown
}

/**
 * A read that failed. Only stable, specific answers become a refusal; everything else (network, 5xx, 429, "not ready",
 * a store that did not answer) stays unreachable so a moment is never turned into a permanent refusal.
 */
export function classifyOwnerEventReadError(error: unknown): OwnerEventOutcome {
  const value = (error && typeof error === 'object' ? error : {}) as MatrixErrorLike
  const message = typeof value.message === 'string' ? value.message : ''

  if (value.httpStatus === 404 || value.errcode === 'M_NOT_FOUND' || message === 'M_NOT_FOUND') {
    return { kind: 'invalid', reason: 'owner_event_not_found' }
  }

  if (message === 'matrix_invocation_untrusted') {
    // Redacted, undecryptable, a plaintext event in an encrypted room, or membership that changed mid-read: the SDK
    // folds them into one answer, and none of them can be a usable owner message.
    return { kind: 'invalid', reason: 'owner_event_undecryptable' }
  }

  if (message === 'matrix_encrypted_room_required') {
    return { kind: 'invalid', reason: 'owner_event_wrong_room' }
  }

  if (message === 'matrix_invocation_invalid') {
    return { kind: 'invalid', reason: 'owner_event_not_found' }
  }

  return { kind: 'unreachable' }
}

type Judged = { ok: true } | { ok: false; reason: OwnerEventInvalid }

function judge(message: MatrixInvocationMessage, input: { roomId: string; eventId: string; ownerId: string }): Judged {
  const no = (reason: OwnerEventInvalid): Judged => ({ ok: false, reason })

  if (message.roomId !== input.roomId || message.eventId !== input.eventId) {
    return no('owner_event_wrong_room')
  }

  if (message.sender !== input.ownerId) {
    return no('owner_event_not_owner')
  }

  if (!matrixOwnerWireType(message.wireType)) {
    return no('owner_event_undecryptable')
  }

  if (message.wireType === 'm.room.encrypted') {
    // A device the owner's own crypto trusts. `roomPlain` with an encrypted wire type is a disagreement: refuse.
    if (
      message.roomPlain === true ||
      !message.senderVerified ||
      typeof message.senderDevice !== 'string' ||
      !message.senderDevice ||
      message.senderDevice === MATRIX_PLAIN_SENDER_DEVICE
    ) {
      return no('owner_event_device_not_owner')
    }
  } else if (message.roomPlain !== true || !message.senderVerified || message.senderDevice !== MATRIX_PLAIN_SENDER_DEVICE) {
    // Plaintext counts only from a room the reader decided is plain. In an encrypted room it is a downgrade.
    return no('owner_event_device_not_owner')
  }

  if (message.content.msgtype !== 'm.text' || typeof message.content.body !== 'string' || !message.content.body.trim()) {
    return no('owner_event_not_found')
  }

  // The owner's own request, as written: not a thread, an edit or reaction (related without a reply target), nor
  // another person's words or protected content passed along.
  if (message.thread || (message.related && !message.content.replyTo)) {
    return no('owner_event_not_found')
  }

  if (message.content.forwarded || message.content.googleProtected) {
    return no('owner_event_not_owner')
  }

  return { ok: true }
}

export function createOwnerEventVerifier(source: OwnerEventSource): OwnerEventVerifier {
  return {
    async fetch({ agentPrincipal, eventId }): Promise<OwnerEventOutcome> {
      if (!EVENT_ID.test(eventId)) {
        return { kind: 'invalid', reason: 'owner_event_not_found' }
      }

      const ownerId = source.ownerUserId()

      if (!ownerId) {
        return { kind: 'unreachable' }
      }

      let message: MatrixInvocationMessage
      let roomId: string

      try {
        const agentId = await source.agentUserId(agentPrincipal)

        if (agentId === null) {
          return { kind: 'invalid', reason: 'owner_event_wrong_room' }
        }

        const room = await source.assistantRoom({ ownerId, agentId })

        if (!room) {
          return { kind: 'invalid', reason: 'owner_event_wrong_room' }
        }

        roomId = room
        message = await source.readEvent({ roomId, eventId })
      } catch (error) {
        return classifyOwnerEventReadError(error)
      }

      // The account that asked must still be the one signed in when the answer is used.
      if (source.ownerUserId() !== ownerId) {
        return { kind: 'unreachable' }
      }

      const verdict = judge(message, { roomId, eventId, ownerId })

      if ('reason' in verdict) {
        return { kind: 'invalid', reason: verdict.reason }
      }

      if (!Number.isFinite(message.timestamp)) {
        return { kind: 'unreachable' }
      }

      return { kind: 'ok', body: message.content.body, originServerTs: message.timestamp }
    }
  }
}

/** The owner's SDK host: the existing `human` host of the Matrix composition (`host.queue.command`). */
export interface OwnerSdkHost {
  userId: string
  command(command: MatrixSdkCommand): Promise<unknown>
}

/**
 * Bind the verifier's port to the Matrix composition's owner SDK host. `agentMatrixUser` is the account's agent
 * roster (`account.agents()`: the active agent with that `principal`, its `matrixUser`), read fresh on each call.
 */
export function createSdkOwnerEventSource(input: {
  owner(): OwnerSdkHost | undefined
  agentMatrixUser(principal: string): Promise<string | null>
}): OwnerEventSource {
  const owner = () => {
    const host = input.owner()

    if (!host) {
      throw new Error('matrix_not_ready')
    }

    return host
  }

  return {
    ownerUserId: () => input.owner()?.userId,
    agentUserId: principal => input.agentMatrixUser(principal),
    async assistantRoom({ ownerId, agentId }) {
      const room = await owner().command({ kind: 'findAssistantRoom', ownerId, agentId })

      return typeof room === 'string' && room ? room : null
    },
    async readEvent({ roomId, eventId }) {
      return (await owner().command({ kind: 'readInvocation', roomId, eventId })) as MatrixInvocationMessage
    }
  }
}
