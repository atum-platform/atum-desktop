import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'

/** The chat a companion shows in: a joined chat with an agent, for a signed-in account on a
 * Mac whose window has the pet bridge. Undefined when that chat would show no companion. */
export function matrixPetRoom(
  snapshot: MatrixSnapshot,
  roomId: string | null | undefined
): (MatrixRoom & { agentPrincipal: string }) | undefined {
  const room = snapshot.rooms.find(value => value.id === roomId)

  if (
    !window.atumMatrix?.pets ||
    !snapshot.identity ||
    !snapshot.petScope ||
    !room?.agentPrincipal ||
    room.membership !== 'join'
  ) {
    return undefined
  }

  return { ...room, agentPrincipal: room.agentPrincipal }
}
