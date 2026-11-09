import { projectRecentContext } from '../context'
import type { RoomPort } from '../ports'
import type { ChainEvent, ContextEvent, RoomContextInput, RoomMember, RoomMode, RoomPolicy } from '../types'

export interface RoomScenario {
  roomId: string
  mode: RoomMode
  members: readonly RoomMember[]
  policy: RoomPolicy
  timeline: readonly ContextEvent[]
  events: readonly ChainEvent[]
}

/** Test adapter only. Verification bits are supplied fixture facts, never inferred from content. */
export class FakeRoomPort implements RoomPort {
  private scenario: RoomScenario
  private settled = new Map<string, Set<string>>()
  readonly reads: { method: string; roomId: string; eventId?: string }[] = []
  readonly published: { roomId: string; content: Readonly<Record<string, unknown>>; eventId: string }[] = []

  constructor(scenario: RoomScenario) {
    this.scenario = structuredClone(scenario)
  }

  replace(change: Partial<Omit<RoomScenario, 'roomId'>>) {
    this.scenario = structuredClone({ ...this.scenario, ...change, roomId: this.scenario.roomId })
  }

  private room(roomId: string) {
    if (roomId !== this.scenario.roomId) {
      throw new Error('matrix_group_changed')
    }

    return this.scenario
  }

  async readMembers(roomId: string) {
    this.reads.push({ method: 'members', roomId })

    return structuredClone(this.room(roomId).members)
  }

  async readPolicy(roomId: string) {
    this.reads.push({ method: 'policy', roomId })

    return structuredClone(this.room(roomId).policy)
  }

  async readRecent(input: RoomContextInput) {
    this.reads.push({ method: 'recent', roomId: input.roomId })
    const room = this.room(input.roomId)

    return projectRecentContext(input, room.mode, room.timeline)
  }

  async readOwnerEvent(roomId: string, eventId: string) {
    this.reads.push({ method: 'event', roomId, eventId })

    return structuredClone(
      this.room(roomId).events.find(event => event.roomId === roomId && event.eventId === eventId) ?? null
    )
  }

  settle(roomId: string, origin: string, agentId: string) {
    this.room(roomId)
    const settled = this.settled.get(origin) ?? new Set<string>()
    settled.add(agentId)
    this.settled.set(origin, settled)
  }

  async readSettled(roomId: string, origin: string) {
    this.room(roomId)
    this.reads.push({ method: 'settled', roomId, eventId: origin })

    return [...(this.settled.get(origin) ?? [])]
  }

  async publish(roomId: string, content: Readonly<Record<string, unknown>>) {
    this.room(roomId)
    const eventId = `$fake-${this.published.length + 1}`
    this.published.push({ roomId, content: structuredClone(content), eventId })

    return { eventId }
  }
}
