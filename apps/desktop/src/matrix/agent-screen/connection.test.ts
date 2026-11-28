import { describe, expect, it } from 'vitest'

import {
  AGENT_SCREEN_CLOSE_CONTROL_TAKEN,
  AGENT_SCREEN_INITIAL,
  AGENT_SCREEN_MAX_RAPID_EVICTIONS,
  type AgentScreenEvent,
  agentScreenPhase,
  agentScreenReduce,
  type AgentScreenState
} from './connection'
import type { AgentScreenLease } from './transport'

const viewer = { id: 'viewer-1', hash: 'aaaaaaaaaaaa' }
const agentLease = (epoch: number): AgentScreenLease => ({ holder: 'agent', epoch, viewerHash: null })
const humanLease = (epoch: number, hash = viewer.hash): AgentScreenLease => ({ holder: 'human', epoch, viewerHash: hash })

function run(events: AgentScreenEvent[], from: AgentScreenState = AGENT_SCREEN_INITIAL): AgentScreenState {
  return events.reduce(agentScreenReduce, from)
}

/** A live watch attach: status, attach, minted viewer, frames. */
function watching(at = 0): AgentScreenState {
  return run([
    { type: 'status', status: { running: true, lease: agentLease(0) } },
    { type: 'attach', manual: false },
    { type: 'minted', viewer, status: { running: true, lease: agentLease(0) }, at },
    { type: 'connected' }
  ])
}

describe('agent screen connection', () => {
  it('goes watch → control → handing back → watch, in step with the server', () => {
    const watch = watching()
    expect(watch.conn).toBe('live')
    expect(agentScreenPhase(watch)).toBe('watch')

    // Asking is not holding: control shows only once the server granted the lease to this viewer.
    const asking = agentScreenReduce(watch, { type: 'take' })
    expect(agentScreenPhase(asking)).toBe('watch')

    const control = agentScreenReduce(asking, { type: 'lease', lease: humanLease(1) })
    expect(agentScreenPhase(control)).toBe('control')

    const handing = agentScreenReduce(control, { type: 'hand_back' })
    expect(agentScreenPhase(handing)).toBe('handing_back')

    const back = agentScreenReduce(handing, { type: 'handed_back', lease: agentLease(2) })
    expect(agentScreenPhase(back)).toBe('watch')
    expect(back.handingBack).toBe(false)
  })

  it('treats a human lease held by another viewer as someone else in control', () => {
    const other = agentScreenReduce(watching(), { type: 'lease', lease: humanLease(1, 'bbbbbbbbbbbb') })

    expect(agentScreenPhase(other)).toBe('other')
  })

  it('sends an evicted viewer back to watching on a fresh attach', () => {
    const control = agentScreenReduce(watching(), { type: 'lease', lease: humanLease(1) })

    const evicted = run(
      [
        { type: 'lease', lease: humanLease(2, 'bbbbbbbbbbbb') },
        { type: 'disconnected', code: AGENT_SCREEN_CLOSE_CONTROL_TAKEN, clean: false, at: 60_000 }
      ],
      control
    )

    // Idle is what re-attaches: watch mode, a fresh ticket, and the caption says why.
    expect(evicted.conn).toBe('idle')
    expect(evicted.evicted).toBe(true)
    expect(agentScreenPhase(evicted)).toBe('other')

    const rewatched = run(
      [
        { type: 'attach', manual: false },
        { type: 'minted', viewer, status: { running: true, lease: agentLease(3) }, at: 61_000 },
        { type: 'connected' }
      ],
      evicted
    )

    expect(rewatched.conn).toBe('live')
    expect(rewatched.evicted).toBe(false)
    expect(agentScreenPhase(rewatched)).toBe('watch')
  })

  it('stops after a bridge evicts every fresh attach', () => {
    let state = watching(0)

    for (let attempt = 1; attempt <= AGENT_SCREEN_MAX_RAPID_EVICTIONS; attempt += 1) {
      state = run(
        [
          { type: 'disconnected', code: AGENT_SCREEN_CLOSE_CONTROL_TAKEN, clean: false, at: attempt * 100 },
          { type: 'attach', manual: false },
          { type: 'minted', viewer, status: { running: true, lease: agentLease(0) }, at: attempt * 100 + 50 }
        ],
        state
      )
      expect(state.conn).toBe('attaching')
    }

    state = agentScreenReduce(state, { type: 'disconnected', code: AGENT_SCREEN_CLOSE_CONTROL_TAKEN, clean: false, at: 1_000 })

    expect(state.conn).toBe('error')
    expect(state.problem).toBe('control_moved')
    // Reconnect by hand starts the budget again.
    expect(agentScreenReduce(state, { type: 'attach', manual: true }).rapidEvictions).toBe(0)
  })

  it('keeps the lease and the viewer when the stream drops', () => {
    const control = agentScreenReduce(watching(), { type: 'lease', lease: humanLease(1) })
    const dropped = agentScreenReduce(control, { type: 'disconnected', code: 1006, clean: false, at: 5_000 })

    expect(dropped.conn).toBe('error')
    expect(dropped.problem).toBe('stream_lost')
    // A dropped link is not a hand back: still this window's control, and the same viewer to re-present.
    expect(dropped.status?.lease).toEqual(humanLease(1))
    expect(dropped.viewer).toEqual(viewer)
    expect(agentScreenPhase(dropped)).toBe('control')

    const reattached = run(
      [
        { type: 'attach', manual: true },
        { type: 'minted', viewer, status: { running: true, lease: humanLease(1) }, at: 6_000 },
        { type: 'connected' }
      ],
      dropped
    )

    expect(agentScreenPhase(reattached)).toBe('control')
  })

  it('never repaints an older lease over a newer one', () => {
    const control = agentScreenReduce(watching(), { type: 'lease', lease: humanLease(4) })
    const stale = agentScreenReduce(control, { type: 'status', status: { running: true, lease: agentLease(3) } })

    expect(stale.status?.lease).toEqual(humanLease(4))
  })

  it('recovers from an unavailable screen when the server answers again', () => {
    const down = agentScreenReduce(watching(), { type: 'failed', problem: 'unavailable' })
    expect(down.conn).toBe('error')

    const up = agentScreenReduce(down, { type: 'status', status: { running: true, lease: agentLease(0) } })
    expect(up.problem).toBeNull()
    expect(up.conn).toBe('idle')
  })
})
