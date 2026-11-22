import { useStore } from '@nanostores/react'
import { useEffect, useEffectEvent } from 'react'

import { $workRelayRooms, $workRelayStop } from './store'

/** Read only the visible conversation, without overlapping polls or retaining a previous account. */
export function useWorkRelayRoom(principal: string | undefined, roomId: string, accountKey: string | undefined, fail: (cause?: unknown) => void) {
  const rooms = useStore($workRelayRooms)
  const onFailure = useEffectEvent(fail)
  useEffect(() => {
    const bridge = window.atumMatrix.work

    if (!principal || !accountKey || !bridge?.readRelay) {return}
    let live = true
    $workRelayStop.set(bridge.stopRelay ? (room, event) => { void bridge.stopRelay!(room, event).catch(onFailure) } : null)
    let timer: ReturnType<typeof setTimeout>

    const read = async () => {
      try {
        const value = await bridge.readRelay!(principal, roomId)

        if (live) {$workRelayRooms.set({ ...$workRelayRooms.get(), [roomId]: value })}
      } catch { /* Keep the last observed state during reconnect. */ }

      if (live) {timer = setTimeout(() => void read(), 3000)}
    }

    void read()

    return () => { live = false; clearTimeout(timer); $workRelayStop.set(null) }
  }, [principal, roomId, accountKey])

  return rooms[roomId]
}
