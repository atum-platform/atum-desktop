import {
  ClientEvent,
  createClient,
  EventType,
  type MatrixClient,
  MatrixEvent,
  Room,
  RoomEvent,
  SyncState
} from 'matrix-js-sdk'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../../shared/matrix-assistant-room'
import { MATRIX_FOUNDER_CHAT_MARKER } from '../../../shared/matrix-founder'

import { trustCrossSignedDevices } from './cross-signed-trust'
import { matrixFounderChat } from './sdk-founder-chat'

const ME = '@alice:test'
const FOUNDER = '@user-0f1e2d3c4b5a69788796a5b4c3d2e1f0:test'
const PERSON = '@bob:test'

interface FakeDevice {
  signedByOwner: boolean
  localVerified: boolean
}

interface RoomShape {
  creator?: string
  roomType?: string
  members: Record<string, 'join' | 'invite' | 'leave'>
  encrypted?: boolean
  direct?: boolean
  /** Who invited this account, for an invitation (or, once joined, the direct invitation it
   * accepted). */
  inviter?: string
  /** The room's own Founder mark, and who set it. */
  mark?: { founder: string; sender?: string }
  createdAt?: number
}

const stops: Array<() => void> = []

afterEach(() => {
  stops.splice(0).forEach(stop => stop())
  vi.restoreAllMocks()
})

function addRoom(client: MatrixClient, id: string, shape: RoomShape): Room {
  const own = client.getSafeUserId()
  const room = new Room(id, client, own)
  const creator = shape.creator ?? own

  const state = [
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: id,
      sender: creator,
      origin_server_ts: shape.createdAt ?? 1,
      content: { room_version: '10', ...(shape.roomType ? { type: shape.roomType } : {}) }
    }),
    ...(shape.encrypted === false
      ? []
      : [
          new MatrixEvent({
            type: EventType.RoomEncryption,
            state_key: '',
            room_id: id,
            sender: creator,
            content: { algorithm: 'm.megolm.v1.aes-sha2' }
          })
        ]),
    ...Object.entries(shape.members).map(
      ([userId, membership]) =>
        new MatrixEvent({
          type: EventType.RoomMember,
          state_key: userId,
          room_id: id,
          sender: userId === own && membership === 'invite' ? (shape.inviter ?? creator) : userId,
          content: { membership, ...(shape.direct ? { is_direct: true } : {}) },
          // A direct invitation this account accepted: the join keeps it in prev_content.
          ...(userId === own && membership === 'join' && shape.direct && shape.inviter
            ? { unsigned: { prev_content: { membership: 'invite', is_direct: true }, prev_sender: shape.inviter } }
            : {})
        })
    ),
    ...(shape.mark
      ? [
          new MatrixEvent({
            type: MATRIX_FOUNDER_CHAT_MARKER,
            state_key: '',
            room_id: id,
            sender: shape.mark.sender ?? creator,
            content: { v: 1, founder: shape.mark.founder }
          })
        ]
      : [])
  ]

  room.currentState.setStateEvents(state)
  room.updateMyMembership(shape.members[own] ?? 'leave')
  client.store.storeRoom(room)

  return room
}

async function addMessage(room: Room, sender: string) {
  await room.addLiveEvents(
    [
      new MatrixEvent({
        type: EventType.RoomMessage,
        event_id: `$${sender}-${room.roomId}`,
        room_id: room.roomId,
        sender,
        content: { msgtype: 'm.text', body: 'hello' }
      })
    ],
    { addToState: false }
  )
}

