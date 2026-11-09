import { describe, expect, it } from 'vitest'

import type { ConversationWrite, MigrationInput } from '../../../shared/agent-conversation/types'

import {
  type ConversationMigrationJournal,
  type ConversationMigrationPorts,
  executeConversationMigration,
  parseConversationMigrationJournal,
  retryConversationMigration
} from './migrate'

const rooms = ['!a:test', '!b:test', '!c:test']
const input: MigrationInput = {
  rooms,
  chosen: rooms[1],
  ownerConfirmed: true,
  noLiveTurn: true,
  cloudMayAnswer: false,
  cloudReady: false,
  fleetReady: true,
  writable: rooms
}

function fixture() {
  let journal: ConversationMigrationJournal | null = null
  const writes: ConversationWrite[] = []
  let fail = ''
  let clearingFails = false
  let effectsFail = false
  let ready = true
  const gate = { cloudMayAnswer: false, cloudReady: false, fleetReady: true }
  let finished = 0
  const ports: ConversationMigrationPorts = {
    ready: () => ready,
    gate: () => gate,
    readJournal: () => journal,
    saveJournal: value => {
      journal = value ? JSON.parse(JSON.stringify(value)) : null
    },
    write: async write => {
      writes.push(write)
      if (
        (write.roomId === fail && Object.keys(write.content).length) ||
        (clearingFails && !Object.keys(write.content).length)
      ) {
        throw new Error('M_FORBIDDEN')
      }
    },
    finish: async (main, candidates) => {
      expect(main).toBe(rooms[1])
      expect(candidates).toEqual(rooms)
      if (effectsFail) {
        throw new Error('jobs unavailable')
      }
      finished++
    }
  }
  return {
    ports,
    writes,
    gate,
    journal: () => journal,
    finished: () => finished,
    fail: (room: string) => {
      fail = room
    },
    clearFailure: (value: boolean) => {
      clearingFails = value
    },
    effectsFailure: (value: boolean) => {
      effectsFail = value
    },
    ready: (value: boolean) => {
      ready = value
    }
  }
}

