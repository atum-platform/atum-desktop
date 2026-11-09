import { describe, expect, it } from 'vitest'

import { EarlierConversationError } from '../../shared/agent-conversation'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { matrixListeningArmCode, matrixListeningFollow, matrixListeningRefusedEverywhere } from './listening-room'

const OWNER = '@owner:test'
const AGENT = '@atum:test'

function room(id: string, conversation?: { role: 'main' | 'earlier'; main: string }) {
  return {
    id,
    name: id,
    membership: 'join',
    encrypted: false,
    plainAgent: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    participants: [
      { userId: OWNER, membership: 'join' },
      { userId: AGENT, membership: 'join' }
    ],
    ...(conversation ? { conversation: { ...conversation, at: 1 }, conversationOwnerId: OWNER } : {})
  }
}

describe('where automatic listening belongs', () => {
  it('follows the main once its room is an earlier conversation, and stays in the main', () => {
    const rooms = [room('!old:test', { role: 'earlier', main: '!new:test' }), room('!new:test', { role: 'main', main: '!new:test' })]

    expect(matrixListeningFollow({ rooms, ownerId: OWNER, agentId: AGENT, roomId: '!old:test' })).toBe('!new:test')
    expect(matrixListeningFollow({ rooms, ownerId: OWNER, agentId: AGENT, roomId: '!new:test' })).toBeUndefined()
  })

  it('stays put while no main is known (rooms all Earlier), until a read names one here', () => {
    const crossed = [room('!a:test', { role: 'earlier', main: '!c:test' }), room('!c:test', { role: 'earlier', main: '!a:test' })]

    expect(matrixListeningFollow({ rooms: crossed, ownerId: OWNER, agentId: AGENT, roomId: '!a:test' })).toBeUndefined()
    // The server read already shows the restored main; this Mac's view has not caught up.
    expect(
      matrixListeningFollow({ rooms: crossed, ownerId: OWNER, agentId: AGENT, roomId: '!a:test', named: '!c:test' })
    ).toBe('!c:test')
    // Never a named room that is not the agent's private room here (a group, an unsynced room).
    expect(
      matrixListeningFollow({ rooms: crossed, ownerId: OWNER, agentId: AGENT, roomId: '!a:test', named: '!elsewhere:test' })
    ).toBeUndefined()
    expect(
      matrixListeningFollow({ rooms: crossed, ownerId: OWNER, agentId: '@other:test', roomId: '!a:test', named: '!c:test' })
    ).toBeUndefined()
  })

  it("keeps to the main this Mac's own move just finished while its view of the markers lags", () => {
    // finish() wrote R main and M Earlier, and moved listening to R; the synced view still shows
    // M as main and R unmarked (a stray), which alone would send listening back to M.
    const stale = [room('!m:test', { role: 'main', main: '!m:test' }), room('!r:test')]

    expect(matrixListeningFollow({ rooms: stale, ownerId: OWNER, agentId: AGENT, roomId: '!r:test' })).toBe('!m:test')
    expect(
      matrixListeningFollow({ rooms: stale, ownerId: OWNER, agentId: AGENT, roomId: '!r:test', pending: '!r:test' })
    ).toBeUndefined()
    // Listening not yet on the finished main goes there, not to the stale one.
    expect(
      matrixListeningFollow({ rooms: stale, ownerId: OWNER, agentId: AGENT, roomId: '!m:test', pending: '!r:test' })
    ).toBe('!r:test')
    // A main the server named wins over both.
    const synced = [...stale, room('!s:test')]
    expect(
      matrixListeningFollow({
        rooms: synced,
        ownerId: OWNER,
        agentId: AGENT,
        roomId: '!r:test',
        pending: '!r:test',
        named: '!s:test'
      })
    ).toBe('!s:test')
  })

  it('counts a refusal toward the handover unless the rooms name no main at all', () => {
    // No main anywhere (crossed moves): every Mac meets it, retried without counting.
    expect(matrixListeningRefusedEverywhere(new EarlierConversationError('!a:test'))).toBe(true)
    // A main is named: listening follows it, and a Mac that cannot (the room has not synced
    // here, no binding) is at fault itself, so the failure counts as before.
    expect(matrixListeningRefusedEverywhere(new EarlierConversationError('!a:test', '!c:test'))).toBe(false)
    expect(matrixListeningRefusedEverywhere(new Error('matrix_earlier_conversation'))).toBe(false)
    expect(matrixListeningRefusedEverywhere(new Error('matrix_conversation_unavailable'))).toBe(false)
  })

  it('logs an arm failure by its closed code only', () => {
    expect(matrixListeningArmCode(new EarlierConversationError('!a:test', '!c:test'))).toBe('matrix_earlier_conversation')
    expect(matrixListeningArmCode(new Error('matrix_catchup_incomplete'))).toBe('matrix_catchup_incomplete')
    expect(matrixListeningArmCode(new Error('Request to !room:server failed: secret'))).toBe('unexpected')
    expect(matrixListeningArmCode('matrix_not_ready')).toBe('unexpected')
  })
})