/** A real SDK client with a scripted homeserver and a scripted crypto store. */
function fixture(
  options: {
    userId?: string
    record?: unknown
    devices?: Record<string, Record<string, FakeDevice>>
    identities?: Record<string, { known: boolean; needsUserApproval?: boolean }>
    published?: boolean
  } = {}
) {
  const userId = options.userId ?? ME
  const client = createClient({ baseUrl: 'https://matrix.test', userId, deviceId: 'DEVICE' })
  let server: unknown = options.record
  const records: unknown[] = []
  let made = 0

  const devices: Record<string, Record<string, FakeDevice>> = options.devices ?? {
    [FOUNDER]: { FPHONE: { signedByOwner: true, localVerified: false } }
  }

  const identities = options.identities ?? { [FOUNDER]: { known: true } }

  vi.spyOn(client.http, 'authedRequest').mockImplementation((async (_method: unknown, path: string) => {
    if (path.endsWith(`/account_data/${encodeURIComponent(MATRIX_FOUNDER_CHAT_MARKER)}`)) {
      if (server === undefined) {
        throw Object.assign(new Error('not found'), { errcode: 'M_NOT_FOUND' })
      }

      return server
    }

    throw new Error(`unexpected request ${path}`)
  }) as never)

  const setRecord = vi.spyOn(client, 'setAccountDataRaw').mockImplementation((async (
    _type: string,
    content: unknown
  ) => {
    server = content
    records.push(content)

    return {}
  }) as never)

  const createRoom = vi.spyOn(client, 'createRoom').mockImplementation((async () => {
    made += 1
    const id = `!made${made}:test`
    addRoom(client, id, {
      members: { [userId]: 'join', [FOUNDER]: 'invite' },
      mark: { founder: FOUNDER },
      direct: true
    })

    return { room_id: id }
  }) as never)

  const leave = vi.spyOn(client, 'leave').mockResolvedValue({} as never)
  const forget = vi.spyOn(client, 'forget').mockResolvedValue({} as never)
  const joinRoom = vi.spyOn(client, 'joinRoom').mockResolvedValue({} as never)

  const crypto = {
    globalBlacklistUnverifiedDevices: true,
    getUserDeviceInfo: vi.fn(
      async (users: string[]) =>
        new Map(users.map(user => [user, new Map(Object.keys(devices[user] ?? {}).map(id => [id, {}]))]))
    ),
    getUserVerificationStatus: vi.fn(async (user: string) => ({
      known: identities[user]?.known ?? false,
      needsUserApproval: identities[user]?.needsUserApproval ?? false
    })),
    getDeviceVerificationStatus: vi.fn(async (user: string, id: string) => {
      const device = devices[user]?.[id]

      return device ? { ...device, isVerified: () => device.localVerified } : null
    }),
    setDeviceVerified: vi.fn(async (user: string, id: string, verified = true) => {
      devices[user]![id]!.localVerified = verified
    }),
    userHasCrossSigningKeys: vi.fn(async () => options.published ?? true),
    prepareToEncrypt: vi.fn()
  }

  vi.spyOn(client, 'getCrypto').mockReturnValue(crypto as never)
  const rememberDirect = vi.fn()
  const sleep = vi.fn(async () => {})

  const founder = matrixFounderChat(
    client,
    { userId, deviceId: 'DEVICE' },
    { active: () => true, changed: () => {}, rememberDirect, now: () => 4321, sleep }
  )

  stops.push(() => founder.stop())

  return {
    client,
    founder,
    crypto,
    devices,
    identities,
    records,
    createRoom,
    setRecord,
    leave,
    forget,
    joinRoom,
    rememberDirect,
    sleep,
    server: (value?: unknown) => (server = value),
    sync: () => client.emit(ClientEvent.Sync, SyncState.Syncing, null),
    local: (content: Record<string, unknown>) => {
      const event = new MatrixEvent({ type: MATRIX_FOUNDER_CHAT_MARKER, content })
      client.store.storeAccountDataEvents([event])
      client.emit(ClientEvent.AccountData, event, undefined)
    }
  }
}

const explicit = { kind: 'founderChat', founder: FOUNDER, create: 'explicit' } as const
const configureOnly = { kind: 'founderChat', founder: FOUNDER, create: 'none' } as const

describe('the record', () => {
  it('is unknown until synced, then absent or present, and any record counts', () => {
    const f = fixture()
    expect(f.founder.snapshot()).toEqual({ state: 'unknown' })
    f.sync()
    expect(f.founder.snapshot()).toEqual({ state: 'absent' })

    f.local({ v: 1, founder: FOUNDER, room: '!chat:test', at: 1 })
    expect(f.founder.snapshot()).toEqual({ state: 'present', founder: FOUNDER, roomId: '!chat:test' })

    // A newer build's record is still a record.
    f.local({ v: 2, someday: true })
    expect(f.founder.snapshot()).toEqual({ state: 'present', founder: '', roomId: '' })
  })
})

