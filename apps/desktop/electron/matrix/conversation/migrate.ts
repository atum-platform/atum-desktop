import {
  buildConversationMarker,
  planConversationMigration,
  rollbackConversationWrites
} from '../../../shared/agent-conversation'
import type {
  ConversationState,
  ConversationWrite,
  MigrationBlock,
  MigrationInput
} from '../../../shared/agent-conversation/types'

export interface ConversationMigrationJournal {
  phase: 'forward' | 'rollback' | 'effects'
  writes: ConversationWrite[]
  cursor: number
  main: string
  rooms: string[]
}

export interface ConversationMigrationPorts {
  /** Native account/host generation and no-live-turn fence, rechecked at every await. */
  ready(): boolean
  gate(): { cloudMayAnswer: boolean; cloudReady: boolean; fleetReady: boolean }
  write(write: ConversationWrite): Promise<void>
  readJournal(): ConversationMigrationJournal | null
  saveJournal(journal: ConversationMigrationJournal | null): void
  /** Repoint actual persisted job origins, then restart only when home changed. */
  finish(main: string, rooms: readonly string[]): Promise<void>
}

export type ConversationMigrationOutcome =
  | { status: 'blocked'; reason: MigrationBlock | 'migration_pending' }
  | { status: 'applied'; main: string }
  | { status: 'rolled_back' | 'rollback_pending'; count: number }
  | { status: 'effects_pending'; main: string }

/** The journal contains only IDs and system markers, in the account's encrypted store. */
export function parseConversationMigrationJournal(raw: string | null): ConversationMigrationJournal | null {
  if (!raw) {
    return null
  }
  try {
    const journal = JSON.parse(raw) as ConversationMigrationJournal
    if (
      !['forward', 'rollback', 'effects'].includes(journal.phase) ||
      !Array.isArray(journal.writes) ||
      !journal.writes.length ||
      !Array.isArray(journal.rooms) ||
      !Number.isSafeInteger(journal.cursor) ||
      journal.cursor < 0 ||
      journal.cursor > journal.writes.length
    ) {
      return null
    }
    buildConversationMarker({ roomId: journal.main, role: 'main', main: journal.main, at: 0 })
    if (!journal.rooms.length || !journal.rooms.includes(journal.main)) {
      return null
    }
    for (const roomId of journal.rooms) {
      buildConversationMarker({ roomId, role: 'main', main: roomId, at: 0 })
    }
    const seen = new Set<string>()
    const writes = journal.writes.map((write, index) => {
      if (!write || typeof write !== 'object' || !journal.rooms.includes(write.roomId) || seen.has(write.roomId)) {
        throw new Error('matrix_invalid_conversation_journal')
      }
      seen.add(write.roomId)
      const content = write.content as ConversationState

      if (journal.phase === 'rollback') {
        if (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).length !== 0) {
          throw new Error('matrix_invalid_conversation_journal')
        }
        return { roomId: write.roomId, content: {} }
      }

      const marker = buildConversationMarker({ roomId: write.roomId, role: content.role, main: content.main, at: content.at })
      const mainWrite = index === 0
      if (
        (mainWrite && (write.roomId !== journal.main || marker.role !== 'main' || marker.main !== journal.main)) ||
        (!mainWrite && (marker.role !== 'earlier' || marker.main !== journal.main))
      ) {
        throw new Error('matrix_invalid_conversation_journal')
      }
      return { roomId: write.roomId, content: marker }
    })
    if (
      (journal.phase === 'rollback' && !writes.some(write => write.roomId === journal.main)) ||
      (journal.phase === 'effects' && journal.cursor !== 0)
    ) {
      return null
    }
    return { phase: journal.phase, writes, cursor: journal.cursor, main: journal.main, rooms: [...journal.rooms] }
  } catch {
    return null
  }
}

