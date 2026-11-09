import type { MatrixCommand, MatrixRoom } from '../../shared/matrix'
import { isCompanyConversationRoom, MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import { isCompanyPrivateCosRoom } from '../../shared/matrix-company-private-cos'

import {
  assertCompanyConversationCommandAllowed,
  assertCompanyRoomCommandAllowed,
  claimsCompanyChannel,
  type CompanyChannelDirectoryRead
} from './company-room-guard'

export interface RoomCommandGuardPorts {
  /** The rooms main holds (its own, unprojected snapshot). */
  rooms(): readonly MatrixRoom[]
  /** The platform's channel directory for a company (the authority on which rooms are channels). */
  directory: CompanyChannelDirectoryRead
  /** Whether the platform's conversation directory lists this room as the conversation it claims. */
  confirmsConversation(room: MatrixRoom): boolean
}

/**
 * The single check every Matrix command that names a room passes before it reaches the SDK, whoever
 * asks: the window's own commands, and main's own (an app bot's invitation is a membership command
 * like any other). It refuses
 *
 * - leave, forget, invite, removal and bans on a directory-confirmed company channel;
 * - the same on a joined company conversation, which has no Personal-style membership at all;
 * - any command on a room that claims to be a company conversation the platform does not list, except
 *   declining its invitation.
 */
export function createRoomCommandGuard(ports: RoomCommandGuardPorts) {
  return async (kind: MatrixCommand['kind'], roomId: string | undefined): Promise<void> => {
    const room = roomId === undefined ? undefined : ports.rooms().find(value => value.id === roomId)
    const channel = room?.roomType === MATRIX_COMPANY_CHANNEL_TYPE ? room : undefined

    // A company channel's membership is the company's, not the person's. A successful negative read leaves a
    // spoof manageable; an unavailable read never hands a joined claim to Personal management.
    await assertCompanyRoomCommandAllowed(kind, claimsCompanyChannel(channel) ? channel : undefined, ports.directory)
    assertCompanyConversationCommandAllowed(kind, room)

    if (room?.membership === 'join' && isCompanyPrivateCosRoom(room) &&
      ['invite', 'removeMember', 'ban', 'unban'].includes(kind)) {
      throw new Error('matrix_company_private_cos_managed')
    }

    if (room && isCompanyConversationRoom(room) && !ports.confirmsConversation(room) && !(kind === 'leave' && room.membership === 'invite')) {
      throw new Error('matrix_company_conversation_unconfirmed')
    }
  }
}

export interface PresentationDispatchPorts {
  /** The strict command parser (`parseMatrixCommand`). */
  parse(value: unknown): MatrixCommand
  guard: ReturnType<typeof createRoomCommandGuard>
  run(command: MatrixCommand): Promise<unknown>
}

/**
 * Presentation signals (what is on screen, who is typing) are not operations: they run while another operation
 * is in flight, so they do not wait for the idle check the other commands do. They are still commands that name a
 * room, so every non-null room id passes the room guard first: a room that claims to be a company conversation the
 * platform does not list is neither marked read nor typed into.
 */
export function createPresentationDispatch(ports: PresentationDispatchPorts) {
  return async (value: unknown): Promise<unknown> => {
    const command = ports.parse(value)
    const roomId = 'roomId' in command && typeof command.roomId === 'string' ? command.roomId : undefined

    await ports.guard(command.kind, roomId)

    return ports.run(command)
  }
}