describe('the record through a reconnecting sync (R4)', () => {
  it('stays known through a blip and is unknown again only once the client stopped', () => {
    const f = fixture()
    f.sync()
    expect(f.founder.snapshot()).toEqual({ state: 'absent' })

    const emit = (state: SyncState) => f.client.emit(ClientEvent.Sync, state, null)
    emit(SyncState.Reconnecting)
    expect(f.founder.snapshot()).toEqual({ state: 'absent' })
    emit(SyncState.Catchup)
    expect(f.founder.snapshot()).toEqual({ state: 'absent' })
    f.sync()

    emit(SyncState.Stopped)
    expect(f.founder.snapshot()).toEqual({ state: 'unknown' })
  })
})

describe('the Founder chat on the person side', () => {
  it('is made once, with exactly the recipe, then recorded and listed as direct', async () => {
    const f = fixture()
    f.sync()

    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!made1:test' })
    expect(f.createRoom).toHaveBeenCalledTimes(1)
    expect(f.createRoom.mock.calls[0]![0]).toEqual({
      preset: 'private_chat',
      is_direct: true,
      invite: [FOUNDER],
      initial_state: [
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
        { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } },
        { type: MATRIX_FOUNDER_CHAT_MARKER, state_key: '', content: { v: 1, founder: FOUNDER } }
      ]
    })
    expect(f.records).toEqual([{ v: 1, founder: FOUNDER, room: '!made1:test', at: 4321 }])
    expect(f.rememberDirect).toHaveBeenCalledWith(FOUNDER, '!made1:test')

    // Asked again (another start, another device's request): the recorded chat, never a second.
    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!made1:test' })
    expect(f.createRoom).toHaveBeenCalledTimes(1)
  })

  it('waits for a recorded chat this device has not synced yet instead of making a second', async () => {
    // A second device starts just after the first: the record is here, its chat has not arrived.
    const f = fixture({ record: { v: 1, founder: FOUNDER, room: '!elsewhere:test', at: 1 } })
    f.sync()

    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'waiting', reason: 'founder_not_ready' })
    expect(f.createRoom).not.toHaveBeenCalled()
    expect(f.records).toEqual([])

    // Once it arrives, the first device's chat is the one; still never a second.
    addRoom(f.client, '!elsewhere:test', { members: { [ME]: 'join', [FOUNDER]: 'invite' }, mark: { founder: FOUNDER } })
    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!elsewhere:test' })
    expect(f.createRoom).not.toHaveBeenCalled()
    expect(f.records).toEqual([])
  })

  it('makes nothing when only told who the founder is, whatever the record says', async () => {
    const left = fixture({ record: { v: 1, founder: FOUNDER, room: '!old:test', at: 1 } })
    addRoom(left.client, '!old:test', { members: { [ME]: 'leave', [FOUNDER]: 'join' }, mark: { founder: FOUNDER } })
    left.sync()
    await expect(left.founder.apply(configureOnly)).resolves.toEqual({ state: 'declined' })

    const unreadable = fixture({ record: { v: 2 } })
    unreadable.sync()
    await expect(unreadable.founder.apply(configureOnly)).resolves.toEqual({ state: 'declined' })

    // The founder left the chat: not reopened on its own either.
    const founderLeft = fixture({ record: { v: 1, founder: FOUNDER, room: '!old:test', at: 1 } })
    addRoom(founderLeft.client, '!old:test', {
      members: { [ME]: 'join', [FOUNDER]: 'leave' },
      mark: { founder: FOUNDER }
    })
    founderLeft.sync()
    await expect(founderLeft.founder.apply(configureOnly)).resolves.toEqual({ state: 'declined' })

    for (const f of [left, unreadable, founderLeft]) {
      expect(f.createRoom).not.toHaveBeenCalled()
      expect(f.records).toEqual([])
    }
  })

  it('is made again only at the person request (Contact us), which replaces the record', async () => {
    const f = fixture({ record: { v: 1, founder: FOUNDER, room: '!old:test', at: 1 } })
    addRoom(f.client, '!old:test', { members: { [ME]: 'leave', [FOUNDER]: 'join' }, mark: { founder: FOUNDER } })
    f.sync()

    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!made1:test' })
    expect(f.createRoom).toHaveBeenCalledTimes(1)
    expect(f.records).toEqual([{ v: 1, founder: FOUNDER, room: '!made1:test', at: 4321 }])
  })

  it('adopts the chat it made when the record could not be written, instead of making another', async () => {
    const f = fixture()
    f.sync()
    f.setRecord.mockRejectedValueOnce(new Error('M_LIMIT_EXCEEDED'))

    await expect(f.founder.apply(explicit)).rejects.toThrow()
    expect(f.createRoom).toHaveBeenCalledTimes(1)

    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!made1:test' })
    expect(f.createRoom).toHaveBeenCalledTimes(1)
    expect(f.records).toEqual([{ v: 1, founder: FOUNDER, room: '!made1:test', at: 4321 }])
  })

  it('adopts only its own marked chat with nobody else in it', async () => {
    const f = fixture()
    // Marked by someone else, someone else in it, or another founder's: none of these.
    addRoom(f.client, '!foreign:test', {
      creator: PERSON,
      members: { [ME]: 'join', [FOUNDER]: 'join', [PERSON]: 'join' },
      mark: { founder: FOUNDER }
    })
    addRoom(f.client, '!crowded:test', {
      members: { [ME]: 'join', [FOUNDER]: 'join', [PERSON]: 'invite' },
      mark: { founder: FOUNDER }
    })
    addRoom(f.client, '!earlier:test', {
      members: { [ME]: 'join', '@user-old:test': 'join' },
      mark: { founder: '@user-old:test' }
    })
    addRoom(f.client, '!unmarked:test', { members: { [ME]: 'join', [FOUNDER]: 'join' } })
    f.sync()

    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!made1:test' })
    expect(f.createRoom).toHaveBeenCalledTimes(1)
  })

  it("gives way to another device's chat and leaves its own while still empty", async () => {
    const f = fixture()
    f.sync()
    // The other device writes its record (and its chat syncs here) between this device's write
    // and its read-back.
    f.setRecord.mockImplementationOnce((async (_type: string, content: unknown) => {
      f.records.push(content)
      f.server({ v: 1, founder: FOUNDER, room: '!other:test', at: 1 })
      addRoom(f.client, '!other:test', { members: { [ME]: 'join', [FOUNDER]: 'invite' }, mark: { founder: FOUNDER } })

      return {}
    }) as never)

    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!other:test' })
    expect(f.leave).toHaveBeenCalledWith('!made1:test')
    expect(f.forget).toHaveBeenCalledWith('!made1:test', true)
  })

  it('settles a race both devices think they won by the record, keeping a chat someone wrote in', async () => {
    const f = fixture()
    f.sync()
    await f.founder.apply(explicit)
    const second = fixture()
    second.sync()
    await second.founder.apply(explicit)

    // The record that stands names the other device's chat.
    f.local({ v: 1, founder: FOUNDER, room: '!elsewhere:test', at: 2 })
    await vi.waitFor(() => expect(f.forget).toHaveBeenCalledWith('!made1:test', true))

    // Here the person already wrote in it: it stays.
    await addMessage(second.client.getRoom('!made1:test')!, ME)
    second.local({ v: 1, founder: FOUNDER, room: '!elsewhere:test', at: 2 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.forget).not.toHaveBeenCalled()
  })

  it('makes the plain chat whatever the founder’s devices (no readiness to wait for)', async () => {
    // No cross-signing identity published, no cross-signed device, or a changed identity.
    for (const f of [
      fixture({ identities: {}, published: false }),
      fixture({ devices: { [FOUNDER]: { FPHONE: { signedByOwner: false, localVerified: false } } } }),
      fixture({ identities: { [FOUNDER]: { known: true, needsUserApproval: true } } })
    ]) {
      f.sync()
      await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!made1:test' })
      expect(f.createRoom).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps using an encrypted Founder chat made before 0.20, and a plain one', async () => {
    for (const encrypted of [true, false]) {
      const f = fixture({ record: { v: 1, founder: FOUNDER, room: '!kept:test', at: 1 } })
      addRoom(f.client, '!kept:test', { members: { [ME]: 'join', [FOUNDER]: 'join' }, encrypted, direct: true })
      f.sync()
      await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'ready', roomId: '!kept:test' })
      expect(f.createRoom).not.toHaveBeenCalled()
    }
  })

  it('waits for a sync, and is off without a founder', async () => {
    const f = fixture()
    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'waiting', reason: 'not_synced' })
    f.sync()
    await expect(f.founder.apply({ kind: 'founderChat', founder: null, create: 'none' })).resolves.toEqual({
      state: 'disabled'
    })
    await expect(f.founder.apply({ kind: 'founderChat', founder: 'founder', create: 'none' } as never)).rejects.toThrow(
      'matrix_command_invalid'
    )
    expect(f.createRoom).not.toHaveBeenCalled()
  })
})

