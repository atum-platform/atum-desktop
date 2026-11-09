import { describe, expect, it } from 'vitest'

import type { MatrixLocalTurnView, MatrixMessage } from '../../shared/matrix'

import { matrixCloudStopTarget } from './cloud-stop'

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
