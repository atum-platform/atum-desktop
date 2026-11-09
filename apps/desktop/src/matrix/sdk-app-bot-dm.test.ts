import {
  ClientEvent,
  createClient,
  EventType,
  type MatrixClient,
  MatrixEvent,
  Room,
  SyncState
} from 'matrix-js-sdk'
import type * as MatrixSdk from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { localAppChatRoom, startAppChat } from '../../electron/matrix/app-bots/open-chat'
import { platformAppChatRoom } from '../../electron/matrix/app-bots/platform-room'
import type { AppDescriptor } from '../../shared/app-catalog'
import { botApp } from '../../shared/app-catalog.test-support'
import type { MatrixSdkCommand, MatrixSnapshot } from '../../shared/matrix'

import { APP_BOT_UNSYNCED_PROBES, appBotCreatedRooms } from './app-bot-created'
import type * as RoomWait from './app-bot-room-wait'
import { APP_BOT_ROOM_WAIT_MS } from './app-bot-room-wait'
import { directAppBot } from './app-bots/direct-app'
import { openAppBotChat } from './app-bots/open'
import { matrixChatCopy } from './chat-copy'
import {
  matrixChatFailure,
  matrixChatFailureCopy,
  matrixFailureRetry,
  matrixFailureSubject
} from './chat-error'
import { projectMatrixRoster } from './roster-model'
import { startMatrixSdk } from './sdk'

vi.mock('matrix-js-sdk', async importOriginal => {
  const actual = await importOriginal<typeof MatrixSdk>()

  return {
    ...actual,
    createClient: vi.fn(),
    IndexedDBStore: class extends actual.MemoryStore {
      async startup() {}
      async save() {}
    }
  }
})

// The SDK selects a bot's chat only once its room has reached the store (`selectAppBotDirectRoom`).
// This is the real wait; the fixture's sync (`freshSdk`'s `sync`) is told which room it waits for.
const syncing = vi.hoisted(() => ({ waiting: (_roomId: string) => {} }))

vi.mock('./app-bot-room-wait', async importOriginal => {
  const actual = await importOriginal<typeof RoomWait>()

  return {
    ...actual,
    waitForRoom: (...args: Parameters<typeof actual.waitForRoom>) => {
      const wait = actual.waitForRoom(...args)
      syncing.waiting(args[1])

      return wait
    }
  }
})

const owner = '@owner:test'
const moon = '00000000-0000-4000-8000-e79acd97ac88'
const moonBot = '@app-moon:test'
const pointerType = `io.atum.app_bot.dm.${moon}`
const open = { kind: 'openAppBotDm' as const, appId: moon, botUserId: moonBot }

const moonApp = {
  app: 'moon',
  app_id: moon,
  roster_order: 1,
  roster_default: true,
  availability: 'available',
  bot: { user_id: moonBot, display_name: 'Moon', state: 'active' }
} as unknown as AppDescriptor

const stops: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(stops.splice(0).map(stop => stop()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // What a run keeps on this device (the chats it made and has not seen arrive) belongs to that test.
  localStorage.clear()
})

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

/** A room this device holds, with the person's own membership. Plain, as 0.20 makes every chat;
 * `encrypted` is a room made before 0.20. */
function heldRoom(client: MatrixClient, id: string, membership = 'join', inviter = '@someone:test', encrypted = false) {
  const value = new Room(id, client, owner)
  value.currentState.setStateEvents([
    ...(encrypted
      ? [
          new MatrixEvent({
            type: EventType.RoomEncryption,
            state_key: '',
            room_id: id,
            sender: owner,
            content: { algorithm: 'm.megolm.v1.aes-sha2' }
          })
        ]
      : []),
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: owner,
      room_id: id,
      sender: membership === 'invite' ? inviter : owner,
      content: { membership, is_direct: true }
    })
  ])
  value.updateMyMembership(membership)
  client.store.storeRoom(value)

  return value
}

/** A Moon chat this account made (its marker in the room's state), with its other members as
 * the server's room state lists them: `leave` is someone who was once in it. */
function moonRoom(
  client: MatrixClient,
  id: string,
  members: Record<string, string> = { [moonBot]: 'join' },
  encrypted = false
) {
  const value = heldRoom(client, id, 'join', '@someone:test', encrypted)
  value.currentState.setStateEvents([
    ...Object.entries(members).map(
      ([userId, membership]) =>
        new MatrixEvent({ type: EventType.RoomMember, state_key: userId, room_id: id, sender: owner, content: { membership } })
    ),
    new MatrixEvent({
      type: 'io.atum.app_bot.dm',
      state_key: '',
      room_id: id,
      sender: owner,
      content: { v: 1, app_id: moon, bot_user_id: moonBot }
    })
  ])

  return value
}

async function said(target: Room, at: number) {
  await target.addLiveEvents(
    [
      new MatrixEvent({
        type: EventType.RoomMessage,
        event_id: `$said-${target.roomId}-${at}`,
        room_id: target.roomId,
        sender: moonBot,
        origin_server_ts: at,
        content: { msgtype: 'm.text', body: 'fixture reading' }
      })
    ],
    { addToState: false }
  )
}

function accountData(client: MatrixClient, type: string, content: Record<string, unknown>) {
  client.store.storeAccountDataEvents([new MatrixEvent({ type, content })])
}

function pointMoonAt(client: MatrixClient, roomId: string) {
  accountData(client, pointerType, { v: 1, room_id: roomId, bot_user_id: moonBot })
}

/** The person's devices list these rooms as their chats with Moon (`m.direct`). */
function directWithMoon(client: MatrixClient, roomIds: string[]) {
  accountData(client, EventType.Direct, { [moonBot]: roomIds })
}

/**
 * What the homeserver holds that another of this person's Macs may have just written: the
 * account's Moon pointer, the rooms the account is in, and those rooms' state. Read by the
 * SDK's own HTTP calls; anything else answers as if offline.
 */
