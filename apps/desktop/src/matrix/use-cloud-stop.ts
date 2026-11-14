import { useEffect, useRef, useState } from 'react'

import type { MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import { cloudRoomAgent } from './cloud-status'
import {
  executeMatrixStop,
  matrixCloudStopScheduled,
  matrixCloudStopTarget,
  matrixShowCloudStop,
  type MatrixStopRoute,
  matrixStopRoute
} from './cloud-stop'
import { matrixUnansweredOwnerMessage } from './no-reply-banner'
import { runMatrixCommand } from './text-document-actions'

/** How long an unconfirmed Stop keeps saying "Stopping…" before it settles without a word. */
export const MATRIX_STOP_SETTLE_MS = 15_000

export interface MatrixCloudStop {
  /** The question the running cloud turn answers: Stop names it. Absent while nothing runs. */
  target?: string
  /** Stop is offered: a named turn, or a Hermes agent still working (host Stop or native /stop). */
  shown: boolean
  /** Which path Stop takes: the Shell host route, the old cloud route, native `/stop`, or none yet. */
  route: MatrixStopRoute
  /** Stop can be pressed now (a path exists and this press was not already sent). */
  ready: boolean
  /** Stop was pressed for this target; it stays so until the snapshot clears or moves it. */
  requested: boolean
  stopping: boolean
  /** The route refused or could not be reached: the chat says so once. */
  refused: boolean
  stop(): void
}

/**
 * The one Stop for a cloud agent's running turn, as the composer's stop button and the side
 * panel's Now both use it. A Hermes-runtime agent (roster `runtime: 'hermes'`) stops through
 * the Shell's host Stop route (`stopTurn`, which main sends to `/api/host/stop`), or with the
 * native `/stop` command for a scheduled turn that has no owner question. An older cloud agent
 * keeps its `stopTurn`. It only names what runs; the host and Hermes decide. The renderer
 * supplies no authority.
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
  const [sending, setSending] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null)
  const cloudAssistant = Boolean(room && cloudRoomAgent(snapshot, room))
  const roomAgent = room ? snapshot.agents?.find(agent => agent.principal === room.agentPrincipal) : undefined

  useEffect(() => {
    setRefused(false)
    setSending(false)
    setUnconfirmed(null)
  }, [room?.id])

  useEffect(() => {
    if (!unconfirmed) {
      return
    }

    const settle = window.setTimeout(() => setUnconfirmed(null), MATRIX_STOP_SETTLE_MS)

    return () => window.clearTimeout(settle)
  }, [unconfirmed])

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
  const scheduled = roomAgent?.runtime === 'hermes' && matrixCloudStopScheduled(messages, roomAgent.userId)
  const route = matrixStopRoute({ runtime: roomAgent?.runtime, eventId: target, working: working || scheduled, scheduled })
  const key = route.kind === 'native' ? `native:${room?.id}` : target

  const shown = matrixShowCloudStop({
    eventId: target,
    cloud: cloudAssistant,
    runtime: roomAgent?.runtime,
    working: working || scheduled
  })

  // A stop that was already asked for stays disabled until its target clears or moves on: the
  // snapshot clears it, not the request resolving.
  const requestedFor = useRef<string | null>(null)
  const requested = Boolean(key) && requestedFor.current === key

  const stop = () => {
    const stopTurn = window.atumMatrix.cloudAgent

    if (!room || !key || !available || !stopTurn || route.kind === 'unavailable' || requestedFor.current === key) {
      return
    }

    const sent = key
    requestedFor.current = sent
    setRefused(false)
    setUnconfirmed(null)
    setSending(true)
    void executeMatrixStop(
      route,
      eventId => stopTurn({ action: 'stopTurn', roomId: room.id, eventId }),
      body => runMatrixCommand({ kind: 'send', roomId: room.id, body })
    )
      .then(result => {
        // `/stop` is a message: a second press later is a new request, not a repeat. A Stop the
        // agent has not confirmed keeps saying "Stopping…" until the turn's final clears it.
        if (result === 'sent') {
          requestedFor.current = null
        } else if (result === 'stopping') {
          setUnconfirmed(sent)
        }
      })
      .catch(() => {
        requestedFor.current = null
        setRefused(true)
      })
      .finally(() => setSending(false))
  }

  const stopping = sending || (unconfirmed !== null && unconfirmed === key)

  return {
    ...(target ? { target } : {}),
    shown,
    route,
    ready: available && route.kind !== 'unavailable' && !stopping && !requested,
    requested,
    stopping,
    refused,
    stop
  }
}
