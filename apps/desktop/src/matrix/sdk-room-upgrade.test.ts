import { createClient, EventType, type MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import type * as MatrixSdk from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'

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

const alice = '@alice:test'
const admin = '@admin:other.test'
const OLD = '!old:test'
const NEW = '!new:other.test'
const stops: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop()
  }

  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

interface Shape {
  membership?: 'join' | 'invite'
  predecessor?: string
  replacement?: string
}

function room(client: MatrixClient, id: string, shape: Shape = {}) {
  const value = new Room(id, client, alice)

  const state = (type: string, content: object, stateKey = '', sender = admin) =>
    new MatrixEvent({ type, state_key: stateKey, sender, room_id: id, content })

  value.currentState.setStateEvents([
    state(EventType.RoomCreate, {
      room_version: '11',
      ...(shape.predecessor ? { predecessor: { room_id: shape.predecessor } } : {})
    }),
    state(EventType.RoomMember, { membership: shape.membership ?? 'join' }, alice, alice),
    ...(shape.replacement ? [state(EventType.RoomTombstone, { replacement_room: shape.replacement })] : [])
  ])
  value.updateMyMembership(shape.membership ?? 'join')
  client.store.storeRoom(value)

  return value
}

async function fixture(setup: (client: MatrixClient) => void) {
  const actual = await vi.importActual<typeof MatrixSdk>('matrix-js-sdk')
  const client = actual.createClient({ baseUrl: 'https://matrix.test', userId: alice, deviceId: 'DEVICE' })
  vi.mocked(createClient).mockReturnValue(client)
  vi.stubGlobal('indexedDB', {})
  vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined)
  vi.spyOn(client, 'getCrypto').mockReturnValue({ globalBlacklistUnverifiedDevices: false } as unknown as ReturnType<
    MatrixClient['getCrypto']
  >)
  vi.spyOn(client, 'startClient').mockResolvedValue(undefined)
  vi.spyOn(client, 'stopClient').mockImplementation(() => {})
  vi.spyOn(client, 'getAccountDataFromServer').mockResolvedValue({})
  vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})
  setup(client)
  const snapshots: MatrixSnapshot[] = []

  const sdk = await startMatrixSdk(
    {
      baseUrl: 'https://matrix.test',
      userId: alice,
      deviceId: 'DEVICE',
      accessToken: 'fixture',
      storageKey: btoa('0'.repeat(32))
    },
    vi.fn(),
    value => snapshots.push(value),
    undefined,
    () => {}
  )

  stops.push(sdk.stop)

  return { client, sdk, latest: () => snapshots.at(-1)! }
}

const ids = (snapshot: MatrixSnapshot) => snapshot.rooms.map(value => value.id).sort()

it('an upgraded room stays in the list, readable, with its banner until the replacement is joined', async () => {
  const f = await fixture(client => {
    room(client, OLD, { replacement: NEW })
    room(client, NEW, { membership: 'invite', predecessor: OLD })
  })

  await f.sdk.command({ kind: 'select', roomId: OLD })

  // Both rows exist: the old chat (with its banner state) and the invitation to the new room.
  expect(ids(f.latest())).toEqual([NEW, OLD].sort())
  expect(f.latest().roomId).toBe(OLD)
  expect(f.latest().rooms.find(value => value.id === OLD)?.successor).toEqual({
    roomId: NEW,
    state: 'join',
    backlink: 'verified'
  })
})

it('go to the new room joins once, opens it, and leaves only the replacement in the list', async () => {
  const f = await fixture(client => {
    room(client, OLD, { replacement: NEW })
  })

  const join = vi.spyOn(f.client, 'joinRoom').mockImplementation(async id => {
    room(f.client, id, { predecessor: OLD })

    return f.client.getRoom(id)!
  })

  await f.sdk.command({ kind: 'select', roomId: OLD })
  expect(join).not.toHaveBeenCalled()

  await f.sdk.command({ kind: 'joinSuccessor', roomId: OLD })

  expect(join).toHaveBeenCalledExactlyOnceWith(NEW, { viaServers: ['other.test'] })
  expect(f.latest().roomId).toBe(NEW)
  expect(ids(f.latest())).toEqual([NEW])
  // Earlier history stays reachable from the new room, and opening it works although the roster hides it.
  expect(f.latest().rooms.find(value => value.id === NEW)?.predecessor).toEqual({ roomId: OLD })

  await f.sdk.command({ kind: 'select', roomId: OLD })
  expect(f.latest().roomId).toBe(OLD)
  expect(ids(f.latest())).toEqual([NEW, OLD].sort())
})

it('an inaccessible replacement fails the action and leaves the old room open and unchanged', async () => {
  const f = await fixture(client => {
    room(client, OLD, { replacement: NEW })
  })

  vi.spyOn(f.client, 'joinRoom').mockRejectedValue(Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' }))
  await f.sdk.command({ kind: 'select', roomId: OLD })

  await expect(f.sdk.command({ kind: 'joinSuccessor', roomId: OLD })).rejects.toThrow('forbidden')
  expect(f.latest().roomId).toBe(OLD)
  expect(ids(f.latest())).toEqual([OLD])
  expect(f.latest().rooms[0]?.successor?.state).toBe('join')
})

it('opening the person’s chat after they moved on from the old room does not pull them back', async () => {
  const f = await fixture(client => {
    room(client, OLD, { replacement: NEW })
    room(client, '!other:test')
  })

  const pending = (() => {
    let resolve!: () => void

    const promise = new Promise<void>(done => {
      resolve = done
    })

    return { promise, resolve }
  })()

  vi.spyOn(f.client, 'joinRoom').mockImplementation(async id => {
    await pending.promise
    room(f.client, id, { predecessor: OLD })

    return f.client.getRoom(id)!
  })

  await f.sdk.command({ kind: 'select', roomId: OLD })
  const operation = f.sdk.command({ kind: 'joinSuccessor', roomId: OLD })
  await f.sdk.command({ kind: 'select', roomId: '!other:test' })
  pending.resolve()
  await operation

  expect(f.latest().roomId).toBe('!other:test')
})
