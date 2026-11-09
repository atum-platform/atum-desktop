import { EventType, type MatrixClient, MsgType } from 'matrix-js-sdk'

import type { GroupSettledTarget } from '../../shared/room-participation/runtime'

import { confirmedPlainRoom } from './plain-room'
import { matrixReplyRoot } from './reply-relation'
import { trustedMatrixSender } from './sender-trust'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export async function readGroupSettled(client: MatrixClient, target: GroupSettledTarget, active: () => boolean) {
  const room = client.getRoom(target.roomId)
  const crypto = client.getCrypto()
  const plain = room ? await confirmedPlainRoom(client, room) : false
  const wireType = plain ? EventType.RoomMessage : EventType.RoomMessageEncrypted

  const live = () =>
    active() &&
    client.getUserId() === target.ownerId &&
    client.getRoom(target.roomId) === room &&
    room?.getMyMembership() === 'join' &&
    // A plain read fails if encryption state appears; an encrypted read stays strict either way.
    (!plain || !room.hasEncryptionStateEvent())

  if (!live() || (!crypto && !plain) || room?.getType()) {
    throw new Error('matrix_group_changed')
  }
  const joined = target.agentIds.filter(id => room!.getMember(id)?.membership === 'join')
  const devices = crypto && !plain ? await crypto.getUserDeviceInfo(joined, false) : new Map()
  const settled = new Set<string>()

  for (const event of room!.getLiveTimeline().getEvents()) {
    const sender = event.getSender()

    if (
      !sender ||
      !joined.includes(sender) ||
      settled.has(sender) ||
      event.status !== null ||
      event.getWireType() !== wireType ||
      event.getType() !== EventType.RoomMessage ||
      event.isRedacted() ||
      event.isDecryptionFailure()
    )
      {continue}

    const content = event.getContent()

    if (
      (content.msgtype !== MsgType.Text && content.msgtype !== MsgType.Notice) ||
      typeof content.body !== 'string' ||
      !content.body.trim() ||
      content['m.relates_to']?.rel_type ||
      matrixReplyRoot(content) !== target.eventId
    )
      {continue}

    if (plain) {
      settled.add(sender)

      continue
    }

    const device = [...(devices.get(sender)?.values() ?? [])].find(
      item => item.getIdentityKey() === event.getSenderKey() && item.getFingerprint() === event.getClaimedEd25519Key()
    )

    const trust = device ? await crypto!.getDeviceVerificationStatus(sender, device.deviceId) : null

    if (trustedMatrixSender(trust, await crypto!.getEncryptionInfoForEvent(event))) {
      settled.add(sender)
    }
  }

  if (!live()) {throw new Error('matrix_group_changed')}

  return [...settled]
}
