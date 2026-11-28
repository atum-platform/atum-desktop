import { useEffect, useRef, useState } from 'react'

import type { MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import { cloudRoomAgent } from './cloud-status'
import {
  executeMatrixStop,
  matrixCloudStopScheduled,
  matrixCloudStopTarget,
  matrixShowCloudStop,
  type MatrixStopResult,
  type MatrixStopRoute,
  matrixStopRoute
} from './cloud-stop'
import { matrixUnansweredOwnerMessage } from './no-reply-banner'

/** How long an unconfirmed Stop keeps saying "Stopping…" before it settles without a word. */
export const MATRIX_STOP_SETTLE_MS = 15_000

export interface MatrixCloudStop {
  /** The question the running cloud turn answers: Stop names it. Absent while nothing runs. */
  target?: string
  /** Stop is offered: a named turn, or a Hermes agent still working. */
  shown: boolean
  route: MatrixStopRoute
  /** Stop can be pressed now (a path exists and this press was not already sent). */
  ready: boolean
  /** This target already has a Stop in flight or settled. */
  requested: boolean
  stopping: boolean
  stopped: boolean
  /** The route refused or could not be reached: the chat says so once. */
  refused: boolean
  stop(): void
}

interface StopAttempt {
  key: string
  roomId: string
  scheduled: boolean
}

interface StopStatus extends StopAttempt {
  result: MatrixStopResult | 'sending' | 'refused'
}

/** The composer and agent desk share the exact-source cloud Stop path. */
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
  const [status, setStatus] = useState<StopStatus | null>(null)
  const inFlight = useRef<StopAttempt | null>(null)
  const cloudAssistant = Boolean(room && cloudRoomAgent(snapshot, room))
  const roomAgent = room ? snapshot.agents?.find(agent => agent.principal === room.agentPrincipal) : undefined

  useEffect(() => {
    inFlight.current = null
    setStatus(null)
  }, [room?.id, roomAgent?.principal, snapshot.identity?.userId])

  useEffect(() => {
    if (status?.result !== 'stopping') {
      return
    }

    const settle = window.setTimeout(() => {
      const settled: StopStatus | null = status.scheduled ? null : { ...status, result: 'settled' }

      setStatus(current => current === status ? settled : current)
    }, MATRIX_STOP_SETTLE_MS)

    return () => window.clearTimeout(settle)
  }, [status])

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
      ? matrixCloudStopTarget({
          messages, turns: snapshot.localTurns, roomId: room.id, unanswered, working,
          agentId: roomAgent?.runtime === 'hermes' ? roomAgent.userId : undefined,
          roomTimeline: messages === snapshot.messages
        })
      : undefined

  // The typing signal a question from another device shows through expires in moments, long
  // before a cloud turn does. Once Stop has named that question, keep naming it until the
  // question clears or the room changes, so the button does not vanish mid-turn.
  const latch = useRef<{ roomId: string; unansweredId: string; eventId: string } | null>(null)

  if (live) {
    latch.current = unanswered ? { roomId: room!.id, unansweredId: unanswered.id, eventId: live } : null
  } else if (
    latch.current &&
    (!available || latch.current.roomId !== room?.id || latch.current.unansweredId !== unanswered?.id)
  ) {
    latch.current = null
  }

  const scheduled = roomAgent?.runtime === 'hermes' ? matrixCloudStopScheduled(messages, roomAgent.userId) : undefined
  const target = scheduled ? undefined : live ?? latch.current?.eventId
  const route = matrixStopRoute({ runtime: roomAgent?.runtime, eventId: target, working: working || Boolean(scheduled), scheduled })
  const key = route.kind === 'schedule'
    ? JSON.stringify([room?.id, roomAgent?.principal, route.schedule.job, route.schedule.execution])
    : target && JSON.stringify([room?.id, target])
  const shown = matrixShowCloudStop({
    eventId: target,
    cloud: cloudAssistant,
    runtime: roomAgent?.runtime,
    working: working || Boolean(scheduled)
  })

  const current = status?.key === key ? status : null
  const requested = Boolean(current && current.result !== 'refused')
  const stopping = current?.result === 'sending' || current?.result === 'stopping'
  const stopped = status?.scheduled === true && status.result === 'stopped' &&
    status.roomId === room?.id && (current === status || (!key && !scheduled))
  const ready = available && route.kind !== 'unavailable' && !requested

  const stop = () => {
    const stopTurn = window.atumMatrix.cloudAgent

    if (!room || !key || !ready || !stopTurn || inFlight.current?.key === key) {
      return
    }

    const attempt = { key, roomId: room.id, scheduled: route.kind === 'schedule' }
    inFlight.current = attempt
    setStatus({ ...attempt, result: 'sending' })

    void executeMatrixStop(route, room.id, stopTurn)
      .then(result => {
        if (inFlight.current === attempt) {
          setStatus({ ...attempt, result })
        }
      })
      .catch(() => {
        if (inFlight.current === attempt) {
          setStatus({ ...attempt, result: 'refused' })
        }
      })
      .finally(() => {
        if (inFlight.current === attempt) {
          inFlight.current = null
        }
      })
  }

  return {
    ...(target ? { target } : {}),
    shown,
    route,
    ready,
    requested,
    stopping,
    stopped,
    refused: current?.result === 'refused',
    stop
  }
}
