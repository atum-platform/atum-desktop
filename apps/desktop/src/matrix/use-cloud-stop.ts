import { useEffect, useRef, useState } from 'react'

import type { MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import { cloudRoomAgent } from './cloud-status'
import { matrixCloudStopTarget } from './cloud-stop'
import { matrixUnansweredOwnerMessage } from './no-reply-banner'

export interface MatrixCloudStop {
  /** The question the running cloud turn answers: Stop names it. Absent while nothing runs. */
  target?: string
  /** Stop was pressed for this target; it stays so until the snapshot clears or moves it. */
  requested: boolean
  stopping: boolean
  /** The controller refused or could not be reached: the chat says so once. */
  refused: boolean
  stop(): void
}

/**
 * The one Stop for a cloud agent's running turn (`cloudAgent({ action: 'stopTurn' })`), as the
 * composer's stop button and the side panel's Now both use it. It only names the question the
 * turn answers; the controller decides. The renderer supplies no authority.
 */
export function useMatrixCloudStop({
  messages,
  room,
  snapshot,
  working
}: {
  messages: readonly MatrixMessage[]
  /** Absent while no chat is open: then nothing runs and Stop is never offered. */
  room: MatrixRoom | undefined
  snapshot: MatrixSnapshot
  /** The agent is typing or a turn of this room is still being answered. */
  working: boolean
}): MatrixCloudStop {
  const [refused, setRefused] = useState(false)
  const [stopping, setStopping] = useState(false)
  const cloudAssistant = Boolean(room && cloudRoomAgent(snapshot, room))

  useEffect(() => {
    setRefused(false)
    setStopping(false)
  }, [room?.id])

  const unanswered = cloudAssistant
    ? matrixUnansweredOwnerMessage(
        messages,
        new Set(
          [snapshot.assistant?.userId, ...(snapshot.agents ?? []).map(agent => agent.userId)].filter(
            (userId): userId is string => Boolean(userId)
          )
        )
      )
    : null

  const available = Boolean(room && cloudAssistant && room.membership === 'join' && window.atumMatrix.cloudAgent)

  const live =
    available && room
      ? matrixCloudStopTarget({ messages, turns: snapshot.localTurns, roomId: room.id, unanswered, working })
      : undefined

  // The typing signal a question from another device shows through expires in moments, long
  // before a cloud turn does. Once Stop has named that question, keep naming it until the
  // question clears or the room changes, so the button does not vanish mid-turn.
  const latch = useRef<{ roomId: string; unansweredId: string | null; eventId: string } | null>(null)

  if (live) {
    latch.current = { roomId: room!.id, unansweredId: unanswered?.id ?? null, eventId: live }
  } else if (
    latch.current &&
    (!available || latch.current.roomId !== room?.id || latch.current.unansweredId !== (unanswered?.id ?? null))
  ) {
    latch.current = null
  }

  const target = live ?? latch.current?.eventId
  // A stop that was already asked for stays disabled until its target clears or moves on: the
  // snapshot clears it, not the request resolving.
  const requestedFor = useRef<string | null>(null)

  const stop = () => {
    const stopTurn = window.atumMatrix.cloudAgent

    if (!room || !target || !stopTurn || requestedFor.current === target) {
      return
    }

    requestedFor.current = target
    setRefused(false)
    setStopping(true)
    void stopTurn({ action: 'stopTurn', roomId: room.id, eventId: target })
      .catch(() => {
        requestedFor.current = null
        setRefused(true)
      })
      .finally(() => setStopping(false))
  }

  return {
    ...(target ? { target } : {}),
    requested: Boolean(target) && requestedFor.current === target,
    stopping,
    refused,
    stop
  }
}