describe('trusting cross-signed devices', () => {
  it('trusts only the devices their identity signed, only while it is known and unchanged', async () => {
    const f = fixture({
      devices: {
        [FOUNDER]: {
          SIGNED: { signedByOwner: true, localVerified: false },
          INJECTED: { signedByOwner: false, localVerified: false },
          TRUSTED: { signedByOwner: true, localVerified: true }
        },
        [PERSON]: { OTHER: { signedByOwner: true, localVerified: false } }
      }
    })

    await expect(trustCrossSignedDevices(f.client, FOUNDER)).resolves.toEqual({ state: 'trusted', count: 2 })
    expect(f.crypto.setDeviceVerified.mock.calls).toEqual([[FOUNDER, 'SIGNED', true]])

    f.identities[FOUNDER] = { known: true, needsUserApproval: true }
    f.devices[FOUNDER]!.NEW = { signedByOwner: true, localVerified: false }
    await expect(trustCrossSignedDevices(f.client, FOUNDER)).resolves.toEqual({ state: 'identity_changed', count: 2 })

    f.identities[FOUNDER] = { known: false }
    await expect(trustCrossSignedDevices(f.client, FOUNDER)).resolves.toEqual({ state: 'no_identity', count: 2 })

    // Never trust removed, never another user, never a blacklist changed.
    expect(f.crypto.setDeviceVerified.mock.calls).toEqual([[FOUNDER, 'SIGNED', true]])
    expect(f.crypto.setDeviceVerified.mock.calls.some(call => call[2] === false)).toBe(false)
    expect(f.crypto.globalBlacklistUnverifiedDevices).toBe(true)
  })
})

