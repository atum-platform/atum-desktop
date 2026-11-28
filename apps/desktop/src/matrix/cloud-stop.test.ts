import { describe, expect, it, vi } from 'vitest'

import type { MatrixLocalTurnView, MatrixMessage } from '../../shared/matrix'

import { executeMatrixStop, matrixCloudStopScheduled, matrixCloudStopTarget, matrixShowCloudStop, matrixStopRoute } from './cloud-stop'

const ROOM = '!assistant:test'
const TURN = '00000000-0000-4000-8000-31f949766961'

function message(overrides: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    id: '$owner',
    sender: '@owner:test',
    body: 'Are you there?',
    timestamp: 1,
    own: true,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...overrides
  }
}

function turn(overrides: Partial<MatrixLocalTurnView> = {}): MatrixLocalTurnView {
  return {
    turnId: TURN,
    roomId: ROOM,
    text: 'Are you there?',
    createdAt: 1,
    state: 'handed_off',
    route: 'cloud',
    synced: { question: true, answer: false },
    ...overrides
  }
}

describe('the event a cloud Stop names', () => {
  it('names no event while the cloud is not working', () => {
    expect(
      matrixCloudStopTarget({
        messages: [message()],
        roomId: ROOM,
        unanswered: message(),
        working: false
      })
    ).toBeUndefined()
  })

  it("finds this Mac's cloud question through its turn marker", () => {
    expect(
      matrixCloudStopTarget({
        messages: [
          message({ id: '$older' }),
          message({ id: '$question', turn: TURN, timestamp: 2 }),
          message({ id: '$later' })
        ],
        turns: [turn()],
        roomId: ROOM,
        unanswered: message({ id: `local-q-${TURN}` }),
        working: true
      })
    ).toBe('$question')
  })

  it('still names a quiet cloud turn while no answer has arrived', () => {
    expect(
      matrixCloudStopTarget({
        messages: [message({ id: '$question', turn: TURN })],
        turns: [turn({ notice: 'home_quiet' })],
        roomId: ROOM,
        unanswered: message({ id: `local-q-${TURN}` }),
        working: false
      })
    ).toBe('$question')
  })

  it('names nothing when the local question has not reached the room yet', () => {
    expect(
      matrixCloudStopTarget({
        messages: [message({ id: '$older' })],
        turns: [turn({ synced: { question: false, answer: false } })],
        roomId: ROOM,
        unanswered: message({ id: `local-q-${TURN}` }),
        working: true
      })
    ).toBeUndefined()
  })

  it('uses the confirmed cloud event while the timeline is still catching up', () => {
    const input = { messages: [], turns: [turn({ questionEventId: '$synced' })], roomId: ROOM, working: true }

    expect(matrixCloudStopTarget({ ...input, roomTimeline: true })).toBe('$synced')
    expect(matrixCloudStopTarget(input)).toBeUndefined()
  })

  it('targets the bound Hermes progress source ahead of a queued question', async () => {
    const agentId = '@agent:test'
    const progress = {
      profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: 'working', kind: 'heartbeat', revision: 1
    } as const
    const line = message({ id: '$working', sender: agentId, own: false, notice: true, progress, replyTo: '$active' })
    const queued = message({ id: '$queued' })
    const input = { messages: [line, queued], agentId, roomId: ROOM, unanswered: queued, working: true }
    const route = matrixStopRoute({ runtime: 'hermes', working: true, eventId: matrixCloudStopTarget(input) })
    const stop = vi.fn(async () => ({ state: 'stopped' as const }))

    await expect(executeMatrixStop(route, ROOM, stop)).resolves.toBe('stopped')
    expect(stop).toHaveBeenCalledWith({ action: 'stopTurn', roomId: ROOM, eventId: '$active' })
    expect(matrixCloudStopTarget({ ...input, agentId: '@other:test' })).toBe('$queued')
    expect(matrixCloudStopTarget({ ...input, messages: [{ ...line, redacted: true }, queued] })).toBe('$queued')
  })

  it('names the oldest owner message still waiting when another device asked', () => {
    expect(
      matrixCloudStopTarget({
        messages: [message({ id: '$older' }), message({ id: '$asked', timestamp: 2 }), message({ id: '$newest', timestamp: 3 })],
        roomId: ROOM,
        unanswered: message({ id: '$asked', timestamp: 2 }),
        working: true
      })
    ).toBe('$asked')
  })

  it('never names a synthetic local id as a room event', () => {
    expect(
      matrixCloudStopTarget({
        messages: [],
        roomId: ROOM,
        unanswered: message({ id: `local-q-${TURN}` }),
        working: true
      })
    ).toBeUndefined()
  })

  it('ignores a cloud turn that already has its answer', () => {
    expect(
      matrixCloudStopTarget({
        messages: [message({ id: '$question', turn: TURN })],
        turns: [turn({ synced: { question: true, answer: true } })],
        roomId: ROOM,
        unanswered: null,
        working: true
      })
    ).toBeUndefined()
  })

  it('stops the running cloud turn, not a queued question behind it', () => {
    expect(
      matrixCloudStopTarget({
        messages: [message({ id: '$running', turn: TURN }), message({ id: '$queued', turn: 'other' })],
        turns: [turn(), turn({ turnId: 'other', synced: { question: true, answer: false } })],
        roomId: ROOM,
        unanswered: message({ id: '$running', turn: TURN }),
        working: true
      })
    ).toBe('$running')
  })

  it('picks the turn whose question is the one still waiting, whatever order the turns arrive in', () => {
    expect(
      matrixCloudStopTarget({
        messages: [
          message({ id: '$queued', turn: 'other', timestamp: 3 }),
          message({ id: '$running', turn: TURN, timestamp: 2 })
        ],
        turns: [
          turn({ turnId: 'other', createdAt: 3, synced: { question: true, answer: false } }),
          turn({ createdAt: 2 })
        ],
        roomId: ROOM,
        unanswered: message({ id: '$running', turn: TURN, timestamp: 2 }),
        working: true
      })
    ).toBe('$running')
  })

  it("names the oldest working turn when the waiting question is another device's", () => {
    expect(
      matrixCloudStopTarget({
        messages: [
          message({ id: '$newer', turn: 'other', timestamp: 3 }),
          message({ id: '$older', turn: TURN, timestamp: 2 })
        ],
        turns: [
          turn({ turnId: 'other', createdAt: 3, synced: { question: true, answer: false } }),
          turn({ createdAt: 1 })
        ],
        roomId: ROOM,
        unanswered: message({ id: '$from-phone', timestamp: 0.5 }),
        working: true
      })
    ).toBe('$older')
  })
})

