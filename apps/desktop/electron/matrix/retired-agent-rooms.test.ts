import { describe, expect, it, type Mock, vi } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import type { MatrixAgentDefinitionRecord } from './agent-definition'
import {
  MatrixRetiredAgentRooms,
  matrixRetiredAgentRooms,
  matrixRetiredAgentUsers,
  RETIRED_AGENT_ROOMS_RETRY_MS
} from './retired-agent-rooms'

type Forget = (input: { roomId: string; ownerId: string; agentId: string }) => Promise<unknown>

const OWNER = '@owner:test'
const ALFRED = '@alfred:test'
const BEA = '@bea:test'
const FRIEND = '@friend:test'

const record = (principal: string, extra: Partial<MatrixAgentDefinitionRecord> = {}): MatrixAgentDefinitionRecord =>
  ({
    id: `${principal}-id`,
    principal,
    displayName: principal,
    isDefault: false,
    status: 'active',
    matrixUser: `@${principal}:test`,
    ...extra
  }) as MatrixAgentDefinitionRecord

const room = (id: string, members: Array<[string, string]>, extra: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id,
  name: id,
  membership: 'join',
  encrypted: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  participants: members.map(([userId, membership]) => ({ userId, membership })),
  ...extra
})

describe("which agents' chats leave the chat list", () => {
  it("takes the roster's tombstones and this Mac's retirements, never an active agent", () => {
    const roster = [
      record('atum', { isDefault: true }),
      record('alfred', { status: 'retired' }),
      record('old', { status: 'retired', matrixUser: undefined })
    ]

    expect(matrixRetiredAgentUsers({ roster, retiredHere: [BEA] })).toEqual([ALFRED, BEA])
    // A tombstone for a Matrix user an active agent answers as never touches that agent.
    expect(
      matrixRetiredAgentUsers({ roster: [...roster, record('alfred-again', { matrixUser: ALFRED })], retiredHere: [] })
    ).toEqual([])
    // The default agent cannot be retired: the roster's word on it stands.
    expect(matrixRetiredAgentUsers({ roster, retiredHere: ['@atum:test'] })).toEqual([ALFRED])
  })

  it('takes an agent retired here although the roster, read before, still lists it as active', () => {
    const roster = [record('atum', { isDefault: true }), record('bea')]

    expect(matrixRetiredAgentUsers({ roster, retiredHere: [BEA] })).toEqual([BEA])
    expect(matrixRetiredAgentUsers({ roster, retiredHere: [] })).toEqual([])
  })

  it("nominates only the owner's own chats with a retired agent, joined, whoever left", () => {
    const rooms = [
      room('!private', [
        [OWNER, 'join'],
        [ALFRED, 'join']
      ]),
      // The agent's account already left: still its chat, still nominated.
      room('!left', [
        [OWNER, 'join'],
        [ALFRED, 'leave']
      ]),
      // A plain direct chat with the agent.
      room(
        '!direct',
        [
          [OWNER, 'join'],
          [ALFRED, 'join']
        ],
        { roomType: undefined }
      ),
      // A group with a person in it, or a person who was: never.
      room('!group', [
        [OWNER, 'join'],
        [ALFRED, 'join'],
        [FRIEND, 'join']
      ]),
      room('!was-group', [
        [OWNER, 'join'],
        [ALFRED, 'join'],
        [FRIEND, 'leave']
      ]),
      // Another kind of room (an app's group, a company project): never.
      room(
        '!typed',
        [
          [OWNER, 'join'],
          [ALFRED, 'join']
        ],
        { roomType: 'io.atum.app-group' }
      ),
      // A live agent's chat, and a chat the owner is only invited to: never.
      room('!bea', [
        [OWNER, 'join'],
        [BEA, 'join']
      ]),
      room(
        '!invite',
        [
          [OWNER, 'invite'],
          [ALFRED, 'join']
        ],
        { membership: 'invite' }
      )
    ]

    expect(matrixRetiredAgentRooms({ rooms, ownerId: OWNER, retired: [ALFRED] })).toEqual([
      { roomId: '!private', agentId: ALFRED },
      { roomId: '!left', agentId: ALFRED },
      { roomId: '!direct', agentId: ALFRED }
    ])
    expect(
      matrixRetiredAgentRooms({ rooms, ownerId: OWNER, retired: [ALFRED], refused: new Set(['!private', '!left']) })
    ).toEqual([{ roomId: '!direct', agentId: ALFRED }])
    expect(matrixRetiredAgentRooms({ rooms, ownerId: OWNER, retired: [] })).toEqual([])
    expect(matrixRetiredAgentRooms({ rooms, ownerId: undefined, retired: [ALFRED] })).toEqual([])
    // The owner is never a retired agent: nothing at all is nominated.
    expect(matrixRetiredAgentRooms({ rooms, ownerId: OWNER, retired: [ALFRED, OWNER] })).toEqual([])
  })
})

