import type { MatrixRoom } from './matrix'

/**
 * A person's own assistants in group chats (owner decision 2026-10-05: owner-only, public-facing
 * agent features later). The rules every side shares:
 *
 * - Only the owner adds their assistant, and only the owner's own new message — an @mention
 *   of it, or a reply to its message — starts its turn. Nobody else's message ever does, so
 *   no other member spends the owner's Protons or reaches the owner's tools, and no assistant's
 *   message can start another's (no agent loops).
 * - A group turn runs in its own Hermes session for that (assistant, room), never the
 *   assistant's private one .
 * - At most five of a person's assistants in one group.
 */
export const MATRIX_GROUP_AGENT_LIMIT = 5

/** The watch id an agent host's group hints carry (src/matrix/group-turns.ts → main). */
export const MATRIX_GROUP_WATCH_ID = 'group'

/**
 * A group's mode, decided again at every turn from who is in it then:
 *
 * - `meeting`: everyone in it (joined or invited) is the owner or one of the owner's own
 *   assistants. The assistant works as it does in its private chat with the owner.
 * - `shared`: anyone else is in it — another person, someone else's assistant, an app. The
 *   assistant sees only the message it was asked and at most one message the owner quoted,
 *   with no memory, skills, Google, scheduled jobs or messaging tools.
 *
 * Shared is the safe answer whenever anything is unclear.
 */
export type MatrixGroupMode = 'meeting' | 'shared'

/** Membership that counts as being in a room: in it, or on the way in. */
const present = (membership: string) => membership === 'join' || membership === 'invite'

/**
 * Display hint only: an ordinary room this account is in, the kind a person's assistants can
 * join, with end-to-end encryption or without (every group since 0.20 is without). Never an
 * assistant's private room, an app group or a company project (each has its own room type).
 * Main re-reads the server's state before anything is added or runs (`readGroupRoom`).
 */
export function isMatrixGroupRoom(room: Pick<MatrixRoom, 'membership' | 'roomType'>): boolean {
  return room.membership === 'join' && !room.roomType
}

/** The owner's own assistants in a room (joined or invited), in the order given. */
export function matrixGroupAgents(
  participants: ReadonlyArray<{ userId: string; membership: string }> | undefined,
  ownAgentIds: readonly string[]
): string[] {
  const inRoom = new Set((participants ?? []).filter(member => present(member.membership)).map(each => each.userId))

  return [...new Set(ownAgentIds)].filter(id => inRoom.has(id))
}

/** See MatrixGroupMode. An owner who isn't in the room has no meeting there. */
export function matrixGroupMode(
  members: ReadonlyArray<{ userId: string; membership: string }>,
  ownerId: string,
  ownAgentIds: readonly string[]
): MatrixGroupMode {
  const own = new Set([ownerId, ...ownAgentIds])
  const inRoom = members.filter(member => present(member.membership))

  return inRoom.some(member => member.userId === ownerId) && inRoom.every(member => own.has(member.userId))
    ? 'meeting'
    : 'shared'
}

/**
 * Who besides the owner and the owner's own assistants is in a group now (joined or invited),
 * sorted: empty in a private meeting. A shared group's session is kept per audience
 * (invocation.ts matrixConversationKey), so what the assistant said there to one set of people
 * is never resumed in front of someone who joined later (who, in an encrypted group with
 * `history_visibility: joined`, could not read it).
 */
export function matrixGroupAudience(
  members: ReadonlyArray<{ userId: string; membership: string }>,
  ownerId: string,
  ownAgentIds: readonly string[]
): string[] {
  const own = new Set([ownerId, ...ownAgentIds])

  return [
    ...new Set(members.filter(member => present(member.membership) && !own.has(member.userId)).map(m => m.userId))
  ].sort()
}
