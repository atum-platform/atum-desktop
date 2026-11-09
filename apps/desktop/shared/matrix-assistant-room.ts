import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from './matrix'

/** Standard Matrix room type, not an execution grant or a bot identity registry. */
export const MATRIX_ASSISTANT_ROOM_TYPE = 'io.atum.assistant'

/** The state an official bot's chat is made with (atum.app-bots/1 §4.1; `APP_BOT_DM_MARKER` in
 * src/matrix/app-bot-dm.ts). An existing marker, not a new one. */
const APP_BOT_DM_STATE = 'io.atum.app_bot.dm'

/** What the two rules below read from a matrix-js-sdk room: its synced state, nothing else. */
export interface MatrixRoomStateView {
  hasEncryptionStateEvent(): boolean
  getType(): string | undefined
  currentState: { getStateEvents(type: string, stateKey: string): unknown }
}

/**
 * A room without end-to-end encryption: every room 0.20 creates (owner decisions D1 and D2,
 * 2026-10-09 and 2026-10-10). People chats and groups use this rule. Matrix never takes
 * encryption out of a room, so a room that has it keeps today's rules everywhere, and a
 * plaintext event inside it is still refused (no downgrade).
 */
export function plainRoom(room: Pick<MatrixRoomStateView, 'hasEncryptionStateEvent'>): boolean {
  return !room.hasEncryptionStateEvent()
}

/**
 * An agent's or an official bot's chat without end-to-end encryption, told by the room-type
 * markers that already exist: the assistant room type, or the bot chat's marker. Logic that is
 * specific to agents and bots uses this rule; people chats and groups use `plainRoom`.
 */
export function plainAgentRoom(room: MatrixRoomStateView): boolean {
  return (
    !room.hasEncryptionStateEvent() &&
    (room.getType() === MATRIX_ASSISTANT_ROOM_TYPE || Boolean(room.currentState.getStateEvents(APP_BOT_DM_STATE, '')))
  )
}

/** The platform's default agent wins; the singular user is an older-snapshot fallback. */
export function matrixPrimaryAgent(
  snapshot: Pick<MatrixSnapshot, 'agents' | 'assistant'>
): MatrixAgentView | undefined {
  return (
    snapshot.agents?.find(agent => agent.isDefault) ??
    snapshot.agents?.find(agent => agent.userId === snapshot.assistant?.userId)
  )
}

/**
 * A company's private Chief of Staff room (private-cos/1.1) is made with the assistant room type
 * too, but it is the company's and never one of the person's own assistants: its marker wins over
 * the type. A malformed claim and the platform-bound flag count as well, so quarantine holds. The
 * fields are read here rather than through matrix-company-private-cos-claim.ts, which imports this
 * module's room type (an import cycle).
 */
export function companyPrivateCosMarked(
  room: Partial<Pick<MatrixRoom, 'companyPrivateCos' | 'companyPrivateCosBound' | 'companyPrivateCosClaim'>>
): boolean {
  return Boolean(room.companyPrivateCos || room.companyPrivateCosClaim || room.companyPrivateCosBound)
}

/**
 * The room as Atum shows it: a company private Chief of Staff room never carries the personal
 * assistant flag or a personal agent, whatever an older projection put on it. Other rooms pass
 * through unchanged (the same object).
 */
export function withoutPersonalAgent<Room extends MatrixRoom>(room: Room): Room {
  if (!companyPrivateCosMarked(room) || (!room.assistant && room.agentPrincipal === undefined)) {
    return room
  }

  const { agentPrincipal: _personal, ...company } = room

  return { ...company, assistant: false } as Room
}

/** Display hint only. Names, m.direct, or renderer flags never grant authority. */
export function isAssistantRoom(room: MatrixRoom, ownerId?: string, agentId?: string): boolean {
  const members = room.participants ?? []

  return (
    Boolean(ownerId && agentId) &&
    !companyPrivateCosMarked(room) &&
    room.roomType === MATRIX_ASSISTANT_ROOM_TYPE &&
    (room.encrypted || room.plainAgent === true) &&
    room.membership === 'join' &&
    ownerId !== agentId &&
    members.length === 2 &&
    members.some(m => m.userId === ownerId && m.membership === 'join') &&
    members.some(m => m.userId === agentId && ['join', 'invite'].includes(m.membership))
  )
}

/** Opening one assistant blocks only that assistant's selected conversation. */
export function assistantOpeningBlocksRoom(
  openingAgentId: string | null,
  room: MatrixRoom | undefined,
  ownerId?: string
): boolean {
  return Boolean(openingAgentId && room && isAssistantRoom(room, ownerId, openingAgentId))
}

/**
 * An agent-created assistant-room invitation in the owner's projection. This is display policy
 * only: adoption verifies signed stripped state and then full server state in assistant-room.ts.
 */
export function isAgentCreatedAssistantInvitation(
  room: MatrixRoom,
  ownerId?: string,
  agentId?: string
): boolean {
  const members = room.participants ?? []

  return (
    Boolean(ownerId && agentId) &&
    !companyPrivateCosMarked(room) &&
    room.roomType === MATRIX_ASSISTANT_ROOM_TYPE &&
    (room.encrypted || room.plainAgent === true) &&
    room.membership === 'invite' &&
    ownerId !== agentId &&
    members.length === 2 &&
    members.some(member => member.userId === ownerId && member.membership === 'invite') &&
    members.some(member => member.userId === agentId && member.membership === 'join')
  )
}

/**
 * A joined chat Atum may use as an agent's or an official bot's: encrypted, or plain by the
 * room-type markers (`plainAgentRoom`, projected as `plainAgent`). Display projection only: main
 * still re-reads the room from the server before any turn.
 */
export function usableAgentRoom(
  room: Pick<MatrixRoom, 'membership' | 'encrypted' | 'plainAgent'> | undefined
): boolean {
  return Boolean(room && room.membership === 'join' && (room.encrypted || room.plainAgent === true))
}