// Both cloud generations share the composer, but only an explicit runtime advertisement opts in.
describe('Stop routing', () => {
  it('keeps unresolved legacy Stop hidden, but shows disabled unresolved Hermes Stop', () => {
    expect(matrixShowCloudStop({ cloud: true, working: true })).toBe(false)
    expect(matrixShowCloudStop({ cloud: true, runtime: 'hermes', working: true })).toBe(true)
    expect(matrixShowCloudStop({ cloud: true, runtime: 'hermes', working: false })).toBe(false)
    expect(matrixShowCloudStop({ cloud: false, runtime: 'hermes', working: true })).toBe(false)
    expect(matrixShowCloudStop({ cloud: true, working: false, eventId: '$owner' })).toBe(true)
  })
  it('preserves the old route when the capability is absent', () => {
    expect(matrixStopRoute({ eventId: '$owner', working: true })).toEqual({ kind: 'legacy', eventId: '$owner' })
  })
  it('uses host Stop for a new-runtime owner source', () => {
    expect(matrixStopRoute({ runtime: 'hermes', eventId: '$owner', working: true })).toEqual({ kind: 'host', eventId: '$owner' })
  })
  it('uses the exact schedule source even with an older owner question', async () => {
    const schedule = { job: 'job', execution: 'fire' }
    const stop = vi.fn(async () => ({ state: 'stopped' as const }))
    const route = matrixStopRoute({ runtime: 'hermes', working: true, scheduled: { schedule }, eventId: '$older-owner' })
    await expect(executeMatrixStop(route, '!room:test', stop)).resolves.toBe('stopped')
    expect(stop).toHaveBeenCalledWith({ action: 'stopSchedule', roomId: '!room:test', schedule })
  })
  it('never redirects a schedule without exact IDs to the older manual turn', () => {
    expect(matrixStopRoute({ runtime: 'hermes', working: true, scheduled: {}, eventId: '$older-owner' }).kind).toBe('unavailable')
  })
  it('calls a manual turn stopped only when the agent confirmed it', async () => {
    const route = matrixStopRoute({ runtime: 'hermes', eventId: '$owner', working: true })
    await expect(executeMatrixStop(route, '!room:test', async () => ({ state: 'stopped' }))).resolves.toBe('stopped')
    await expect(executeMatrixStop(route, '!room:test', async () => ({ state: 'completed' }))).resolves.toBe('stopped')
    await expect(executeMatrixStop(route, '!room:test', async () => ({ state: 'stop_requested' }))).resolves.toBe('stopping')
  })
  it('passes a failed Stop through as a failure', async () => {
    const route = matrixStopRoute({ runtime: 'hermes', eventId: '$owner', working: true })
    await expect(executeMatrixStop(route, '!room:test', async () => {
      throw new Error('matrix_host_stop_refused')
    })).rejects.toThrow('matrix_host_stop_refused')
  })
  it('disables unresolved owner messages and idle turns', () => {
    expect(matrixStopRoute({ runtime: 'hermes', working: true }).kind).toBe('unavailable')
    expect(matrixStopRoute({ runtime: 'hermes', working: false }).kind).toBe('unavailable')
    expect(matrixStopRoute({ runtime: 'hermes', working: true }).kind).toBe('unavailable')
  })
})

it('only reads the native tuple from the bound agent’s current cron progress', () => {
  const schedule = { job: 'same-job', execution: 'fire-b' }
  const progress = { profile: 'atum.agent-turns/1.3' as const, scope: 'owner_private' as const, phase: 'working' as const, kind: 'heartbeat' as const, revision: 1, trigger: 'cron' as const, schedule }
  const cron = message({ id: '$second', sender: '@agent:test', own: false, notice: true, progress })
  const older = message({ ...cron, id: '$first', progress: { ...progress, schedule: { ...schedule, execution: 'fire-a' } } })
  const unidentified = message({ ...cron, progress: { ...progress, schedule: undefined } })

  expect(matrixCloudStopScheduled([older, cron], '@agent:test')).toEqual({ schedule })
  expect(matrixCloudStopScheduled([older, unidentified], '@agent:test')?.schedule).toBeUndefined()
  expect(matrixCloudStopScheduled([cron], '@foreign:test')).toBeUndefined()
  const answer = message({ sender: '@agent:test', own: false, body: 'Other run finished' })
  expect(matrixCloudStopScheduled([cron, answer], '@agent:test')).toEqual({ schedule })
  expect(matrixCloudStopScheduled([older, { ...cron, redacted: true }, answer], '@agent:test'))
    .toEqual({ schedule: { ...schedule, execution: 'fire-a' } })
  expect(matrixCloudStopScheduled([message({ ...cron, progress: { ...progress, phase: 'settled' } })], '@agent:test')).toBeUndefined()
})
