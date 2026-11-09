import { APP_UUID } from '../../shared/app-shortcuts'

import { isAppBotUserId } from './app-bot-dm'

/**
 * A chat this device made for an official bot (`createRoom` answered) that sync may not have brought
 * into its store yet. `createRoom` commits before the room reaches the store, so for a moment (and for
 * as long as sync lags) the room exists on the server and nowhere this device can see: no room, no
 * marker to read, and, when the pointer write failed, no pointer. Remembered here so that a restart in
 * that moment does not make the next open look like a first use and make a second chat.
 *
 * One device-local record in the SDK's existing isolated partition, like the selection
 * (room-navigation.ts `roomSelection`): this account on this device. It is the SDK's own memory of what
 * it made, never an authority: the server decides whether the room is still the person's chat
 * (`unsyncedAppBotDm`), and the record goes once the room is in the store.
 */
export interface CreatedAppBotDm {
  botUserId: string
  roomId: string
}

/** Apps with a chat made here and not yet synced: far more than a person has; a bound for the record. */
const LIMIT = 64

/** How many rooms the account is in that the store lacks are looked at for the bot's marker when none
 * is remembered (`unsyncedAppBotDm`). A room made a moment ago is among the few the store lacks; more
 * means a store that has not caught up with an account of many chats, which the record's own room
 * (looked at first) does not depend on. */
export const APP_BOT_UNSYNCED_PROBES = 20

export function appBotCreatedRooms(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  userId: string,
  deviceId: string
) {
  const key = `io.atum.app-bot-created:${JSON.stringify([userId, deviceId])}`

  const load = (): Map<string, CreatedAppBotDm> => {
    const rooms = new Map<string, CreatedAppBotDm>()

    try {
      const value: unknown = JSON.parse(storage.getItem(key) ?? 'null')

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const [appId, entry] of Object.entries(value)) {
          const direct = entry as Partial<CreatedAppBotDm> | null

          if (
            rooms.size < LIMIT &&
            APP_UUID.test(appId) &&
            isAppBotUserId(direct?.botUserId) &&
            typeof direct.roomId === 'string' &&
            direct.roomId.startsWith('!') &&
            direct.roomId.length <= 1024
          ) {
            rooms.set(appId, { botUserId: direct.botUserId, roomId: direct.roomId })
          }
        }
      }
    } catch {
      /* Optional memory: an unreadable record is no record. */
    }

    return rooms
  }

  const save = (rooms: Map<string, CreatedAppBotDm>) => {
    try {
      if (rooms.size) {
        storage.setItem(key, JSON.stringify(Object.fromEntries(rooms)))
      } else {
        storage.removeItem(key)
      }
    } catch {
      /* Optional memory: opening the bot never waits on it. */
    }
  }

  return {
    /** What a previous run of this SDK made and never saw arrive. */
    read: load,
    write(appId: string, direct: CreatedAppBotDm) {
      const rooms = load()

      rooms.set(appId, direct)
      save(rooms)
    },
    /** Forgets the app's chat; with `roomId`, only while the record still names that room. */
    remove(appId: string, roomId?: string) {
      const rooms = load()

      if (rooms.has(appId) && (roomId === undefined || rooms.get(appId)!.roomId === roomId)) {
        rooms.delete(appId)
        save(rooms)
      }
    }
  }
}
