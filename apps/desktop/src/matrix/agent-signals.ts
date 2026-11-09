import {
  EventType,
  type MatrixClient,
  type MatrixEvent,
  ReceiptType,
  RelationType,
  type Room,
  RoomEvent
} from 'matrix-js-sdk'

import type { MatrixSdkCommand } from '../../shared/matrix'
import { MATRIX_AGENT_SIGNALS } from '../../shared/matrix-agent-signals'
import { type MatrixReceiptEvent, matrixReceiptTarget } from '../../shared/matrix-presentation-signals'

/**
 * The agent's presentation signals (agent-turns v1.1 "Presentation signals"): a public
 * `m.read` in its own chat and `m.typing` in any joined room containing its owner, the
 * standard Matrix signals every app shows unmodified. Presentation only: what a turn is
 * doing is never read from them.
 */

/** A typing notice ends on its own after this long unless main renews it (never longer). */
export const MATRIX_AGENT_TYPING_TIMEOUT_MS = MATRIX_AGENT_SIGNALS.typingTimeoutMs
/** At most this many messages this Mac took up and is still answering, per room. */
export const MATRIX_AGENT_ADMITTED_MAX = MATRIX_AGENT_SIGNALS.admittedMax
/**
 * How long the agent's own client waits for the message to reach its timeline. Main asks the
 * moment the owner's device has posted it (the local path), while the agent's own sync brings
 * it a moment later; asked before then, the receipt used to be dropped without a word. Within
 * main's 15 second limit for the request.
 */
export const MATRIX_AGENT_SEEN_ARRIVAL_MS = 10_000

type SeenCommand = Extract<MatrixSdkCommand, { kind: 'agentSeen' }>
type TypingCommand = Extract<MatrixSdkCommand, { kind: 'agentTyping' }>

const eventId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('$') && value.length <= 255

const userId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('@') && value.length <= 255

/**
 * A message from the owner that asks for something: a new message (or one this device can't
 * read, which might be one), never an edit, a reaction or a deleted message.
 */
function ownerMessage(event: MatrixEvent, ownerId: string): boolean {
  if (event.getSender() !== ownerId || !eventId(event.getId()) || event.isState() || event.isRedacted()) {
    return false
  }

  const wire = event.getWireType()

  if (wire !== EventType.RoomMessage && wire !== EventType.RoomMessageEncrypted) {
    return false
  }

  // Decrypted into something other than a message (an encrypted reaction, say). Still
  // encrypted, or unreadable here, it may be a message: it counts.
  if (wire === EventType.RoomMessageEncrypted && event.getClearContent() && event.getType() !== EventType.RoomMessage) {
    return false
  }

  return !event.isRelation(RelationType.Replace) && !event.isRelation(RelationType.Annotation)
}

/** The messages the agent has already answered or posted a status line about: its own rich
 * replies (an answer or an `m.notice`), and older answers' thread relation. */
function answeredBy(events: readonly MatrixEvent[], agentId: string): Set<string> {
  const answered = new Set<string>()

  for (const event of events) {
    if (event.getSender() !== agentId) {
      continue
    }

    const relation = (event.getContent()['m.relates_to'] ?? event.getWireContent()['m.relates_to']) as
      | { 'm.in_reply_to'?: { event_id?: unknown }; rel_type?: unknown; event_id?: unknown }
      | undefined

    const reply = relation?.['m.in_reply_to']?.event_id ?? event.replyEventId

    if (eventId(reply)) {
      answered.add(reply)
    }

    if (relation?.rel_type === RelationType.Thread && eventId(relation.event_id)) {
      answered.add(relation.event_id)
    }
  }

  return answered
}