describe('before a send', () => {
  it('trusts the founder first, and refuses a send that would reach no device of theirs', async () => {
    const blacklist = vi.spyOn(Room.prototype, 'setBlacklistUnverifiedDevices')
    const f = fixture({ identities: { [FOUNDER]: { known: true } } })
    addRoom(f.client, '!founder:test', { members: { [ME]: 'join', [FOUNDER]: 'invite' }, mark: { founder: FOUNDER } })
    addRoom(f.client, '!friend:test', { members: { [ME]: 'join', [PERSON]: 'join' } })
    f.sync()
    await f.founder.apply(configureOnly)

    await expect(f.founder.beforeSend('!founder:test')).resolves.toBeUndefined()
    expect(f.crypto.setDeviceVerified).toHaveBeenCalledWith(FOUNDER, 'FPHONE', true)

    // Elsewhere it does nothing at all.
    f.crypto.getUserDeviceInfo.mockClear()
    await f.founder.beforeSend('!friend:test')
    expect(f.crypto.getUserDeviceInfo).not.toHaveBeenCalled()

    // No device of the founder's can be trusted: refused, after one wait for devices to arrive.
    const unready = fixture({ identities: {}, devices: { [FOUNDER]: {} } })
    addRoom(unready.client, '!founder:test', {
      members: { [ME]: 'join', [FOUNDER]: 'invite' },
      mark: { founder: FOUNDER }
    })
    unready.sync()
    await unready.founder.apply(configureOnly)
    await expect(unready.founder.beforeSend('!founder:test')).rejects.toThrow('matrix_founder_unready')
    expect(unready.crypto.prepareToEncrypt).toHaveBeenCalledTimes(1)
    expect(blacklist).not.toHaveBeenCalled()
  })

  it('trusts devices that arrive while it waits', async () => {
    const f = fixture({ identities: {}, devices: { [FOUNDER]: {} } })
    addRoom(f.client, '!founder:test', { members: { [ME]: 'join', [FOUNDER]: 'invite' }, mark: { founder: FOUNDER } })
    f.sync()
    await f.founder.apply(configureOnly)
    f.sleep.mockImplementationOnce(async () => {
      // The room's key query brings the founder's identity and phone.
      f.identities[FOUNDER] = { known: true }
      f.devices[FOUNDER] = { FPHONE: { signedByOwner: true, localVerified: false } }
      f.client.emit(CryptoEvent.DevicesUpdated, [FOUNDER], false)
    })

    await expect(f.founder.beforeSend('!founder:test')).resolves.toBeUndefined()
    expect(f.crypto.setDeviceVerified).toHaveBeenCalledWith(FOUNDER, 'FPHONE', true)
  })

  it("on the founder's side, refuses a reply that would reach no device of the person's", async () => {
    const f = fixture({
      userId: FOUNDER,
      identities: { [PERSON]: { known: true } },
      devices: { [PERSON]: { LAPTOP: { signedByOwner: false, localVerified: false } } }
    })

    // The person's Founder chat, as the founder joined it: a direct invitation from them.
    addRoom(f.client, '!support:test', {
      creator: PERSON,
      inviter: PERSON,
      direct: true,
      members: { [FOUNDER]: 'join', [PERSON]: 'join' }
    })
    addRoom(f.client, '!group:test', {
      creator: PERSON,
      members: { [FOUNDER]: 'join', [PERSON]: 'join', [ME]: 'join' }
    })
    // The founder's own assistant, and a two-person room nobody invited them to directly.
    addRoom(f.client, '!assistant:test', {
      inviter: '@agent-0123:test',
      direct: true,
      members: { [FOUNDER]: 'join', '@agent-0123:test': 'join' }
    })
    addRoom(f.client, '!plain:test', { creator: PERSON, members: { [FOUNDER]: 'join', [PERSON]: 'join' } })
    f.sync()
    await expect(f.founder.apply(explicit)).resolves.toEqual({ state: 'founder_mode' })

    await expect(f.founder.beforeSend('!support:test')).rejects.toThrow('matrix_founder_recipient_unready')

    for (const roomId of ['!group:test', '!assistant:test', '!plain:test']) {
      await expect(f.founder.beforeSend(roomId)).resolves.toBeUndefined()
    }

    f.devices[PERSON]!.LAPTOP = { signedByOwner: true, localVerified: false }
    await expect(f.founder.beforeSend('!support:test')).resolves.toBeUndefined()
    expect(f.crypto.setDeviceVerified).toHaveBeenCalledWith(PERSON, 'LAPTOP', true)
  })
})

