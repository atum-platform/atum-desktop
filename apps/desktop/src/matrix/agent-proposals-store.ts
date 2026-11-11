import { useStore } from '@nanostores/react'
import { map } from 'nanostores'
import { useEffect } from 'react'

import type { MatrixAgentProposalCard, MatrixAgentProposalsBridge } from '../../shared/matrix-agent-proposals'

/** Each room's validated cards, as main last projected them. Empty until a proposal arrives. */
export const $agentProposals = map<Record<string, MatrixAgentProposalCard[]>>({})

interface Watch {
  count: number
  stop(): void
}

const watches = new WeakMap<MatrixAgentProposalsBridge, Map<string, Watch>>()

/** Replace one card with main's answer for it (a confirm or decline result). */
export function takeAgentProposal(card: MatrixAgentProposalCard): void {
  const cards = $agentProposals.get()[card.roomId] ?? []
  $agentProposals.setKey(card.roomId, cards.map(item => (item.id === card.id ? card : item)))
}

function watchRoom(bridge: MatrixAgentProposalsBridge, roomId: string): Watch {
  let live = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0

  const load = () => {
    const token = ++generation

    void bridge.read(roomId).then(
      cards => {
        if (!live || token !== generation) {
          return
        }

        $agentProposals.setKey(roomId, cards)
        clearTimeout(timer)
        // Main expires a pending card on read; ask again when the soonest one runs out.
        const soonest = Math.min(...cards.filter(card => card.state === 'pending').map(card => card.expiresAt))

        if (Number.isFinite(soonest)) {
          timer = setTimeout(load, Math.max(0, soonest - Date.now()) + 50)
        }
      },
      () => undefined
    )
  }

  const unsubscribe = bridge.subscribe(changed => changed === roomId && load())
  load()

  return {
    count: 0,
    stop: () => {
      live = false
      clearTimeout(timer)
      unsubscribe()
    }
  }
}

/** The cards placed under one message. One read and one subscription per open room. */
export function useAgentProposals(
  bridge: MatrixAgentProposalsBridge | undefined,
  roomId: string,
  eventId: string
): MatrixAgentProposalCard[] {
  const rooms = useStore($agentProposals, { keys: [roomId] })

  useEffect(() => {
    if (!bridge) {
      return
    }

    const byRoom = watches.get(bridge) ?? new Map<string, Watch>()
    watches.set(bridge, byRoom)
    const watch = byRoom.get(roomId) ?? watchRoom(bridge, roomId)
    byRoom.set(roomId, watch)
    watch.count += 1

    return () => {
      watch.count -= 1

      if (watch.count === 0) {
        watch.stop()
        byRoom.delete(roomId)
      }
    }
  }, [bridge, roomId])

  return bridge ? (rooms[roomId] ?? []).filter(card => card.eventId === eventId) : []
}
