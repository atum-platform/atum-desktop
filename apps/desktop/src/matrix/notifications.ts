import { EventType, type MatrixClient, type MatrixEvent, MatrixEventEvent, RoomEvent } from 'matrix-js-sdk'
import type { IRoomTimelineData } from 'matrix-js-sdk/lib/models/event-timeline-set'

import type { MatrixNotificationHint } from '../../shared/matrix'
import { isCanonicalMatrixRoomId } from '../../shared/matrix-app-bot-dm'
import {
  MATRIX_COMPANY_CHANNEL_TYPE,
  MATRIX_COMPANY_CONVERSATION_TYPE
} from '../../shared/matrix-company-channel-room'
import {
  isCompanyPrivateCosClaim,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT
} from '../../shared/matrix-company-private-cos-claim'
import {
  type MatrixNotificationPolicyContent,
  matrixResolvedNotificationLevel
} from '../../shared/matrix-notification-policy'

import { matrixEventAttentionKind, matrixEventThreadRoot } from './attention'

const PRIVATE_COS_NOTIFICATION_ROOM_LIMIT = 1_000

/** Strictly bounded trusted-host projection; an invalid update leaves the SDK's prior set intact. */
export function matrixCompanyPrivateCosNotificationRoomIds(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value) || value.length > PRIVATE_COS_NOTIFICATION_ROOM_LIMIT ||
    value.some(roomId => !isCanonicalMatrixRoomId(roomId))) {
    return undefined
  }

  return new Set(value)
}

/** Only event admission lives here. Ordinary rooms keep SDK push-rule evaluation; Team space
 * uses the portable private-account policy without changing server unread counts. Late decryption
 * may finish a live candidate, never turn recovered history into alerts. */
export function watchMatrixNotifications(
  client: MatrixClient,
  ready: () => boolean,
  offer: (hint: MatrixNotificationHint) => void,
  policy?: () => MatrixNotificationPolicyContent | undefined,
  privateCosBoundRoom?: (roomId: string) => boolean
) {
  const candidates = new WeakSet<MatrixEvent>()
  const delivered = new Set<string>()
  let stopped = false

  function incoming(event: MatrixEvent) {
    const sender = event.getSender()

    return (
      !stopped &&
      ready() &&
      event.status === null &&
      !event.isRedacted() &&
      Boolean(sender && sender !== client.getUserId() && !client.isUserIgnored(sender)) &&
      client.getRoom(event.getRoomId())?.getMyMembership() === 'join'
    )
  }

  function deliver(event: MatrixEvent) {
    if (
      !candidates.has(event) ||
      !incoming(event) ||
      event.isDecryptionFailure() ||
      event.getType() !== EventType.RoomMessage
    ) {
      return
    }

    // Edits are not new messages. Replies and genuine threads still may notify,
    // according to the user's SDK push rules.
    if (event.getContent()['m.relates_to']?.rel_type === 'm.replace') {
      candidates.delete(event)

      return
    }

    const roomId = event.getRoomId(),
      eventId = event.getId()

    if (!roomId || !eventId || eventId.startsWith('~') || delivered.has(eventId)) {
      return
    }

    const room = client.getRoom(roomId)
    const privateCosEvents = room?.currentState.getStateEvents(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT)
    const privateCosClaim = Array.isArray(privateCosEvents)
      ? privateCosEvents.length > 0
      : Boolean(privateCosEvents)

    // Private CoS messages stay inside their authenticated company DM. Treat every marker
    // state key as a claim; only the empty key is trusted elsewhere for classification.
    if (privateCosBoundRoom?.(roomId) ||
      isCompanyPrivateCosClaim(privateCosClaim ? { companyPrivateCosClaim: true } : undefined)) {
      candidates.delete(event)

      return
    }

    const currentPolicy = policy?.()
    const teamSpace = Boolean(
      room && [MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '')
    )
    const actions = client.getPushActionsForEvent(event, true)
    let sound = Boolean(actions?.tweaks.sound)

    if (teamSpace && room && currentPolicy) {
      const level = matrixResolvedNotificationLevel(currentPolicy, roomId, matrixEventThreadRoot(event))
      const attention = matrixEventAttentionKind(event, room, client.getSafeUserId())

      if (level === 'nothing' || level === 'mentions' && attention === undefined) {
        candidates.delete(event)

        return
      }

      // `all` and participated-thread replies may intentionally exceed the homeserver's
      // default mention rule. The portable sound switch is still applied at the host boundary.
      sound = actions?.notify ? Boolean(actions.tweaks.sound) : true
    } else if (!actions?.notify) {
      candidates.delete(event)

      return
    }

    candidates.delete(event)
    delivered.add(eventId)

    if (delivered.size > 256) {
      delivered.delete(delivered.values().next().value!)
    }

    try {
      offer({ roomId, eventId, sound })
    } catch {
      // A retired/unsupported native host must not break SDK timeline handling.
    }
  }

  const timeline = (
    event: MatrixEvent,
    _room: unknown,
    toStart: boolean | undefined,
    removed: boolean,
    data: IRoomTimelineData
  ) => {
    if (toStart || removed || !data?.liveEvent || !incoming(event)) {
      return
    }

    candidates.add(event)
    deliver(event)
  }

  client.on(RoomEvent.Timeline, timeline)
  client.on(MatrixEventEvent.Decrypted, deliver)

  return {
    stop() {
      stopped = true
      delivered.clear()
      client.off(RoomEvent.Timeline, timeline)
      client.off(MatrixEventEvent.Decrypted, deliver)
    }
  }
}