/**
 * Where the agent's read receipt may go for `eventId`, or nothing to send.
 *
 * Matrix receipts are cumulative: `m.read` on an event says every earlier one was read too. So
 * the receipt goes no further than the last event before the first owner message (after the
 * agent's current receipt and after the agent's latest own message) that has neither an answer
 * or status line from the agent, nor a place in `admitted` (taken up on this Mac, still being
 * answered): a message the agent declined without a word never looks seen. A message the agent
 * has spoken after counts as behind it, wherever that later message is: before `eventId`, or
 * after it, like the answer to `eventId` itself (agent-turns v1.1 P2: once the agent posts any
 * later message, every owner event before it no longer holds the receipt). The receipt still
 * never goes past `eventId`. Only events of the live timeline count; an event not in it is
 * never acknowledged, and a receipt already at or past it is left alone.
 */
export function matrixAgentSeenTarget(
  room: Room,
  input: { agentId: string; ownerId: string; eventId: string; admitted: ReadonlySet<string> }
): MatrixEvent | undefined {
  const events = room.getLiveTimeline().getEvents()
  const end = events.findIndex(event => event.getId() === input.eventId)

  if (end < 0) {
    return undefined
  }

  const current = room.getReadReceiptForUserId(input.agentId, true, ReceiptType.Read)?.eventId
  const from = current ? events.findIndex(event => event.getId() === current) : -1

  if (from >= end) {
    return undefined
  }

  const answered = answeredBy(events, input.agentId)
  const window = events.slice(from + 1, end + 1)

  const projection: MatrixReceiptEvent[] = window.map((event, index) => {
    const id = event.getId()

    const disposition =
      event.getSender() === input.agentId && index < window.length - 1
        ? 'agent_message'
        : ownerMessage(event, input.ownerId)
          ? id === input.eventId || input.admitted.has(id!)
            ? 'admitted'
            : answered.has(id!)
              ? 'answered'
              : 'unchecked'
          : 'not_a_turn'

    return {
      eventId: id ?? '',
      disposition,
      // Preserve the released private-room cumulative receipt target, including an agent
      // reply immediately before a silent refusal. This adapter still rejects all groups.
      receiptEligible: eventId(id) && event.status === null
    }
  })

  // The agent's first message after it that the server has (its answer, or a status line):
  // it releases every hold before it, and is never a target itself.
  const later = events.slice(end + 1).find(event => event.getSender() === input.agentId && eventId(event.getId()))

  const spokeAfter: MatrixReceiptEvent[] = later
    ? [{ eventId: later.getId()!, disposition: 'agent_message', receiptEligible: false }]
    : []

  const target = matrixReceiptTarget([...projection, ...spokeAfter])

  return target === null ? undefined : window.find(event => event.getId() === target)
}

/**
 * Where the agent's read receipt goes in a group: the owner's message it was addressed in (or
 * admitted), nothing earlier named and nothing else. Main sends it only after the group
 * admission checks. Matrix receipts are cumulative, so the server reads it as covering earlier
 * events too, but the agent only ever names a message addressed to or admitted by it, and
 * never one past it (agent-turns/1.3 amendment A1). A receipt already at or past it is left alone.
 */
export function matrixAgentGroupSeenTarget(
  room: Room,
  input: { agentId: string; ownerId: string; eventId: string }
): MatrixEvent | undefined {
  const events = room.getLiveTimeline().getEvents()
  const end = events.findIndex(event => event.getId() === input.eventId)

  if (end < 0 || !ownerMessage(events[end]!, input.ownerId) || events[end]!.status !== null) {
    return undefined
  }

  const current = room.getReadReceiptForUserId(input.agentId, true, ReceiptType.Read)?.eventId
  const from = current ? events.findIndex(event => event.getId() === current) : -1

  return from >= end ? undefined : events[end]
}

function inLiveTimeline(room: Room, id: string): boolean {
  return room
    .getLiveTimeline()
    .getEvents()
    .some(event => event.getId() === id)
}

/** True once the event is in the room's live timeline (now or as sync brings it), false when
 * it has not arrived within `timeoutMs`. */
