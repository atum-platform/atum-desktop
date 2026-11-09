import { buildConversationMarker } from './marker'
import { compareIds } from './resolver'
import type { ConversationWrite, MigrationBlock, MigrationCandidate, MigrationInput } from './types'

const RECENT_OWNER_MS = 30 * 24 * 60 * 60 * 1000

/** The recency key `rankConversationCandidates` sorts by. Exposed so a caller can treat rooms of
 * equal recency as a tie and break it on another fact without changing this order. */
export function conversationRecencyRank(candidate: MigrationCandidate, now: number): [number, number] {
  if (candidate.ownerAt !== undefined && candidate.ownerAt <= now && candidate.ownerAt >= now - RECENT_OWNER_MS) {
    return [0, -candidate.ownerAt]
  }

  if (candidate.activityAt !== undefined) {
    return [1, -candidate.activityAt]
  }

  return [2, candidate.createdAt ?? Number.POSITIVE_INFINITY]
}

export function rankConversationCandidates(candidates: readonly MigrationCandidate[], now: number): string[] {
  return [...candidates]
    .sort((a, b) => {
      const ar = conversationRecencyRank(a, now)
      const br = conversationRecencyRank(b, now)

      return ar[0] - br[0] || ar[1] - br[1] || compareIds(a.roomId, b.roomId)
    })
    .map(candidate => candidate.roomId)
}

/** Pure ordering only. Adapter supplies confirmed authority, gate and preflight
 * facts, performs writes, and retains incomplete rollback until all clears pass. */
export function planConversationMigration(
  input: MigrationInput,
  at: number
): { status: 'ready'; writes: ConversationWrite[] } | { status: 'blocked'; reason: MigrationBlock; writes: [] } {
  const gates: [boolean, MigrationBlock][] = [
    [input.ownerConfirmed, 'owner_confirmation'],
    [input.noLiveTurn, 'turn_live'],
    [!input.cloudMayAnswer || input.cloudReady, 'cloud_not_ready'],
    [input.fleetReady, 'fleet_not_ready'],
    [input.rooms.includes(input.chosen) && input.writable.includes(input.chosen), 'chosen_not_writable']
  ]

  const failed = gates.find(([ready]) => !ready)

  if (failed) {
    return { status: 'blocked', reason: failed[1], writes: [] }
  }

  const targets = [...new Set(input.rooms)].filter(room => room !== input.chosen && input.writable.includes(room))
  targets.sort(compareIds)

  return {
    status: 'ready',
    writes: [input.chosen, ...targets].map(roomId => ({
      roomId,
      content: buildConversationMarker({
        roomId,
        role: roomId === input.chosen ? 'main' : 'earlier',
        main: input.chosen,
        at
      })
    }))
  }
}

export function rollbackConversationWrites(written: readonly ConversationWrite[]): ConversationWrite[] {
  return [...written].reverse().map(({ roomId }) => ({ roomId, content: {} }))
}