describe("the founder's side", () => {
  function founderFixture() {
    return fixture({ userId: FOUNDER, identities: {}, devices: {} })
  }

  it("joins a person's direct invitation, plain or encrypted, and nothing else", async () => {
    const f = founderFixture()
    f.sync()
    await expect(f.founder.apply({ kind: 'founderChat', founder: FOUNDER, create: 'none' })).resolves.toEqual({
      state: 'founder_mode'
    })

    const invite = (id: string, shape: Partial<RoomShape> = {}) => {
      const room = addRoom(f.client, id, {
        creator: PERSON,
        inviter: PERSON,
        direct: true,
        members: { [FOUNDER]: 'invite', [PERSON]: 'join' },
        ...shape
      })

      f.client.emit(RoomEvent.MyMembership, room, 'invite', undefined)
    }

    invite('!not-direct:test', { direct: false })
    invite('!relayed:test', {
      inviter: '@carol:test',
      members: { [FOUNDER]: 'invite', [PERSON]: 'join', '@carol:test': 'join' }
    })
    invite('!agent:test', {
      creator: '@agent-0123:test',
      inviter: '@agent-0123:test',
      roomType: MATRIX_ASSISTANT_ROOM_TYPE,
      members: { [FOUNDER]: 'invite', '@agent-0123:test': 'join' }
    })
    invite('!app:test', {
      creator: '@app-moon:test',
      inviter: '@app-moon:test',
      members: { [FOUNDER]: 'invite', '@app-moon:test': 'join' }
    })
    invite('!service:test', {
      creator: '@service-x:test',
      inviter: '@service-x:test',
      members: { [FOUNDER]: 'invite', '@service-x:test': 'join' }
    })
    invite('!system:test', {
      creator: '@system-y:test',
      inviter: '@system-y:test',
      members: { [FOUNDER]: 'invite', '@system-y:test': 'join' }
    })
    vi.spyOn(f.client, 'isUserIgnored').mockImplementation(user => user === '@troll:test')
    invite('!ignored:test', {
      creator: '@troll:test',
      inviter: '@troll:test',
      members: { [FOUNDER]: 'invite', '@troll:test': 'join' }
    })
    invite('!person:test')
    invite('!plain:test', { encrypted: false })

    await vi.waitFor(() => expect(f.joinRoom).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.joinRoom.mock.calls).toEqual([['!person:test'], ['!plain:test']])
  })

  it('asks the server once for an invitation it refuses, not on every sync', async () => {
    const f = founderFixture()
    f.sync()
    await f.founder.apply({ kind: 'founderChat', founder: FOUNDER, create: 'none' })
    f.joinRoom.mockRejectedValue(Object.assign(new Error('gone'), { errcode: 'M_FORBIDDEN' }))

    const room = addRoom(f.client, '!gone:test', {
      creator: PERSON,
      inviter: PERSON,
      direct: true,
      members: { [FOUNDER]: 'invite', [PERSON]: 'join' }
    })

    f.client.emit(RoomEvent.MyMembership, room, 'invite', undefined)
    await vi.waitFor(() => expect(f.joinRoom).toHaveBeenCalledTimes(1))
    f.sync()
    f.sync()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.joinRoom).toHaveBeenCalledTimes(1)
  })

  it('joins one at a time and waits as long as the server asks', async () => {
    const f = founderFixture()
    f.sync()
    await f.founder.apply({ kind: 'founderChat', founder: FOUNDER, create: 'none' })
    const order: string[] = []
    let first = true

    f.joinRoom.mockImplementation((async (roomId: string) => {
      order.push(`start ${roomId}`)

      if (roomId === '!one:test' && first) {
        first = false
        throw Object.assign(new Error('slow down'), { errcode: 'M_LIMIT_EXCEEDED', data: { retry_after_ms: 2500 } })
      }

      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`end ${roomId}`)

      return {}
    }) as never)

    for (const id of ['!one:test', '!two:test']) {
      const room = addRoom(f.client, id, {
        creator: PERSON,
        inviter: PERSON,
        direct: true,
        members: { [FOUNDER]: 'invite', [PERSON]: 'join' }
      })

      f.client.emit(RoomEvent.MyMembership, room, 'invite', undefined)
    }

    await vi.waitFor(() =>
      expect(order).toEqual(['start !one:test', 'start !one:test', 'end !one:test', 'start !two:test', 'end !two:test'])
    )
    expect(f.sleep).toHaveBeenCalledWith(2500)
  })

  it('joins invitations already waiting when founder mode starts, and none for a person', async () => {
    const f = founderFixture()
    addRoom(f.client, '!waiting:test', {
      creator: PERSON,
      inviter: PERSON,
      direct: true,
      members: { [FOUNDER]: 'invite', [PERSON]: 'join' }
    })
    f.sync()
    expect(f.joinRoom).not.toHaveBeenCalled()
    await f.founder.apply({ kind: 'founderChat', founder: FOUNDER, create: 'none' })
    await vi.waitFor(() => expect(f.joinRoom).toHaveBeenCalledWith('!waiting:test'))

    const person = fixture()

    const room = addRoom(person.client, '!dm:test', {
      creator: PERSON,
      inviter: PERSON,
      direct: true,
      members: { [ME]: 'invite', [PERSON]: 'join' }
    })

    person.sync()
    await person.founder.apply(configureOnly)
    person.client.emit(RoomEvent.MyMembership, room, 'invite', undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(person.joinRoom).not.toHaveBeenCalled()
  })
})
