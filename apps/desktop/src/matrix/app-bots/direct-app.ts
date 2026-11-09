import type { AppDescriptor } from '../../../shared/app-catalog'
import { isDirectAppBotRoom } from '../../../shared/bot-api-room'
import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'

/** Presentation only: shared rooms keep their group identity, even with a bot. Encrypted or plain
 * (0.20): only the members decide. */
export function directAppBotForRoom(snapshot: MatrixSnapshot, room: MatrixRoom | undefined): AppDescriptor | undefined {
  const ownUserId = snapshot.identity?.userId

  if (!room || !ownUserId) {
    return undefined
  }

  return snapshot.apps?.apps.find(app => isDirectAppBotRoom(app, { room, ownUserId }))
}

/** The selected official bot, when the current destination is its canonical pairwise room. */
export function directAppBot(snapshot: MatrixSnapshot): AppDescriptor | undefined {
  return directAppBotForRoom(
    snapshot,
    snapshot.rooms.find(value => value.id === snapshot.roomId)
  )
}
