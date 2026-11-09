import {
  conversationSweepCandidates,
  decideConversationTurn,
  EarlierConversationError,
  planConversationMigration,
  resolveConversationRoom,
  rollbackConversationWrites,
  shouldPostEarlierNotice
} from '..'
import type {
  ConversationMarker,
  ConversationResolution,
  ConversationRoom,
  ConversationState,
  ConversationWrite,
  MigrationInput
} from '../types'

export interface FakeRoom {
  roomId: string
  marker?: ConversationMarker | null
  read?: ConversationRoom['read']
}

export interface FakeMigrationResult {
  status: 'applied' | 'blocked' | 'rolled_back' | 'crashed'
  writes: ConversationWrite[]
}

/**
 * A deliberately small Matrix-shaped room set for controller conformance.
 * Policy decisions stay in the shared production functions; this only stores
 * their writes and turns them back into rooms for the next decision.
 */
export class FakeRoomSet {
  private readonly rooms = new Map<string, FakeRoom>()
  private readonly noticeDays = new Map<string, string>()
  readonly writeLog: ConversationWrite[] = []

  constructor(rooms: readonly FakeRoom[]) {
    for (const room of rooms) {
      this.rooms.set(room.roomId, { ...room })
    }
  }

  resolution(previous?: ConversationResolution): ConversationResolution {
    return resolveConversationRoom(
      [...this.rooms.values()].map(room => ({
        roomId: room.roomId,
        read: room.read ?? 'readable',
        marker: room.marker
      })),
      previous
    )
  }

  display(roomId: string): FakeRoom {
    return this.requireRoom(roomId)
  }

  readForTurn(roomId: string): FakeRoom {
    const resolution = this.resolution()
    const admission = decideConversationTurn({ roomId, privateAssistant: true, forTurn: true, resolution })

    if (admission.admit === false) {
      throw new EarlierConversationError(roomId, admission.main)
    }

    return this.requireRoom(roomId)
  }

  migrate(input: MigrationInput, at: number, failBeforeWrite?: number): FakeMigrationResult {
    const planned = planConversationMigration(input, at)

    if (planned.status === 'blocked') {
      return { status: 'blocked', writes: [] }
    }

    const applied: ConversationWrite[] = []

    for (const [index, write] of planned.writes.entries()) {
      if (index === failBeforeWrite) {
        const rollback = rollbackConversationWrites(applied)

        for (const clear of rollback) {
          this.apply(clear)
        }

        return { status: 'rolled_back', writes: [...applied, ...rollback] }
      }

      this.apply(write)
      applied.push(write)
    }

    return { status: 'applied', writes: planned.writes }
  }

  crashAfterMain(input: MigrationInput, at: number): FakeMigrationResult {
    const planned = planConversationMigration(input, at)

    if (planned.status === 'blocked') {
      return { status: 'blocked', writes: [] }
    }

    this.apply(planned.writes[0])

    return { status: 'crashed', writes: [planned.writes[0]] }
  }

  sweep(at: number): ConversationWrite[] {
    const resolution = this.resolution()

    const writes = conversationSweepCandidates(resolution, at).filter(write => {
      const marker = this.requireRoom(write.roomId).marker

      // The pure helper returns every candidate. Like the production adapter,
      // suppress an already-converged Earlier pointer even when `at` differs.
      return marker?.role !== 'earlier' || marker.main !== resolution.main
    })

    for (const write of writes) {
      this.apply(write)
    }

    return writes
  }

  earlierNoticeDue(roomId: string, day: string, leaseHolder = true): boolean {
    return shouldPostEarlierNotice({ leaseHolder, day, lastDay: this.noticeDays.get(roomId) })
  }

  earlierNoticePublished(roomId: string, day: string): void {
    this.requireRoom(roomId)
    this.noticeDays.set(roomId, day)
  }

  marker(roomId: string): ConversationMarker | null | undefined {
    return this.requireRoom(roomId).marker
  }

  private apply(write: ConversationWrite): void {
    const room = this.requireRoom(write.roomId)
    const content = write.content as Partial<ConversationState>

    room.marker = Object.keys(content).length
      ? { role: content.role!, main: content.main!, at: content.at! }
      : null
    this.writeLog.push(write)
  }

  private requireRoom(roomId: string): FakeRoom {
    const room = this.rooms.get(roomId)

    if (!room) {
      throw new Error(`unknown fake room: ${roomId}`)
    }

    return room
  }
}