describe('owner-confirmed migration transaction', () => {
  it.each([
    ['owner_confirmation', { ownerConfirmed: false }],
    ['turn_live', { noLiveTurn: false }],
    ['chosen_not_writable', { writable: [rooms[0]] }]
  ] as Array<[string, Partial<MigrationInput>]>)('does not write when %s fails', async (reason, change) => {
    const f = fixture()
    expect(await executeConversationMigration({ ...input, ...change }, 100, f.ports)).toEqual({
      status: 'blocked',
      reason
    })
    expect(f.writes).toEqual([])
    expect(f.journal()).toBeNull()
  })
  it.each(['cloud_not_ready', 'fleet_not_ready'])('does not write behind %s', async reason => {
    const f = fixture()
    if (reason === 'cloud_not_ready') {
      f.gate.cloudMayAnswer = true
    } else {
      f.gate.fleetReady = false
    }
    expect(await executeConversationMigration(input, 100, f.ports)).toEqual({ status: 'blocked', reason })
    expect(f.writes).toEqual([])
  })
  it('writes main first, Earlier in stable order, then finishes jobs/home once', async () => {
    const f = fixture()
    expect(await executeConversationMigration(input, 100, f.ports)).toEqual({ status: 'applied', main: rooms[1] })
    expect(f.writes.map(write => write.roomId)).toEqual([rooms[1], rooms[0], rooms[2]])
    expect(f.finished()).toBe(1)
    expect(f.journal()).toBeNull()
  })
  it('clears every attempted write, including a possibly committed failed response', async () => {
    const f = fixture()
    f.fail(rooms[0])
    expect(await executeConversationMigration(input, 100, f.ports)).toEqual({ status: 'rolled_back', count: 2 })
    expect(f.writes.slice(2)).toEqual([
      { roomId: rooms[0], content: {} },
      { roomId: rooms[1], content: {} }
    ])
    expect(f.finished()).toBe(0)
    expect(f.journal()).toBeNull()
    f.fail('')
    expect((await executeConversationMigration(input, 101, f.ports)).status).toBe('applied')
  })
  it('retains incomplete rollback through restart and allows only retry', async () => {
    const f = fixture()
    f.fail(rooms[0])
    f.clearFailure(true)
    expect((await executeConversationMigration(input, 100, f.ports)).status).toBe('rollback_pending')
    const saved = JSON.stringify(f.journal())
    expect(parseConversationMigrationJournal(saved)?.phase).toBe('rollback')
    expect((await executeConversationMigration(input, 101, f.ports)).status).toBe('blocked')
    f.clearFailure(false)
    f.gate.cloudMayAnswer = true
    expect((await retryConversationMigration(f.ports)).status).toBe('rolled_back')
    expect(f.journal()).toBeNull()
  })
  it('retains job/restart effects until they finish and does not rewrite markers on retry', async () => {
    const f = fixture()
    f.effectsFailure(true)
    expect((await executeConversationMigration(input, 100, f.ports)).status).toBe('effects_pending')
    expect(f.journal()?.phase).toBe('effects')
    f.effectsFailure(false)
    expect((await retryConversationMigration(f.ports)).status).toBe('applied')
    expect(f.writes).toHaveLength(3)
    expect(f.finished()).toBe(1)
  })
  it('leaves unwritable/unreachable rooms unmarked and retains a valid recovery journal', async () => {
    const f = fixture()
    f.effectsFailure(true)
    await executeConversationMigration({ ...input, writable: [rooms[1]] }, 100, f.ports)
    expect(f.writes.map(write => write.roomId)).toEqual([rooms[1]])
    expect(parseConversationMigrationJournal(JSON.stringify(f.journal()))).not.toBeNull()
  })
  it('rejects malformed persisted markers and pointers', () => {
    expect(parseConversationMigrationJournal('{')).toBeNull()
    expect(
      parseConversationMigrationJournal(
        JSON.stringify({ phase: 'forward', cursor: 0, main: '/file', rooms: [], writes: [] })
      )
    ).toBeNull()
  })
  it('rejects torn journals whose marker pointers or phases cannot arise from the migration state machine', () => {
    const main = rooms[1]
    const forward = {
      phase: 'forward',
      cursor: 1,
      main,
      rooms,
      writes: [
        { roomId: main, content: { v: 1, role: 'main', main, at: 100 } },
        { roomId: rooms[0], content: { v: 1, role: 'earlier', main, at: 100 } }
      ]
    }
    expect(parseConversationMigrationJournal(JSON.stringify(forward))).not.toBeNull()

    for (const malformed of [
      { ...forward, main: rooms[0] },
      {
        ...forward,
        writes: [forward.writes[0], { ...forward.writes[1], content: { ...forward.writes[1].content, main: rooms[2] } }]
      },
      { ...forward, writes: [{ ...forward.writes[0], content: { ...forward.writes[0].content, role: 'earlier' } }, forward.writes[1]] },
      { ...forward, rooms: [main] },
      { ...forward, writes: [forward.writes[0], forward.writes[0]] },
      { ...forward, phase: 'effects', cursor: 1 },
      { ...forward, phase: 'rollback', writes: [{ roomId: main, content: forward.writes[0].content }] },
      { ...forward, phase: 'rollback', writes: [{ roomId: rooms[0], content: {} }] }
    ]) {
      expect(parseConversationMigrationJournal(JSON.stringify(malformed))).toBeNull()
    }
  })
  it('keeps valid effects, rollback, and replacement journals recoverable', () => {
    const main = rooms[1]
    const replacementRooms = [rooms[0], main]
    const replacement = {
      phase: 'effects',
      cursor: 0,
      main,
      rooms: replacementRooms,
      writes: [{ roomId: main, content: { v: 1, role: 'main', main, at: 100 } }]
    }
    const rollback = {
      phase: 'rollback',
      cursor: 1,
      main,
      rooms,
      writes: [{ roomId: rooms[0], content: {} }, { roomId: main, content: {} }]
    }

    expect(parseConversationMigrationJournal(JSON.stringify(replacement))).toMatchObject(replacement)
    expect(parseConversationMigrationJournal(JSON.stringify(rollback))).toMatchObject(rollback)
  })
  it('does not resume a malformed persisted pointer into writes or effects', async () => {
    const f = fixture()
    const main = rooms[1]
    const raw = JSON.stringify({
      phase: 'effects',
      cursor: 0,
      main,
      rooms,
      writes: [{ roomId: rooms[0], content: { v: 1, role: 'main', main: rooms[0], at: 100 } }]
    })
    const ports = { ...f.ports, readJournal: () => parseConversationMigrationJournal(raw) }

    expect(await retryConversationMigration(ports)).toEqual({ status: 'blocked', reason: 'migration_pending' })
    expect(f.writes).toEqual([])
    expect(f.finished()).toBe(0)
  })
})
