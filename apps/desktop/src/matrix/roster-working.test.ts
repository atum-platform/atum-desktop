import { describe, expect, it } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'

import { matrixAgentWorkingRow, matrixWorkingRooms, matrixWorkingStep } from './roster-working'

const activity = (roomId: string, state: 'running' | 'complete' | 'stopped') => ({
  roomId,
  invocationId: `${roomId}:turn`,
  state,
  text: '',
  tools: []
})

const snapshot = (extra: Partial<MatrixSnapshot>): MatrixSnapshot => ({
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'OWNER' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  ...extra
})

describe('roster working state', () => {
  it('collects the rooms where a turn is running, from every agent', () => {
    const rooms = matrixWorkingRooms(
      snapshot({
        hermesActivity: activity('!atum:test', 'running'),
        agentTurns: [
          { roomId: '!moon:test', activity: activity('!moon:test', 'running') },
          { roomId: '!done:test', activity: activity('!done:test', 'complete') },
          { roomId: '!asking:test', prompts: [] }
        ]
      })
    )

    expect([...rooms].sort()).toEqual(['!atum:test', '!moon:test'])
    expect(matrixWorkingRooms(snapshot({ hermesActivity: activity('!atum:test', 'stopped') })).size).toBe(0)
  })

  it('marks the history in sight, else the agent row, and never both', () => {
    const working = new Set(['!b:test'])
    const rooms = [{ id: '!a:test' }, { id: '!b:test' }]

    expect(matrixAgentWorkingRow({ hermes: 'ready' }, rooms, rooms, working)).toBe('history')
    // The history is furled away: the agent's own row says it.
    expect(matrixAgentWorkingRow({ hermes: 'ready' }, rooms, [], working)).toBe('agent')
    // Started, before its first activity: only the agent knows it is busy.
    expect(matrixAgentWorkingRow({ hermes: 'running' }, rooms, rooms, new Set())).toBe('agent')
    expect(matrixAgentWorkingRow({ hermes: 'ready' }, rooms, rooms, new Set())).toBeNull()
  })

  it('projects the current step only while that room is running', () => {
    const state = snapshot({
      hermesActivity: { ...activity('!atum:test', 'running'), text: 'Checking guesthouses…' },
      agentTurns: [
        {
          roomId: '!moon:test',
          activity: { ...activity('!moon:test', 'running'), text: 'Reading the brief…' }
        }
      ]
    })

    expect(matrixWorkingStep(state, '!atum:test')).toBe('Checking guesthouses…')
    expect(matrixWorkingStep(state, '!moon:test')).toBe('Reading the brief…')
    expect(matrixWorkingStep(state, '!other:test')).toBeUndefined()
  })
})
