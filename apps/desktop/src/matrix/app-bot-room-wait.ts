/**
 * The window draws only the rooms the SDK's store holds, and a room the account has just made (or
 * that another of its Macs made) reaches the store with the next sync, not with the answer that
 * named it. An official bot's chat is therefore selected only once its room is here: `sdk.ts`
 * waits for it at most this long. Past it the open fails with `matrix_app_bot_syncing` and the
 * person retries. Nothing is lost by failing: the room, its marker and the account's pointer are
 * already written, so a retry opens the same room instead of making another.
 *
 * It rides on top of the ordinary command bound (sdk-host-queue.ts `matrixSdkCommandTimeout`), so a
 * slow network in the steps before the wait cannot spend the wait.
 */
export const APP_BOT_ROOM_WAIT_MS = 15_000

/** What the wait needs from the SDK's store: a look, and a way to hear when a room enters it. */
export interface RoomArrivals {
  /** The room is in the store now. */
  has(roomId: string): boolean
  /** Calls back with the id of every room that enters the store; returns how to stop listening. */
  watch(listener: (roomId: string) => void): () => void
}

export interface RoomWait {
  /** True when the room is in the store; false at the deadline or once cancelled. */
  arrived: Promise<boolean>
  /** Ends the wait now (the SDK is stopping): `arrived` settles false and nothing stays listening. */
  cancel(): void
}

/**
 * Waits for one room to enter the store. It listens for the store's own event rather than looking
 * again and again, and holds one timer, so nothing runs while the room is on its way. The room
 * may already be here, or arrive between the look and the listener: it listens first, then looks.
 */
export function waitForRoom(arrivals: RoomArrivals, roomId: string, timeoutMs = APP_BOT_ROOM_WAIT_MS): RoomWait {
  let settle: (arrived: boolean) => void = () => {}

  const arrived = new Promise<boolean>(resolve => {
    let stop = () => {}
    const timer = setTimeout(() => settle(false), timeoutMs)

    settle = value => {
      clearTimeout(timer)
      stop()
      resolve(value)
    }

    stop = arrivals.watch(id => {
      if (id === roomId) {
        settle(true)
      }
    })

    if (arrivals.has(roomId)) {
      settle(true)
    }
  })

  return { arrived, cancel: () => settle(false) }
}