function arrival(room: Room, id: string, timeoutMs: number): Promise<boolean> {
  if (inLiveTimeline(room, id)) {
    return Promise.resolve(true)
  }

  return new Promise(resolve => {
    const done = (arrived: boolean) => {
      clearTimeout(timer)
      room.off(RoomEvent.Timeline, timeline)
      resolve(arrived)
    }

    const timeline = () => {
      if (inLiveTimeline(room, id)) {
        done(true)
      }
    }

    const timer = setTimeout(() => done(false), timeoutMs)
    room.on(RoomEvent.Timeline, timeline)
  })
}

/** A joined room containing the owner. Enough for a presentation-only typing notice. */
function ownerRoom(client: MatrixClient, roomId: unknown, ownerId: string): Room {
  const room = typeof roomId === 'string' ? client.getRoom(roomId) : null

  if (!room || room.getMyMembership() !== 'join' || room.getMember(ownerId)?.membership !== 'join') {
    throw new Error('matrix_assistant_room_required')
  }

  return room
}

/** The agent's private chat with its owner: nobody else. */
function ownerChat(client: MatrixClient, roomId: unknown, ownerId: string): Room {
  const room = ownerRoom(client, roomId, ownerId)

  if (room.getInvitedAndJoinedMemberCount() > 2) {
    throw new Error('matrix_assistant_room_required')
  }

  return room
}

/** The agent acknowledges an owner message it took up or answered (see matrixAgentSeenTarget):
 * a public, unthreaded `m.read`. Answers the event acknowledged, or null when held (or when the
 * message never reached this client's timeline in time). */
export async function sendMatrixAgentSeen(
  client: MatrixClient,
  command: SeenCommand,
  active: () => boolean = () => true
): Promise<string | null> {
  const agentId = client.getSafeUserId()

  if (
    !eventId(command.eventId) ||
    !userId(command.ownerId) ||
    command.ownerId === agentId ||
    !Array.isArray(command.admitted) ||
    command.admitted.length > MATRIX_AGENT_ADMITTED_MAX ||
    !command.admitted.every(eventId)
  ) {
    throw new Error('matrix_command_invalid')
  }

  // The owner's device has just posted it; this client's own sync brings it a moment later. A
  // room of more than the two of them is a group: its receipt names only the addressed message.
  const arriving = ownerRoom(client, command.roomId, command.ownerId)

  if (!(await arrival(arriving, command.eventId, MATRIX_AGENT_SEEN_ARRIVAL_MS))) {
    return null
  }

  if (!active()) {
    throw new Error('matrix_sdk_stopped')
  }

  // Read again after the wait, and by what the room is now: a chat that has become a group
  // moves to the group rule, never the other way round for one message.
  const room = ownerRoom(client, command.roomId, command.ownerId)

  const target =
    room.getInvitedAndJoinedMemberCount() > 2
      ? matrixAgentGroupSeenTarget(room, { agentId, ownerId: command.ownerId, eventId: command.eventId })
      : matrixAgentSeenTarget(room, {
          agentId,
          ownerId: command.ownerId,
          eventId: command.eventId,
          admitted: new Set(command.admitted)
        })

  if (!target) {
    return null
  }

  // Unthreaded: the one receipt slot every app reads for the main timeline.
  await client.sendReceipt(target, ReceiptType.Read, {}, true)

  return target.getId()!
}

/** The agent's typing notice in a joined owner room (main renews it while it works, and stops it). */
export async function sendMatrixAgentTyping(client: MatrixClient, command: TypingCommand): Promise<null> {
  if (!userId(command.ownerId) || command.ownerId === client.getSafeUserId() || typeof command.typing !== 'boolean') {
    throw new Error('matrix_command_invalid')
  }

  const room = ownerRoom(client, command.roomId, command.ownerId)
  await client.sendTyping(room.roomId, command.typing, MATRIX_AGENT_TYPING_TIMEOUT_MS)

  return null
}
