import { MATRIX_AGENT_SIGNALS } from './matrix-agent-signals'

/** agent-turns/v1.1 presentation only. None of these values confers execution authority. */
export type MatrixReceiptDisposition =
  | 'admitted'
  | 'answered'
  | 'status_shown'
  | 'not_a_turn'
  | 'unchecked'
  | 'refused_silently'
  | 'agent_message'

export interface MatrixReceiptEvent {
  eventId: string
  disposition: MatrixReceiptDisposition
  /** The existing private-room SDK may target any settled timeline event before a hold.
   * Group/outbox adapters omit this: only addressed, admitted/answered/status turns qualify. */
  receiptEligible?: boolean
}

const receiptTargets = new Set<MatrixReceiptDisposition>(['admitted', 'answered', 'status_shown'])
const receiptHolds = new Set<MatrixReceiptDisposition>(['unchecked', 'refused_silently'])

/** Cumulative receipt: stop before the first unchecked/silent turn after the agent last spoke.
 * The legacy "already spoken after it" exception is part of the frozen v1.1 vectors. */
export function matrixReceiptTarget(
  events: readonly MatrixReceiptEvent[],
  previous: string | null = null
): string | null {
  let spokeAt = -1

  for (let index = 0; index < events.length; index++) {
    if (events[index]!.disposition === 'agent_message') {
      spokeAt = index
    }
  }

  let target: string | null = null

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!

    if (index > spokeAt && receiptHolds.has(event.disposition)) {
      break
    }

    if (event.receiptEligible ?? receiptTargets.has(event.disposition)) {
      target = event.eventId
    }
  }

  if (target === null || previous === null) {
    return target
  }

  return events.findIndex(event => event.eventId === target) > events.findIndex(event => event.eventId === previous)
    ? target
    : null
}

export type MatrixPresentationState = 'observed' | 'refused' | 'admitted' | 'working' | 'waiting' | 'ended'
export type MatrixPresentationEvent =
  | 'refused_with_status_line'
  | 'trust_fence_lease_passed'
  | 'work_started'
  | 'typing_renewed'
  | 'wait_state'
  | 'wait_state_changed'
  | 'work_resumed'
  | 'outcome_published'

const presentationTransitions: Record<
  MatrixPresentationState,
  Partial<Record<MatrixPresentationEvent, MatrixPresentationState>>
> = {
  observed: { refused_with_status_line: 'refused', trust_fence_lease_passed: 'admitted' },
  refused: {},
  admitted: { work_started: 'working', wait_state: 'waiting', outcome_published: 'ended' },
  working: { typing_renewed: 'working', wait_state: 'waiting', outcome_published: 'ended' },
  waiting: { wait_state_changed: 'waiting', work_resumed: 'working', outcome_published: 'ended' },
  ended: {}
}

/** Invalid edges are rejected, including typing before admission/while waiting/after outcome. */
export function matrixPresentationTransition(
  state: MatrixPresentationState,
  event: MatrixPresentationEvent
): MatrixPresentationState | null {
  return presentationTransitions[state][event] ?? null
}

export function matrixTypingBody(typing: boolean): { typing: boolean; timeout?: number } {
  return typing ? { typing: true, timeout: MATRIX_AGENT_SIGNALS.typingTimeoutMs } : { typing: false }
}

export type MatrixPresentationCommand =
  | { kind: 'agentSeen'; roomId: string; eventId: string; ownerId: string; admitted: string[] }
  | { kind: 'agentTyping'; roomId: string; ownerId: string; typing: boolean }

/** The thin host port: no Node, Matrix SDK, timer implementation, or controller dependency. */
export interface MatrixPresentationPort {
  send(command: MatrixPresentationCommand): Promise<unknown>
  owner(): string | undefined
  leaseHeld(): boolean
  /** Schedule recurring work and return its cancellation function. */
  every(milliseconds: number, run: () => void): () => void
  log?(line: string): void
}

export interface MatrixPresentationWork {
  waiting<T>(wait: Promise<T>): Promise<T>
  stop(): void
}

/**
 * What makes this executor the one that may acknowledge a message (agent-turns v1.1 P2: only the
 * executor that holds the agent's lease and has claimed the turn).
 * - `lease`: the message is being taken up now; the lease is checked at this moment.
 * - `claimed`: this executor claimed the turn under its lease earlier (the caller's own record of
 *   that turn says so) and has now published its answer. The lease may have been released since
 *   because no work was left (the Mac does so as soon as a run ends, before its answer is posted);
 *   no other executor can have claimed that turn.
 */
