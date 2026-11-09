import { describe, expect, it, vi } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixAliasBridge, MatrixAliasResult } from '../../shared/matrix-aliases'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import {
  assistantPersona,
  directRoomWith,
  groupConversations,
  knownPeople,
  lookupPerson,
  matchesName,
  mergePeople,
  parsePersonQuery
} from './people'

const ME = '@me:test'

const dm = (
  id: string,
  other: string,
  name: string,
  lastActiveAt: number,
  extra: Partial<MatrixRoom> = {}
): MatrixRoom => ({
  id,
  name,
  membership: 'join',
  encrypted: true,
  direct: true,
  lastActiveAt,
  participants: [
    { userId: ME, membership: 'join' },
    { userId: other, membership: 'join' }
  ],
  ...extra
})

const snapshot = (rooms: MatrixRoom[], extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot => ({
  state: 'ready',
  identity: { userId: ME, deviceId: 'D' },
  assistant: { userId: '@atum:test', deviceId: 'A' },
  agents: [
    { principal: 'atum', userId: '@atum:test', isDefault: true, ready: true, hermes: 'ready', atumModel: true },
    { principal: 'bea', userId: '@bea:test', isDefault: false, ready: true, hermes: 'ready', atumModel: true }
  ],
  appParticipants: [{ appId: 'river', userId: '@river:test', ready: true }],
  rooms,
  roomId: null,
  messages: [],
  error: null,
  ...extra
})

describe('person queries', () => {
  it.each([
    ['', { kind: 'empty' }],
    ['   ', { kind: 'empty' }],
    ['@Lan', { kind: 'handle', handle: 'lan', text: '@Lan' }],
    [' lan_99 ', { kind: 'handle', handle: 'lan_99', text: 'lan_99' }],
    ['Linh Nguyen', { kind: 'text', text: 'Linh Nguyen' }],
    ['ab', { kind: 'text', text: 'ab' }],
    ['@lan:', { kind: 'text', text: '@lan:' }],
    ['@user-0a1b:example.invalid', { kind: 'matrixId', userId: '@user-0a1b:example.invalid' }]
  ])('reads %j as a person query', (raw, expected) => {
    expect(parsePersonQuery(raw)).toEqual(expected)
  })
})

describe('people the owner already talks to', () => {
  const rooms = [
    dm('!linh-old:test', '@linh:test', 'Linh', 10),
    dm('!linh:test', '@linh:test', 'Linh', 30),
    dm('!quan:test', '@quan:test', 'Quân', 20),
    dm('!unnamed:test', '@ghost:test', '  ', 40),
    dm('!bea:test', '@bea:test', 'Bea', 50),
    dm('!river:test', '@river:test', 'River', 60),
    dm('!assistant:test', '@atum:test', 'Atum', 70, { roomType: MATRIX_ASSISTANT_ROOM_TYPE, assistant: true }),
    dm('!invite:test', '@hoa:test', 'Hoa', 80, { membership: 'invite' }),
    dm('!plain:test', '@lan:test', 'Lan', 90, { encrypted: false }),
    {
      id: '!group:test',
      name: 'Design team',
      membership: 'join',
      encrypted: true,
      lastActiveAt: 100,
      participants: [
        { userId: ME, membership: 'join' },
        { userId: '@linh:test', membership: 'join' },
        { userId: '@tam:test', membership: 'join' }
      ]
    }
  ]

  it('lists named one-on-one partners once, newest first, never assistants, apps or addresses', () => {
    expect(knownPeople(snapshot(rooms))).toEqual([
      // A plain chat (every one-on-one chat 0.20 makes) counts like an encrypted one.
      { userId: '@lan:test', name: 'Lan', roomId: '!plain:test', lastActiveAt: 90 },
      { userId: '@linh:test', name: 'Linh', roomId: '!linh:test', lastActiveAt: 30 },
      { userId: '@quan:test', name: 'Quân', roomId: '!quan:test', lastActiveAt: 20 }
    ])
  })

  it('reuses the newest direct conversation with a person, and has none for a group-only contact', () => {
    expect(directRoomWith(snapshot(rooms), '@linh:test')?.id).toBe('!linh:test')
    expect(directRoomWith(snapshot(rooms), '@tam:test')).toBeUndefined()
    expect(directRoomWith(snapshot(rooms, { identity: null }), '@linh:test')).toBeUndefined()
  })

  it('lists joined named groups, not private conversations or invitations', () => {
    expect(groupConversations(snapshot(rooms)).map(room => room.id)).toEqual(['!group:test'])
  })

  it('lists a group your assistants are in, as main now projects it (never as the assistant’s chat)', () => {
    const withAssistants: MatrixRoom = {
      id: '!trip:test',
      name: 'Trip',
      membership: 'join',
      encrypted: true,
      lastActiveAt: 110,
      assistant: false,
      participants: [
        { userId: ME, membership: 'join' },
        { userId: '@atum:test', membership: 'join' },
        { userId: '@bea:test', membership: 'join' },
        { userId: '@linh:test', membership: 'join' }
      ]
    }

    expect(groupConversations(snapshot([...rooms, withAssistants])).map(room => room.id)).toEqual([
      '!trip:test',
      '!group:test'
    ])
  })

  it('matches what is shown, ignoring accents, case and a leading @', () => {
    expect(matchesName('Quân', 'quan')).toBe(true)
    expect(matchesName('Quân', '@QUA')).toBe(true)
    expect(matchesName('Linh', 'lan')).toBe(false)
    expect(matchesName('@lan', 'lan', 'lan')).toBe(true)
    expect(matchesName('Linh', '')).toBe(true)
  })
})

describe('finding someone new by @name', () => {
  const bridge = (result: MatrixAliasResult | Error): MatrixAliasBridge => ({
    pending: vi.fn(),
    request: vi.fn(async () => {
      if (result instanceof Error) {
        throw result
      }

      return result
    })
  })

  it('asks the directory for exactly the handle, and reports who holds it', async () => {
    const human = bridge({
      ok: true,
      value: { kind: 'lookup', handle: 'lan', state: 'assigned', principalKind: 'human', matrixUser: '@user-1:test' }
    })

    await expect(lookupPerson(human, 'lan')).resolves.toEqual({
      state: 'found',
      handle: 'lan',
      holder: 'person',
      userId: '@user-1:test'
    })
    expect(human.request).toHaveBeenCalledExactlyOnceWith({ action: 'lookup', handle: 'lan' })

    await expect(
      lookupPerson(
        bridge({
          ok: true,
          value: { kind: 'lookup', handle: 'lan', state: 'assigned', principalKind: 'human', matrixUser: null }
        }),
        'lan'
      )
    ).resolves.toMatchObject({ state: 'found', userId: null })
    await expect(
      lookupPerson(
        bridge({
          ok: true,
          value: {
            kind: 'lookup',
            handle: 'spa_bot',
            state: 'assigned',
            principalKind: 'agent',
            matrixUser: '@agent-1:test'
          }
        }),
        'spa_bot'
      )
    ).resolves.toMatchObject({ holder: 'assistant' })
    await expect(
      lookupPerson(
        bridge({
          ok: true,
          value: { kind: 'lookup', handle: 'moon', state: 'assigned', principalKind: 'app', matrixUser: '@app-1:test' }
        }),
        'moon'
      )
    ).resolves.toMatchObject({ holder: 'app' })
  })

  it.each([
    [
      { ok: true, value: { kind: 'lookup', handle: 'lan', state: 'available' } },
      { state: 'missing', handle: 'lan' }
    ],
    [
      { ok: true, value: { kind: 'lookup', handle: 'lan', state: 'unavailable' } },
      { state: 'missing', handle: 'lan' }
    ],
    [
      { ok: true, value: { kind: 'lookup', handle: null, state: 'invalid' } },
      { state: 'missing', handle: 'lan' }
    ],
    [
      { ok: false, error: 'invalid' },
      { state: 'missing', handle: 'lan' }
    ],
    [
      { ok: false, error: 'limit', retryAfterSeconds: 30 },
      { state: 'failed', reason: 'limit', retryAfterSeconds: 30 }
    ],
    [
      { ok: false, error: 'authentication' },
      { state: 'failed', reason: 'signedOut' }
    ],
    [
      { ok: false, error: 'denied' },
      { state: 'failed', reason: 'unavailable' }
    ],
    [
      { ok: true, value: { kind: 'current', alias: null } },
      { state: 'failed', reason: 'unavailable' }
    ],
    [new Error('bridge gone'), { state: 'failed', reason: 'unavailable' }]
  ] as const)('gives a plain state for every other answer (%#)', async (answer, expected) => {
    await expect(lookupPerson(bridge(answer as MatrixAliasResult | Error), 'lan')).resolves.toEqual(expected)
  })

  it('reports an unavailable search when the build has no alias bridge', async () => {
    await expect(lookupPerson(undefined, 'lan')).resolves.toEqual({ state: 'failed', reason: 'unavailable' })
  })
})

describe('merged people search', () => {
  it('keeps known conversation data, adds new directory people and deduplicates by Matrix identity', () => {
    const known = [{ userId: '@nguyen:test', name: 'Nguyễn', roomId: '!dm:test' }]
    expect(mergePeople(known, [
      { userId: '@nguyen:test', name: 'Directory name' },
      { userId: '@linh:test', name: 'Linh' }
    ])).toEqual([
      { userId: '@nguyen:test', name: 'Nguyễn', roomId: '!dm:test' },
      { userId: '@linh:test', name: 'Linh' }
    ])
  })
})

describe('a new assistant’s persona', () => {
  it('is empty when nothing is answered, so Atum’s default stays', () => {
    expect(assistantPersona('Bea', '  ', '')).toBe('')
  })

  it('writes who they are and what they do under the name', () => {
    expect(assistantPersona(' Bea ', ' Warm and brief. ', '')).toBe('# Bea\n\n## Who you are\n\nWarm and brief.')
    expect(assistantPersona('Bea', '', 'Keeps my calendar.')).toBe('# Bea\n\n## What you do\n\nKeeps my calendar.')
    expect(assistantPersona('Bea', 'Warm.', 'Keeps my calendar.')).toBe(
      '# Bea\n\n## Who you are\n\nWarm.\n\n## What you do\n\nKeeps my calendar.'
    )
  })
})
