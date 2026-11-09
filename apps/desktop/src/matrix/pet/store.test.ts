import { describe, expect, it } from 'vitest'

import type { MatrixSnapshot } from '../../../shared/matrix'

import { PET_FAILED_MS, petWorkChangesAt } from './presentation'
import { holdPetPresentation, petWorkFor } from './store'

const snapshot = {
  roomId: '!here',
  rooms: [],
  messages: [],
  state: 'ready',
  identity: null,
  error: null
} as MatrixSnapshot

describe('agent-scoped pet presentation', () => {
  it('shares only one account/agent and drops presentation after its last mounted surface', () => {
    const one = holdPetPresentation('account:A', 100)
    const same = holdPetPresentation('account:A', 200)
    const other = holdPetPresentation('account:B', 200)
    one.store.set({ lastActiveAt: 300, commands: [{ action: 'wave' }] })
    expect(same.store.get().commands).toEqual([{ action: 'wave' }])
    expect(other.store.get().commands).toEqual([])
    one.release()
    expect(same.store.get().lastActiveAt).toBe(300)
    same.release()
    same.release()
    const reopened = holdPetPresentation('account:A', 400)
    expect(reopened.store.get()).toEqual({ lastActiveAt: 400, commands: [] })
    reopened.release()
    other.release()
  })

  it('uses current-room prompts before work and never borrows another room activity', () => {
    const activity = { invocationId: 'turn', state: 'running', text: '', tools: [], roomId: '!elsewhere' } as const
    expect(petWorkFor({ ...snapshot, hermesActivity: { ...activity, tools: [] } })).toBe('idle')
    expect(
      petWorkFor({
        ...snapshot,
        agentTurns: [{ roomId: '!here', activity: { ...activity, roomId: '!here', tools: [] } }]
      })
    ).toBe('working')
    expect(
      petWorkFor({
        ...snapshot,
        hermesActivity: { ...activity, roomId: '!here', tools: [] },
        hermesPrompts: { roomId: '!here', prompts: [{} as never] }
      })
    ).toBe('waiting')
  })

  it('shows a failed local send and clears that pose when a newer turn succeeds', () => {
    const failed = {
      turnId: 'old',
      roomId: '!here',
      text: '',
      createdAt: 10,
      state: 'not_sent',
      failedAt: 1_000,
      synced: { question: false, answer: false }
    } as const

    expect(petWorkFor({ ...snapshot, localTurns: [failed] }, 1_500)).toBe('failed')
    const answered = { ...failed, turnId: 'new', createdAt: 20, state: 'done' } as const
    expect(petWorkFor({ ...snapshot, localTurns: [answered, failed] }, 1_500)).toBe('idle')
  })

  it('reacts to an unsent message only briefly: an old failure never pins the companion', () => {
    const failed = {
      turnId: 'old',
      roomId: '!here',
      text: '',
      createdAt: 10,
      state: 'not_sent',
      failedAt: 1_000,
      synced: { question: false, answer: false }
    } as const

    const room = { ...snapshot, localTurns: [failed] }
    // While it is news, the reaction says when it ends, so a surface can stop it on time.
    expect(petWorkChangesAt(room, 1_000)).toBe(1_000 + PET_FAILED_MS)
    expect(petWorkFor(room, 1_000 + PET_FAILED_MS - 1)).toBe('failed')
    expect(petWorkFor(room, 1_000 + PET_FAILED_MS)).toBe('idle')
    expect(petWorkChangesAt(room, 1_000 + PET_FAILED_MS)).toBeNull()
    // A day-old failure (kept for the chat's retry) and one whose time is unknown are history.
    expect(petWorkFor(room, 1_000 + 24 * 60 * 60_000)).toBe('idle')
    const { failedAt: _unknown, ...undated } = failed
    expect(petWorkFor({ ...snapshot, localTurns: [undated] }, 1_500)).toBe('idle')
    // Real work still shows for as long as it runs.
    expect(petWorkFor({ ...room, localTurns: [{ ...failed, turnId: 'next', createdAt: 20, state: 'running' }] }, 9e9)).toBe(
      'working'
    )
  })
})
