import { EventType, type Room } from 'matrix-js-sdk'

import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from '../../shared/matrix-company-channel-room'
import { MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT } from '../../shared/matrix-company-private-cos-claim'

import { appBotDmMarker } from './app-bot-dm'
import { isMatrixPrivateChat } from './assistant-room'

export function matrixThreadRoomKind(room: Room): 'team' | 'group' | 'direct' | undefined {
  const type = room.getType()

  if (type === MATRIX_COMPANY_CHANNEL_TYPE || type === MATRIX_COMPANY_CONVERSATION_TYPE) {
    return 'team'
  }

  // Use the same ordinary-room and private-chat distinction as the group assistant admission.
  // Typed rooms and rooms reserved for a company assistant or an app keep their own surfaces.
  const owner = room.client.getUserId()

  if (type || !owner || !room.currentState.getStateEvents(EventType.RoomCreate, '') ||
      room.currentState.getStateEvents(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT).length ||
      appBotDmMarker(room, owner) || room.getAccountData('io.atum.app_bot.legacy_moved')) {
    return undefined
  }

  return isMatrixPrivateChat(room.client, room) ? 'direct' : 'group'
}

export function matrixThreadRoom(room: Room): boolean {
  const kind = matrixThreadRoomKind(room)

  return kind === 'team' || kind === 'group'
}