describe('clearing the chats', () => {
  const alfredRoom = room('!alfred', [
    [OWNER, 'join'],
    [ALFRED, 'join']
  ])

  const beaRoom = room('!bea', [
    [OWNER, 'join'],
    [BEA, 'join']
  ])

  function harness(forget: Mock<Forget> = vi.fn<Forget>(async () => 'forgotten')) {
    let clock = 1_000
    const rooms = new MatrixRetiredAgentRooms({ forget, now: () => clock })

    return { rooms, forget, advance: (ms: number) => void (clock += ms) }
  }

  it('leaves and forgets the chats of an agent retired here at once, and only once', async () => {
    const { rooms, forget } = harness()
    // The roster main holds was read before the retirement: Alfred is still active in it.
    rooms.roster(OWNER, [record('atum', { isDefault: true }), record('alfred'), record('bea')])
    rooms.retired(OWNER, ALFRED)

    await rooms.sweep({ owner: OWNER, ready: true, rooms: [alfredRoom, beaRoom] })
    expect(forget).toHaveBeenCalledExactlyOnceWith({ roomId: '!alfred', ownerId: OWNER, agentId: ALFRED })

    // Forgotten, the room is gone from the next sync: nothing more to do.
    await rooms.sweep({ owner: OWNER, ready: true, rooms: [beaRoom] })
    expect(forget).toHaveBeenCalledOnce()
  })

  it('keeps clearing them when a roster fetched before the retirement arrives after it', async () => {
    const { rooms, forget } = harness()
    rooms.roster(OWNER, [record('atum', { isDefault: true })])
    rooms.retired(OWNER, ALFRED)
    rooms.roster(OWNER, [record('atum', { isDefault: true }), record('alfred'), record('bea')])

    await rooms.sweep({ owner: OWNER, ready: true, rooms: [alfredRoom, beaRoom] })
    expect(forget).toHaveBeenCalledExactlyOnceWith({ roomId: '!alfred', ownerId: OWNER, agentId: ALFRED })
  })

  it("clears an agent retired on another Mac, or before this launch, from the roster's tombstone", async () => {
    const { rooms, forget } = harness()
    rooms.roster(OWNER, [record('atum', { isDefault: true }), record('alfred', { status: 'retired' })])

    await rooms.sweep({ owner: OWNER, ready: true, rooms: [alfredRoom, beaRoom] })
    expect(forget).toHaveBeenCalledExactlyOnceWith({ roomId: '!alfred', ownerId: OWNER, agentId: ALFRED })
  })

  it('waits for the chats to sync, and never acts for another person', async () => {
    const { rooms, forget } = harness()
    rooms.retired(OWNER, ALFRED)

    await rooms.sweep({ owner: OWNER, ready: false, rooms: [alfredRoom] })
    await rooms.sweep({ owner: '@someone:test', ready: true, rooms: [alfredRoom] })
    expect(forget).not.toHaveBeenCalled()

    // Signing in as someone else drops the first person's retired agents.
    rooms.roster('@someone:test', [])
    await rooms.sweep({ owner: '@someone:test', ready: true, rooms: [alfredRoom] })
    expect(forget).not.toHaveBeenCalled()
  })

  it('keeps a room the server shows is not only the two of them, and does not ask again', async () => {
    const forget = vi.fn<Forget>(async () => 'kept')
    const { rooms } = harness(forget)
    rooms.retired(OWNER, ALFRED)

    await rooms.sweep({ owner: OWNER, ready: true, rooms: [alfredRoom] })
    await rooms.sweep({ owner: OWNER, ready: true, rooms: [alfredRoom] })
    expect(forget).toHaveBeenCalledOnce()
  })

  it('tries again a minute after a failure that may pass, sooner for a new retirement', async () => {
    const forget = vi.fn<Forget>(async () => {
      throw new Error('matrix_operation_failed')
    })

    const { rooms, advance } = harness(forget)
    rooms.retired(OWNER, ALFRED)
    const view = { owner: OWNER, ready: true, rooms: [alfredRoom, beaRoom] }

    await rooms.sweep(view)
    await rooms.sweep(view)
    expect(forget).toHaveBeenCalledOnce()

    advance(RETIRED_AGENT_ROOMS_RETRY_MS)
    await rooms.sweep(view)
    expect(forget).toHaveBeenCalledTimes(2)

    forget.mockResolvedValue('forgotten')
    rooms.retired(OWNER, BEA)
    await rooms.sweep(view)
    expect(forget.mock.calls.slice(2).map(([input]) => input)).toEqual([
      { roomId: '!alfred', ownerId: OWNER, agentId: ALFRED },
      { roomId: '!bea', ownerId: OWNER, agentId: BEA }
    ])
  })

  it('runs one sweep at a time', async () => {
    let release: () => void = () => {}

    const forget = vi.fn<Forget>(
      () =>
        new Promise<unknown>(resolve => {
          release = () => resolve('forgotten')
        })
    )

    const { rooms } = harness(forget)
    rooms.retired(OWNER, ALFRED)
    const view = { owner: OWNER, ready: true, rooms: [alfredRoom] }
    const first = rooms.sweep(view)
    const second = rooms.sweep(view)
    expect(forget).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
  })
})
