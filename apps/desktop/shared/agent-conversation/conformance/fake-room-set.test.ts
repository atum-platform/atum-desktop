import { describe, expect, it } from 'vitest'

import { EarlierConversationError } from '..'
import type { MigrationInput } from '../types'

import { CLOUD_AGENT_CONVERSATION_DEFAULT } from './cloud-agent-conversation'
import { FakeRoomSet } from './fake-room-set'

const main = '!main:conformance.test'
const earlier = '!earlier:conformance.test'
const stray = '!stray:conformance.test'
const raced = '!raced:conformance.test'

const migration = (chosen = main): MigrationInput => ({
  rooms: [main, earlier, stray],
  chosen,
  ownerConfirmed: true,
  noLiveTurn: true,
  cloudMayAnswer: false,
  cloudReady: false,
  fleetReady: true,
  writable: [main, earlier, stray]
})

function expectEarlierRefusal(read: () => unknown): void {
  try {
    read()
    throw new Error('expected Earlier conversation refusal')
  } catch (error) {
    expect(error).toBeInstanceOf(EarlierConversationError)
    expect(error).toMatchObject({ code: 'matrix_earlier_conversation', main })
  }
}

describe('agent-conversation fake room-set conformance', () => {
  // The 68 fixture scenarios in ../conformance.test.ts exhaust the pure core.
  // These cases add state transitions that only an adapter can exercise.
  it('keeps the cloud join flag off by default', () => {
    expect(CLOUD_AGENT_CONVERSATION_DEFAULT).toBe(false)
  })

  it('allows display reads but refuses only Earlier and stray turn admission', () => {
    const rooms = new FakeRoomSet([
      { roomId: main, marker: { role: 'main', main, at: 10 } },
      { roomId: earlier, marker: { role: 'earlier', main, at: 10 } },
      { roomId: stray }
    ])

    expect(rooms.display(earlier).roomId).toBe(earlier)
    expect(rooms.readForTurn(main).roomId).toBe(main)

    for (const roomId of [earlier, stray]) {
      expectEarlierRefusal(() => rooms.readForTurn(roomId))
    }
  })

  it('migrates main first, makes every other writable room Earlier, and admits only the main afterwards', () => {
    const rooms = new FakeRoomSet([{ roomId: main }, { roomId: earlier }, { roomId: stray }])

    expect(rooms.migrate(migration(), 20)).toMatchObject({ status: 'applied' })
    expect(rooms.writeLog.map(write => write.roomId)).toEqual([main, earlier, stray])
    expect(rooms.marker(main)).toEqual({ role: 'main', main, at: 20 })
    expect(rooms.marker(earlier)).toEqual({ role: 'earlier', main, at: 20 })
    expectEarlierRefusal(() => rooms.readForTurn(earlier))
  })

  it('rolls back only committed markers when M_FORBIDDEN rejects the selected write', () => {
    const rooms = new FakeRoomSet([{ roomId: main }, { roomId: earlier }, { roomId: stray }])

    expect(rooms.migrate(migration(), 20, 1)).toEqual({
      status: 'rolled_back',
      writes: [
        { roomId: main, content: { v: 1, role: 'main', main, at: 20 } },
        { roomId: main, content: {} }
      ]
    })
    expect(rooms.marker(main)).toBeNull()
    expect(rooms.marker(earlier)).toBeUndefined()
    expect(rooms.marker(stray)).toBeUndefined()
    expect(rooms.resolution()).toMatchObject({ source: 'legacy' })
    expect(rooms.resolution().main).toBeUndefined()
    expect(rooms.migrate(migration(), 21)).toMatchObject({ status: 'applied' })
    expect(rooms.resolution()).toMatchObject({ main, earlier: [earlier, stray], stray: [] })
  })

  it('does not write any marker for a cloud-answerable agent until its join flag is ready', () => {
    const rooms = new FakeRoomSet([{ roomId: main }, { roomId: earlier }, { roomId: stray }])

    expect(rooms.migrate({ ...migration(), cloudMayAnswer: true }, 20)).toEqual({ status: 'blocked', writes: [] })
    expect(rooms.writeLog).toEqual([])
    expect(rooms.migrate({ ...migration(), cloudMayAnswer: true, cloudReady: true }, 21)).toMatchObject({
      status: 'applied'
    })
  })

  it('leaves strays after a crash just after the main write, then sweeps them to Earlier', () => {
    const rooms = new FakeRoomSet([{ roomId: main }, { roomId: earlier }, { roomId: stray }])

    expect(rooms.crashAfterMain(migration(), 20)).toEqual({
      status: 'crashed',
      writes: [{ roomId: main, content: { v: 1, role: 'main', main, at: 20 } }]
    })
    expect(rooms.resolution()).toMatchObject({ main, stray: [earlier, stray] })
    expect(rooms.sweep(21)).toEqual([
      { roomId: earlier, content: { v: 1, role: 'earlier', main, at: 21 } },
      { roomId: stray, content: { v: 1, role: 'earlier', main, at: 21 } }
    ])
    expect(rooms.resolution()).toMatchObject({ main, earlier: [earlier, stray], stray: [] })
    expect(rooms.sweep(22)).toEqual([])
  })

  it('converges raced mains and a stray with Earlier-only sweep writes', () => {
    const rooms = new FakeRoomSet([
      { roomId: main, marker: { role: 'main', main, at: 10 } },
      { roomId: raced, marker: { role: 'main', main: raced, at: 20 } },
      { roomId: stray }
    ])

    const writes = rooms.sweep(30)
    expect(writes.map(write => [write.roomId, write.content.role])).toEqual([
      [main, 'earlier'],
      [stray, 'earlier']
    ])
    expect(rooms.resolution()).toMatchObject({ main: raced, earlier: [main, stray], stray: [] })
    expect(rooms.sweep(31)).toEqual([])
    expect(rooms.resolution()).toMatchObject({ main: raced, earlier: [main, stray], stray: [] })
  })

  it('records a static Earlier notice only after publish succeeds and suppresses clock rollback', () => {
    const rooms = new FakeRoomSet([
      { roomId: main, marker: { role: 'main', main, at: 10 } },
      { roomId: earlier, marker: { role: 'earlier', main, at: 10 } }
    ])

    expectEarlierRefusal(() => rooms.readForTurn(earlier))
    expect(rooms.earlierNoticeDue(earlier, '2026-10-08')).toBe(true)
    // A failed publish does not record the day, so it remains due.
    expect(rooms.earlierNoticeDue(earlier, '2026-10-08')).toBe(true)
    rooms.earlierNoticePublished(earlier, '2026-10-08')
    expect(rooms.earlierNoticeDue(earlier, '2026-10-08')).toBe(false)
    expect(rooms.earlierNoticeDue(earlier, '2026-10-07')).toBe(false)
    expect(rooms.earlierNoticeDue(earlier, '2026-10-09', false)).toBe(false)
    expect(rooms.earlierNoticeDue(earlier, '2026-10-09')).toBe(true)
  })
})