/** Fresh actions are owner-confirmed. A durable accepted action can be retried after restart. */
export async function executeConversationMigration(
  input: MigrationInput,
  at: number,
  ports: ConversationMigrationPorts
): Promise<ConversationMigrationOutcome> {
  if (ports.readJournal()) {
    return { status: 'blocked', reason: 'migration_pending' }
  }
  const planned = planConversationMigration(
    { ...input, ...ports.gate(), noLiveTurn: input.noLiveTurn && ports.ready() },
    at
  )
  if (planned.status === 'blocked') {
    return { status: 'blocked', reason: planned.reason }
  }
  const journal: ConversationMigrationJournal = {
    phase: 'forward',
    writes: planned.writes,
    cursor: 0,
    main: input.chosen,
    rooms: [...input.rooms]
  }
  ports.saveJournal(journal)
  return runMigration(journal, ports)
}

export async function retryConversationMigration(
  ports: ConversationMigrationPorts
): Promise<ConversationMigrationOutcome> {
  const journal = ports.readJournal()
  if (!journal) {
    return { status: 'blocked', reason: 'migration_pending' }
  }
  return runMigration(journal, ports)
}

async function runMigration(
  journal: ConversationMigrationJournal,
  ports: ConversationMigrationPorts
): Promise<ConversationMigrationOutcome> {
  if (!ports.ready()) {
    return { status: 'blocked', reason: 'turn_live' }
  }
  // Rollback must remain possible when a readiness gate regresses after a failed write.
  if (journal.phase !== 'rollback') {
    const gate = ports.gate()
    if (gate.cloudMayAnswer && !gate.cloudReady) {
      return { status: 'blocked', reason: 'cloud_not_ready' }
    }
    if (!gate.fleetReady) {
      return { status: 'blocked', reason: 'fleet_not_ready' }
    }
  }
  if (journal.phase === 'forward') {
    while (journal.cursor < journal.writes.length) {
      const attempted = journal.cursor
      try {
        if (!ports.ready()) {
          throw new Error('matrix_conversation_stale')
        }
        const gate = ports.gate()
        if ((gate.cloudMayAnswer && !gate.cloudReady) || !gate.fleetReady) {
          throw new Error('matrix_conversation_gate_changed')
        }
        await ports.write(journal.writes[attempted])
        if (!ports.ready()) {
          throw new Error('matrix_conversation_stale')
        }
        journal = { ...journal, cursor: attempted + 1 }
        ports.saveJournal(journal)
      } catch {
        // Include the attempted write: a lost response may have committed on the server.
        journal = {
          ...journal,
          phase: 'rollback',
          cursor: 0,
          writes: rollbackConversationWrites(journal.writes.slice(0, attempted + 1))
        }
        ports.saveJournal(journal)
        return clearMigration(journal, ports)
      }
    }
    journal = { ...journal, phase: 'effects', cursor: 0 }
    ports.saveJournal(journal)
  }
  if (journal.phase === 'rollback') {
    return clearMigration(journal, ports)
  }
  try {
    if (!ports.ready()) {
      throw new Error('matrix_conversation_stale')
    }
    await ports.finish(journal.main, journal.rooms)
    if (!ports.ready()) {
      throw new Error('matrix_conversation_stale')
    }
    ports.saveJournal(null)
    return { status: 'applied', main: journal.main }
  } catch {
    return { status: 'effects_pending', main: journal.main }
  }
}

async function clearMigration(
  journal: ConversationMigrationJournal,
  ports: ConversationMigrationPorts
): Promise<ConversationMigrationOutcome> {
  const count = journal.writes.length
  while (journal.cursor < journal.writes.length) {
    try {
      if (!ports.ready()) {
        throw new Error('matrix_conversation_stale')
      }
      await ports.write(journal.writes[journal.cursor])
      if (!ports.ready()) {
        throw new Error('matrix_conversation_stale')
      }
      journal = { ...journal, cursor: journal.cursor + 1 }
      ports.saveJournal(journal)
    } catch {
      return { status: 'rollback_pending', count }
    }
  }
  ports.saveJournal(null)
  return { status: 'rolled_back', count }
}
