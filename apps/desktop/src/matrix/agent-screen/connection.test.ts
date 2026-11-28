import { describe, expect, it } from 'vitest'

import {
  AGENT_SCREEN_INITIAL,
  agentScreenInputEnabled,
  agentScreenPhase,
  agentScreenReduce
} from './connection'

const agent = { running: true, holder: 'agent' as const, controlRevision: 0, viewerHasControl: false }
const control = { running: true, holder: 'human' as const, controlRevision: 1, viewerHasControl: true }

function minted(mode: 'watch' | 'control', status = mode === 'watch' ? agent : control) {
  const attaching = agentScreenReduce(AGENT_SCREEN_INITIAL, { type: 'attach', manual: false })

  return agentScreenReduce(attaching, { type: 'minted', sessionId: 'session', mode, status, at: 10 })
}

describe('screen connection', () => {
  it('gates input on both the controller lease and the live control stream', () => {
    const opening = minted('control')
    expect(agentScreenInputEnabled(opening)).toBe(false)

    const live = agentScreenReduce(opening, { type: 'connected' })
    expect(agentScreenInputEnabled(live)).toBe(true)
    expect(agentScreenInputEnabled(agentScreenReduce(live, { type: 'hand_back' }))).toBe(false)
    expect(agentScreenInputEnabled(agentScreenReduce(minted('watch', control), { type: 'connected' }))).toBe(false)
  })

  it('keeps the session and confirmed lease on a dropped link while disabling input', () => {
    const live = agentScreenReduce(minted('control'), { type: 'connected' })
    const lost = agentScreenReduce(live, { type: 'disconnected', code: 1006, clean: false, at: 100 })
    expect(lost).toMatchObject({ sessionId: 'session', conn: 'error', status: control })
    expect(agentScreenInputEnabled(lost)).toBe(false)
  })

  it('returns to watch after eviction and stops a rapid reconnect loop', () => {
    let state = minted('control')
    for (let i = 0; i < 4; i++) {
      state = agentScreenReduce(state, { type: 'disconnected', code: 4000, clean: false, at: 100 + i })
      expect(agentScreenPhase(state)).toBe('other')
      expect(agentScreenInputEnabled(state)).toBe(false)
    }

    expect(state).toMatchObject({ sessionId: 'session', conn: 'error', problem: 'control_moved' })
  })

  it('accepts a fresh revision after the controller retires the old session', () => {
    const live = agentScreenReduce(minted('control'), { type: 'connected' })
    const reset = agentScreenReduce(live, { type: 'session_expired', status: agent })
    expect(reset).toMatchObject({ conn: 'idle', sessionId: undefined, status: agent })
    expect(agentScreenInputEnabled(reset)).toBe(false)
  })

  it('ignores status from an older control revision', () => {
    const live = agentScreenReduce(minted('control'), { type: 'connected' })
    expect(agentScreenReduce(live, { type: 'status', status: agent })).toBe(live)
  })
})
