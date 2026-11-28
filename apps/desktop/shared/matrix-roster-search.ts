import type { MatrixRoom } from './matrix'
import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from './matrix-company-channel-room'
import { isCompanyPrivateCosClaim } from './matrix-company-private-cos-claim'
import type { MatrixCompanyMessageSearchValue } from './matrix-company-search'

export type MatrixRosterSearchScope = 'plain' | 'device'

export interface MatrixRosterMessageHit {
  roomId: string
  eventId: string
  sender: string
  senderName?: string
  snippet: string
  at: number
  threadRootId?: string
}

export interface MatrixRosterMessagePage {
  coverage: MatrixCompanyMessageSearchValue['coverage'] & { loadedMessages?: number }
  results: MatrixRosterMessageHit[]
  nextBatch?: string
}

export type MatrixRosterSearchCommand =
  | { kind: 'rosterMessageSearch'; scope: MatrixRosterSearchScope; roomIds: string[]; query: string }
  | { kind: 'selectSearchEvent'; scope: MatrixRosterSearchScope; roomId: string; eventId: string; threadRootId?: string }

/** Apply to the main-authorized roster, before passing any room IDs to the SDK. */
export function matrixRosterSearchRooms(rooms: readonly MatrixRoom[]): MatrixRoom[] {
  return rooms.filter(room =>
    room.membership === 'join' && !room.appBot?.hidden && room.roomType !== 'm.space' &&
    !isCompanyPrivateCosClaim(room) &&
    (room.roomType !== MATRIX_COMPANY_CHANNEL_TYPE || Boolean(room.companyChannel)) &&
    (room.roomType !== MATRIX_COMPANY_CONVERSATION_TYPE || Boolean(room.companyConversation))
  )
}