function homeserver(client: MatrixClient) {
  const held: {
    pointer: Record<string, unknown> | null
    joined: string[]
    state: Map<string, unknown[]>
    /** Each room's history, newest first, as `/messages` pages it back. */
    history: Map<string, unknown[]>
  } = {
    pointer: null,
    joined: [],
    state: new Map(),
    history: new Map()
  }

  vi.spyOn(client.http, 'authedRequest').mockImplementation((async (_method: string, path: string) => {
    if (path.endsWith(`/account_data/${encodeURIComponent(pointerType)}`)) {
      if (held.pointer) {
        return held.pointer
      }

      throw Object.assign(new Error('not found'), { errcode: 'M_NOT_FOUND' })
    }

    if (path === '/joined_rooms') {
      return { joined_rooms: held.joined }
    }

    const room = /^\/rooms\/([^/]+)\/state$/.exec(path)

    if (room && held.state.has(decodeURIComponent(room[1]!))) {
      return held.state.get(decodeURIComponent(room[1]!))
    }

    const messages = /^\/rooms\/([^/]+)\/messages$/.exec(path)

    if (messages && held.history.has(decodeURIComponent(messages[1]!))) {
      return { chunk: held.history.get(decodeURIComponent(messages[1]!)), start: 'now' }
    }

    throw new Error('offline fixture')
  }) as never)

  return {
    held,
    /** The room this Mac made, as the server holds it: its making, its members and its marker,
     * and the messages written in it since (`said`). */
    madeHere(roomId: string, said: string[] = []) {
      held.history.set(roomId, [
        ...said.map((body, index) => ({
          type: EventType.RoomMessage,
          event_id: `$said-${index}`,
          sender: moonBot,
          origin_server_ts: 2_000 + index,
          content: { msgtype: 'm.text', body }
        })),
        { type: 'io.atum.app_bot.dm', state_key: '', event_id: '$marker', sender: owner, content: {} },
        { type: EventType.RoomMember, state_key: moonBot, event_id: '$invite', sender: owner, content: { membership: 'invite' } },
        { type: EventType.RoomMember, state_key: owner, event_id: '$join', sender: owner, content: { membership: 'join' } },
        { type: EventType.RoomCreate, state_key: '', event_id: '$create', sender: owner, content: {} }
      ])
    },
    /** A chat with Moon the account is in on the server, in the state a chat this account made has, that
     * this device's store lacks: no pointer, no `m.direct` entry. `marker` is whose marker it carries. */
    heldChat(
      roomId: string,
      {
        members = { [owner]: 'join', [moonBot]: 'invite' },
        encrypted = false,
        marker = 'own'
      }: {
        members?: Record<string, string>
        encrypted?: boolean
        /** `own`: the account's; `bot`: set by the bot; `none`; `other`: names another app. */
        marker?: 'own' | 'bot' | 'none' | 'other'
      } = {}
    ) {
      held.joined.push(roomId)
      held.state.set(roomId, [
        { type: EventType.RoomCreate, state_key: '', sender: owner, content: {} },
        ...(marker === 'none'
          ? []
          : [
              {
                type: 'io.atum.app_bot.dm',
                state_key: '',
                sender: marker === 'bot' ? moonBot : owner,
                content: {
                  v: 1,
                  app_id: marker === 'other' ? '00000000-0000-4000-8000-87d96e07d1bf' : moon,
                  bot_user_id: moonBot
                }
              }
            ]),
        ...(encrypted
          ? [{ type: EventType.RoomEncryption, state_key: '', sender: owner, content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
          : []),
        ...Object.entries(members).map(([userId, membership]) => ({
          type: EventType.RoomMember,
          state_key: userId,
          sender: owner,
          content: { membership }
        }))
      ])
    },
    /** Another Mac made a Moon chat and pointed the account at it. */
    otherMacMade(roomId: string, members: Record<string, string> = { [owner]: 'join', [moonBot]: 'invite' }, encrypted = false) {
      held.pointer = { v: 1, room_id: roomId, bot_user_id: moonBot }
      held.joined.push(roomId)
      held.state.set(roomId, [
        { type: EventType.RoomCreate, state_key: '', sender: owner, content: {} },
        { type: 'io.atum.app_bot.dm', state_key: '', sender: owner, content: { v: 1, app_id: moon, bot_user_id: moonBot } },
        ...(encrypted
          ? [{ type: EventType.RoomEncryption, state_key: '', sender: owner, content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
          : []),
        ...Object.entries(members).map(([userId, membership]) => ({
          type: EventType.RoomMember,
          state_key: userId,
          sender: owner,
          content: { membership }
        }))
      ])
    }
  }
}

/**
 * A fresh SDK over a real js-sdk client, as after a restart: nothing remembered in memory, only
 * what the account and this device's store hold. `prepare` lays out that state first.
 */
async function freshSdk(
  prepare: (client: MatrixClient, encryptedInStore: Set<string>) => void | Promise<void> = () => {}
) {
  const actual = await vi.importActual<typeof MatrixSdk>('matrix-js-sdk')
  const client = actual.createClient({ baseUrl: 'https://matrix.test', userId: owner, deviceId: 'DEVICE' })

  vi.mocked(createClient).mockReturnValue(client)
  vi.stubGlobal('indexedDB', {})
  vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined)
  // The crypto store's record: a room is plain unless it has seen the room's encryption.
  const encryptedInStore = new Set<string>()
  vi.spyOn(client, 'getCrypto').mockReturnValue({
    globalBlacklistUnverifiedDevices: false,
    isEncryptionEnabledInRoom: async (roomId: string) => encryptedInStore.has(roomId)
  } as unknown as ReturnType<MatrixClient['getCrypto']>)
  vi.spyOn(client, 'startClient').mockResolvedValue(undefined)
  vi.spyOn(client, 'stopClient').mockImplementation(() => {})
  vi.spyOn(client, 'getAccountDataFromServer').mockResolvedValue({})
  vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})
  vi.spyOn(client, 'setRoomAccountData').mockResolvedValue({})
  const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!moon-new:test' })
  const join = vi.spyOn(client, 'joinRoom').mockImplementation(async roomId => client.getRoom(roomId as string)!)
  const leave = vi.spyOn(client, 'leave').mockResolvedValue({})
  const forget = vi.spyOn(client, 'forget').mockResolvedValue({})
  const server = homeserver(client)
  await prepare(client, encryptedInStore)

  const snapshots: MatrixSnapshot[] = []

  const sdk = await startMatrixSdk(
    { baseUrl: 'https://matrix.test', userId: owner, deviceId: 'DEVICE', accessToken: 'fixture', storageKey: btoa('0'.repeat(32)) },
    vi.fn(),
    value => snapshots.push(value)
  )

  stops.push(sdk.stop)
  // Synced: Delete chat and the roster act only on a ready account.
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  // What sync does for a room the SDK waits for. It arrives as the server holds it: a room another
  // Mac or client made from the server's state, a room this Mac made from its `createRoom` call.
  // `auto` (the default) brings it as soon as the wait starts, `manual` when the test calls
  // `deliver`, `never` not at all (a sync that does not reach the room).
  const waitingFor: string[] = []

  function deliver(roomId: string) {
    if (client.getRoom(roomId)) {
      return
    }

    type StateJson = { type: string; state_key: string; sender: string; content: Record<string, unknown> }

    const held = server.held.state.get(roomId) as StateJson[] | undefined
    const made = create.mock.settledResults.findIndex(r => r.type === 'fulfilled' && r.value?.room_id === roomId)
    const options = made >= 0 ? (create.mock.calls[made]![0] as Record<string, any>) : undefined

    const events: StateJson[] = held ?? [
      { type: EventType.RoomCreate, state_key: '', sender: owner, content: {} },
      { type: EventType.RoomMember, state_key: owner, sender: owner, content: { membership: 'join' } },
      ...((options?.invite ?? []) as string[]).map(userId => ({
        type: EventType.RoomMember as string,
        state_key: userId,
        sender: owner,
        content: { membership: 'invite' }
      })),
      ...((options?.initial_state ?? []) as StateJson[]).map(event => ({ ...event, sender: owner }))
    ]

    const room = new Room(roomId, client, owner)
    room.currentState.setStateEvents(events.map(event => new MatrixEvent({ ...event, room_id: roomId })))

    const mine = events.find(event => event.type === EventType.RoomMember && event.state_key === owner)
    room.updateMyMembership(String(mine?.content.membership ?? 'join'))
    client.store.storeRoom(room)
    client.emit(ClientEvent.Room, room)
  }

  const sync = { mode: 'auto' as 'auto' | 'manual' | 'never', delayMs: 0, waitingFor, deliver }

  syncing.waiting = roomId => {
    waitingFor.push(roomId)

    if (sync.mode === 'auto') {
      setTimeout(() => deliver(roomId), sync.delayMs)
    }
  }

  const pointerWrites = () =>
    vi.mocked(client.setAccountDataRaw).mock.calls.filter(([type]) => type === pointerType).map(([, content]) => content)

  const directWrites = () => vi.mocked(client.setAccountDataRaw).mock.calls.filter(([type]) => type === EventType.Direct)

  return {
    client,
    sdk,
    create,
    join,
    leave,
    forget,
    server,
    sync,
    pointerWrites,
    directWrites,
    snapshots,
    latest: () => snapshots.at(-1)!,
    room: (id: string) => snapshots.at(-1)!.rooms.find(value => value.id === id)
  }
}

/** No snapshot the window was given selects a room it cannot draw (the generic "no conversation"). */
const drawn = (snapshot: MatrixSnapshot) =>
  !snapshot.roomId || snapshot.rooms.some(room => room.id === snapshot.roomId)

/** Lets the work the SDK has queued run while the clock is faked, until `done` says it has. */
async function settle(done: () => boolean) {
  for (let turn = 0; turn < 500 && !done(); turn++) {
    await vi.advanceTimersByTimeAsync(0)
  }

  expect(done()).toBe(true)
}

/**
 * Runs `command` against a sync that never brings the room: it is still waiting one tick before the
 * bound, and fails closed with `matrix_app_bot_syncing` at the bound.
 */
async function expectWaitRunsOut(
  f: Awaited<ReturnType<typeof freshSdk>>,
  command: Parameters<Awaited<ReturnType<typeof freshSdk>>['sdk']['command']>[0],
  waiting: string[]
) {
  vi.useFakeTimers()

  try {
    let outcome: unknown = 'pending'

    const opening = f.sdk.command(command).then(
      value => (outcome = value),
      error => (outcome = error)
    )

    await settle(() => f.sync.waitingFor.length > 0)
    expect(f.sync.waitingFor).toEqual(waiting)

    await vi.advanceTimersByTimeAsync(APP_BOT_ROOM_WAIT_MS - 1)
    expect(outcome).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await opening
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('matrix_app_bot_syncing')
  } finally {
    vi.useRealTimers()
  }
}

describe('two Macs opening Moon at once', () => {
  it('reuses the chat another Mac made while this one was choosing, and makes nothing new', async () => {
    // This Mac has synced nothing about it yet; the server's pointer already names it.
    const f = await freshSdk()
    f.server.otherMacMade('!moon-other-mac:test')

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-other-mac:test',
      outcome: 'recovered',
      reason: 'pointer',
      pointer: 'kept'
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.pointerWrites()).toEqual([])
    expect(f.latest().roomId).toBe('!moon-other-mac:test')
  })

  it('leaves the room it made when the other Mac’s pointer landed first, so one chat remains', async () => {
    const f = await freshSdk()
    f.server.madeHere('!moon-new:test')
    f.create.mockImplementation(async () => {
      // Both Macs make a room in the same moment; the other one writes its pointer first.
      f.server.otherMacMade('!moon-other-mac:test')

      return { room_id: '!moon-new:test' }
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-other-mac:test', pointer: 'kept' })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.leave).toHaveBeenCalledExactlyOnceWith('!moon-new:test')
    expect(f.pointerWrites()).toEqual([])
    // Later opens in this session stay in that one chat.
    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-other-mac:test' })
    expect(f.create).toHaveBeenCalledOnce()
  })

  it('never leaves the room it made once something was written in it, and still opens the other Mac’s chat', async () => {
    const f = await freshSdk()
    f.server.madeHere('!moon-new:test', ['Chào bạn'])
    f.create.mockImplementation(async () => {
      f.server.otherMacMade('!moon-other-mac:test')

      return { room_id: '!moon-new:test' }
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-other-mac:test', pointer: 'kept' })
    expect(f.leave).not.toHaveBeenCalled()
  })

  it('reads the pointer back after writing it, and opens the other Mac’s chat when that write landed last', async () => {
    const f = await freshSdk()
    f.server.madeHere('!moon-new:test')
    vi.mocked(f.client.setAccountDataRaw).mockImplementation(async type => {
      // Neither Mac saw the other's room before writing; the other Mac's pointer lands just after.
      if (type === pointerType) {
        f.server.otherMacMade('!moon-other-mac:test')
      }

      return {}
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-other-mac:test', pointer: 'kept' })
    expect(f.leave).toHaveBeenCalledExactlyOnceWith('!moon-new:test')
    expect(f.latest().roomId).toBe('!moon-other-mac:test')
    // Later opens stay in that one chat; the room made here is not offered again.
    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-other-mac:test' })
    expect(f.create).toHaveBeenCalledOnce()
  })

  it('keeps its room after the read-back when it is no longer empty, or when emptiness cannot be read', async () => {
    for (const said of [['Chào bạn'], null]) {
      const f = await freshSdk()

      if (said) {
        f.server.madeHere('!moon-new:test', said)
      }

      vi.mocked(f.client.setAccountDataRaw).mockImplementation(async type => {
        if (type === pointerType) {
          f.server.otherMacMade('!moon-other-mac:test')
        }

        return {}
      })

      await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-other-mac:test' })
      expect(f.leave).not.toHaveBeenCalled()
      await f.sdk.stop()
    }
  })

  it('keeps the room it made when the server’s pointer still names it after the write', async () => {
    const f = await freshSdk()
    f.server.madeHere('!moon-new:test')
    vi.mocked(f.client.setAccountDataRaw).mockImplementation(async (type, content) => {
      if (type === pointerType) {
        f.server.held.pointer = content as Record<string, unknown>
        f.server.held.joined.push('!moon-new:test')
        f.server.held.state.set('!moon-new:test', [
          { type: 'io.atum.app_bot.dm', state_key: '', sender: owner, content: { v: 1, app_id: moon, bot_user_id: moonBot } },
          { type: EventType.RoomMember, state_key: owner, sender: owner, content: { membership: 'join' } },
          { type: EventType.RoomMember, state_key: moonBot, sender: owner, content: { membership: 'invite' } }
        ])
      }

      return {}
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-new:test',
      outcome: 'created',
      pointer: 'written'
    })
    expect(f.leave).not.toHaveBeenCalled()
  })

  it('still makes a room when the server’s pointer names one that does not work as Moon’s chat', async () => {
    for (const [members, encrypted] of [
      [{ [owner]: 'join', [moonBot]: 'join', '@carol:test': 'join' }, false],
      [{ [owner]: 'join', [moonBot]: 'leave' }, false],
      [{ [owner]: 'join', [moonBot]: 'join' }, true]
    ] as const) {
      const f = await freshSdk()
      f.server.otherMacMade('!moon-broken:test', members, encrypted)

      await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test', outcome: 'created' })
      expect(f.leave).not.toHaveBeenCalled()
      await f.sdk.stop()
    }
  })
})

describe('opening Moon after a restart', () => {
  it('reuses the room its pointer names even though someone else was once in it, and makes nothing new', async () => {
    const f = await freshSdk(async client => {
      // Rejected by 0.19.3 ("exactly two people ever"), which then made a new empty room.
      const chat = moonRoom(client, '!moon-history:test', { [moonBot]: 'join', '@carol:test': 'leave' })
      await said(chat, 1_000)
      pointMoonAt(client, chat.roomId)
      directWithMoon(client, [chat.roomId])
    })

    await expect(f.sdk.command(open)).resolves.toEqual({
      roomId: '!moon-history:test',
      outcome: 'reused',
      reason: 'pointer',
      joined: 1,
      left: 0,
      pointer: 'kept',
      shown: 'none'
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.latest().roomId).toBe('!moon-history:test')
    // Nothing to repair: no pointer write and no new m.direct entry.
    expect(f.pointerWrites()).toEqual([])
    expect(f.directWrites()).toEqual([])
    // The send check agrees: it is still Moon's chat.
    await expect(
      f.sdk.command({ kind: 'isOfficialAppBotDm', appId: moon, userId: owner, roomId: '!moon-history:test' })
    ).resolves.toBe(true)
  })

  it('opens the same room on every click and across a restart', async () => {
    const first = await freshSdk()
    const opened = (await first.sdk.command(open)) as { roomId: string; outcome: string }
    expect(opened).toMatchObject({ roomId: '!moon-new:test', outcome: 'created', reason: 'first_use' })
    expect(first.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-new:test', bot_user_id: moonBot }])
    await first.sdk.stop()

    // After the restart this device holds the room (sync) and the account holds its pointer.
    const second = await freshSdk(client => {
      moonRoom(client, opened.roomId)
      pointMoonAt(client, opened.roomId)
    })

    for (let click = 0; click < 10; click++) {
      await expect(second.sdk.command(open)).resolves.toMatchObject({ roomId: opened.roomId, outcome: 'reused' })
    }

    expect(second.create).not.toHaveBeenCalled()
  })

  it('opens one room for concurrent clicks while the new room is still on its way', async () => {
    const f = await freshSdk()
    f.sync.mode = 'manual'
    const created = deferred<{ room_id: string }>()
    f.create.mockReturnValue(created.promise)

    const first = f.sdk.command(open)
    const second = f.sdk.command(open)
    created.resolve({ room_id: '!moon:test' })

    // Both clicks wait for the same room, once.
    await vi.waitFor(() => expect(f.sync.waitingFor).toEqual(['!moon:test']), { timeout: 5_000 })
    f.sync.deliver('!moon:test')

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ roomId: '!moon:test' }),
      expect.objectContaining({ roomId: '!moon:test' })
    ])
    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon:test' })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.sync.waitingFor).toEqual(['!moon:test'])
  })

  it('opens the committed room when its pointer write briefly fails, and repairs the pointer', async () => {
    const f = await freshSdk()
    vi.mocked(f.client.setAccountDataRaw).mockRejectedValueOnce(new Error('temporary account data failure'))

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-new:test',
      outcome: 'created',
      pointer: 'write_failed'
    })
    expect(f.latest().roomId).toBe('!moon-new:test')
    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-new:test',
      outcome: 'recovered',
      reason: 'pointer_missing'
    })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.pointerWrites()).toContainEqual({ v: 1, room_id: '!moon-new:test', bot_user_id: moonBot })
  })

  it('recovers a working Moon chat when the pointer names a room the person left, and never tries to rejoin it', async () => {
    const f = await freshSdk(async client => {
      // The left room is not held after a restart; only the pointer and m.direct remember it.
      const kept = moonRoom(client, '!moon-kept:test')
      await said(kept, 2_000)
      pointMoonAt(client, '!moon-left:test')
      directWithMoon(client, ['!moon-left:test', kept.roomId])
    })

    await expect(f.sdk.command(open)).resolves.toEqual({
      roomId: '!moon-kept:test',
      outcome: 'recovered',
      reason: 'pointer_left',
      joined: 1,
      left: 1,
      pointer: 'written',
      shown: 'none'
    })
    expect(f.join).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-kept:test', bot_user_id: moonBot }])
  })

  it('prefers the Moon chat with messages over an empty one the pointer names', async () => {
    const f = await freshSdk(async client => {
      moonRoom(client, '!moon-empty:test')
      await said(moonRoom(client, '!moon-talked:test'), 3_000)
      pointMoonAt(client, '!moon-empty:test')
    })

    // The roster's row already points at the room a click opens.
    expect(f.room('!moon-talked:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot, current: true })
    expect(f.room('!moon-empty:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot })
    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-talked:test',
      outcome: 'recovered',
      reason: 'pointer_empty'
    })
  })

  it('makes a new room only when every earlier one was left, without attempting a join the server refuses', async () => {
    const f = await freshSdk(client => {
      pointMoonAt(client, '!moon-left:test')
      directWithMoon(client, ['!moon-left:test', '!moon-older:test'])
    })

    await expect(f.sdk.command(open)).resolves.toEqual({
      roomId: '!moon-new:test',
      outcome: 'rejoin_impossible',
      reason: 'invite_only',
      joined: 1,
      left: 2,
      pointer: 'written',
      shown: 'none'
    })
    expect(f.join).not.toHaveBeenCalled()
    expect(f.create).toHaveBeenCalledOnce()
  })

  it('joins the room the person left when Moon has invited them back', async () => {
    const f = await freshSdk(client => {
      heldRoom(client, '!moon-back:test', 'invite', moonBot)
      pointMoonAt(client, '!moon-back:test')
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-back:test',
      outcome: 'rejoined',
      reason: 'invited'
    })
    expect(f.join).toHaveBeenCalledWith('!moon-back:test')
    expect(f.create).not.toHaveBeenCalled()
  })

  it('joins the room Moon invited the person back to over the empty room the pointer names, and draws one row', async () => {
    const f = await freshSdk(client => {
      // The owner's data after 0.19.3: the pointer names the empty room made after a restart,
      // and Moon has invited the person back into the older room that holds their history.
      moonRoom(client, '!moon-empty:test')
      heldRoom(client, '!moon-history:test', 'invite', moonBot)
      pointMoonAt(client, '!moon-empty:test')
      directWithMoon(client, ['!moon-history:test', '!moon-empty:test'])
    })

    // Before the click the roster already folds the invitation into Moon's row, and the row
    // opens it: no second "Moon" row.
    expect(f.room('!moon-history:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot, current: true })
    expect(f.room('!moon-empty:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot })
    const roster = projectMatrixRoster({
      ...f.latest(),
      apps: { state: 'ready', apps: [moonApp], connections: {} },
      appShortcuts: { [moon]: { visibility: 'default', status: 'ready' } }
    })
    expect(roster.apps).toEqual([{ app: moonApp, room: expect.objectContaining({ id: '!moon-history:test' }) }])
    expect(roster.rest.map(room => room.id)).not.toContain('!moon-history:test')
    expect(roster.rest.map(room => room.id)).not.toContain('!moon-empty:test')

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-history:test',
      outcome: 'rejoined',
      reason: 'invited',
      pointer: 'written'
    })
    expect(f.join).toHaveBeenCalledWith('!moon-history:test')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-history:test', bot_user_id: moonBot }])
    expect(f.latest().roomId).toBe('!moon-history:test')
  })

  it('keeps the person in the Moon chat they are talking in, beside an invitation into an older room', async () => {
    const f = await freshSdk(async client => {
      await said(moonRoom(client, '!moon-talked:test'), 5_000)
      heldRoom(client, '!moon-history:test', 'invite', moonBot)
      pointMoonAt(client, '!moon-talked:test')
      directWithMoon(client, ['!moon-history:test', '!moon-talked:test'])
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-talked:test', outcome: 'reused' })
    expect(f.join).not.toHaveBeenCalled()
    // Still drawn in Moon's row, never as a row of its own.
    expect(f.room('!moon-history:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot })
  })

  it('folds an invitation from Moon into its row even when every earlier Moon chat was left', async () => {
    const f = await freshSdk(client => {
      heldRoom(client, '!moon-history:test', 'invite', moonBot)
      pointMoonAt(client, '!moon-left:test')
      directWithMoon(client, ['!moon-left:test', '!moon-history:test'])
    })

    expect(f.room('!moon-history:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot, current: true })
  })

  it('opens a deleted Moon chat even when showing it again fails, and says so', async () => {
    const f = await freshSdk(async client => {
      const chat = moonRoom(client, '!moon:test')
      await said(chat, 1_000)
      pointMoonAt(client, chat.roomId)
    })

    await f.sdk.command({ kind: 'forget', roomId: '!moon:test' })
    vi.mocked(f.client.setRoomAccountData).mockRejectedValueOnce(new Error('temporary account data failure'))

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon:test', outcome: 'reused', shown: 'failed' })
    expect(f.latest().roomId).toBe('!moon:test')
  })

  it('does not join an invitation someone else sent into the pointer room, nor fold it into Moon\u2019s row', async () => {
    const f = await freshSdk(client => {
      heldRoom(client, '!moon-back:test', 'invite', '@stranger:test')
      pointMoonAt(client, '!moon-back:test')
      directWithMoon(client, ['!moon-back:test'])
    })

    expect(f.room('!moon-back:test')?.appBot).toBeUndefined()

    await expect(f.sdk.command(open)).resolves.toMatchObject({ outcome: 'created', reason: 'no_usable_room' })
    expect(f.join).not.toHaveBeenCalled()
  })

  it('makes a new room when Moon has left the old one, which then stays an ordinary chat', async () => {
    const f = await freshSdk(client => {
      moonRoom(client, '!moon-gone:test', { [moonBot]: 'leave' })
      pointMoonAt(client, '!moon-gone:test')
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-new:test',
      outcome: 'created',
      reason: 'no_usable_room'
    })
    expect(f.room('!moon-gone:test')?.appBot).toBeUndefined()
    await expect(
      f.sdk.command({ kind: 'isOfficialAppBotDm', appId: moon, userId: owner, roomId: '!moon-gone:test' })
    ).resolves.toBe(false)
  })

  it('does not take a room someone else made to look like a Moon chat', async () => {
    const f = await freshSdk(client => {
      const forged = heldRoom(client, '!forged:test')
      forged.currentState.setStateEvents([
        new MatrixEvent({ type: EventType.RoomMember, state_key: moonBot, room_id: forged.roomId, sender: moonBot, content: { membership: 'join' } }),
        new MatrixEvent({
          type: 'io.atum.app_bot.dm',
          state_key: '',
          room_id: forged.roomId,
          sender: moonBot,
          content: { v: 1, app_id: moon, bot_user_id: moonBot }
        })
      ])
      pointMoonAt(client, forged.roomId)
    })

    expect(f.room('!forged:test')?.appBot).toBeUndefined()
    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test', outcome: 'created' })
  })
})

// 0.20 (owner decision D1): the bot's chat is a plain room. An encrypted one made before is left
// once (`moved`), and every later open reuses the plain one.
describe('moving Moon out of an encrypted chat', () => {
  const movedNote = (f: Awaited<ReturnType<typeof freshSdk>>) =>
    vi
      .mocked(f.client.setRoomAccountData)
      .mock.calls.filter(([, type]) => (type as string) === 'io.atum.app_bot.legacy_moved')

  it('marks the encrypted chat the pointer names as moved, makes one plain chat, and reuses it afterwards', async () => {
    const f = await freshSdk(async client => {
      const old = moonRoom(client, '!moon-old:test', undefined, true)
      await said(old, 1_000)
      pointMoonAt(client, old.roomId)
      directWithMoon(client, [old.roomId])
    })

    await expect(f.sdk.command(open)).resolves.toEqual({
      roomId: '!moon-new:test',
      outcome: 'moved',
      reason: 'pointer_encrypted',
      joined: 1,
      left: 0,
      pointer: 'written',
      shown: 'none'
    })
    expect(f.create).toHaveBeenCalledOnce()
    // The new chat is plain: no encryption in what the room is made with.
    const made = f.create.mock.calls[0]![0]
    expect(made.initial_state?.some(event => event.type === EventType.RoomEncryption)).toBe(false)
    expect(movedNote(f)).toEqual([
      [
        '!moon-old:test',
        'io.atum.app_bot.legacy_moved',
        { v: 1, app_id: moon, bot_user_id: moonBot, moved_at: expect.any(Number) }
      ]
    ])
    // The old chat carries its moved record at once, and is no longer the chat Moon's row opens.
    expect(f.room('!moon-old:test')?.legacyAppBotMoved).toEqual({
      appId: moon,
      botUserId: moonBot,
      movedAt: expect.any(Number)
    })
    expect(f.room('!moon-old:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot })

    for (let click = 0; click < 10; click++) {
      await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test' })
    }

    expect(f.create).toHaveBeenCalledOnce()
    expect(movedNote(f)).toHaveLength(1)
  })

  // After a restart the old chat's encryption state may not have synced yet while the crypto
  // store already knows it: still the encrypted chat, from this device's rooms and from the server's
  // pointer alike.
  it('moves out of an encrypted chat whose encryption state has not synced, never reusing it as the plain chat', async () => {
    const f = await freshSdk(async (client, encryptedInStore) => {
      const old = moonRoom(client, '!moon-old:test')
      encryptedInStore.add(old.roomId)
      await said(old, 1_000)
      pointMoonAt(client, old.roomId)
    })

    f.server.held.pointer = { v: 1, room_id: '!moon-old:test', bot_user_id: moonBot }

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-new:test',
      outcome: 'moved',
      reason: 'pointer_encrypted',
      pointer: 'written'
    })
    expect(movedNote(f).map(([roomId]) => roomId)).toEqual(['!moon-old:test'])
  })

  it('reuses a plain chat as before when the crypto store agrees it is plain', async () => {
    const f = await freshSdk(async client => {
      const chat = moonRoom(client, '!moon-plain:test')
      await said(chat, 1_000)
      pointMoonAt(client, chat.roomId)
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-plain:test', outcome: 'reused' })
    expect(f.create).not.toHaveBeenCalled()
  })

  it('moves at most once across a restart: the plain chat wins over the encrypted pointer', async () => {
    const f = await freshSdk(async client => {
      const old = moonRoom(client, '!moon-old:test', undefined, true)
      await said(old, 9_000)
      moonRoom(client, '!moon-plain:test')
      pointMoonAt(client, old.roomId)
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-plain:test',
      outcome: 'recovered',
      reason: 'pointer_encrypted',
      pointer: 'written'
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(movedNote(f)).toEqual([])
    expect(f.room('!moon-plain:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot, current: true })

    // The row opens the plain chat; the encrypted one with the history is listed as an ordinary
    // chat (and so in ⌘K), never lost from sight.
    const roster = projectMatrixRoster({
      ...f.latest(),
      apps: { state: 'ready', apps: [moonApp], connections: {} },
      appShortcuts: { [moon]: { visibility: 'default', status: 'ready' } }
    })
    expect(roster.apps?.map(({ room }) => room?.id)).toEqual(['!moon-plain:test'])
    expect(roster.rest.map(room => room.id)).toContain('!moon-old:test')
    expect(roster.rest.map(room => room.id)).not.toContain('!moon-plain:test')
  })

  it('moves out of an encrypted chat the pointer does not name, with the most history', async () => {
    const f = await freshSdk(async client => {
      await said(moonRoom(client, '!moon-older:test', undefined, true), 1_000)
      await said(moonRoom(client, '!moon-recent:test', undefined, true), 5_000)
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-new:test',
      outcome: 'moved',
      reason: 'pointer_missing'
    })
    expect(movedNote(f).map(([roomId]) => roomId)).toEqual(['!moon-recent:test'])
  })

  it('still moves when the moved note cannot be written; the note is display only', async () => {
    const f = await freshSdk(async client => {
      const old = moonRoom(client, '!moon-old:test', undefined, true)
      pointMoonAt(client, old.roomId)
    })

    vi.mocked(f.client.setRoomAccountData).mockRejectedValueOnce(new Error('temporary account data failure'))

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test', outcome: 'moved' })
    expect(f.create).toHaveBeenCalledOnce()
  })

  it('does not join an encrypted room Moon invited the person back to; it makes a plain chat', async () => {
    const f = await freshSdk(client => {
      heldRoom(client, '!moon-back:test', 'invite', moonBot, true)
      pointMoonAt(client, '!moon-back:test')
      directWithMoon(client, ['!moon-back:test'])
    })

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test', outcome: 'created' })
    expect(f.join).not.toHaveBeenCalled()
  })

  it('keeps a plain chat usable for the send check, and no longer an encrypted one it moved out of', async () => {
    const f = await freshSdk(async client => {
      const old = moonRoom(client, '!moon-old:test', undefined, true)
      pointMoonAt(client, old.roomId)
    })

    // Before the move the pointer names a working chat (encrypted, before 0.20).
    await expect(
      f.sdk.command({ kind: 'isOfficialAppBotDm', appId: moon, userId: owner, roomId: '!moon-old:test' })
    ).resolves.toBe(true)
    await f.sdk.command(open)
    // Sync brings the new chat and the pointer written to it.
    moonRoom(f.client, '!moon-new:test')
    pointMoonAt(f.client, '!moon-new:test')
    await expect(
      f.sdk.command({ kind: 'isOfficialAppBotDm', appId: moon, userId: owner, roomId: '!moon-new:test' })
    ).resolves.toBe(true)
    await expect(
      f.sdk.command({ kind: 'isOfficialAppBotDm', appId: moon, userId: owner, roomId: '!moon-old:test' })
    ).resolves.toBe(false)
  })
})

describe('Delete chat on Moon', () => {
  it('keeps the room out of sight instead of leaving it, and opening Moon again shows the same room', async () => {
    const f = await freshSdk(async client => {
      const chat = moonRoom(client, '!moon:test')
      await said(chat, 1_000)
      pointMoonAt(client, chat.roomId)
    })

    await f.sdk.command({ kind: 'select', roomId: '!moon:test' })

    await expect(f.sdk.command({ kind: 'forget', roomId: '!moon:test' })).resolves.toEqual({
      outcome: 'hidden',
      appId: moon
    })
    expect(f.leave).not.toHaveBeenCalled()
    expect(f.forget).not.toHaveBeenCalled()
    expect(f.client.getRoom('!moon:test')?.getMyMembership()).toBe('join')
    expect(f.latest().roomId).toBeNull()
    expect(f.room('!moon:test')?.appBot).toEqual({ appId: moon, botUserId: moonBot, current: true, hidden: true })

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon:test', outcome: 'reused', shown: 'shown' })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.client.setRoomAccountData).toHaveBeenLastCalledWith('!moon:test', 'io.atum.app_bot.hidden', {})
    expect(f.latest().roomId).toBe('!moon:test')
    expect(f.room('!moon:test')?.appBot?.hidden).toBeUndefined()
  })

  it('shows a deleted chat again when something new arrives in it', async () => {
    const f = await freshSdk(async client => {
      const chat = moonRoom(client, '!moon:test')
      await said(chat, 1_000)
      pointMoonAt(client, chat.roomId)
    })

    await f.sdk.command({ kind: 'forget', roomId: '!moon:test' })
    expect(f.room('!moon:test')?.appBot?.hidden).toBe(true)

    await said(f.client.getRoom('!moon:test')!, Date.now() + 60_000)
    await vi.waitFor(() => expect(f.room('!moon:test')?.appBot?.hidden).toBeUndefined())
  })

  it('still leaves and forgets an ordinary chat', async () => {
    const f = await freshSdk(client => {
      heldRoom(client, '!friends:test')
    })

    await expect(f.sdk.command({ kind: 'forget', roomId: '!friends:test' })).resolves.toBeNull()
    expect(f.leave).toHaveBeenCalledWith('!friends:test')
    expect(f.forget).toHaveBeenCalledWith('!friends:test', true)
  })
})

describe('opening the chat of an app this client has no code for', () => {
  // The catalog admits an app id of any UUID version; Moon's and Andy's happen to be version 4.
  const acme = '0192f4a0-7c3b-7d4e-8a1b-2c3d4e5f6a7b'
  const acmeBot = '@app-acme:test'
  const openAcme = { kind: 'openAppBotDm' as const, appId: acme, botUserId: acmeBot }

  it('makes the one plain chat with its bot, marked for its app, and opens it', async () => {
    const f = await freshSdk()
    f.create.mockResolvedValue({ room_id: '!acme-new:test' })

    await expect(f.sdk.command(openAcme)).resolves.toMatchObject({
      roomId: '!acme-new:test',
      outcome: 'created',
      reason: 'first_use',
      pointer: 'written'
    })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.create.mock.calls[0]![0]).toMatchObject({
      is_direct: true,
      invite: [acmeBot],
      initial_state: expect.arrayContaining([
        expect.objectContaining({
          type: 'io.atum.app_bot.dm',
          content: { v: 1, app_id: acme, bot_user_id: acmeBot }
        })
      ])
    })
    expect(f.client.setAccountDataRaw).toHaveBeenCalledWith(`io.atum.app_bot.dm.${acme}`, {
      v: 1,
      room_id: '!acme-new:test',
      bot_user_id: acmeBot
    })
    expect(f.latest().roomId).toBe('!acme-new:test')
  })

  it('opens that same chat on every later click, whoever the bot is', async () => {
    const first = await freshSdk()
    first.create.mockResolvedValue({ room_id: '!acme-new:test' })
    await first.sdk.command(openAcme)
    await first.sdk.stop()

    const second = await freshSdk(client => {
      const room = heldRoom(client, '!acme-new:test')
      room.currentState.setStateEvents([
        new MatrixEvent({
          type: EventType.RoomMember,
          state_key: acmeBot,
          room_id: '!acme-new:test',
          sender: owner,
          content: { membership: 'join' }
        }),
        new MatrixEvent({
          type: 'io.atum.app_bot.dm',
          state_key: '',
          room_id: '!acme-new:test',
          sender: owner,
          content: { v: 1, app_id: acme, bot_user_id: acmeBot }
        })
      ])
      accountData(client, `io.atum.app_bot.dm.${acme}`, { v: 1, room_id: '!acme-new:test', bot_user_id: acmeBot })
    })

    await expect(second.sdk.command(openAcme)).resolves.toMatchObject({
      roomId: '!acme-new:test',
      outcome: 'reused'
    })
    expect(second.create).not.toHaveBeenCalled()
  })

  it('refuses what is not an app id or a bot identity, before touching the account', async () => {
    const f = await freshSdk()

    for (const bad of [
      { ...openAcme, appId: 'acme' },
      { ...openAcme, appId: acme.replace(/-/gu, '') },
      { ...openAcme, botUserId: 'acme' },
      { ...openAcme, botUserId: '@acme' }
    ]) {
      await expect(f.sdk.command(bad)).rejects.toThrow('matrix_app_bot_dm_invalid')
    }

    expect(f.create).not.toHaveBeenCalled()
  })
})

// The platform names the bot's chat when several devices may start at once
// (`POST /api/matrix/v1/apps/{slug}/bot/start`, spec/canonical-room/v1.1; the order of the steps is
// electron/matrix/app-bots/platform-room.ts). The SDK keeps four steps and decides none of them:
// find a chat to offer, make a candidate, open the room the platform names, leave a candidate that lost.
describe('the steps the platform leaves to this Mac', () => {
  const find = { kind: 'findAppBotDm' as const, appId: moon, botUserId: moonBot }
  const make = { kind: 'makeAppBotDm' as const, appId: moon, botUserId: moonBot }
  const leaveRoom = (roomId: string) => ({ kind: 'leaveAppBotDm' as const, appId: moon, botUserId: moonBot, roomId })

  const openRoom = (roomId: string, selection?: number) => ({
    kind: 'openAppBotRoom' as const,
    appId: moon,
    botUserId: moonBot,
    roomId,
    ...(selection === undefined ? {} : { selection })
  })

  /** A room as the server's state lists it for the account: the person, the bot, its marker. */
  function serverRoom({
    members = { [owner]: 'join', [moonBot]: 'join' },
    encrypted = false,
    marker = 'own'
  }: {
    members?: Record<string, string>
    encrypted?: boolean
    /** `own`: the account's; `bot`: set by the bot; `none`; `other`: names another app. */
    marker?: 'own' | 'bot' | 'none' | 'other'
  } = {}) {
    return [
      { type: EventType.RoomCreate, state_key: '', sender: owner, content: {} },
      ...(marker === 'none'
        ? []
        : [
            {
              type: 'io.atum.app_bot.dm',
              state_key: '',
              sender: marker === 'bot' ? moonBot : owner,
              content: { v: 1, app_id: marker === 'other' ? '00000000-0000-4000-8000-87d96e07d1bf' : moon, bot_user_id: moonBot }
            }
          ]),
      ...(encrypted
        ? [{ type: EventType.RoomEncryption, state_key: '', sender: owner, content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
        : []),
      ...Object.entries(members).map(([userId, membership]) => ({
        type: EventType.RoomMember,
        state_key: userId,
        sender: owner,
        content: { membership }
      }))
    ]
  }

  const markerWrites = (f: Awaited<ReturnType<typeof freshSdk>>) =>
    vi.mocked(f.client.sendStateEvent).mock.calls.filter(([, type]) => (type as string) === 'io.atum.app_bot.dm')

  /** A fresh SDK that can write room state, for the room-opening steps. */
  async function sdkWithState(prepare?: Parameters<typeof freshSdk>[0]) {
    const f = await freshSdk(prepare)
    vi.spyOn(f.client, 'sendStateEvent').mockResolvedValue({ event_id: '$marker' })

    return f
  }

  describe('finding a chat to offer', () => {
    it('offers the plain chat the account already has, and only looks', async () => {
      const f = await freshSdk(async client => {
        const chat = moonRoom(client, '!moon-history:test')
        await said(chat, 1_000)
        pointMoonAt(client, chat.roomId)
        directWithMoon(client, [chat.roomId])
      })

      const before = f.latest().roomId

      await expect(f.sdk.command(find)).resolves.toEqual({
        roomId: '!moon-history:test',
        selection: expect.any(Number)
      })
      expect(f.create).not.toHaveBeenCalled()
      expect(f.join).not.toHaveBeenCalled()
      expect(f.leave).not.toHaveBeenCalled()
      expect(f.pointerWrites()).toEqual([])
      expect(f.directWrites()).toEqual([])
      expect(f.latest().roomId).toBe(before)
    })

    it.each([
      [
        'there is no chat',
        () => {}
      ],
      [
        'the only chat has end-to-end encryption (made before 0.20)',
        async (client: MatrixClient) => {
          const old = moonRoom(client, '!moon-old:test', undefined, true)
          await said(old, 1_000)
          pointMoonAt(client, old.roomId)
        }
      ],
      [
        'the only chat is one the person left',
        (client: MatrixClient) => {
          pointMoonAt(client, '!moon-left:test')
          directWithMoon(client, ['!moon-left:test'])
        }
      ],
      [
        'the bot has only invited the person back to a chat',
        (client: MatrixClient) => {
          heldRoom(client, '!moon-invite:test', 'invite', moonBot)
          directWithMoon(client, ['!moon-invite:test'])
        }
      ]
    ])('offers nothing when %s', async (_case, prepare) => {
      const f = await freshSdk(prepare)

      await expect(f.sdk.command(find)).resolves.toEqual({ roomId: null, selection: expect.any(Number) })
      expect(f.create).not.toHaveBeenCalled()
      expect(f.join).not.toHaveBeenCalled()
    })

    it('offers nothing for a chat whose encryption has not synced but the crypto store knows', async () => {
      const f = await freshSdk(async (client, encryptedInStore) => {
        const old = moonRoom(client, '!moon-old:test')
        encryptedInStore.add(old.roomId)
        await said(old, 1_000)
        pointMoonAt(client, old.roomId)
      })

      await expect(f.sdk.command(find)).resolves.toMatchObject({ roomId: null })
    })
  })

  describe('making a candidate', () => {
    it('makes one plain, direct chat with the bot and its marker, and selects and points at nothing', async () => {
      const f = await freshSdk()
      const before = f.latest().roomId

      await expect(f.sdk.command(make)).resolves.toEqual({ roomId: '!moon-new:test', moved: false })
      expect(f.create).toHaveBeenCalledOnce()

      const made = f.create.mock.calls[0]![0]

      expect(made).toMatchObject({
        is_direct: true,
        invite: [moonBot],
        preset: 'private_chat',
        initial_state: expect.arrayContaining([
          expect.objectContaining({
            type: 'io.atum.app_bot.dm',
            state_key: '',
            content: { v: 1, app_id: moon, bot_user_id: moonBot }
          })
        ])
      })
      expect(made.initial_state?.some(event => event.type === EventType.RoomEncryption)).toBe(false)
      // Nothing follows until the platform keeps it: a loser leaves no pointer or direct entry behind.
      expect(f.latest().roomId).toBe(before)
      expect(f.pointerWrites()).toEqual([])
      expect(f.directWrites()).toEqual([])
    })

    it('offers the candidate it made before sync brings it, instead of making another', async () => {
      const f = await freshSdk()
      await f.sdk.command(make)

      await expect(f.sdk.command(find)).resolves.toMatchObject({ roomId: '!moon-new:test' })
      expect(f.create).toHaveBeenCalledOnce()
    })

    it('marks an encrypted chat from before 0.20 as moved, and says so', async () => {
      const f = await freshSdk(async client => {
        const old = moonRoom(client, '!moon-old:test', undefined, true)
        await said(old, 1_000)
        pointMoonAt(client, old.roomId)
      })

      await expect(f.sdk.command(make)).resolves.toEqual({ roomId: '!moon-new:test', moved: true })
      expect(
        vi
          .mocked(f.client.setRoomAccountData)
          .mock.calls.filter(([, type]) => (type as string) === 'io.atum.app_bot.legacy_moved')
          .map(([roomId]) => roomId)
      ).toEqual(['!moon-old:test'])
    })

    it('makes a new chat even when it holds one the platform refused: the choice is the platform’s', async () => {
      const f = await freshSdk(client => {
        const chat = moonRoom(client, '!moon-history:test')
        pointMoonAt(client, chat.roomId)
      })

      await expect(f.sdk.command(make)).resolves.toEqual({ roomId: '!moon-new:test', moved: false })
      expect(f.create).toHaveBeenCalledOnce()
    })
  })

  describe('opening the room the platform named', () => {
    it('opens a room another device made: its pointer and direct entry follow, and it is selected', async () => {
      const f = await sdkWithState()
      f.server.held.state.set('!moon-other:test', serverRoom())

      await expect(f.sdk.command(openRoom('!moon-other:test'))).resolves.toEqual({
        roomId: '!moon-other:test',
        outcome: 'recovered',
        reason: 'canonical',
        joined: 1,
        left: 0,
        pointer: 'written',
        shown: 'none'
      })
      expect(f.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-other:test', bot_user_id: moonBot }])
      expect(f.directWrites()).toHaveLength(1)
      expect(f.latest().roomId).toBe('!moon-other:test')
      expect(f.create).not.toHaveBeenCalled()
      // The account's marker is there already: nothing to repair.
      expect(markerWrites(f)).toEqual([])
    })

    it('reuses the room the account’s pointer already names, and writes nothing', async () => {
      const f = await sdkWithState(client => {
        const chat = moonRoom(client, '!moon-history:test')
        pointMoonAt(client, chat.roomId)
        directWithMoon(client, [chat.roomId])
      })

      f.server.held.state.set('!moon-history:test', serverRoom())

      await expect(f.sdk.command(openRoom('!moon-history:test'))).resolves.toMatchObject({
        roomId: '!moon-history:test',
        outcome: 'reused',
        reason: 'canonical',
        pointer: 'kept'
      })
      expect(f.pointerWrites()).toEqual([])
      expect(f.directWrites()).toEqual([])
      expect(f.latest().roomId).toBe('!moon-history:test')
    })

    it('says the room this Mac made was created, once the platform keeps it', async () => {
      const f = await sdkWithState()
      const made = (await f.sdk.command(make)) as { roomId: string }
      f.server.held.state.set(made.roomId, serverRoom())

      await expect(f.sdk.command(openRoom(made.roomId))).resolves.toMatchObject({
        roomId: made.roomId,
        outcome: 'created',
        reason: 'canonical',
        pointer: 'written'
      })
      expect(f.pointerWrites()).toEqual([{ v: 1, room_id: made.roomId, bot_user_id: moonBot }])
      expect(f.latest().roomId).toBe(made.roomId)
    })

    it('marks a room another client made without the account’s marker, so it is recognised as the bot’s chat', async () => {
      for (const marker of ['none', 'bot'] as const) {
        const f = await sdkWithState()
        f.server.held.state.set('!moon-phone:test', serverRoom({ marker }))

        await expect(f.sdk.command(openRoom('!moon-phone:test'))).resolves.toMatchObject({ roomId: '!moon-phone:test' })
        expect(markerWrites(f)).toEqual([
          ['!moon-phone:test', 'io.atum.app_bot.dm', { v: 1, app_id: moon, bot_user_id: moonBot }, '']
        ])
        await f.sdk.stop()
      }
    })

    it('opens a room whose bot has only been invited, as the local rule does', async () => {
      const f = await sdkWithState()
      f.server.held.state.set('!moon-other:test', serverRoom({ members: { [owner]: 'join', [moonBot]: 'invite' } }))

      await expect(f.sdk.command(openRoom('!moon-other:test'))).resolves.toMatchObject({ roomId: '!moon-other:test' })
    })

    it('never opens an encrypted room as the bot’s chat, and changes nothing', async () => {
      const f = await sdkWithState()
      f.server.held.state.set('!moon-old:test', serverRoom({ encrypted: true }))
      const before = f.latest().roomId

      await expect(f.sdk.command(openRoom('!moon-old:test'))).rejects.toThrow('matrix_app_bot_dm_encrypted')
      expect(f.pointerWrites()).toEqual([])
      expect(f.directWrites()).toEqual([])
      expect(markerWrites(f)).toEqual([])
      expect(f.latest().roomId).toBe(before)
    })

    it.each([
      ['a third person in it', serverRoom({ members: { [owner]: 'join', [moonBot]: 'join', '@carol:test': 'join' } })],
      ['a third person invited to it', serverRoom({ members: { [owner]: 'join', [moonBot]: 'join', '@carol:test': 'invite' } })],
      ['the bot not in it', serverRoom({ members: { [owner]: 'join', [moonBot]: 'leave' } })],
      ['the person only invited', serverRoom({ members: { [owner]: 'invite', [moonBot]: 'join' } })],
      ['a marker for another app', serverRoom({ marker: 'other' })]
    ])('is not the bot’s one-to-one chat with %s', async (_case, state) => {
      const f = await sdkWithState()
      f.server.held.state.set('!moon-odd:test', state)
      const before = f.latest().roomId

      await expect(f.sdk.command(openRoom('!moon-odd:test'))).rejects.toThrow('matrix_app_bot_dm_invalid')
      expect(f.pointerWrites()).toEqual([])
      expect(markerWrites(f)).toEqual([])
      expect(f.latest().roomId).toBe(before)
    })

    it('says a room the server will not show the person is not their chat, and a failed read is only a retry', async () => {
      const f = await sdkWithState()

      vi.mocked(f.client.http.authedRequest).mockImplementationOnce(async () => {
        throw Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' })
      })
      await expect(f.sdk.command(openRoom('!moon-left:test'))).rejects.toThrow('matrix_app_bot_dm_invalid')

      // Not a room the fixture's server holds: the read fails the way an outage does.
      await expect(f.sdk.command(openRoom('!moon-unread:test'))).rejects.toThrow('matrix_app_bot_resting')

      // A marker that cannot be written is the same: forbidden is no chat, anything else is a retry.
      f.server.held.state.set('!moon-phone:test', serverRoom({ marker: 'none' }))
      vi.mocked(f.client.sendStateEvent).mockRejectedValueOnce(
        Object.assign(new Error('no power'), { errcode: 'M_FORBIDDEN' })
      )
      await expect(f.sdk.command(openRoom('!moon-phone:test'))).rejects.toThrow('matrix_app_bot_dm_invalid')
      vi.mocked(f.client.sendStateEvent).mockRejectedValueOnce(new Error('offline'))
      await expect(f.sdk.command(openRoom('!moon-phone:test'))).rejects.toThrow('matrix_app_bot_resting')
      expect(f.pointerWrites()).toEqual([])
    })

    it('does not take the selection back from a room the person chose while it was deciding', async () => {
      const f = await sdkWithState(client => {
        heldRoom(client, '!elsewhere:test')
      })

      f.server.held.state.set('!moon-other:test', serverRoom())

      const { selection } = (await f.sdk.command(find)) as { selection: number }
      await f.sdk.command({ kind: 'select', roomId: '!elsewhere:test' })

      // The chat still opens for the person who asks again, and its records follow; the selection does not move.
      await expect(f.sdk.command(openRoom('!moon-other:test', selection))).resolves.toMatchObject({
        roomId: '!moon-other:test',
        pointer: 'written'
      })
      expect(f.latest().roomId).toBe('!elsewhere:test')

      // With the selection as it is now, it is selected.
      await f.sdk.command(openRoom('!moon-other:test'))
      expect(f.latest().roomId).toBe('!moon-other:test')
    })

    it('keeps the person where they were until sync has brought a room another device made, then selects it', async () => {
      const f = await sdkWithState(client => {
        heldRoom(client, '!elsewhere:test')
      })

      await f.sdk.command({ kind: 'select', roomId: '!elsewhere:test' })
      f.server.held.state.set('!moon-other:test', serverRoom())
      f.sync.mode = 'manual'

      let settled = false
      const opening = f.sdk.command(openRoom('!moon-other:test')).finally(() => (settled = true))
      await vi.waitFor(() => expect(f.sync.waitingFor).toEqual(['!moon-other:test']), { timeout: 5_000 })

      // The platform kept it, so its records follow, but the window is not sent to a room it cannot draw.
      expect(f.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-other:test', bot_user_id: moonBot }])
      expect(f.latest().roomId).toBe('!elsewhere:test')
      expect(settled).toBe(false)

      f.sync.deliver('!moon-other:test')
      await expect(opening).resolves.toMatchObject({ roomId: '!moon-other:test', outcome: 'recovered' })
      expect(f.latest().roomId).toBe('!moon-other:test')
      expect(f.room('!moon-other:test')).toBeDefined()
      expect(f.snapshots.every(drawn)).toBe(true)
    })

    it('fails closed when sync never brings the room this Mac made, offers it again, and opens it on the retry', async () => {
      const f = await sdkWithState()
      f.sync.mode = 'never'
      const made = (await f.sdk.command(make)) as { roomId: string }
      f.server.held.state.set(made.roomId, serverRoom())

      await expectWaitRunsOut(f, openRoom(made.roomId), [made.roomId])

      // Nothing was selected, and the person was not told it opened.
      expect(f.latest().roomId).toBeNull()
      expect(f.snapshots.every(drawn)).toBe(true)
      // The platform kept the room, so its records are there for the retry.
      expect(f.pointerWrites()).toEqual([{ v: 1, room_id: made.roomId, bot_user_id: moonBot }])
      // The next start offers that same room, and no second one is made.
      await expect(f.sdk.command(find)).resolves.toMatchObject({ roomId: made.roomId })

      f.sync.mode = 'auto'
      await expect(f.sdk.command(openRoom(made.roomId))).resolves.toMatchObject({ roomId: made.roomId })
      expect(f.latest().roomId).toBe(made.roomId)
      expect(f.create).toHaveBeenCalledOnce()
    })

    it('does not fail, or take the selection, when the person has gone elsewhere and the room never comes', async () => {
      const f = await sdkWithState(client => {
        heldRoom(client, '!elsewhere:test')
      })

      f.server.held.state.set('!moon-other:test', serverRoom())
      f.sync.mode = 'never'
      vi.useFakeTimers()

      try {
        const { selection } = (await f.sdk.command(find)) as { selection: number }
        const opening = f.sdk.command(openRoom('!moon-other:test', selection))
        await settle(() => f.sync.waitingFor.length > 0)

        await f.sdk.command({ kind: 'select', roomId: '!elsewhere:test' })
        await vi.advanceTimersByTimeAsync(APP_BOT_ROOM_WAIT_MS)

        await expect(opening).resolves.toMatchObject({ roomId: '!moon-other:test' })
        expect(f.latest().roomId).toBe('!elsewhere:test')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('leaving a candidate that lost', () => {
    it('leaves it while nobody has written in it, and forgets it', async () => {
      const f = await freshSdk()
      f.server.madeHere('!moon-new:test')
      await f.sdk.command(make)

      await expect(f.sdk.command(leaveRoom('!moon-new:test'))).resolves.toEqual({ left: true })
      expect(f.leave).toHaveBeenCalledExactlyOnceWith('!moon-new:test')
      // No longer offered: the next find does not return the room that was left.
      await expect(f.sdk.command(find)).resolves.toMatchObject({ roomId: null })
    })

    it('never leaves a room anyone has written in, or one whose history cannot be read', async () => {
      for (const said of [['Chào bạn'], null]) {
        const f = await freshSdk()

        if (said) {
          f.server.madeHere('!moon-new:test', said)
        }

        await expect(f.sdk.command(leaveRoom('!moon-new:test'))).resolves.toEqual({ left: false })
        expect(f.leave).not.toHaveBeenCalled()
        await f.sdk.stop()
      }
    })

    it('never leaves the chat the account’s pointer names, as the server has it', async () => {
      const f = await freshSdk(client => {
        const chat = moonRoom(client, '!moon-history:test')
        pointMoonAt(client, chat.roomId)
      })

      f.server.madeHere('!moon-history:test')
      f.server.held.pointer = { v: 1, room_id: '!moon-history:test', bot_user_id: moonBot }

      await expect(f.sdk.command(leaveRoom('!moon-history:test'))).resolves.toEqual({ left: false })
      expect(f.leave).not.toHaveBeenCalled()
    })

    it('leaves an empty chat this device’s pointer still names once the server’s names another', async () => {
      // The pointer written a moment ago (by `openAppBotRoom`) has not synced here yet.
      const f = await freshSdk(client => {
        const old = moonRoom(client, '!moon-old:test')
        pointMoonAt(client, old.roomId)
      })

      f.server.madeHere('!moon-old:test')
      f.server.held.pointer = { v: 1, room_id: '!moon-other:test', bot_user_id: moonBot }

      await expect(f.sdk.command(leaveRoom('!moon-old:test'))).resolves.toEqual({ left: true })
      expect(f.leave).toHaveBeenCalledExactlyOnceWith('!moon-old:test')
    })

    it('keeps a chat when the server cannot say what the pointer names', async () => {
      const f = await freshSdk()
      f.server.madeHere('!moon-new:test')

      vi.mocked(f.client.http.authedRequest).mockImplementationOnce(async () => {
        throw new Error('offline')
      })

      await expect(f.sdk.command(leaveRoom('!moon-new:test'))).resolves.toEqual({ left: false })
      expect(f.leave).not.toHaveBeenCalled()
    })
  })

  it('refuses what is not an app id, a bot identity, a room id or a selection, before touching the account', async () => {
    const f = await sdkWithState()

    for (const bad of [
      { ...find, appId: 'moon' },
      { ...make, botUserId: '@moon' },
      { ...openRoom('!moon-other:test'), appId: moon.replace(/-/gu, '') },
      openRoom('moon-other'),
      openRoom('!moon-other'),
      openRoom('!moon-other:test', -1),
      openRoom('!moon-other:test', 1.5),
      leaveRoom('!x'),
      leaveRoom('')
    ]) {
      await expect(f.sdk.command(bad), JSON.stringify(bad)).rejects.toThrow('matrix_app_bot_dm_invalid')
    }

    expect(f.create).not.toHaveBeenCalled()
    expect(f.leave).not.toHaveBeenCalled()
    expect(f.pointerWrites()).toEqual([])
  })
})

// A chat's room can be made (or named) before this device's sync has brought it: the window draws
// only the rooms the SDK's store holds, so the chat is selected once its room is here, never before
// (`selectAppBotDirectRoom`). These run the real SDK over a real js-sdk client whose sync is the
// fixture's: it brings the room after a delay, when told, or never.
describe('a bot chat whose room sync has not delivered yet', () => {
  it('keeps the person where they were until the new room has synced, then opens it', async () => {
    const f = await freshSdk()
    f.sync.mode = 'manual'

    let settled = false
    const opening = f.sdk.command(open).finally(() => (settled = true))
    await vi.waitFor(() => expect(f.sync.waitingFor).toEqual(['!moon-new:test']), { timeout: 5_000 })

    // The room is made and its records are written, but sync has not brought it: nothing is selected
    // yet, so the window never draws "no conversation" for a chat that is opening.
    expect(settled).toBe(false)
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-new:test', bot_user_id: moonBot }])
    expect(f.latest().roomId).toBeNull()

    // Sync brings it 150 ms after the create answered.
    setTimeout(() => f.sync.deliver('!moon-new:test'), 150)
    await expect(opening).resolves.toMatchObject({ roomId: '!moon-new:test', outcome: 'created' })
    expect(f.latest().roomId).toBe('!moon-new:test')
    expect(f.room('!moon-new:test')).toBeDefined()
    expect(f.snapshots.every(drawn)).toBe(true)
  })

  it('opens at once, with no wait, when the room is already here', async () => {
    const f = await freshSdk(client => {
      const chat = moonRoom(client, '!moon-history:test')
      pointMoonAt(client, chat.roomId)
    })

    f.sync.mode = 'never'
    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-history:test', outcome: 'reused' })
    expect(f.sync.waitingFor).toEqual([])
  })

  it('fails closed when sync never brings the room, leaves the person where they were, and the retry opens that same room', async () => {
    const f = await freshSdk()
    f.sync.mode = 'never'

    await expectWaitRunsOut(f, open, ['!moon-new:test'])

    expect(f.latest().roomId).toBeNull()
    expect(f.snapshots.every(drawn)).toBe(true)
    // The room exists and the account points at it: the retry has something to open.
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-new:test', bot_user_id: moonBot }])

    f.sync.mode = 'auto'
    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test' })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.latest().roomId).toBe('!moon-new:test')
    expect(f.room('!moon-new:test')).toBeDefined()
  })

  it('keeps the retry on the same room across several waits that run out', async () => {
    const f = await freshSdk()
    f.sync.mode = 'never'

    for (let attempt = 0; attempt < 3; attempt++) {
      f.sync.waitingFor.length = 0
      await expectWaitRunsOut(f, open, ['!moon-new:test'])
    }

    expect(f.create).toHaveBeenCalledOnce()
  })

  it('does not fail, or take the selection, when the person went elsewhere while it was on its way', async () => {
    const f = await freshSdk(client => {
      heldRoom(client, '!elsewhere:test')
    })

    f.sync.mode = 'never'
    vi.useFakeTimers()

    try {
      const opening = f.sdk.command(open)
      await settle(() => f.sync.waitingFor.length > 0)

      await f.sdk.command({ kind: 'select', roomId: '!elsewhere:test' })
      await vi.advanceTimersByTimeAsync(APP_BOT_ROOM_WAIT_MS)

      await expect(opening).resolves.toMatchObject({ roomId: '!moon-new:test' })
      expect(f.latest().roomId).toBe('!elsewhere:test')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not take the selection back when the room arrives after the person went elsewhere', async () => {
    const f = await freshSdk(client => {
      heldRoom(client, '!elsewhere:test')
    })

    f.sync.mode = 'manual'
    const opening = f.sdk.command(open)
    await vi.waitFor(() => expect(f.sync.waitingFor).toHaveLength(1), { timeout: 5_000 })

    await f.sdk.command({ kind: 'select', roomId: '!elsewhere:test' })
    f.sync.deliver('!moon-new:test')

    await expect(opening).resolves.toMatchObject({ roomId: '!moon-new:test' })
    expect(f.latest().roomId).toBe('!elsewhere:test')
  })

  it('ends the wait when the SDK stops, rather than holding the command for the rest of the bound', async () => {
    const f = await freshSdk()
    f.sync.mode = 'never'

    const opening = f.sdk.command(open)
    const refused = expect(opening).rejects.toThrow('matrix_sdk_stopped')
    await vi.waitFor(() => expect(f.sync.waitingFor).toHaveLength(1), { timeout: 5_000 })

    await f.sdk.stop()
    await refused
  })

  it('stops listening for the room once it has come, or the wait has run out', async () => {
    const f = await freshSdk()
    const listeners = () => f.client.listenerCount(ClientEvent.Room)
    const before = listeners()

    f.sync.mode = 'never'
    await expectWaitRunsOut(f, open, ['!moon-new:test'])
    expect(listeners()).toBe(before)

    f.sync.mode = 'auto'
    await f.sdk.command(open)
    expect(listeners()).toBe(before)
  })
})

// `createRoom` answers before sync does. When the account's records could not be written either, nothing
// but this device's own memory names the chat made: a restart in that moment used to make the next open a
// first use, and a second chat. The SDK keeps what it made until the store holds it, and asks the server
// before it makes any chat (the rooms the account is in that the store lacks, by the account's marker).
describe('a chat made here that sync never delivered, across a restart', () => {
  const record = () => appBotCreatedRooms(localStorage, owner, 'DEVICE').read().get(moon)
  const made = { botUserId: moonBot, roomId: '!moon-new:test' }

  /** The first run: the chat is made, the account refuses every record, and sync does not bring the room. */
  async function madeAndNeverSynced() {
    const first = await freshSdk()
    first.sync.mode = 'never'
    vi.mocked(first.client.setAccountDataRaw).mockRejectedValue(new Error('account data unavailable'))
    await expectWaitRunsOut(first, open, ['!moon-new:test'])

    return first
  }

  it('makes no second chat after a restart: pointer write failed, sync timed out, the store lacks the room', async () => {
    const first = await madeAndNeverSynced()
    expect(first.create).toHaveBeenCalledOnce()
    expect(first.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-new:test', bot_user_id: moonBot }])
    expect(first.latest().roomId).toBeNull()
    expect(record()).toEqual(made)
    await first.sdk.stop()

    // The restart. The server holds the room, as the first run made it; this device's store does not; the
    // account has no pointer and no direct entry; the SDK remembers nothing in memory.
    const second = await freshSdk()
    second.server.heldChat('!moon-new:test')
    second.sync.mode = 'never'

    await expectWaitRunsOut(second, open, ['!moon-new:test'])
    expect(second.create).not.toHaveBeenCalled()
    expect(second.latest().roomId).toBeNull()
    // Still the same chat, still remembered: another restart in this state would not forget it either.
    expect(record()).toEqual(made)

    // Retry, once sync has brought it.
    second.sync.mode = 'auto'
    second.sync.waitingFor.length = 0

    await expect(second.sdk.command(open)).resolves.toMatchObject({
      roomId: '!moon-new:test',
      outcome: 'recovered',
      reason: 'pointer_missing',
      joined: 1,
      pointer: 'written'
    })
    expect(second.create).not.toHaveBeenCalled()
    expect(second.pointerWrites()).toContainEqual({ v: 1, room_id: '!moon-new:test', bot_user_id: moonBot })
    expect(second.latest().roomId).toBe('!moon-new:test')
    expect(second.snapshots.every(drawn)).toBe(true)
    // It is in the store now: what was kept for the moment before has done its work.
    expect(record()).toBeUndefined()
  })

  it('keeps what it made until the room is in the store, and lets it go when it is', async () => {
    const f = await freshSdk()
    f.sync.mode = 'manual'
    const opening = f.sdk.command(open)
    await vi.waitFor(() => expect(f.sync.waitingFor).toEqual(['!moon-new:test']), { timeout: 5_000 })
    expect(record()).toEqual(made)

    f.sync.deliver('!moon-new:test')
    await expect(opening).resolves.toMatchObject({ roomId: '!moon-new:test' })
    expect(record()).toBeUndefined()
  })

  it('does not take a remembered chat on trust: it makes one chat when the account is no longer in it', async () => {
    const first = await madeAndNeverSynced()
    await first.sdk.stop()

    // The room was left (or deleted) from another client before this one ever saw it.
    const second = await freshSdk()
    second.create.mockResolvedValue({ room_id: '!moon-second:test' })
    second.sync.mode = 'manual'
    const opening = second.sdk.command(open)
    await vi.waitFor(() => expect(second.sync.waitingFor).toEqual(['!moon-second:test']), { timeout: 5_000 })

    expect(second.create).toHaveBeenCalledOnce()
    // Only the chat it waits for is remembered; the stale one is gone for good.
    expect(record()).toEqual({ botUserId: moonBot, roomId: '!moon-second:test' })

    second.sync.deliver('!moon-second:test')
    await expect(opening).resolves.toMatchObject({ roomId: '!moon-second:test', outcome: 'created' })
  })

  it('forgets a remembered chat the account is in but that no longer works as the bot’s chat', async () => {
    const first = await madeAndNeverSynced()
    await first.sdk.stop()

    // Someone else was added to it: it is a group now, whatever else it is.
    const second = await freshSdk()
    second.server.heldChat('!moon-new:test', { members: { [owner]: 'join', [moonBot]: 'join', '@third:test': 'join' } })
    second.create.mockResolvedValue({ room_id: '!moon-second:test' })
    second.sync.mode = 'manual'
    const opening = second.sdk.command(open)
    await vi.waitFor(() => expect(second.sync.waitingFor).toEqual(['!moon-second:test']), { timeout: 5_000 })

    expect(second.create).toHaveBeenCalledOnce()
    expect(record()).toEqual({ botUserId: moonBot, roomId: '!moon-second:test' })
    second.sync.deliver('!moon-second:test')
    await opening
  })

  it('finds a chat the account has made by its marker alone, with no record on this device', async () => {
    // Made by this account elsewhere (or by a run whose record is gone): joined on the server, not synced.
    const f = await freshSdk()
    f.server.heldChat('!moon-lost:test')
    f.sync.mode = 'manual'

    const opening = f.sdk.command(open)
    await vi.waitFor(() => expect(f.sync.waitingFor).toEqual(['!moon-lost:test']), { timeout: 5_000 })
    expect(f.latest().roomId).toBeNull()

    f.sync.deliver('!moon-lost:test')
    await expect(opening).resolves.toMatchObject({
      roomId: '!moon-lost:test',
      outcome: 'recovered',
      reason: 'pointer_missing',
      joined: 1,
      pointer: 'written'
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.pointerWrites()).toEqual([{ v: 1, room_id: '!moon-lost:test', bot_user_id: moonBot }])
    expect(f.latest().roomId).toBe('!moon-lost:test')
  })

  it('looks first at the chats this account lists as its direct chats with the bot', async () => {
    const f = await freshSdk(client => directWithMoon(client, ['!moon-direct:test']))

    for (let n = 0; n < 5; n++) {
      f.server.heldChat(`!other-${n}:test`, { marker: 'none' })
    }

    f.server.heldChat('!moon-direct:test')
    const looked = vi.spyOn(f.client, 'roomState')

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-direct:test' })
    expect(looked.mock.calls.map(([id]) => id)).toEqual(['!moon-direct:test'])
    expect(f.create).not.toHaveBeenCalled()
  })

  it.each([
    ['another app’s marker', { marker: 'other' as const }],
    ['a marker the bot set, not the account', { marker: 'bot' as const }],
    ['no marker', { marker: 'none' as const }],
    ['end-to-end encryption', { encrypted: true }],
    ['a third person in it', { members: { [owner]: 'join', [moonBot]: 'join', '@third:test': 'join' } }],
    ['the bot absent from it', { members: { [owner]: 'join' } }]
  ])('does not take a room with %s for the bot’s chat, and makes the chat', async (_case, held) => {
    const f = await freshSdk()
    f.server.heldChat('!not-moon:test', held)

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test', outcome: 'created' })
    expect(f.create).toHaveBeenCalledOnce()
    // Another chat is nobody's to leave.
    expect(f.leave).not.toHaveBeenCalled()
  })

  it('looks at a bounded number of rooms the store lacks', async () => {
    const f = await freshSdk()

    for (let n = 0; n < APP_BOT_UNSYNCED_PROBES + 8; n++) {
      f.server.heldChat(`!other-${n}:test`, { marker: 'none' })
    }

    const looked = vi.spyOn(f.client, 'roomState')

    await f.sdk.command(open)
    expect(looked.mock.calls.length).toBeLessThanOrEqual(APP_BOT_UNSYNCED_PROBES)
    expect(f.create).toHaveBeenCalledOnce()
  })

  it('looks at the remembered chat first, however many other rooms the store lacks', async () => {
    const first = await madeAndNeverSynced()
    await first.sdk.stop()

    const second = await freshSdk()

    for (let n = 0; n < APP_BOT_UNSYNCED_PROBES + 8; n++) {
      second.server.heldChat(`!other-${n}:test`, { marker: 'none' })
    }

    second.server.heldChat('!moon-new:test')
    const looked = vi.spyOn(second.client, 'roomState')
    second.sync.mode = 'never'

    await expectWaitRunsOut(second, open, ['!moon-new:test'])
    expect(looked.mock.calls.map(([id]) => id)).toEqual(['!moon-new:test'])
    expect(second.create).not.toHaveBeenCalled()
  })

  it('looks at nothing when the store holds a chat that works', async () => {
    const f = await freshSdk(client => {
      const chat = moonRoom(client, '!moon-history:test')
      pointMoonAt(client, chat.roomId)
    })

    f.server.heldChat('!moon-other:test')
    const listed = vi.spyOn(f.client, 'getJoinedRooms')
    const looked = vi.spyOn(f.client, 'roomState')

    await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-history:test', outcome: 'reused' })
    expect(listed).not.toHaveBeenCalled()
    expect(looked).not.toHaveBeenCalled()
  })

  describe('when the server cannot say whether the chat exists', () => {
    it('makes no chat when the list of rooms cannot be read, and opens the chat on the retry', async () => {
      const f = await freshSdk()
      f.server.heldChat('!moon-lost:test')
      vi.spyOn(f.client, 'getJoinedRooms').mockRejectedValueOnce(new Error('offline'))

      await expect(f.sdk.command(open)).rejects.toThrow('matrix_app_bot_syncing')
      expect(f.create).not.toHaveBeenCalled()
      expect(f.latest().roomId).toBeNull()

      await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-lost:test' })
      expect(f.create).not.toHaveBeenCalled()
    })

    it('makes no chat when a room’s state cannot be read, whatever that room is', async () => {
      const f = await freshSdk()
      f.server.heldChat('!moon-lost:test')
      vi.spyOn(f.client, 'roomState').mockRejectedValueOnce(new Error('timed out'))

      await expect(f.sdk.command(open)).rejects.toThrow('matrix_app_bot_syncing')
      expect(f.create).not.toHaveBeenCalled()

      await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-lost:test' })
      expect(f.create).not.toHaveBeenCalled()
    })

    it('keeps a remembered chat when the server could not be asked, and drops nothing', async () => {
      const first = await madeAndNeverSynced()
      await first.sdk.stop()

      const second = await freshSdk()
      second.server.heldChat('!moon-new:test')
      vi.spyOn(second.client, 'getJoinedRooms').mockRejectedValueOnce(new Error('offline'))

      await expect(second.sdk.command(open)).rejects.toThrow('matrix_app_bot_syncing')
      expect(second.create).not.toHaveBeenCalled()
      expect(record()).toEqual(made)
    })

    it('takes a room the server refuses to show as not the bot’s, and goes on', async () => {
      const f = await freshSdk()
      f.server.heldChat('!gone:test')
      f.server.heldChat('!moon-lost:test')

      const real = f.client.roomState.bind(f.client)

      vi.spyOn(f.client, 'roomState').mockImplementation(async id => {
        if (id === '!gone:test') {
          throw Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' })
        }

        return real(id)
      })

      await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-lost:test' })
      expect(f.create).not.toHaveBeenCalled()
    })
  })

  describe('what is kept on this device', () => {
    it('is forgotten when the room is deleted elsewhere before it arrives', async () => {
      const f = await freshSdk()
      f.sync.mode = 'never'
      await expectWaitRunsOut(f, open, ['!moon-new:test'])
      expect(record()).toEqual(made)

      f.client.emit(ClientEvent.DeleteRoom, '!moon-new:test')
      expect(record()).toBeUndefined()
    })

    it('is forgotten when the platform did not keep the candidate and it was left', async () => {
      const f = await freshSdk()
      f.server.madeHere('!moon-new:test')
      await f.sdk.command({ kind: 'makeAppBotDm', appId: moon, botUserId: moonBot })
      expect(record()).toEqual(made)

      await f.sdk.command({ kind: 'leaveAppBotDm', appId: moon, botUserId: moonBot, roomId: '!moon-new:test' })
      expect(record()).toBeUndefined()
    })

    it('is not kept for a room sync had already brought by the time create answered', async () => {
      const f = await freshSdk()
      f.create.mockImplementation(async () => {
        // The room exists from here, and sync has it before the answer reaches the SDK.
        f.server.heldChat('!moon-new:test')
        f.sync.deliver('!moon-new:test')

        return { room_id: '!moon-new:test' }
      })

      await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test', outcome: 'created' })
      expect(f.sync.waitingFor).toEqual([])
      expect(record()).toBeUndefined()
    })

    it('is only ever this account’s on this device', async () => {
      appBotCreatedRooms(localStorage, owner, 'ANOTHER-DEVICE').write(moon, { botUserId: moonBot, roomId: '!x:test' })
      appBotCreatedRooms(localStorage, '@someone:test', 'DEVICE').write(moon, { botUserId: moonBot, roomId: '!y:test' })

      const f = await freshSdk()
      f.sync.mode = 'never'
      await expectWaitRunsOut(f, open, ['!moon-new:test'])

      expect(record()).toEqual(made)
      expect(appBotCreatedRooms(localStorage, owner, 'ANOTHER-DEVICE').read().get(moon)?.roomId).toBe('!x:test')
      expect(appBotCreatedRooms(localStorage, '@someone:test', 'DEVICE').read().get(moon)?.roomId).toBe('!y:test')
    })

    it('never stands in the way of opening when this device cannot keep it', async () => {
      const f = await freshSdk()
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError')
      })

      f.sync.mode = 'never'
      await expectWaitRunsOut(f, open, ['!moon-new:test'])

      // Still one chat for as long as this run lives.
      f.sync.mode = 'auto'
      f.sync.waitingFor.length = 0
      await expect(f.sdk.command(open)).resolves.toMatchObject({ roomId: '!moon-new:test' })
      expect(f.create).toHaveBeenCalledOnce()
    })
  })

  describe('the platform’s steps after a restart', () => {
    const find = { kind: 'findAppBotDm' as const, appId: moon, botUserId: moonBot }
    const make = { kind: 'makeAppBotDm' as const, appId: moon, botUserId: moonBot }

    it('offers the candidate it made before the restart, as the server shows it, and makes no other', async () => {
      const first = await freshSdk()
      await first.sdk.command(make)
      expect(record()).toEqual(made)
      await first.sdk.stop()

      const second = await freshSdk()
      second.server.heldChat('!moon-new:test')

      await expect(second.sdk.command(find)).resolves.toMatchObject({ roomId: '!moon-new:test' })
      expect(second.create).not.toHaveBeenCalled()
    })

    it('offers nothing, and forgets the candidate, when the account is no longer in it', async () => {
      const first = await freshSdk()
      await first.sdk.command(make)
      await first.sdk.stop()

      const second = await freshSdk()

      await expect(second.sdk.command(find)).resolves.toMatchObject({ roomId: null })
      expect(record()).toBeUndefined()
    })

    it('says it cannot tell, rather than offering nothing, when the server cannot be asked', async () => {
      const first = await freshSdk()
      await first.sdk.command(make)
      await first.sdk.stop()

      const second = await freshSdk()
      second.server.heldChat('!moon-new:test')
      vi.spyOn(second.client, 'getJoinedRooms').mockRejectedValueOnce(new Error('offline'))

      await expect(second.sdk.command(find)).rejects.toThrow('matrix_app_bot_syncing')
      expect(record()).toEqual(made)
    })

    it('does not offer an invitation back, as before', async () => {
      const f = await freshSdk(client => {
        heldRoom(client, '!moon-invited:test', 'invite', moonBot)
        directWithMoon(client, ['!moon-invited:test'])
      })

      await expect(f.sdk.command(find)).resolves.toMatchObject({ roomId: null })
    })
  })
})

// The window opens an app's chat by the same steps for every app, and a failure at any of them is
// a closed code the window can show with a Retry. This runs those steps for an app this client has
// no code for, from the renderer's open down to the real SDK: the renderer (`openAppBotChat`) calls
// main's resolver (`startAppChat` with the platform resolver, whose route answers 404 as the Shell
// without its room verifier does), which falls back to the SDK's local rule.
describe('an app this client has no code for, opened the way the window opens it', () => {
  const novel = botApp({
    slug: 'zephyr_lab',
    name: 'Zephyr',
    appId: '00000000-0000-4000-8000-850e1398a2ab',
    versionId: '00000000-0000-4000-8000-61d49dea90d5',
    guest: true
  })

  const catalog = { apps: { state: 'ready' as const, apps: [novel], connections: {} } } as Pick<MatrixSnapshot, 'apps'>
  const requests: string[] = []

  /** What the bridge hands the window: main's open for this app, with its log lines and the IPC wording of a refusal. */
  function windowOverSdk(f: Awaited<ReturnType<typeof freshSdk>>, logs: string[]) {
    const command = (value: MatrixSdkCommand) => f.sdk.command(value)

    const open = () =>
      startAppChat({
        descriptor: () => novel,
        current: () => true,
        resolveRoom: platformAppChatRoom({
          // A Shell without the room verifier answers its route with a JSON 404.
          start: async (slug, body) => {
            requests.push(`${slug} ${Object.keys(body).sort().join(',')}`)

            return { status: 404, body: { error: 'matrix_404' } }
          },
          command,
          fallback: localAppChatRoom(command),
          requestId: () => '00000000-0000-4000-8000-c12ab3c170f9',
          current: () => true,
          log: line => logs.push(line)
        }),
        slug: novel.app,
        log: line => logs.push(line)
      })

    Object.assign(window, {
      atumMatrix: {
        apps: {
          chat: (appId: string) =>
            appId === novel.app_id
              ? open().catch((error: Error) => {
                  throw new Error(`Error invoking remote method 'matrix:ui': Error: ${error.message}`)
                })
              : Promise.reject(new Error('matrix_app_bot_unavailable'))
        }
      }
    })
  }

  afterEach(() => {
    Reflect.deleteProperty(window, 'atumMatrix')
    requests.length = 0
  })

  it('opens the chat when sync brings the new room a moment after the create answered', async () => {
    const f = await freshSdk()
    f.sync.delayMs = 120
    const logs: string[] = []
    const fail = vi.fn()
    windowOverSdk(f, logs)

    await openAppBotChat(catalog, novel.app_id, 'vi', fail)

    expect(fail).not.toHaveBeenCalled()
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.create.mock.calls[0]![0]).toMatchObject({ is_direct: true, invite: [novel.bot.user_id] })
    const roomId = f.latest().roomId!
    expect(f.room(roomId)).toBeDefined()
    expect(f.snapshots.every(drawn)).toBe(true)
    expect(requests).toEqual(['zephyr_lab requestId'])
    expect(logs).toEqual([
      '[Matrix] app bot start app=zephyr_lab step=first answer=absent',
      expect.stringMatching(
        /^\[Matrix\] app bot open app=zephyr_lab outcome=created reason=first_use room=\S+ joined=1 left=0 pointer=written shown=none$/u
      )
    ])
  })

  it('says why, logs the closed code with the slug, and offers a Retry that opens the same room, when sync never comes', async () => {
    const f = await freshSdk()
    f.sync.mode = 'never'
    const logs: string[] = []
    const failures: unknown[] = []
    windowOverSdk(f, logs)

    vi.useFakeTimers()

    try {
      const opening = openAppBotChat(catalog, novel.app_id, 'vi', cause => failures.push(cause))
      await settle(() => f.sync.waitingFor.length > 0)
      await vi.advanceTimersByTimeAsync(APP_BOT_ROOM_WAIT_MS)
      await opening
    } finally {
      vi.useRealTimers()
    }

    // The window is told, by name, in its language, with something to press.
    expect(failures).toHaveLength(1)
    const failure = failures[0]
    expect(matrixChatFailure(failure)).toBe('app_bot_syncing')
    expect(matrixFailureSubject(failure)).toBe('Zephyr')
    expect(matrixChatFailureCopy('app_bot_syncing', matrixChatCopy('vi'), 'vi', matrixFailureSubject(failure))).toBe(
      'Cuộc trò chuyện với Zephyr đang mở lâu hơn bình thường. Bạn thử lại nhé.'
    )

    // main.log has the app and the closed code, and nothing else about it.
    expect(logs).toEqual([
      '[Matrix] app bot start app=zephyr_lab step=first answer=absent',
      '[Matrix] app bot open app=zephyr_lab outcome=failed code=matrix_app_bot_syncing'
    ])

    // Nothing was selected for the window to draw as empty.
    expect(f.latest().roomId).toBeNull()
    expect(f.snapshots.every(drawn)).toBe(true)

    // Retry, once sync is back: the same room, not a second one.
    const retry = matrixFailureRetry(failure)
    expect(retry).toBeTypeOf('function')
    f.sync.mode = 'auto'
    retry!()
    await vi.waitFor(() => expect(f.latest().roomId).toBe('!moon-new:test'), { timeout: 5_000 })
    expect(f.create).toHaveBeenCalledOnce()
    expect(logs.at(-1)).toMatch(/^\[Matrix\] app bot open app=zephyr_lab outcome=recovered /u)
  })
})

describe('the first open of an app, as the platform answers create and then ready', () => {
  const app = botApp({
    slug: 'zephyr_lab',
    name: 'Zephyr',
    appId: '00000000-0000-4000-8000-850e1398a2ab',
    versionId: '00000000-0000-4000-8000-61d49dea90d5',
    guest: true
  })

  const catalog = { state: 'ready' as const, apps: [app], connections: {} }

  /** What the window projects from one snapshot of the SDK, with the app on the person's roster. */
  const windowOf = (snapshot: MatrixSnapshot) => ({
    ...snapshot,
    apps: catalog,
    appShortcuts: { [app.app_id]: { visibility: 'default' as const, status: 'ready' as const } }
  })

  it('keeps one row for the app, and draws its new chat as the app’s from the first frame it is on screen', async () => {
    const f = await freshSdk()
    // Sync brings the room made here while the platform's second answer is on its way. The account's
    // m.direct hint, written after the chat is selected, never echoes in this test: it is the slow part
    // in production, and the window must not wait for it to know whose chat this is.
    f.sync.mode = 'manual'
    const command = (value: MatrixSdkCommand) => f.sdk.command(value)
    const answers: string[] = []

    const start = async (_slug: string, body: { roomId?: string }) => {
      if (!body.roomId) {
        answers.push('create')

        return { status: 200, body: { state: 'create', botUserId: app.bot.user_id } }
      }

      answers.push('ready')
      f.server.held.state.set(body.roomId, [
        { type: EventType.RoomCreate, state_key: '', sender: owner, content: {} },
        {
          type: 'io.atum.app_bot.dm',
          state_key: '',
          sender: owner,
          content: { v: 1, app_id: app.app_id, bot_user_id: app.bot.user_id }
        },
        { type: EventType.RoomMember, state_key: owner, sender: owner, content: { membership: 'join' } },
        { type: EventType.RoomMember, state_key: app.bot.user_id, sender: owner, content: { membership: 'invite' } }
      ])
      f.sync.deliver(body.roomId)
      // The window is given a snapshot of the room before the platform has answered.
      await new Promise(done => setTimeout(done, 120))

      return { status: 200, body: { state: 'ready', roomId: body.roomId, botUserId: app.bot.user_id } }
    }

    const opened = await startAppChat({
      descriptor: () => app,
      current: () => true,
      resolveRoom: platformAppChatRoom({
        start,
        command,
        fallback: localAppChatRoom(command),
        requestId: () => '00000000-0000-4000-8000-c12ab3c170f9',
        current: () => true
      }),
      slug: app.app
    })

    expect(answers).toEqual(['create', 'ready'])
    expect(f.create).toHaveBeenCalledOnce()
    expect(opened).toBe('!moon-new:test')
    expect(f.latest().roomId).toBe(opened)
    // The snapshot that brought the room in, and the one that selected it, are among these.
    expect(f.snapshots.some(snapshot => snapshot.rooms.length > 0 && snapshot.roomId === null)).toBe(true)

    for (const snapshot of f.snapshots) {
      const shown = windowOf(snapshot)
      const roster = projectMatrixRoster(shown)

      // Exactly one row for the app, with nothing of its chat listed beside it as a chat of its own.
      expect(roster.apps).toHaveLength(1)
      expect(roster.rest).toEqual([])

      // The chat is the app's one-to-one chat in every frame it exists in, so the window never draws
      // it as an ordinary untitled room first (header, group actions, no setup card).
      for (const room of snapshot.rooms) {
        expect(room.direct).toBe(true)
      }

      if (snapshot.roomId) {
        expect(directAppBot(shown)?.app_id).toBe(app.app_id)
      }
    }
  })
})