export type MatrixSeenProof = 'lease' | 'claimed'

interface Session {
  waits: number
}

interface RoomTyping {
  sessions: Set<Session>
  on: boolean
  cancel?: () => void
}

export class MatrixPresentationSignals {
  private readonly admitted = new Map<string, string[]>()
  private readonly rooms = new Map<string, RoomTyping>()

  constructor(private readonly port: MatrixPresentationPort) {}

  /** Call only after the real trust/fence/lease admission (`lease`, checked now), or once the
   * answer to a turn this executor claimed under its lease is published (`claimed`). */
  seen(roomId: string, eventId: string, proof: MatrixSeenProof = 'lease'): void {
    const ownerId = this.port.owner()

    if (
      !ownerId ||
      (proof !== 'claimed' && !this.port.leaseHeld()) ||
      typeof eventId !== 'string' ||
      !eventId.startsWith('$')
    ) {
      return
    }

    const admitted = [...(this.admitted.get(roomId) ?? []).filter(id => id !== eventId), eventId].slice(
      -MATRIX_AGENT_SIGNALS.admittedMax
    )

    this.admitted.set(roomId, admitted)
    this.send({ kind: 'agentSeen', roomId, eventId, ownerId, admitted: [...admitted] })
  }

  work(roomId: string): MatrixPresentationWork {
    const session: Session = { waits: 0 }
    const room = this.rooms.get(roomId) ?? { sessions: new Set<Session>(), on: false }
    this.rooms.set(roomId, room)
    room.sessions.add(session)
    this.refresh(roomId)
    let stopped = false

    return {
      waiting: async wait => {
        if (stopped) {
          return wait
        }

        session.waits++
        this.refresh(roomId)

        try {
          return await wait
        } finally {
          session.waits--
          this.refresh(roomId)
        }
      },
      stop: () => {
        if (stopped) {
          return
        }

        stopped = true
        this.rooms.get(roomId)?.sessions.delete(session)
        this.refresh(roomId)
      }
    }
  }

  stop(): void {
    for (const roomId of this.rooms.keys()) {
      this.endRoom(roomId)
    }

    this.admitted.clear()
  }

  private endRoom(roomId: string): void {
    const room = this.rooms.get(roomId)
    room?.cancel?.()

    if (room?.on) {
      this.typing(roomId, false)
    }

    this.rooms.delete(roomId)
    this.admitted.delete(roomId)
  }

  private refresh(roomId: string): void {
    const room = this.rooms.get(roomId)

    if (!room) {
      return
    }

    if (!this.port.leaseHeld()) {
      this.endRoom(roomId)

      return
    }

    const working = [...room.sessions].some(session => session.waits === 0)

    if (working && !room.on) {
      room.on = true
      this.typing(roomId, true)
      room.cancel = this.port.every(MATRIX_AGENT_SIGNALS.typingRenewMs, () => {
        // A stale executor may stop its old notice, but must never renew it after lease loss.
        if (!this.port.leaseHeld()) {
          this.endRoom(roomId)
        } else {
          this.typing(roomId, true)
        }
      })
    } else if (!working && room.on) {
      room.on = false
      room.cancel?.()
      room.cancel = undefined
      this.typing(roomId, false)
    }

    if (!room.sessions.size) {
      this.rooms.delete(roomId)
    }
  }

  private typing(roomId: string, typing: boolean): void {
    const ownerId = this.port.owner()

    if (ownerId) {
      this.send({ kind: 'agentTyping', roomId, ownerId, typing })
    }
  }

  private send(command: MatrixPresentationCommand): void {
    let pending: Promise<unknown>

    try {
      pending = this.port.send(command)
    } catch (error) {
      pending = Promise.reject(error)
    }

    void pending.catch(error => {
      const safe =
        error instanceof Error &&
        [
          'matrix_offline',
          'matrix_sdk_unavailable',
          'matrix_agent_unavailable',
          'matrix_assistant_room_required',
          'matrix_command_invalid'
        ].includes(error.message)
          ? error.message
          : 'unexpected'

      this.port.log?.(`[Matrix] agent ${command.kind === 'agentSeen' ? 'read receipt' : 'typing'} not sent: ${safe}`)
    })
  }
}
