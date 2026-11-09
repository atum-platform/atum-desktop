import { describe, expect, it } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../../shared/matrix-assistant-room'

import { createPetIntentIntake, type PetIntakeInput } from './intake'
import { createPetLiveEvents } from './live-events'

function input(): PetIntakeInput {
  return {
    now: 100_000,
    shown: true,
    reducedMotion: false,
    room: {
      id: '!private:test',
      name: 'Agent',
      membership: 'join',
      encrypted: true,
      assistant: true,
      direct: true,
      agentPrincipal: '@agent:test'
    },
    message: {
      id: '$reply',
      sender: '@agent:test',
      body: 'Hello',
      timestamp: 100_000,
      own: false,
      encrypted: true,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      petIntents: { commands: [{ action: 'go', place: 'left' }, { action: 'wave' }], live: true }
    }
  }
}

describe('private agent intent intake', () => {
  it('feeds the exact ordered data-only list once and rate limits new replies', () => {
    const intake = createPetIntentIntake()
    const next = input()
    expect(intake.accept(next)).toEqual(next.message.petIntents?.commands)
    expect(intake.accept(next)).toBeUndefined()
    next.message = { ...next.message, id: '$next' }
    expect(intake.accept(next)).toBeUndefined()
    next.now += 20_000
    next.message = { ...next.message, id: '$later', timestamp: next.now }
    expect(intake.accept(next)).toEqual(next.message.petIntents?.commands)
  })

  it.each(['own', 'pending', 'failed', 'redacted', 'edited', 'notice', 'attachment', 'decryptionFailed'] as const)(
    'ignores %s events',
    flag => {
      const next = input()
      next.message[flag] = true
      expect(createPetIntentIntake().accept(next)).toBeUndefined()
    }
  )

  it.each([
    'encryption',
    'sender',
    'history',
    'id',
    'old',
    'future',
    'malformed',
    'hidden',
    'motion',
    'group',
    'app',
    'unjoined',
    'not-agent'
  ])('rejects %s without delaying a valid text message', condition => {
    const next = input()

    switch (condition) {
      case 'encryption':
        next.message.encrypted = false

        break

      case 'sender':
        next.message.sender = '@other:test'

        break

      case 'history':
        next.message.petIntents!.live = false

        break

      case 'id':
        next.message.id = 'local'

        break

      case 'old':
        next.message.timestamp = next.now - 60_001

        break

      case 'future':
        next.message.timestamp = next.now + 30_001

        break

      case 'malformed':
        next.message.petIntents!.commands = JSON.parse('[{"action":"go"}]')

        break

      case 'hidden':
        next.shown = false

        break

      case 'motion':
        next.reducedMotion = true

        break

      case 'group':
        next.room.direct = false

        break

      case 'app':
        next.room.appGroup = { owner: '@owner:test', app: 'moon' }

        break

      case 'unjoined':
        next.room.membership = 'leave'

        break

      case 'not-agent':
        next.room.assistant = false

        break
    }

    expect(createPetIntentIntake().accept(next)).toBeUndefined()
    expect(next.message.body).toBe('Hello')
  })

  // 0.20: agent chats are plain rooms; their replies arrive plain.
  it('feeds a plain reply in a plain agent chat, never one in a plain room that is no agent chat', () => {
    const plain = input()
    plain.room = { ...plain.room, encrypted: false, plainAgent: true, roomType: MATRIX_ASSISTANT_ROOM_TYPE }
    plain.message.encrypted = false
    expect(createPetIntentIntake().accept(plain)).toEqual(plain.message.petIntents?.commands)
    const other = input()
    other.room = { ...other.room, encrypted: false }
    other.message.encrypted = false
    expect(createPetIntentIntake().accept(other)).toBeUndefined()
  })

  it('feeds an encrypted reply in a typed agent chat, and refuses plaintext there and any other room type', () => {
    const typed = input()
    typed.room = { ...typed.room, roomType: MATRIX_ASSISTANT_ROOM_TYPE }
    expect(createPetIntentIntake().accept(typed)).toEqual(typed.message.petIntents?.commands)
    const downgraded = input()
    downgraded.room = { ...downgraded.room, roomType: MATRIX_ASSISTANT_ROOM_TYPE }
    downgraded.message.encrypted = false
    expect(createPetIntentIntake().accept(downgraded)).toBeUndefined()
    const foreign = input()
    foreign.room = { ...foreign.room, encrypted: false, plainAgent: true, roomType: 'io.atum.company_project' }
    foreign.message.encrypted = false
    expect(createPetIntentIntake().accept(foreign)).toBeUndefined()
  })

  it('admits exact age/skew bounds, keeping each account/agent independent', () => {
    const left = input()
    left.message.timestamp -= 60_000
    expect(createPetIntentIntake().accept(left)).toBeDefined()
    const right = input()
    right.message.timestamp += 30_000
    expect(createPetIntentIntake().accept(right)).toBeDefined()
  })

  it('retains only500 applied ids without retaining message text', () => {
    const intake = createPetIntentIntake()
    const next = input()

    for (let index = 0; index < 501; index++) {
      next.now = 100_000 + index * 20_000
      next.message = { ...next.message, id: `$${index}`, timestamp: next.now }
      expect(intake.accept(next)).toBeDefined()
    }

    next.now += 20_000
    next.message = { ...next.message, id: '$0', timestamp: next.now }
    expect(intake.accept(next)).toBeDefined()
  })
})

it('SDK live provenance excludes backfill, removed events and other rooms, and retires on selection', () => {
  const tracker = createPetLiveEvents<object>()

  const live = {},
    history = {},
    removed = {},
    foreign = {}

  tracker.observed(live, '!a', false, false, true)
  expect(tracker.has(live, '!a')).toBe(false)
  tracker.loaded('!a')
  tracker.observed(live, '!a', false, false, true)
  tracker.observed(history, '!a', true, false, true)
  tracker.observed(removed, '!a', false, true, true)
  tracker.observed(foreign, '!b', false, false, true)
  expect(tracker.has(live, '!a')).toBe(true)
  expect([history, removed, foreign].map(event => tracker.has(event, '!a'))).toEqual([false, false, false])
  tracker.loaded('!b')
  tracker.loaded('!a')
  expect(tracker.has(live, '!a')).toBe(false)
})
