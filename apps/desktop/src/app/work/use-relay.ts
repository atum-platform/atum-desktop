import { useStore } from '@nanostores/react'
import { useEffect, useEffectEvent } from 'react'

import { $workRelayReads, $workRelayRooms, $workRelayStop } from './store'

export const WORK_RELAY_READ_TIMEOUT_MS = 8_000

/** Read only the visible conversation, without overlapping polls or retaining a previous account. */
export function useWorkRelayRoom(principal: string | undefined, roomId: string, accountKey: string | undefined, fail: (cause?: unknown) => void, manageStop = true) {
  const rooms = useStore($workRelayRooms)
  const onFailure = useEffectEvent(fail)
  useEffect(() => {
    const bridge = window.atumMatrix.work

    if (!principal || !accountKey || !bridge?.readRelay) {return}
    let live = true
    $workRelayReads.set({ ...$workRelayReads.get(), [roomId]: 'loading' })

    if (manageStop) {$workRelayStop.set(bridge.stopRelay ? (room, event) => { void bridge.stopRelay!(room, event).catch(onFailure) } : null)}
    let timer: ReturnType<typeof setTimeout>

    const read = async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        const value = await Promise.race([
          bridge.readRelay!(principal, roomId),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('work_relay_read_timeout')), WORK_RELAY_READ_TIMEOUT_MS) })
        ])

        if (live) {
          $workRelayReads.set({ ...$workRelayReads.get(), [roomId]: value?.account ? 'ready' : 'unavailable' })
          if (value?.account) {$workRelayRooms.set({ ...$workRelayRooms.get(), [roomId]: value })}
        }
      } catch {
        if (live) {$workRelayReads.set({ ...$workRelayReads.get(), [roomId]: 'failed' })}
      } finally { clearTimeout(deadline) }

      if (live) {timer = setTimeout(() => void read(), 3000)}
    }

    void read()

    return () => { live = false; clearTimeout(timer);

 if (manageStop) {$workRelayStop.set(null)} }
  }, [principal, roomId, accountKey, manageStop])

  return rooms[roomId]
}
