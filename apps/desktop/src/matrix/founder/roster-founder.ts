import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'

type FounderFacts = Pick<MatrixSnapshot, 'founder' | 'identity' | 'rooms'>

/** The signed-in account is the founder (founder mode): no Founder row, intro or Contact us. */
export function isFounderAccount(snapshot: Pick<MatrixSnapshot, 'founder' | 'identity'>): boolean {
  return Boolean(snapshot.founder && snapshot.identity && snapshot.identity.userId === snapshot.founder.userId)
}

/**
 * This account's Founder chat, as the roster pins it: the room main named for the platform's
 * founder (`founder.roomId`, only ever from this account's own record), joined (plain since 0.20,
 * encrypted before), and with the founder joined or invited. Never on the founder's own account, and never a room that
 * merely looks like it: a name, a handle or an avatar proves nothing.
 */
export function founderRoom(snapshot: FounderFacts): MatrixRoom | undefined {
  const founder = snapshot.founder

  if (!founder?.roomId || !snapshot.identity || isFounderAccount(snapshot)) {
    return undefined
  }

  const room = snapshot.rooms.find(value => value.id === founder.roomId)

  if (!room || room.membership !== 'join') {
    return undefined
  }

  const theirs = room.participants?.find(member => member.userId === founder.userId)?.membership

  return theirs === 'join' || theirs === 'invite' ? room : undefined
}

export function isFounderRoom(snapshot: FounderFacts, roomId: string | null | undefined): boolean {
  return Boolean(roomId) && founderRoom(snapshot)?.id === roomId
}
