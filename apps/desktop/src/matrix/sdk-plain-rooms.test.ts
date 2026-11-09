import { Attachment, initAsync } from '@matrix-org/matrix-sdk-crypto-wasm'
import { cleanup, render, screen } from '@testing-library/react'
import {
  ClientEvent,
  createClient,
  EventStatus,
  EventType,
  type MatrixClient,
  MatrixEvent,
  NotificationCountType,
  Room,
  RoomEvent,
  RoomStateEvent,
  SyncState,
  User
} from 'matrix-js-sdk'
import type * as MatrixSdk from 'matrix-js-sdk'
import {
  FeatureSupport,
  FILTER_RELATED_BY_REL_TYPES,
  FILTER_RELATED_BY_SENDERS,
  Thread,
  THREAD_RELATION_TYPE
} from 'matrix-js-sdk/lib/models/thread'
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { appBotPhotoForRenderer } from '../../electron/matrix/bot-api-media'
import type { AppDescriptor } from '../../shared/app-catalog'
import { MATRIX_MAX_FILE_BYTES, type MatrixMessage, type MatrixSnapshot } from '../../shared/matrix'
import {
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
  MATRIX_COMPANY_CHANNEL_TYPE
} from '../../shared/matrix-company-channel-room'

import { authorizedBotApi } from './app-bots/bot-api'
import { MatrixBotApiPhotoView } from './app-bots/bot-photo'
import { readCompanyAIJoinedMembers, readCompanyAIQuestion } from './company-ai-sdk'
import { matrixMessage } from './message'
import { PLAIN_ANSWER_MS } from './plain-room'
import { MATRIX_ATTACHMENT_UPLOAD_TIMEOUT_MS, startMatrixSdk } from './sdk'

// The 0.20 shave-down (owner decisions D1 and D2): agent, bot, people and group chats are plain
// Matrix rooms. These run the SDK commands over a real js-sdk client, as after a restart.

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

beforeAll(() => initAsync())

const owner = '@owner:test'
const moon = '00000000-0000-4000-8000-e79acd97ac88'
const moonBot = '@app-moon:atumplatform.com'
const appBotPerson = '@person:atumplatform.com'
const demoza = '00000000-0000-4000-8000-f8cea4c3b21c'
const demozaBot = '@app-demoza:atumplatform.com'
const stops: Array<() => Promise<void>> = []

const memberResponse = (...members: Array<[string, string]>) => ({
  chunk: members.map(([state_key, membership]) => ({ state_key, content: { membership } }))
}) as never

afterEach(async () => {
  cleanup()
  await Promise.all(stops.splice(0).map(stop => stop()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

interface RoomOptions {
  membership?: string
  inviter?: string
  encrypted?: boolean
  type?: string
  members?: Record<string, string>
  /** More of the create event's content (an app group's binding). */
  create?: Record<string, unknown>
  /** The invitation marks a direct chat. */
  direct?: boolean
}

/** A room this device holds. Plain unless `encrypted` (a room made before 0.20). */
function holdRoom(client: MatrixClient, id: string, options: RoomOptions = {}) {
  const userId = client.getSafeUserId()
  const membership = options.membership ?? 'join'
  const room = new Room(id, client, userId)
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: id,
      sender: options.inviter ?? userId,
      content: { ...(options.type ? { type: options.type } : {}), ...options.create }
    }),
    ...(options.encrypted
      ? [
          new MatrixEvent({
            type: EventType.RoomEncryption,
            state_key: '',
            room_id: id,
            sender: userId,
            content: { algorithm: 'm.megolm.v1.aes-sha2' }
          })
        ]
      : []),
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: userId,
      room_id: id,
      sender: membership === 'invite' ? (options.inviter ?? '@friend:test') : userId,
      content: { membership, ...(options.direct ? { is_direct: true } : {}) }
    }),
    ...Object.entries(options.members ?? {}).map(
      ([member, state]) =>
        new MatrixEvent({
          type: EventType.RoomMember,
          state_key: member,
          room_id: id,
          sender: member,
          content: { membership: state }
        })
    )
  ])
  room.updateMyMembership(membership)
  client.store.storeRoom(room)

  return room
}

async function sdkFor(userId: string, prepare: (client: MatrixClient) => void = () => {}, mode?: 'app-bot') {
  const actual = await vi.importActual<typeof MatrixSdk>('matrix-js-sdk')
  const client = actual.createClient({ baseUrl: 'https://matrix.test', userId, deviceId: 'DEVICE' })

  vi.mocked(createClient).mockReturnValue(client)
  vi.stubGlobal('indexedDB', {})
  vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined)
  vi.spyOn(client, 'getCrypto').mockReturnValue({
    globalBlacklistUnverifiedDevices: false,
    isEncryptionEnabledInRoom: async () => false
  } as unknown as ReturnType<MatrixClient['getCrypto']>)
  vi.spyOn(client, 'startClient').mockImplementation(async options => {
    // Preserve the real SDK's sync-option behavior while keeping all network I/O offline.
    Reflect.set(client, 'clientOpts', options ?? {})
  })
  vi.spyOn(client, 'stopClient').mockImplementation(() => {})
  vi.spyOn(client, 'getAccountDataFromServer').mockResolvedValue({})
  vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})
  const join = vi.spyOn(client, 'joinRoom').mockImplementation(async roomId => client.getRoom(roomId as string)!)
  prepare(client)

  const offerAppBotEvent = vi.fn()
  const snapshots: MatrixSnapshot[] = []

  const sdk = await startMatrixSdk(
    {
      baseUrl: 'https://matrix.test',
      userId,
      deviceId: 'DEVICE',
      accessToken: 'fixture',
      storageKey: btoa('0'.repeat(32)),
      ...(mode ? { mode } : { threadSupport: true })
    },
    vi.fn(),
    value => snapshots.push(value),
    undefined,
    undefined,
    undefined,
    offerAppBotEvent
  )

  stops.push(sdk.stop)
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)

  return { client, sdk, join, offerAppBotEvent, latest: () => snapshots.at(-1)! }
}

describe('joining', () => {
  it('accepts a person’s invitation to a plain chat, and still refuses an ignored inviter', async () => {
    const f = await sdkFor(owner, client => {
      holdRoom(client, '!people:test', { membership: 'invite', inviter: '@friend:test' })
      holdRoom(client, '!encrypted:test', { membership: 'invite', inviter: '@friend:test', encrypted: true })
      holdRoom(client, '!ignored:test', { membership: 'invite', inviter: '@pest:test' })
      vi.spyOn(client, 'isUserIgnored').mockImplementation(userId => userId === '@pest:test')
    })

    await expect(f.sdk.command({ kind: 'join', roomId: '!people:test' })).resolves.toBeNull()
    await expect(f.sdk.command({ kind: 'join', roomId: '!encrypted:test' })).resolves.toBeNull()
    await expect(f.sdk.command({ kind: 'join', roomId: '!ignored:test' })).rejects.toThrow(
      'matrix_encrypted_invite_required'
    )
    expect(f.join.mock.calls.map(([roomId]) => roomId)).toEqual(['!people:test', '!encrypted:test'])
  })

  it('lets an agent join its plain chat, a plain group or app group, never a plain room of another kind', async () => {
    const agent = '@agent:test'
    const appGroup = { 'io.atum.app_group': { app: agent } }

    const f = await sdkFor(agent, client => {
      holdRoom(client, '!assistant:test', { membership: 'invite', inviter: owner, type: 'io.atum.assistant' })
      holdRoom(client, '!group:test', { membership: 'invite', inviter: owner })
      holdRoom(client, '!app-group:test', {
        membership: 'invite',
        inviter: owner,
        type: 'io.atum.app_group.v1',
        create: appGroup
      })
      holdRoom(client, '!other:test', { membership: 'invite', inviter: owner, type: 'io.atum.company.project' })
      holdRoom(client, '!old:test', {
        membership: 'invite',
        inviter: owner,
        encrypted: true,
        type: 'io.atum.assistant'
      })
    })

    const join = (roomId: string, scope: 'assistant' | 'group' | 'app') =>
      f.sdk.command({ kind: 'joinAgentRoom', roomId, ownerId: owner, scope })

    await expect(join('!assistant:test', 'assistant')).resolves.toBeNull()
    await expect(join('!group:test', 'group')).resolves.toBeNull()
    await expect(join('!old:test', 'assistant')).resolves.toBeNull()
    await expect(join('!app-group:test', 'app')).resolves.toBeNull()
    await expect(join('!other:test', 'app')).rejects.toThrow('matrix_encrypted_invite_required')
    expect(f.join.mock.calls.map(([roomId]) => roomId)).toEqual([
      '!assistant:test',
      '!group:test',
      '!old:test',
      '!app-group:test'
    ])
  })

  it('takes a plain invitation only as what it was admitted as, and only from the owner', async () => {
    const agent = '@agent:test'

    const f = await sdkFor(agent, client => {
      // A plain untyped room: never the agent's own chat.
      holdRoom(client, '!untyped:test', { membership: 'invite', inviter: owner })
      // A plain group someone else invited the agent to.
      holdRoom(client, '!stranger-group:test', { membership: 'invite', inviter: '@friend:test' })
      // A direct chat of two, made as one: never a group.
      holdRoom(client, '!direct:test', { membership: 'invite', inviter: owner, direct: true })
      // An app group bound to another app, and one without the owner's binding.
      holdRoom(client, '!foreign-app-group:test', {
        membership: 'invite',
        inviter: owner,
        type: 'io.atum.app_group.v1',
        create: { 'io.atum.app_group': { app: '@other-app:test' } }
      })
      holdRoom(client, '!unbound-app-group:test', { membership: 'invite', inviter: owner, type: 'io.atum.app_group.v1' })
      // An assistant room offered as a group or an app room.
      holdRoom(client, '!assistant:test', { membership: 'invite', inviter: owner, type: 'io.atum.assistant' })
      // An app's plain pair invited by someone other than the owner.
      holdRoom(client, '!stranger-pair:test', { membership: 'invite', inviter: '@friend:test' })
    })

    const refused = (roomId: string, scope: 'assistant' | 'group' | 'app') =>
      expect(f.sdk.command({ kind: 'joinAgentRoom', roomId, ownerId: owner, scope })).rejects.toThrow(
        'matrix_encrypted_invite_required'
      )

    await refused('!untyped:test', 'assistant')
    await refused('!stranger-group:test', 'group')
    await refused('!direct:test', 'group')
    await refused('!foreign-app-group:test', 'app')
    await refused('!unbound-app-group:test', 'app')
    await refused('!unbound-app-group:test', 'group')
    await refused('!assistant:test', 'group')
    await refused('!assistant:test', 'app')
    await refused('!stranger-pair:test', 'app')
    expect(f.join).not.toHaveBeenCalled()

    // The same untyped room is the app's pair, from the owner.
    await expect(
      f.sdk.command({ kind: 'joinAgentRoom', roomId: '!untyped:test', ownerId: owner, scope: 'app' })
    ).resolves.toBeNull()
  })
})

describe('saving a file', () => {
  const file = (type: string, content: Record<string, unknown>) => ({
    type,
    room_id: '!room:test',
    event_id: '$file',
    sender: '@friend:test',
    origin_server_ts: 1,
    content
  })

  it('downloads a plain file from a plain chat as sent', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test'))
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(
      file(EventType.RoomMessage, { msgtype: 'm.file', body: 'notes.txt', url: 'mxc://test/notes' }) as never
    )

    const download = vi
      .spyOn(f.client.http, 'authedRequest')
      .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])]) as never)

    await expect(f.sdk.command({ kind: 'download', roomId: '!room:test', eventId: '$file' })).resolves.toEqual({
      name: 'notes.txt',
      bytes: new Uint8Array([1, 2, 3])
    })
    expect(download.mock.calls[0]![1]).toBe('/media/download/test/notes')
  })

  it('never downloads a plain file from an encrypted chat (no downgrade)', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test', { encrypted: true }))
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(
      file(EventType.RoomMessage, { msgtype: 'm.file', body: 'notes.txt', url: 'mxc://test/notes' }) as never
    )
    const download = vi.spyOn(f.client.http, 'authedRequest')

    await expect(f.sdk.command({ kind: 'download', roomId: '!room:test', eventId: '$file' })).rejects.toThrow(
      'matrix_file_unavailable'
    )
    expect(download).not.toHaveBeenCalled()
  })

  it('never downloads a plain file where the crypto store knows the room is encrypted, though its state has not synced', async () => {
    const f = await sdkFor(owner, client => {
      holdRoom(client, '!room:test')
      vi.mocked(client.getCrypto).mockReturnValue({
        globalBlacklistUnverifiedDevices: false,
        isEncryptionEnabledInRoom: async () => true
      } as unknown as ReturnType<MatrixClient['getCrypto']>)
    })

    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(
      file(EventType.RoomMessage, { msgtype: 'm.file', body: 'notes.txt', url: 'mxc://test/notes' }) as never
    )
    const download = vi.spyOn(f.client.http, 'authedRequest')

    await expect(f.sdk.command({ kind: 'download', roomId: '!room:test', eventId: '$file' })).rejects.toThrow(
      'matrix_file_unavailable'
    )
    expect(download).not.toHaveBeenCalled()
  })
})

describe('showing a plain file', () => {
  it('shows it once the crypto store answers, and asks again after an answer that did not come', async () => {
    const answers = [Promise.reject(new Error('store busy')), Promise.resolve(false)]
    answers[0]!.catch(() => {})
    const asked = vi.fn((_roomId: string) => answers.shift() ?? Promise.resolve(false))

    const f = await sdkFor(owner, client => {
      holdRoom(client, '!room:test')
      vi.mocked(client.getCrypto).mockReturnValue({
        globalBlacklistUnverifiedDevices: false,
        isEncryptionEnabledInRoom: asked
      } as unknown as ReturnType<MatrixClient['getCrypto']>)
    })

    await f.client.getRoom('!room:test')!.addLiveEvents(
      [
        new MatrixEvent({
          type: EventType.RoomMessage,
          room_id: '!room:test',
          event_id: '$file',
          sender: '@friend:test',
          origin_server_ts: 1,
          content: { msgtype: 'm.file', body: 'notes.txt', url: 'mxc://test/notes' }
        })
      ],
      { addToState: false }
    )

    const shown = () => f.latest().messages.find(message => message.id === '$file')?.attachment

    // Counted as encrypted while the store has not answered, and after it failed to.
    await f.sdk.command({ kind: 'select', roomId: '!room:test' })
    expect(shown()).toBe(false)
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shown()).toBe(false)

    // The next projection asks again; the store's answer shows the file.
    await f.sdk.command({ kind: 'select', roomId: '!room:test' })
    await vi.waitFor(() => expect(shown()).toBe(true))
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('never shows it where the crypto store has the room as encrypted, and does not ask again', async () => {
    const asked = vi.fn(async (_roomId: string) => true)

    const f = await sdkFor(owner, client => {
      holdRoom(client, '!room:test')
      vi.mocked(client.getCrypto).mockReturnValue({
        globalBlacklistUnverifiedDevices: false,
        isEncryptionEnabledInRoom: asked
      } as unknown as ReturnType<MatrixClient['getCrypto']>)
    })

    await f.client.getRoom('!room:test')!.addLiveEvents(
      [
        new MatrixEvent({
          type: EventType.RoomMessage,
          room_id: '!room:test',
          event_id: '$file',
          sender: '@friend:test',
          origin_server_ts: 1,
          content: { msgtype: 'm.file', body: 'notes.txt', url: 'mxc://test/notes' }
        })
      ],
      { addToState: false }
    )

    await f.sdk.command({ kind: 'select', roomId: '!room:test' })
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 60))
    await f.sdk.command({ kind: 'select', roomId: '!room:test' })
    expect(f.latest().messages.find(message => message.id === '$file')?.attachment).toBe(false)
    expect(asked).toHaveBeenCalledTimes(1)
  })
})

describe('sending a file', () => {
  const bytes = new Uint8Array([7, 8, 9, 10])

  /** The homeserver: uploads keep their bytes, sends keep their content, and both read back. */
  function homeserver(client: MatrixClient) {
    const media = new Map<string, Uint8Array>()
    const events = new Map<string, Record<string, unknown>>()

    const upload = vi.spyOn(client, 'uploadContent').mockImplementation((async (blob: Blob) => {
      const uri = `mxc://test/media${media.size + 1}`
      media.set(uri, new Uint8Array(await blob.arrayBuffer()))

      return { content_uri: uri }
    }) as never)

    const send = vi.spyOn(client, 'sendEvent').mockImplementation((async (
      roomId: string,
      type: string,
      content: Record<string, unknown>
    ) => {
      const eventId = `$sent${events.size + 1}`
      events.set(eventId, {
        type,
        room_id: roomId,
        event_id: eventId,
        sender: client.getSafeUserId(),
        origin_server_ts: 1,
        content
      })

      return { event_id: eventId }
    }) as never)

    vi.spyOn(client, 'fetchRoomEvent').mockImplementation((async (_roomId: string, eventId: string) =>
      events.get(eventId)) as never)
    vi.spyOn(client.http, 'authedRequest').mockImplementation((async (_method: string, path: string) => {
      const [, server, id] = /^\/media\/download\/([^/]+)\/(.+)$/.exec(path)!

      return new Blob([new Uint8Array(media.get(`mxc://${server}/${id}`)!)])
    }) as never)

    return { upload, send, media }
  }

  it('uploads the bytes as they are into a plain chat, with a plain URL and its info, and reads it back', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test'))
    const server = homeserver(f.client)

    const eventId = await f.sdk.command({ kind: 'attach', roomId: '!room:test', name: 'notes.txt', bytes })

    expect(server.send.mock.calls[0]![2]).toEqual({
      msgtype: 'm.file',
      body: 'notes.txt',
      filename: 'notes.txt',
      url: 'mxc://test/media1',
      info: { mimetype: 'application/octet-stream', size: 4 }
    })
    expect(server.media.get('mxc://test/media1')).toEqual(bytes)
    await expect(f.sdk.command({ kind: 'download', roomId: '!room:test', eventId: eventId as string })).resolves.toEqual({
      name: 'notes.txt',
      bytes
    })
  })

  it('keeps the encrypted descriptor in an encrypted chat, never plain media there', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test', { encrypted: true }))
    const server = homeserver(f.client)

    await f.sdk.command({ kind: 'attach', roomId: '!room:test', name: 'notes.txt', bytes })

    const content = server.send.mock.calls[0]![2] as unknown as Record<string, unknown>
    expect(content).not.toHaveProperty('url')
    expect(content.file).toMatchObject({ url: 'mxc://test/media1', v: 'v2' })
    expect(server.media.get('mxc://test/media1')).not.toEqual(bytes)
  })
  it('keeps encrypted media in a room whose encryption state is missing here but the crypto store remembers', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test'))
    const server = homeserver(f.client)
    const remembered = vi.fn(async (roomId: string) => roomId === '!room:test')
    vi.mocked(f.client.getCrypto).mockReturnValue({
      globalBlacklistUnverifiedDevices: false,
      isEncryptionEnabledInRoom: remembered
    } as unknown as ReturnType<MatrixClient['getCrypto']>)

    await f.sdk.command({ kind: 'attach', roomId: '!room:test', name: 'notes.txt', bytes })

    const content = server.send.mock.calls[0]![2] as unknown as Record<string, unknown>
    expect(remembered).toHaveBeenCalledWith('!room:test')
    expect(content).not.toHaveProperty('url')
    expect(content.file).toMatchObject({ url: 'mxc://test/media1', v: 'v2' })
    expect(server.media.get('mxc://test/media1')).not.toEqual(bytes)
  })

  it('lets a progressing 5 MiB upload run past the old 30-second command deadline and posts it once', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test'))
    const payload = new Uint8Array(5 * 1024 * 1024)
    const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$sent' } as never)

    const upload = vi.spyOn(f.client, 'uploadContent').mockImplementation(
      ((_blob: Blob, options: Parameters<MatrixClient['uploadContent']>[1]) =>
        new Promise(resolve => {
          // matrix-js-sdk's XHR path refreshes its own 30-second inactivity timer on
          // progress. This upload remains active beyond 30 seconds but below Atum's
          // absolute upload bound.
          setTimeout(() => resolve({ content_uri: 'mxc://test/slow' }), 31_000)
          expect(options?.abortController?.signal.aborted).toBe(false)
        })) as never
    )

    vi.useFakeTimers()

    try {
      const pending = f.sdk.command({ kind: 'attach', roomId: '!room:test', name: 'report.pdf', bytes: payload })
      await vi.advanceTimersByTimeAsync(31_000)

      await expect(pending).resolves.toBe('$sent')
      expect(upload).toHaveBeenCalledOnce()
      expect((upload.mock.calls[0]![0] as Blob).size).toBe(payload.byteLength)
      expect(send).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a Bot API photo the bounded upload deadline before publishing m.image', async () => {
    const roomId = '!bot-api:test'
    const f = await sdkFor(moonBot, client => {
      holdRoom(client, roomId, { members: { [appBotPerson]: 'join' } })
      vi.spyOn(client, 'members').mockResolvedValue(memberResponse([moonBot, 'join'], [appBotPerson, 'join']))
    }, 'app-bot')
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$bot-photo' } as never)
    const upload = vi.spyOn(f.client, 'uploadContent').mockImplementation(
      ((_blob: Blob, options: Parameters<MatrixClient['uploadContent']>[1]) =>
        new Promise(resolve => {
          setTimeout(() => resolve({ content_uri: 'mxc://test/bot-photo' }), 31_000)
          expect(options?.abortController?.signal.aborted).toBe(false)
        })) as never
    )

    vi.useFakeTimers()
    try {
      const pending = f.sdk.command({
        kind: 'appBotApiSend',
        roomId,
        directPerson: appBotPerson,
        body: 'receipt',
        transactionId: 'atum-bot-0123456789abcdef',
        metadata: {
          version: 'io.atum.bot_api/1',
          bot_id: moon,
          public_message_id: 55,
          photo: { file_ref: 'mref_0123456789abcdef', width: 1, height: 1, mime_type: 'image/png' }
        },
        photo: { bytes_base64: Buffer.from(payload).toString('base64'), mime_type: 'image/png', width: 1, height: 1 }
      })
      await vi.advanceTimersByTimeAsync(31_000)

      await expect(pending).resolves.toBe('$bot-photo')
      expect(upload).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledWith(
        roomId,
        EventType.RoomMessage,
        expect.objectContaining({ msgtype: 'm.image', url: 'mxc://test/bot-photo' }),
        'atum-bot-0123456789abcdef'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-checks the private audience after Bot API photo upload', async () => {
    const roomId = '!bot-api-photo-changed:test'
    const third = '@third:atumplatform.com'
    const f = await sdkFor(moonBot, client => {
      holdRoom(client, roomId, { members: { [appBotPerson]: 'join' } })
      vi.spyOn(client, 'members')
        .mockResolvedValueOnce(memberResponse([moonBot, 'join'], [appBotPerson, 'join']))
        .mockResolvedValueOnce(memberResponse([moonBot, 'join'], [appBotPerson, 'join']))
        .mockResolvedValueOnce(memberResponse([moonBot, 'join'], [appBotPerson, 'join'], [third, 'join']))
    }, 'app-bot')
    const upload = vi.spyOn(f.client, 'uploadContent').mockResolvedValue({ content_uri: 'mxc://test/private-photo' })
    const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$must-not-send' } as never)

    await expect(f.sdk.command({
      kind: 'appBotApiSend',
      roomId,
      directPerson: appBotPerson,
      body: 'receipt',
      transactionId: 'atum-bot-photo-audience-change',
      metadata: { version: 'io.atum.bot_api/1', bot_id: moon, public_message_id: 59 },
      photo: {
        bytes_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        mime_type: 'image/png',
        width: 1,
        height: 1
      }
    })).rejects.toThrow('matrix_app_bot_audience_changed')

    expect(upload).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it('publishes a Bot API message only while the admitted direct audience is unchanged', async () => {
    const roomId = '!bot-api-direct:test'
    const f = await sdkFor(moonBot, client => {
      holdRoom(client, roomId, { members: { [appBotPerson]: 'join' } })
      vi.spyOn(client, 'members').mockResolvedValue(memberResponse([moonBot, 'join'], [appBotPerson, 'join']))
    }, 'app-bot')
    const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$bot-message' } as never)

    await expect(f.sdk.command({
      kind: 'appBotApiSend',
      roomId,
      directPerson: appBotPerson,
      body: 'private answer',
      transactionId: 'atum-bot-unchanged-audience',
      metadata: { version: 'io.atum.bot_api/1', bot_id: moon, public_message_id: 56 }
    })).resolves.toBe('$bot-message')

    expect(f.client.members).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledOnce()
  })

  it('refuses when a member joins between the retry check and Bot API publication', async () => {
    const roomId = '!bot-api-changed:test'
    const third = '@third:atumplatform.com'
    const f = await sdkFor(moonBot, client => {
      holdRoom(client, roomId, { members: { [appBotPerson]: 'join' } })
      vi.spyOn(client, 'members')
        .mockResolvedValueOnce(memberResponse([moonBot, 'join'], [appBotPerson, 'join']))
        .mockResolvedValueOnce(memberResponse([moonBot, 'join'], [appBotPerson, 'join'], [third, 'join']))
    }, 'app-bot')
    const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$must-not-send' } as never)

    await expect(f.sdk.command({
      kind: 'appBotApiSend',
      roomId,
      directPerson: appBotPerson,
      body: 'private answer',
      transactionId: 'atum-bot-changed-audience',
      metadata: { version: 'io.atum.bot_api/1', bot_id: moon, public_message_id: 57 }
    })).rejects.toThrow('matrix_app_bot_audience_changed')

    expect(send).not.toHaveBeenCalled()
  })

  it('refuses Bot API publication when current membership cannot be established', async () => {
    const roomId = '!bot-api-unknown:test'
    const f = await sdkFor(moonBot, client => {
      holdRoom(client, roomId, { members: { [appBotPerson]: 'join' } })
      vi.spyOn(client, 'members').mockRejectedValue(new Error('homeserver unavailable'))
    }, 'app-bot')
    const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$must-not-send' } as never)

    await expect(f.sdk.command({
      kind: 'appBotApiSend',
      roomId,
      directPerson: appBotPerson,
      body: 'private answer',
      transactionId: 'atum-bot-unknown-audience',
      metadata: { version: 'io.atum.bot_api/1', bot_id: moon, public_message_id: 58 }
    })).rejects.toThrow('matrix_app_bot_audience_unknown')

    expect(send).not.toHaveBeenCalled()
  })

  it('aborts a bounded upload before event send and ignores its late success', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test'))
    const send = vi.spyOn(f.client, 'sendEvent').mockResolvedValue({ event_id: '$late' } as never)
    let signal: AbortSignal | undefined

    const upload = vi.spyOn(f.client, 'uploadContent').mockImplementation(((
      _blob: Blob,
      options: Parameters<MatrixClient['uploadContent']>[1]
    ) => {
      signal = options?.abortController?.signal

      // Deliberately ignore abort like a hostile/buggy transport. The wrapper's race
      // must still reject and this late media success must never reach sendEvent.
      return new Promise(resolve =>
        setTimeout(() => resolve({ content_uri: 'mxc://test/late' }), MATRIX_ATTACHMENT_UPLOAD_TIMEOUT_MS + 5_000)
      )
    }) as never)

    vi.useFakeTimers()

    try {
      const pending = f.sdk.command({ kind: 'attach', roomId: '!room:test', name: 'report.pdf', bytes })
      const failed = expect(pending).rejects.toThrow('matrix_send_failed')
      await vi.advanceTimersByTimeAsync(MATRIX_ATTACHMENT_UPLOAD_TIMEOUT_MS)
      await failed

      expect(signal?.aborted).toBe(true)
      expect(send).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5_000)
      expect(upload).toHaveBeenCalledOnce()
      expect(send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps homeserver upload rejection 413 to the closed file-size refusal without posting an event', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test'))
    const send = vi.spyOn(f.client, 'sendEvent')
    vi.spyOn(f.client, 'uploadContent').mockRejectedValue(
      Object.assign(new Error('private homeserver response'), { httpStatus: 413, errcode: 'M_TOO_LARGE' })
    )

    await expect(f.sdk.command({ kind: 'attach', roomId: '!room:test', name: 'report.pdf', bytes })).rejects.toThrow(
      'matrix_file_invalid'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a genuine oversize file before upload or event send', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!room:test'))
    const upload = vi.spyOn(f.client, 'uploadContent')
    const send = vi.spyOn(f.client, 'sendEvent')

    await expect(
      f.sdk.command({
        kind: 'attach',
        roomId: '!room:test',
        name: 'too-large.pdf',
        bytes: new Uint8Array(MATRIX_MAX_FILE_BYTES + 1)
      })
    ).rejects.toThrow('matrix_file_invalid')
    expect(upload).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('forwards visible content once with relations and mentions stripped', async () => {
    let source!: Room
    const f = await sdkFor(owner, client => {
      source = holdRoom(client, '!source:test')
      holdRoom(client, '!target:test')
    })
    const server = homeserver(f.client)
    await source.addLiveEvents([new MatrixEvent({
      type: EventType.RoomMessage, room_id: source.roomId, event_id: '$source', sender: owner,
      origin_server_ts: 1, content: {
        msgtype: 'm.text', body: 'Forward me',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } },
        'm.mentions': { user_ids: ['@agent:test'] },
        'io.atum.turn': 'drop'
      }
    })], { addToState: false })
    const command = { kind: 'forward' as const, roomId: source.roomId, eventId: '$source',
      toRoomId: '!target:test', dialogNonce: 'dialog' }

    await expect(f.sdk.command(command)).resolves.toBe('$sent1')
    expect(server.send).toHaveBeenCalledOnce()
    expect(server.send.mock.calls[0]![3]).toMatch(/^atum-fw-[A-Za-z0-9_-]{32}$/u)
    expect(server.send.mock.calls[0]![2]).toEqual({
      msgtype: 'm.text', body: 'Forward me', 'io.atum.forwarded': true
    })
  })

  it('keeps encrypted media encrypted and re-encrypts plain media for an encrypted target', async () => {
    let source!: Room
    const f = await sdkFor(owner, client => {
      source = holdRoom(client, '!source:test')
      holdRoom(client, '!target:test', { encrypted: true })
    })
    const server = homeserver(f.client)
    const plain = new Uint8Array([1, 2, 3])
    server.media.set('mxc://test/plain', plain)
    await source.addLiveEvents([new MatrixEvent({
      type: EventType.RoomMessage, room_id: source.roomId, event_id: '$plain', sender: owner,
      origin_server_ts: 1, content: {
        msgtype: 'm.file', body: 'notes.txt', url: 'mxc://test/plain', info: { mimetype: 'text/plain', size: 3 }
      }
    })], { addToState: false })

    await f.sdk.command({ kind: 'forward', roomId: source.roomId, eventId: '$plain',
      toRoomId: '!target:test', dialogNonce: 'plain' })
    const content = server.send.mock.calls[0]![2] as unknown as Record<string, unknown>
    expect(content).not.toHaveProperty('url')
    expect(content.file).toMatchObject({ url: 'mxc://test/media2', v: 'v2' })
    expect(server.media.get('mxc://test/media2')).not.toEqual(plain)
  })

  it('refuses a company message sent to a personal room even when the renderer asks', async () => {
    const companyId = '00000000-0000-4000-8000-8c031eadb7f3'
    const channelId = '00000000-0000-4000-8000-16b7785de2e4'
    let source!: Room
    const f = await sdkFor(owner, client => {
      source = holdRoom(client, '!company:test', {
        type: MATRIX_COMPANY_CHANNEL_TYPE,
        create: {
          room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
          [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId, channelId }
        }
      })
      holdRoom(client, '!personal:test')
    })
    const send = vi.spyOn(f.client, 'sendEvent')
    await source.addLiveEvents([new MatrixEvent({
      type: EventType.RoomMessage, room_id: source.roomId, event_id: '$company', sender: owner,
      origin_server_ts: 1, content: { msgtype: 'm.text', body: 'Team only' }
    })], { addToState: false })

    await expect(f.sdk.command({ kind: 'forward', roomId: source.roomId, eventId: '$company',
      toRoomId: '!personal:test', dialogNonce: 'scope' })).rejects.toThrow('matrix_forward_scope')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('an official bot’s host', () => {
  const bot = (prepare: (client: MatrixClient) => void = () => {}) => sdkFor(moonBot, prepare, 'app-bot')

  const message = (type: string, content: Record<string, unknown> = { msgtype: 'm.text', body: 'xin chào' }) => ({
    type,
    room_id: '!dm:test',
    event_id: '$message',
    sender: owner,
    origin_server_ts: 2_000,
    content
  })

  it('hears a live plain message in a plain chat, never a plaintext one in an encrypted chat', async () => {
    const f = await bot(client => {
      holdRoom(client, '!dm:test')
      holdRoom(client, '!old:test', { encrypted: true })
      // Encrypted, but its encryption state has not synced here yet; the crypto store knows.
      holdRoom(client, '!lag:test')
      vi.mocked(client.getCrypto).mockReturnValue({
        globalBlacklistUnverifiedDevices: false,
        isEncryptionEnabledInRoom: async (roomId: string) => roomId === '!lag:test'
      } as unknown as ReturnType<MatrixClient['getCrypto']>)
    })

    await f.sdk.command({ kind: 'appBotWatch', watch: true })

    const live = (roomId: string, eventId: string) =>
      f.client.emit(
        RoomEvent.Timeline,
        new MatrixEvent({ ...message(EventType.RoomMessage), room_id: roomId, event_id: eventId }),
        f.client.getRoom(roomId)!,
        false,
        false,
        { liveEvent: true, timeline: f.client.getRoom(roomId)!.getLiveTimeline() }
      )

    live('!lag:test', '$lagged')
    live('!old:test', '$forged')
    live('!dm:test', '$plain')
    await vi.waitFor(() => expect(f.offerAppBotEvent).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.offerAppBotEvent.mock.calls).toEqual([[{ roomId: '!dm:test', eventId: '$plain' }]])
  })

  it('passes a live plain message on while the crypto store has not answered, for the pipeline to read again', async () => {
    const f = await bot(client => {
      holdRoom(client, '!dm:test')
      vi.mocked(client.getCrypto).mockReturnValue({
        globalBlacklistUnverifiedDevices: false,
        isEncryptionEnabledInRoom: () => new Promise<boolean>(() => {})
      } as unknown as ReturnType<MatrixClient['getCrypto']>)
    })

    await f.sdk.command({ kind: 'appBotWatch', watch: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      f.client.emit(
        RoomEvent.Timeline,
        new MatrixEvent({ ...message(EventType.RoomMessage), event_id: '$plain' }),
        f.client.getRoom('!dm:test')!,
        false,
        false,
        { liveEvent: true, timeline: f.client.getRoom('!dm:test')!.getLiveTimeline() }
      )
      await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)
    } finally {
      vi.useRealTimers()
    }

    expect(f.offerAppBotEvent.mock.calls).toEqual([[{ roomId: '!dm:test', eventId: '$plain' }]])
  })

  it('lists plain and encrypted rooms alike after a restart', async () => {
    const f = await bot(client => {
      holdRoom(client, '!dm:test')
      holdRoom(client, '!old:test', { encrypted: true })
      holdRoom(client, '!invite:test', { membership: 'invite', inviter: owner })
    })

    const rooms = (await f.sdk.command({ kind: 'appBotRooms' })) as Array<{ roomId: string }>
    expect(rooms.map(room => room.roomId).sort()).toEqual(['!dm:test', '!invite:test', '!old:test'])
  })

  it('reads a plain message in a plain chat with its words and the stand-in device', async () => {
    const f = await bot(client => holdRoom(client, '!dm:test'))
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(message(EventType.RoomMessage) as never)

    await expect(
      f.sdk.command({ kind: 'appBotReadEvent', roomId: '!dm:test', eventId: '$message' })
    ).resolves.toMatchObject({
      sender: owner,
      senderDevice: 'unencrypted',
      encrypted: false,
      decrypted: false,
      content: { msgtype: 'm.text', body: 'xin chào' }
    })
  })

  it('withholds a plaintext message’s words and device in an encrypted chat (no downgrade)', async () => {
    const f = await bot(client => holdRoom(client, '!dm:test', { encrypted: true }))
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(message(EventType.RoomMessage) as never)

    await expect(
      f.sdk.command({ kind: 'appBotReadEvent', roomId: '!dm:test', eventId: '$message' })
    ).resolves.toMatchObject({
      senderDevice: null,
      encrypted: false,
      content: {}
    })
  })

  it('asks the server whether a room it does not hold yet is plain, and treats a failed answer as encrypted', async () => {
    const f = await bot()
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(message(EventType.RoomMessage) as never)

    const state = vi
      .spyOn(f.client, 'getStateEvent')
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { errcode: 'M_NOT_FOUND' }))
      .mockRejectedValueOnce(new Error('network'))

    await expect(
      f.sdk.command({ kind: 'appBotReadEvent', roomId: '!dm:test', eventId: '$message' })
    ).resolves.toMatchObject({
      senderDevice: 'unencrypted',
      content: { body: 'xin chào' }
    })
    await expect(
      f.sdk.command({ kind: 'appBotReadEvent', roomId: '!dm:test', eventId: '$message' })
    ).resolves.toMatchObject({
      senderDevice: null,
      content: {}
    })
    expect(state).toHaveBeenCalledWith('!dm:test', EventType.RoomEncryption, '')
  })

  it('catches up on plain messages in a plain chat, and only ciphertext in an encrypted one', async () => {
    const page = {
      chunk: [message(EventType.RoomMessage), { ...message(EventType.RoomMessageEncrypted), event_id: '$cipher' }]
    }

    const plain = await bot(client => holdRoom(client, '!dm:test'))
    vi.spyOn(plain.client, 'createMessagesRequest').mockResolvedValue(page as never)
    await expect(
      plain.sdk.command({ kind: 'appBotScan', roomId: '!dm:test', since: 1_000, pageCap: 1 })
    ).resolves.toEqual({ hints: [{ roomId: '!dm:test', eventId: '$message', timestamp: 2_000 }], complete: true })
    await plain.sdk.stop()

    const encrypted = await bot(client => holdRoom(client, '!dm:test', { encrypted: true }))
    vi.spyOn(encrypted.client, 'createMessagesRequest').mockResolvedValue(page as never)
    await expect(
      encrypted.sdk.command({ kind: 'appBotScan', roomId: '!dm:test', since: 1_000, pageCap: 1 })
    ).resolves.toEqual({ hints: [{ roomId: '!dm:test', eventId: '$cipher', timestamp: 2_000 }], complete: true })
  })

  it('takes only ciphertext, and reports the room encrypted, where the crypto store knows it is though its state has not synced', async () => {
    const page = {
      chunk: [message(EventType.RoomMessage), { ...message(EventType.RoomMessageEncrypted), event_id: '$cipher' }]
    }

    const f = await bot(client => {
      holdRoom(client, '!dm:test')
      vi.mocked(client.getCrypto).mockReturnValue({
        globalBlacklistUnverifiedDevices: false,
        isEncryptionEnabledInRoom: async () => true
      } as unknown as ReturnType<MatrixClient['getCrypto']>)
    })
    vi.spyOn(f.client, 'createMessagesRequest').mockResolvedValue(page as never)
    await expect(
      f.sdk.command({ kind: 'appBotScan', roomId: '!dm:test', since: 1_000, pageCap: 1 })
    ).resolves.toEqual({ hints: [{ roomId: '!dm:test', eventId: '$cipher', timestamp: 2_000 }], complete: true })
    await expect(f.sdk.command({ kind: 'appBotInviteState', roomId: '!dm:test' })).resolves.toMatchObject({
      membership: 'join',
      encrypted: true
    })
  })

  it('reports a plain chat as plain once the crypto store agrees', async () => {
    const f = await bot(client => holdRoom(client, '!dm:test'))
    await expect(f.sdk.command({ kind: 'appBotInviteState', roomId: '!dm:test' })).resolves.toMatchObject({
      membership: 'join',
      encrypted: false
    })
  })

  // A busy bot host (its store committing, twenty rooms rescanning) can leave the crypto store's
  // answer past `PLAIN_ANSWER_MS`. That is no answer: never a scan of ciphertext only (which would
  // skip the room's plain messages and let the host move its cursor past them), never a plain
  // message withheld as if the room were encrypted, never a room reported encrypted.
  it('reports a scan incomplete, a read failed and the room unknown while the crypto store has not answered', async () => {
    let answer: (encrypted: boolean) => void = () => {}
    const asked = vi.fn((_roomId: string) => new Promise<boolean>(resolve => (answer = resolve)))

    const f = await bot(client => {
      holdRoom(client, '!dm:test')
      vi.mocked(client.getCrypto).mockReturnValue({
        globalBlacklistUnverifiedDevices: false,
        isEncryptionEnabledInRoom: asked
      } as unknown as ReturnType<MatrixClient['getCrypto']>)
    })

    const page = vi
      .spyOn(f.client, 'createMessagesRequest')
      .mockResolvedValue({ chunk: [message(EventType.RoomMessage)] } as never)

    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(message(EventType.RoomMessage) as never)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const scan = f.sdk.command({ kind: 'appBotScan', roomId: '!dm:test', since: 1_000, pageCap: 1 })
      const read = f.sdk.command({ kind: 'appBotReadEvent', roomId: '!dm:test', eventId: '$message' })
      const state = f.sdk.command({ kind: 'appBotInviteState', roomId: '!dm:test' })
      read.catch(() => {})
      await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)

      await expect(scan).resolves.toEqual({ hints: [], complete: false })
      expect(page).not.toHaveBeenCalled()
      await expect(read).rejects.toThrow()
      expect((await state) as Record<string, unknown>).toMatchObject({ membership: 'join', encrypted: undefined })
    } finally {
      vi.useRealTimers()
    }

    // Once the store answers, the same room is scanned and read as the plain chat it is.
    asked.mockResolvedValue(false)
    answer(false)
    await expect(
      f.sdk.command({ kind: 'appBotScan', roomId: '!dm:test', since: 1_000, pageCap: 1 })
    ).resolves.toEqual({ hints: [{ roomId: '!dm:test', eventId: '$message', timestamp: 2_000 }], complete: true })
    await expect(
      f.sdk.command({ kind: 'appBotReadEvent', roomId: '!dm:test', eventId: '$message' })
    ).resolves.toMatchObject({ senderDevice: 'unencrypted', content: { body: 'xin chào' } })
    await expect(f.sdk.command({ kind: 'appBotInviteState', roomId: '!dm:test' })).resolves.toMatchObject({
      encrypted: false
    })
  })

  // A bot that answers only in plain chats may publish no devices; the read-back after a restart
  // still has to find its own replies, so it never sends a plain reply twice.
  it('lists its own recent replies even when it has published no devices', async () => {
    const f = await bot(client => holdRoom(client, '!dm:test'))
    vi.spyOn(f.client, 'createMessagesRequest').mockResolvedValue({
      chunk: [
        { ...message(EventType.RoomMessage), event_id: '$reply', sender: moonBot },
        message(EventType.RoomMessage)
      ]
    } as never)

    await expect(
      f.sdk.command({ kind: 'appBotRecent', roomId: '!dm:test', untilTs: 1_000, pageCap: 1, botDevices: [] })
    ).resolves.toEqual({ eventIds: ['$reply'], complete: true })
  })

  it('finds the person’s plain direct chat for a notice', async () => {
    const f = await bot(client => {
      const dm = holdRoom(client, '!dm:test')
      dm.addAccountData([
        new MatrixEvent({
          type: 'io.atum.app_bot.state',
          content: { v: 2, classification: 'direct', direct_person: owner }
        })
      ])
    })

    const create = vi.spyOn(f.client, 'createRoom')

    await expect(f.sdk.command({ kind: 'appBotDirectRoomWith', userId: owner })).resolves.toBe('!dm:test')
    expect(create).not.toHaveBeenCalled()
  })
})

describe('a bot’s buttons in the person’s plain chat', () => {
  const notice = (sender = moonBot, type: string = EventType.RoomMessage) => ({
    type,
    room_id: '!moon:test',
    event_id: '$notice',
    sender,
    origin_server_ts: 1,
    content: {
      msgtype: 'm.notice',
      body: 'Set up Moon',
      'io.atum.app_bot': {
        v: 1,
        app_id: moon,
        kind: 'notice',
        turn_id: null,
        code: 'needs_setup',
        action: { app: 'moon', kind: 'open_setup' }
      }
    }
  })

  const evidence = {
    kind: 'appBotDisplayEvidence' as const,
    appId: moon,
    app: 'moon',
    guest: false,
    userId: moonBot,
    roomId: '!moon:test',
    eventId: '$notice',
    devices: []
  }

  it('shows the bot’s plain notice actions, with no device pin', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!moon:test', { members: { [moonBot]: 'join' } }))
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(notice() as never)

    await expect(f.sdk.command(evidence)).resolves.toEqual({
      appId: moon,
      kind: 'notice',
      authenticated: true,
      code: 'needs_setup',
      action: { kind: 'open_setup', app: 'moon' }
    })
  })

  it('returns authenticated display evidence for an official bot-api message', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!moon:test', { members: { [moonBot]: 'join' } }))
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue({
      type: EventType.RoomMessage,
      room_id: '!moon:test',
      event_id: '$notice',
      sender: moonBot,
      origin_server_ts: 1,
      content: {
        msgtype: 'm.text',
        body: 'Hello',
        'io.atum.bot_api': {
          version: 'io.atum.bot_api/1',
          bot_id: moon,
          public_message_id: 42
        }
      }
    } as never)

    await expect(f.sdk.command(evidence)).resolves.toEqual({
      appId: moon,
      kind: 'bot_api',
      authenticated: true,
      botId: moon,
      publicMessageId: 42
    })
  })

  it('never shows actions from someone else, or a plaintext notice in an encrypted chat', async () => {
    const plain = await sdkFor(owner, client => holdRoom(client, '!moon:test'))
    vi.spyOn(plain.client, 'fetchRoomEvent').mockResolvedValue(notice('@stranger:test') as never)
    await expect(plain.sdk.command(evidence)).resolves.toBeNull()
    await plain.sdk.stop()

    const encrypted = await sdkFor(owner, client => holdRoom(client, '!moon:test', { encrypted: true }))
    vi.spyOn(encrypted.client, 'fetchRoomEvent').mockResolvedValue(notice() as never)
    await expect(encrypted.sdk.command(evidence)).resolves.toBeNull()
  })

  it('accepts a guest-enabled bot’s canonical actions from only its own official bot identity', async () => {
    const f = await sdkFor(owner, client =>
      holdRoom(client, '!demoza:test', { members: { [demozaBot]: 'join' } })
    )
    const fetchEvent = vi.spyOn(f.client, 'fetchRoomEvent')
    const demozaEvidence = {
      kind: 'appBotDisplayEvidence' as const,
      appId: demoza,
      app: 'demoza',
      guest: true,
      userId: demozaBot,
      roomId: '!demoza:test',
      eventId: '$demoza-notice',
      devices: []
    }
    const demozaNotice = (code: string, action: Record<string, unknown>, sender = demozaBot) => ({
      type: EventType.RoomMessage,
      room_id: '!demoza:test',
      event_id: '$demoza-notice',
      sender,
      origin_server_ts: 1,
      content: {
        msgtype: 'm.notice',
        body: 'Demoza notice',
        'io.atum.app_bot': {
          v: 1,
          app_id: demoza,
          kind: 'notice',
          turn_id: null,
          code,
          action
        }
      }
    })

    for (const [code, action] of [
      ['guest_limit_reached', { kind: 'connect_account', app: 'demoza' }],
      ['quota_unavailable', { kind: 'retry_later' }],
      ['busy', { kind: 'wait' }],
      ['outcome_unknown', { kind: 'acknowledge_unknown' }]
    ] as const) {
      fetchEvent.mockResolvedValueOnce(demozaNotice(code, action) as never)
      await expect(f.sdk.command(demozaEvidence)).resolves.toMatchObject({
        appId: demoza,
        kind: 'notice',
        authenticated: true,
        code,
        action
      })
    }

    fetchEvent.mockResolvedValueOnce(
      demozaNotice('guest_limit_reached', { kind: 'connect_account', app: 'moon' }) as never
    )
    await expect(f.sdk.command(demozaEvidence)).resolves.toBeNull()

    fetchEvent.mockResolvedValueOnce(
      demozaNotice('quota_unavailable', { kind: 'retry_later' }, moonBot) as never
    )
    await expect(f.sdk.command(demozaEvidence)).resolves.toBeNull()
  })

  describe('an app the client has no code for', () => {
    const acme = '00000000-0000-4000-8000-e2f66bfade22'
    const acmeBot = '@app-acme:atumplatform.com'

    const acmeEvidence = (guest: boolean) => ({
      kind: 'appBotDisplayEvidence' as const,
      appId: acme,
      app: 'acme',
      guest,
      userId: acmeBot,
      roomId: '!acme:test',
      eventId: '$acme-notice',
      devices: []
    })

    const acmeNotice = (code: string, action: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
      type: EventType.RoomMessage,
      room_id: '!acme:test',
      event_id: '$acme-notice',
      sender: acmeBot,
      origin_server_ts: 1,
      content: {
        msgtype: 'm.notice',
        body: 'Acme notice',
        'io.atum.app_bot': { v: 1, app_id: acme, kind: 'notice', turn_id: null, code, action, ...extra }
      }
    })

    const room = () =>
      sdkFor(owner, client => holdRoom(client, '!acme:test', { members: { [acmeBot]: 'join' } }))

    it('shows the buttons its bot sends in the plain chat, from the identity its catalog names', async () => {
      const f = await room()
      const fetchEvent = vi.spyOn(f.client, 'fetchRoomEvent')

      for (const action of [
        { kind: 'open_setup', app: 'acme' },
        { kind: 'open_bot_dm', app: 'acme' },
        { kind: 'open_app_route', app: 'acme', route_id: 'chat' }
      ]) {
        fetchEvent.mockResolvedValueOnce(acmeNotice('needs_setup', action) as never)
        await expect(f.sdk.command(acmeEvidence(false))).resolves.toEqual({
          appId: acme,
          kind: 'notice',
          authenticated: true,
          code: 'needs_setup',
          action
        })
      }
    })

    it('gives a guest-enabled bot the same recovery actions Demoza has, and no other bot', async () => {
      const f = await room()
      const fetchEvent = vi.spyOn(f.client, 'fetchRoomEvent')

      for (const [code, action] of [
        ['guest_limit_reached', { kind: 'connect_account', app: 'acme' }],
        ['quota_unavailable', { kind: 'retry_later' }],
        ['busy', { kind: 'wait' }],
        ['outcome_unknown', { kind: 'acknowledge_unknown' }]
      ] as const) {
        fetchEvent.mockResolvedValueOnce(acmeNotice(code, action) as never)
        await expect(f.sdk.command(acmeEvidence(true))).resolves.toMatchObject({ authenticated: true, code, action })

        // The same notice from a bot the catalog does not call guest-enabled is not believed.
        fetchEvent.mockResolvedValueOnce(acmeNotice(code, action) as never)
        await expect(f.sdk.command(acmeEvidence(false))).resolves.toBeNull()
      }
    })

    it('refuses an action that names another app, another sender or another bot identity', async () => {
      const f = await room()
      const fetchEvent = vi.spyOn(f.client, 'fetchRoomEvent')

      // A command refused before any read leaves the next event unread, so each case sets its own.
      fetchEvent.mockResolvedValue(acmeNotice('needs_setup', { kind: 'open_setup', app: 'moon' }) as never)
      await expect(f.sdk.command(acmeEvidence(false))).resolves.toBeNull()

      fetchEvent.mockResolvedValue({ ...acmeNotice('needs_setup', null), sender: moonBot } as never)
      await expect(f.sdk.command(acmeEvidence(false))).resolves.toBeNull()

      // The catalog's app and bot must agree: acme's id with Moon's identity is nobody's bot, even
      // when that very identity is the one that sent the notice.
      fetchEvent.mockResolvedValue({ ...acmeNotice('needs_setup', null), sender: moonBot } as never)
      await expect(f.sdk.command({ ...acmeEvidence(false), userId: moonBot })).resolves.toBeNull()

      fetchEvent.mockResolvedValue(acmeNotice('needs_setup', null, { app_id: moon }) as never)
      await expect(f.sdk.command(acmeEvidence(false))).resolves.toBeNull()

      // And the same notice, sent by the right bot for the right app, is believed.
      fetchEvent.mockResolvedValue(acmeNotice('needs_setup', null) as never)
      await expect(f.sdk.command(acmeEvidence(false))).resolves.toMatchObject({ authenticated: true, action: null })
    })

    // The platform may add fields to what a bot sends; an older Atum reads what gives authority
    // (kind, app, route, code, ids) and ignores the rest, which does not survive the read.
    it('believes a notice with fields it does not know, in the metadata and in the action, and strips them', async () => {
      const f = await room()
      const fetchEvent = vi.spyOn(f.client, 'fetchRoomEvent')

      for (const [code, action, guest, expected] of [
        ['needs_setup', { kind: 'open_setup', app: 'acme', style: 'quiet' }, false, { kind: 'open_setup', app: 'acme' }],
        ['needs_setup', { kind: 'open_bot_dm', app: 'acme', x: 1 }, false, { kind: 'open_bot_dm', app: 'acme' }],
        [
          'needs_intake',
          { kind: 'open_app_route', app: 'acme', route_id: 'intake', badge: 3 },
          false,
          { kind: 'open_app_route', app: 'acme', route_id: 'intake' }
        ],
        ['guest_limit_reached', { kind: 'connect_account', app: 'acme', cta: 'y' }, true, { kind: 'connect_account', app: 'acme' }],
        ['quota_unavailable', { kind: 'retry_later', after_ms: 5000 }, true, { kind: 'retry_later' }],
        ['busy', { kind: 'wait', app: 'acme' }, true, { kind: 'wait' }]
      ] as const) {
        fetchEvent.mockResolvedValue(acmeNotice(code, action, { future_meta: { a: 1 } }) as never)

        await expect(f.sdk.command(acmeEvidence(guest))).resolves.toEqual({
          appId: acme,
          kind: 'notice',
          authenticated: true,
          code,
          action: expected
        })
      }
    })

    it('still refuses a notice that names another app, a kind or route that is not one, or a recovery action for the wrong code', async () => {
      const f = await room()
      const fetchEvent = vi.spyOn(f.client, 'fetchRoomEvent')

      for (const [code, action, guest] of [
        ['needs_setup', { kind: 'open_setup', app: 'moon', style: 'quiet' }, false],
        ['needs_setup', { kind: 'delete_everything', app: 'acme' }, false],
        ['needs_intake', { kind: 'open_app_route', app: 'acme', route_id: 'Bad Route!' }, false],
        ['needs_intake', { kind: 'open_app_route', app: 'acme' }, false],
        ['needs_intake', { kind: 'open_app_route', app: 'acme', route_id: 7 }, false],
        ['busy', { kind: 'retry_later' }, true],
        ['quota_unavailable', { kind: 'wait', after_ms: 1 }, true],
        ['busy', { kind: 'wait', app: 'moon' }, true],
        ['guest_limit_reached', { kind: 'connect_account', app: 'acme', cta: 'y' }, false]
      ] as const) {
        fetchEvent.mockResolvedValue(acmeNotice(code, action, { future_meta: true }) as never)

        await expect(f.sdk.command(acmeEvidence(guest)), `${code} ${JSON.stringify(action)}`).resolves.toBeNull()
      }
    })

    it('believes a reply with fields it does not know, and still reads its turn and parts strictly', async () => {
      const f = await room()
      const fetchEvent = vi.spyOn(f.client, 'fetchRoomEvent')
      const turn = '00000000-0000-4000-8000-5c28b2022dca'

      const reply = (change: Record<string, unknown>) => ({
        type: EventType.RoomMessage,
        room_id: '!acme:test',
        event_id: '$acme-notice',
        sender: acmeBot,
        origin_server_ts: 1,
        content: {
          msgtype: 'm.text',
          body: 'Hello',
          'io.atum.app_bot': { v: 1, app_id: acme, kind: 'reply', turn_id: turn, part: 1, parts: 2, ...change }
        }
      })

      fetchEvent.mockResolvedValue(reply({ future: { a: 1 } }) as never)
      await expect(f.sdk.command(acmeEvidence(false))).resolves.toEqual({
        appId: acme,
        kind: 'reply',
        authenticated: true,
        turnId: turn,
        part: 1,
        parts: 2
      })

      for (const change of [
        { turn_id: 'not-a-uuid' },
        { turn_id: '0192f4a0-7c3b-7d4e-8a1b-2c3d4e5f6a7b' },
        { part: 0 },
        { part: 3 },
        { parts: 5 },
        { part: 1.5 },
        { app_id: moon }
      ]) {
        fetchEvent.mockResolvedValue(reply(change) as never)
        await expect(f.sdk.command(acmeEvidence(false)), JSON.stringify(change)).resolves.toBeNull()
      }
    })
  })
})

describe('bot-api media', () => {
  it('downloads one photo and derives a caption only when body differs from an explicit filename', async () => {
    const f = await sdkFor(owner, client => holdRoom(client, '!moon:test', { members: { [moonBot]: 'join' } }))
    const fetchEvent = vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue({
      type: EventType.RoomMessage,
      room_id: '!moon:test',
      event_id: '$photo',
      sender: moonBot,
      origin_server_ts: 1,
      content: {
        msgtype: 'm.image', body: 'A useful caption', filename: 'IMG_1234.PNG', url: 'mxc://matrix.test/photo',
        info: { mimetype: 'image/png', w: 2, h: 3 }
      }
    } as never)
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    vi.spyOn(f.client.http, 'authedRequest').mockResolvedValue(new Blob([bytes]) as never)

    await expect(f.sdk.command({ kind: 'appBotReadMedia', roomId: '!moon:test', eventId: '$photo' })).resolves.toEqual({
      bytes, mxc: 'mxc://matrix.test/photo', mimeType: 'image/png', width: 2, height: 3,
      caption: 'A useful caption'
    })
    fetchEvent.mockResolvedValue({
      type: EventType.RoomMessage, room_id: '!moon:test', event_id: '$photo', sender: moonBot, origin_server_ts: 1,
      content: { msgtype: 'm.image', body: 'IMG_1234.PNG', filename: 'IMG_1234.PNG', url: 'mxc://matrix.test/photo', info: { mimetype: 'image/png', w: 2, h: 3 } }
    } as never)
    await expect(f.sdk.command({ kind: 'appBotReadMedia', roomId: '!moon:test', eventId: '$photo' })).resolves.not.toHaveProperty('caption')
    fetchEvent.mockResolvedValue({
      type: EventType.RoomMessage, room_id: '!moon:test', event_id: '$photo', sender: moonBot, origin_server_ts: 1,
      content: { msgtype: 'm.image', body: 'IMG_1234.PNG', url: 'mxc://matrix.test/photo', info: { mimetype: 'image/png', w: 2, h: 3 } }
    } as never)
    await expect(f.sdk.command({ kind: 'appBotReadMedia', roomId: '!moon:test', eventId: '$photo' })).resolves.not.toHaveProperty('caption')
    expect(f.client.http.authedRequest).toHaveBeenCalledWith(
      'GET', '/media/download/matrix.test/photo', undefined, undefined,
      { prefix: '/_matrix/client/v1', rawResponseBody: true, localTimeoutMs: expect.any(Number) }
    )
  })

  it('returns Matrix member display names to the app-bot host boundary', async () => {
    const f = await sdkFor(moonBot, client => {
      holdRoom(client, '!moon:test', { members: { [owner]: 'join' } })
      vi.spyOn(client, 'members').mockResolvedValue({
        chunk: [
          { state_key: owner, content: { membership: 'join', displayname: 'Minh' } },
          { state_key: moonBot, content: { membership: 'join', displayname: 'Moon' } }
        ]
      } as never)
    }, 'app-bot')

    await expect(f.sdk.command({ kind: 'appBotMembers', roomId: '!moon:test' })).resolves.toEqual([
      { userId: owner, membership: 'join', displayName: 'Minh' },
      { userId: moonBot, membership: 'join', displayName: 'Moon' }
    ])
  })

  it('renders an encrypted bot-api photo only after pinned evidence and an authenticated media read', async () => {
    const roomId = '!moon:test'
    const eventId = '$encrypted-photo'
    const device = { deviceId: 'MOON_1', ed25519: 'ed25519', curve25519: 'curve25519', retiredAt: null }
    const photoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const encryptedPhoto = Attachment.encrypt(photoBytes)
    const encryptedBytes = new Uint8Array(encryptedPhoto.encryptedData)
    const file = { ...JSON.parse(encryptedPhoto.mediaEncryptionInfo!), url: 'mxc://matrix.test/photo' }
    encryptedPhoto.free()

    const clearContent = {
      msgtype: 'm.image',
      body: 'Inspect this',
      file,
      info: { mimetype: 'image/png', w: 2, h: 3 },
      'io.atum.bot_api': {
        version: 'io.atum.bot_api/1',
        bot_id: moon,
        public_message_id: 42,
        photo: {
          file_ref: 'mref_0123456789abcdef',
          width: 2,
          height: 3,
          mime_type: 'image/png',
          caption: 'Inspect this'
        },
        fallback_text: 'Inspect this'
      }
    }
    const wire = () => ({
      type: EventType.RoomMessageEncrypted,
      room_id: roomId,
      event_id: eventId,
      sender: moonBot,
      origin_server_ts: 1,
      content: {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'fixture',
        device_id: device.deviceId,
        session_id: 'fixture'
      }
    })

    const f = await sdkFor(owner, client => {
      holdRoom(client, roomId, { encrypted: true, members: { [moonBot]: 'join' } })
      vi.mocked(client.getCrypto).mockReturnValue({
        globalBlacklistUnverifiedDevices: false,
        isEncryptionEnabledInRoom: async () => true,
        getEncryptionInfoForEvent: async () => ({ shieldColour: 0, shieldReason: null })
      } as unknown as ReturnType<MatrixClient['getCrypto']>)
    })
    vi.spyOn(f.client, 'fetchRoomEvent').mockImplementation(async () => wire() as never)
    vi.spyOn(f.client, 'decryptEventIfNeeded').mockImplementation(async event => {
      await event.attemptDecryption({
        decryptEvent: async () => ({
          clearEvent: { type: EventType.RoomMessage, content: clearContent },
          senderCurve25519Key: device.curve25519,
          claimedEd25519Key: device.ed25519
        })
      } as unknown as Parameters<MatrixEvent['attemptDecryption']>[0])
    })
    vi.spyOn(f.client.http, 'authedRequest').mockResolvedValue(new Blob([encryptedBytes]) as never)

    const evidence = await f.sdk.command({
      kind: 'appBotDisplayEvidence',
      appId: moon,
      app: 'moon',
      guest: false,
      userId: moonBot,
      roomId,
      eventId,
      devices: [device]
    })
    expect(evidence).toEqual({
      appId: moon,
      kind: 'bot_api',
      authenticated: true,
      botId: moon,
      publicMessageId: 42
    })

    const event = new MatrixEvent(wire() as never)
    await f.client.decryptEventIfNeeded(event)
    const projected = matrixMessage(event, owner, new Set(), f.client.getRoom(roomId)!, false, false)
    expect(projected?.botApi?.photo).toBeDefined()

    const message = { ...projected!, appBot: evidence as MatrixMessage['appBot'] }
    const app = { app_id: moon, bot: { user_id: moonBot } } as AppDescriptor
    const authorized = authorizedBotApi(app, message, true)
    expect(authorized?.photo).toBeDefined()

    const media = await f.sdk.command({ kind: 'appBotReadMedia', roomId, eventId })
    const renderedPhoto = appBotPhotoForRenderer(media)
    expect(renderedPhoto).not.toBeNull()

    render(
      createElement(
        I18nProvider,
        {
          configClient: null,
          initialLocale: 'en',
          children: createElement(MatrixBotApiPhotoView, {
            appId: moon,
            body: message.body,
            caption: authorized!.photo!.caption,
            eventId,
            locale: 'en',
            media: async () => renderedPhoto,
            photo: authorized!.photo!,
            roomId
          })
        }
      )
    )

    const image = await screen.findByRole('img', { name: 'Inspect this' })
    expect(image).toHaveProperty('src', renderedPhoto!.url)
    expect(f.client.http.authedRequest).toHaveBeenCalledWith(
      'GET', '/media/download/matrix.test/photo', undefined, undefined,
      { prefix: '/_matrix/client/v1', rawResponseBody: true, localTimeoutMs: expect.any(Number) }
    )
  })
})

describe('standard threads in the owner window', () => {
  it('shows another client’s personal-DM reply inline and acknowledges it only once that transcript is attended', async () => {
    const friend = '@friend:test'
    let room!: Room
    const f = await sdkFor(owner, client => {
      room = holdRoom(client, '!personal-thread:test', { direct: true, members: { [friend]: 'join' } })
    })
    const write = vi.spyOn(f.client, 'setRoomReadMarkersHttpRequest').mockResolvedValue({})
    const root = new MatrixEvent({
      type: EventType.RoomMessage,
      room_id: room.roomId,
      event_id: '$personal-root',
      sender: owner,
      origin_server_ts: 10,
      content: { msgtype: 'm.text', body: 'Where should we meet?' }
    })
    const reply = new MatrixEvent({
      type: EventType.RoomMessage,
      room_id: room.roomId,
      event_id: '$personal-reply',
      sender: friend,
      origin_server_ts: 20,
      content: {
        msgtype: 'm.text',
        body: 'At the cafe.',
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: '$personal-root',
          is_falling_back: true,
          'm.in_reply_to': { event_id: '$personal-root' }
        }
      }
    })

    await room.addLiveEvents([root, reply], { addToState: false })
    await vi.waitFor(() => expect(room.getThread('$personal-root')?.events.map(event => event.getId())).toEqual([
      '$personal-root',
      '$personal-reply'
    ]))
    expect(room.getLiveTimeline().getEvents().map(event => event.getId())).toEqual(['$personal-root'])

    await f.sdk.command({ kind: 'select', roomId: room.roomId })
    expect(f.latest().messages.map(message => message.id)).toEqual(['$personal-root', '$personal-reply'])
    expect(f.latest().messages[1]).toMatchObject({
      id: '$personal-reply',
      body: 'At the cafe.',
      replyTo: '$personal-root'
    })
    expect(f.latest().messages[1]).not.toHaveProperty('thread')
    expect(f.latest().threads).toEqual([])
    expect(write).not.toHaveBeenCalled()

    await f.sdk.command({ kind: 'attend', roomId: room.roomId })
    await vi.waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith(
      room.roomId,
      '$personal-reply',
      '$personal-reply',
      undefined
    ))
  })
})

describe('a company channel this person is invited to (OB1)', () => {
  const companyId = '00000000-0000-4000-8000-e8de92db6f7b'
  const channelId = '00000000-0000-4000-8000-a4cf5981107a'
  const manager = '@company-manager:test'
  const channel = (membership: string) => ({
    membership,
    inviter: manager,
    type: MATRIX_COMPANY_CHANNEL_TYPE,
    create: { room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION, [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId, channelId } }
  })

  it('reads fresh joined members only from the exact bound channel and fails on a private sibling', async () => {
    const f = await sdkFor(owner, client => { holdRoom(client, '!roster:test', channel('join')) })
    const members = vi.spyOn(f.client, 'members').mockResolvedValue({chunk: [
      {type: EventType.RoomMember, room_id: '!roster:test', state_key: owner,
        content: {membership: 'join', displayname: 'Alice'}},
      {type: EventType.RoomMember, room_id: '!roster:test', state_key: '@invited:test', content: {membership: 'invite'}},
      {type: EventType.RoomMember, room_id: '!private:test', state_key: '@private:test', content: {membership: 'join'}}
    ]} as never)
    expect(await readCompanyAIJoinedMembers(f.client, {companyId, channelId}, () => true))
      .toEqual([{userId: owner, displayName: 'Alice'}])
    expect(members).toHaveBeenCalledWith('!roster:test', 'join')
    await expect(readCompanyAIJoinedMembers(f.client,
      {companyId, channelId: '00000000-0000-4000-8000-551fde9a8877'}, () => true)).rejects.toThrow()
    expect(members).toHaveBeenCalledTimes(1)
  })

  it('gives a stuck Matrix membership read its own five-second deadline', async () => {
    const f = await sdkFor(owner, client => { holdRoom(client, '!roster:test', channel('join')) })
    vi.spyOn(f.client, 'members').mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const read = readCompanyAIJoinedMembers(f.client, {companyId, channelId}, () => true)
      const rejected = expect(read).rejects.toThrow('matrix_roster_timeout')
      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
    } finally { vi.useRealTimers() }
  })

  it('shows a CoS status or answer as one thread on its channel mention after live sync and room reselection', async () => {
    let room!: Room
    const f = await sdkFor(owner, client => {
      room = holdRoom(client, '!cos:test', channel('join'))
    })
    vi.spyOn(f.client, 'fetchRoomEvent').mockImplementation(async (_roomId, eventId) => ({
      type: 'm.room.message', room_id: room.roomId, event_id: eventId, sender: owner,
      origin_server_ts: 1, content: { msgtype: 'm.text', body: '@Chief of Staff hi' }
    }))
    await f.sdk.command({ kind: 'select', roomId: room.roomId })
    const root = new MatrixEvent({ type: EventType.RoomMessage, room_id: room.roomId,
      event_id: '$mention', sender: owner, origin_server_ts: 1,
      content: { msgtype: 'm.text', body: '@Chief of Staff hi' } })
    const reply = new MatrixEvent({ type: EventType.RoomMessage, room_id: room.roomId,
      event_id: '$status', sender: '@cos:test', origin_server_ts: 2,
      content: { msgtype: 'm.text', body: "Company AI couldn't confirm this answer.",
        'm.relates_to': { rel_type: 'm.thread', event_id: '$mention', is_falling_back: true,
          'm.in_reply_to': { event_id: '$mention' } } } })
    await room.addLiveEvents([root, reply], { addToState: false })
    await vi.waitFor(() => expect(room.getThread('$mention')?.events.some(event => event.getId() === '$status')).toBe(true))
    f.client.emit(RoomEvent.Timeline, reply, room, false, false, { liveEvent: true, timeline: room.getLiveTimeline() })
    await f.sdk.command({ kind: 'select', roomId: room.roomId })
    expect(f.latest().messages.map(message => message.id)).toContain('$mention')
    expect(f.latest().messages.map(message => message.id)).not.toContain('$status')
    expect(f.latest().threads).toContainEqual(expect.objectContaining({
      root: expect.objectContaining({ id: '$mention' }), replyCount: 1,
      replies: [expect.objectContaining({ id: '$status', sender: '@cos:test',
        body: "Company AI couldn't confirm this answer.", thread: true })]
    }))
    const question = await readCompanyAIQuestion(f.client, { companyId, channelId,
      threadRootEventId: '$mention', triggerEventId: '$mention' }, '@cos:test')
    expect(question.history).toContainEqual({role: 'assistant', text: "Company AI couldn't confirm this answer."})

  })

  it('keeps CoS intake on both a channel mention and its in-thread follow-up when SDK threads are on', async () => {
    const cos = '@cos:test'
    let room!: Room
    const f = await sdkFor(cos, client => {
      room = holdRoom(client, '!cos-watch:test', channel('join'))
    })
    const mention = new MatrixEvent({
      type: EventType.RoomMessage,
      room_id: room.roomId,
      event_id: '$m1',
      sender: owner,
      origin_server_ts: 1,
      content: { msgtype: 'm.text', body: '@Chief of Staff hi', 'm.mentions': { user_ids: [cos] } }
    })
    const followUp = new MatrixEvent({
      type: EventType.RoomMessage,
      room_id: room.roomId,
      event_id: '$f1',
      sender: owner,
      origin_server_ts: 2,
      content: {
        msgtype: 'm.text',
        body: '@Chief of Staff and then?',
        'm.mentions': { user_ids: [cos] },
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: '$m1',
          is_falling_back: true,
          'm.in_reply_to': { event_id: '$m1' }
        }
      }
    })

    await room.addLiveEvents([mention, followUp], { addToState: false })
    await vi.waitFor(() => expect(room.getThread('$m1')?.events.some(event => event.getId() === '$f1')).toBe(true))
    expect(room.getLiveTimeline().getEvents().map(event => event.getId())).toContain('$m1')
    expect(room.getLiveTimeline().getEvents().map(event => event.getId())).not.toContain('$f1')
    vi.spyOn(f.client,'createMessagesRequest').mockResolvedValue({start:'seed-token',end:'next-token',
      chunk:[mention.getEffectiveEvent(),followUp.getEffectiveEvent()]} as never)

    await expect(f.sdk.command({kind:'companyAIWatch',companyId,agentUserId:cos,
      checkpoint:{positions:[{roomId:room.roomId,token:'seed-token'}]},catchupAfterMs:0})).resolves.toMatchObject({
      schemaVersion: 2,
      hints: [
        {roomId:room.roomId,eventId:'$m1',atMs:1},
        {roomId:room.roomId,eventId:'$f1',atMs:2}
      ],
      checkpoint:{positions:[{roomId:room.roomId,token:'next-token',liveEventId:'$m1',draining:true}],nextRoomId:null}
    })
  })

  it('projects a server-supported CoS reply through the SDK production thread fetch path', async () => {
    const previousSupport = Thread.hasServerSideSupport
    const previousRelatedBySenders = FILTER_RELATED_BY_SENDERS.name
    const previousRelatedByRelTypes = FILTER_RELATED_BY_REL_TYPES.name
    const previousThreadRelation = THREAD_RELATION_TYPE.name
    Thread.setServerSideSupport(FeatureSupport.Stable)

    try {
      let room!: Room
      const f = await sdkFor(owner, client => {
        room = holdRoom(client, '!cos-server-thread:test', channel('join'))
      })
      const rootWire = {
        type: EventType.RoomMessage,
        room_id: room.roomId,
        event_id: '$server-mention',
        sender: owner,
        origin_server_ts: 10,
        unsigned: {},
        content: { msgtype: 'm.text', body: '@Chief of Staff hi' }
      }
      const replyWire = {
        type: EventType.RoomMessage,
        room_id: room.roomId,
        event_id: '$server-reply',
        sender: '@cos:test',
        origin_server_ts: 20,
        unsigned: {},
        content: {
          msgtype: 'm.text',
          body: 'Here is the answer.',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: '$server-mention',
            is_falling_back: true,
            'm.in_reply_to': { event_id: '$server-mention' }
          }
        }
      }
      const fetchRoot = vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(rootWire)
      const fetchRelations = vi.spyOn(f.client, 'fetchRelations').mockResolvedValue({ chunk: [replyWire] })
      vi.spyOn(f.client, 'getOrCreateFilter').mockResolvedValue('thread-filter')

      await room.addLiveEvents([new MatrixEvent(rootWire), new MatrixEvent(replyWire)], { addToState: false })
      await vi.waitFor(() => expect(room.getThread('$server-mention')?.initialEventsFetched).toBe(true))
      await f.sdk.command({ kind: 'select', roomId: room.roomId })

      expect(fetchRoot).toHaveBeenCalledWith(room.roomId, '$server-mention')
      expect(fetchRelations).toHaveBeenCalled()
      expect(f.latest().threads).toContainEqual(expect.objectContaining({
        root: expect.objectContaining({ id: '$server-mention' }),
        replyCount: 1,
        replies: [expect.objectContaining({ id: '$server-reply', body: 'Here is the answer.', thread: true })]
      }))
    } finally {
      Thread.setServerSideSupport(previousSupport)
      FILTER_RELATED_BY_SENDERS.setPreferUnstable(previousRelatedBySenders === FILTER_RELATED_BY_SENDERS.unstable)
      FILTER_RELATED_BY_REL_TYPES.setPreferUnstable(previousRelatedByRelTypes === FILTER_RELATED_BY_REL_TYPES.unstable)
      THREAD_RELATION_TYPE.setPreferUnstable(previousThreadRelation === THREAD_RELATION_TYPE.unstable)
    }
  })

  it('updates a channel root’s thread line live (count, repliers, last reply, unread) on the Stable server path', async () => {
    const previousSupport = Thread.hasServerSideSupport
    const previousRelatedBySenders = FILTER_RELATED_BY_SENDERS.name
    const previousRelatedByRelTypes = FILTER_RELATED_BY_REL_TYPES.name
    const previousThreadRelation = THREAD_RELATION_TYPE.name
    Thread.setServerSideSupport(FeatureSupport.Stable)

    try {
      let room!: Room
      const f = await sdkFor(owner, client => {
        room = holdRoom(client, '!cos-live-line:test', channel('join'))
      })
      const wire = (eventId: string, sender: string, ts: number, body: string, threaded: boolean) => ({
        type: EventType.RoomMessage,
        room_id: room.roomId,
        event_id: eventId,
        sender,
        origin_server_ts: ts,
        unsigned: {},
        content: {
          msgtype: 'm.text',
          body,
          ...(threaded
            ? { 'm.relates_to': { rel_type: 'm.thread', event_id: '$line-root', is_falling_back: true,
                'm.in_reply_to': { event_id: '$line-root' } } }
            : {})
        }
      })
      const rootWire = wire('$line-root', owner, 10, '@Chief of Staff any project updates?', false)
      const cosWire = wire('$line-cos', '@cos:test', 20, 'No project updates yet.', true)
      const ownWire = wire('$line-own', owner, 30, 'Thanks, check again tomorrow.', true)
      const serverReplies: Array<typeof cosWire> = [cosWire]
      vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue(rootWire)
      vi.spyOn(f.client, 'fetchRelations').mockImplementation(async () => ({ chunk: [...serverReplies].reverse() }))
      vi.spyOn(f.client, 'getOrCreateFilter').mockResolvedValue('thread-filter')
      const receipt = vi.spyOn(f.client, 'sendReadReceipt').mockResolvedValue({})

      await f.sdk.command({ kind: 'select', roomId: room.roomId })
      await room.addLiveEvents([new MatrixEvent(rootWire), new MatrixEvent(cosWire)], { addToState: false })
      await vi.waitFor(() => expect(room.getThread('$line-root')?.initialEventsFetched).toBe(true))

      // The CoS answer is a line under the root, never its own channel row.
      await vi.waitFor(() => expect(f.latest().threads).toContainEqual(expect.objectContaining({
        root: expect.objectContaining({ id: '$line-root' }),
        replyCount: 1,
        lastActivityAt: 20,
        replies: [expect.objectContaining({ id: '$line-cos', sender: '@cos:test', thread: true })]
      })))
      expect(f.latest().messages.map(message => message.id)).toEqual(['$line-root'])

      // A new reply arrives over sync: no manual re-emit, the projection republishes by itself.
      serverReplies.push(ownWire)
      await room.addLiveEvents([new MatrixEvent(ownWire)], { addToState: false })
      await vi.waitFor(() => expect(f.latest().threads?.find(thread => thread.root.id === '$line-root')).toMatchObject({
        replyCount: 2,
        lastActivityAt: 30,
        participantIds: [owner, '@cos:test']
      }))
      expect(f.latest().threads?.find(thread => thread.root.id === '$line-root')?.replies.map(reply => reply.sender))
        .toEqual(['@cos:test', owner])
      expect(f.latest().messages.map(message => message.id)).toEqual(['$line-root'])

      // Unread thread replies mark the line; reading the thread clears it.
      room.setThreadUnreadNotificationCount('$line-root', NotificationCountType.Total, 1)
      await vi.waitFor(() => expect(f.latest().threads?.find(thread => thread.root.id === '$line-root')?.unread).toBe(true))
      await f.sdk.command({ kind: 'threadRead', roomId: room.roomId, rootId: '$line-root' })
      expect(receipt.mock.calls.map(([event, type]) => [event?.getId(), type])).toEqual([['$line-own', 'm.read.private']])
      await vi.waitFor(() => expect(f.latest().threads?.find(thread => thread.root.id === '$line-root')?.unread).toBe(false))
    } finally {
      Thread.setServerSideSupport(previousSupport)
      FILTER_RELATED_BY_SENDERS.setPreferUnstable(previousRelatedBySenders === FILTER_RELATED_BY_SENDERS.unstable)
      FILTER_RELATED_BY_REL_TYPES.setPreferUnstable(previousRelatedByRelTypes === FILTER_RELATED_BY_REL_TYPES.unstable)
      THREAD_RELATION_TYPE.setPreferUnstable(previousThreadRelation === THREAD_RELATION_TYPE.unstable)
    }
  })

  it('keeps a legacy tagged Atum answer visible while SDK standard threads are enabled', async () => {
    let room!: Room
    const f = await sdkFor(owner, client => { room = holdRoom(client, '!legacy:test') })
    const root = new MatrixEvent({ type: EventType.RoomMessage, room_id: room.roomId,
      event_id: '$question', sender: owner, origin_server_ts: 1,
      content: { msgtype: 'm.text', body: 'hello' } })
    const reply = new MatrixEvent({ type: EventType.RoomMessage, room_id: room.roomId,
      event_id: '$old-answer', sender: '@agent:test', origin_server_ts: 2,
      content: { msgtype: 'm.text', body: 'older answer', 'io.atum.result': { invocation: 'old', transaction: 'old' },
        'm.relates_to': { rel_type: 'm.thread', event_id: '$question',
          'm.in_reply_to': { event_id: '$question' } } } })
    await room.addLiveEvents([root, reply], { addToState: false })
    await vi.waitFor(() => expect(room.getThread('$question')?.events.some(event => event.getId() === '$old-answer')).toBe(true))
    await f.sdk.command({ kind: 'select', roomId: room.roomId })
    expect(f.latest().messages).toContainEqual(expect.objectContaining({ id: '$old-answer', body: 'older answer' }))
  })

  it('is listed as that company’s channel while invited, accepts the invitation, and opens', async () => {
    const f = await sdkFor(owner, client => {
      holdRoom(client, '!chung:test', channel('invite'))
    })

    expect(f.latest().rooms.find(room => room.id === '!chung:test')).toMatchObject({
      membership: 'invite',
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId, channelId }
    })

    await expect(f.sdk.command({ kind: 'join', roomId: '!chung:test' })).resolves.toBeNull()
    expect(f.join).toHaveBeenCalledWith('!chung:test')
    await expect(f.sdk.command({ kind: 'select', roomId: '!chung:test' })).resolves.toBeNull()
    expect(f.latest()).toMatchObject({ roomId: '!chung:test', destination: { kind: 'room', roomId: '!chung:test' } })
  })

  it('opens a joined channel with a message still sending under chronological pending-event ordering', async () => {
    let chung!: Room
    const f = await sdkFor(owner, client => {
      chung = holdRoom(client, '!chung:test', channel('join'))
    })
    // Chronological ordering (the client's default) keeps local echoes in the live timeline, where
    // Room.getPendingEvents() throws; nothing on the open path may ask for it.
    expect(() => chung.getPendingEvents()).toThrow(/chronological/)
    const echo = new MatrixEvent({
      type: EventType.RoomMessage, room_id: chung.roomId, sender: owner, content: { msgtype: 'm.text', body: 'Chào cả nhà' }
    })
    echo.setTxnId('txn-1')
    echo.setStatus(EventStatus.SENDING)
    chung.addPendingEvent(echo, 'txn-1')

    await expect(f.sdk.command({ kind: 'select', roomId: '!chung:test' })).resolves.toBeNull()
    expect(f.latest().roomId).toBe('!chung:test')
    expect(f.latest().messages.map(message => message.body)).toContain('Chào cả nhà')
  })

  it('keeps the create-event manager out of channel members, counts and presence', async () => {
    const human = '@linh:test'
    const f = await sdkFor(owner, client => {
      holdRoom(client, '!chung:test', {
        ...channel('join'),
        members: { [human]: 'join', [manager]: 'join' }
      })

      for (const [userId, displayname] of [[human, 'Linh'], [manager, 'Atum Team Space']] as const) {
        const user = new User(userId)
        user.setPresenceEvent(new MatrixEvent({
          type: EventType.Presence,
          sender: userId,
          content: { presence: 'online', displayname }
        }))
        client.store.storeUser(user)
      }
    })

    const projected = f.latest().rooms.find(room => room.id === '!chung:test')!
    expect(projected.companyChannel).toEqual({ companyId, channelId, managerUserId: manager })
    expect(projected.participants?.map(member => member.userId)).toEqual([owner, human])
    expect(f.latest().presence?.users.map(user => user.userId)).toContain(human)
    expect(f.latest().presence?.users.map(user => user.userId)).not.toContain(manager)

    await f.sdk.command({ kind: 'select', roomId: '!chung:test' })
    expect(f.latest().members?.map(member => member.userId)).toEqual([owner, human])
  })
})

it('deletes a personal chat with one leave then forget and refreshes the roster', async () => {
  const id = '!delete:test'
  const f = await sdkFor(owner, client => holdRoom(client, id))
  const leave = vi.spyOn(f.client, 'leave').mockImplementation(async () => {
    f.client.getRoom(id)!.updateMyMembership('leave')
    return {}
  })
  const forget = vi.spyOn(f.client, 'forget').mockImplementation(async () => {
    f.client.store.removeRoom(id)
    return {}
  })
  await f.sdk.command({ kind: 'select', roomId: id })
  await f.sdk.command({ kind: 'forget', roomId: id })
  expect(leave).toHaveBeenCalledExactlyOnceWith(id)
  expect(forget).toHaveBeenCalledExactlyOnceWith(id, true)
  expect(leave.mock.invocationCallOrder[0]).toBeLessThan(forget.mock.invocationCallOrder[0]!)
  expect(f.latest().rooms.some(room => room.id === id)).toBe(false)
  expect(f.latest().roomId).toBeNull()
})

describe('a group’s shared name and topic', () => {
  /** A joined people group whose power levels give `ownerPower` against the state default of 50. */
  function holdGroup(client: MatrixClient, id: string, ownerPower: number, options: RoomOptions = {}) {
    const room = holdRoom(client, id, { members: { '@bob:test': 'join' }, ...options })
    room.currentState.setStateEvents([
      new MatrixEvent({
        type: EventType.RoomPowerLevels,
        state_key: '',
        room_id: id,
        sender: '@bob:test',
        content: { users: { [owner]: ownerPower, '@bob:test': 100 }, users_default: 0, state_default: 50 }
      }),
      new MatrixEvent({ type: EventType.RoomName, state_key: '', room_id: id, sender: '@bob:test', content: { name: 'Friends' } }),
      new MatrixEvent({
        type: EventType.RoomTopic,
        state_key: '',
        room_id: id,
        sender: '@bob:test',
        content: { topic: '  Plans\nfor   Saturday ' }
      })
    ])
    // Sync recalculates the room's name from its state; the fixture does as sync would.
    room.recalculate()

    return room
  }

  it('projects the topic and whether this account may change name and topic', async () => {
    const f = await sdkFor(owner, client => {
      holdGroup(client, '!admin:test', 100)
      holdGroup(client, '!member:test', 0)
    })

    await vi.waitFor(() => expect(f.latest().rooms.length).toBeGreaterThanOrEqual(2))
    const rooms = new Map(f.latest().rooms.map(room => [room.id, room]))
    expect(rooms.get('!admin:test')).toMatchObject({ name: 'Friends', topic: 'Plans for Saturday', canName: true, canTopic: true })
    expect(rooms.get('!member:test')).toMatchObject({ name: 'Friends', topic: 'Plans for Saturday' })
    expect(rooms.get('!member:test')).not.toHaveProperty('canName')
    expect(rooms.get('!member:test')).not.toHaveProperty('canTopic')
  })

  it('follows a new name and topic from sync into the projection', async () => {
    let room: Room

    const f = await sdkFor(owner, client => {
      room = holdGroup(client, '!group:test', 0)
    })

    const renamed = [
      new MatrixEvent({ type: EventType.RoomName, state_key: '', room_id: '!group:test', sender: '@bob:test', content: { name: 'Weekend trip' } }),
      new MatrixEvent({ type: EventType.RoomTopic, state_key: '', room_id: '!group:test', sender: '@bob:test', content: { topic: '' } })
    ]

    room!.currentState.setStateEvents(renamed)
    room!.recalculate()
    f.client.emit(RoomStateEvent.Events, renamed[1]!, room!.currentState, null)

    await vi.waitFor(() =>
      expect(f.latest().rooms.find(value => value.id === '!group:test')).toMatchObject({ name: 'Weekend trip' })
    )
    // An empty topic is no topic.
    expect(f.latest().rooms.find(value => value.id === '!group:test')).not.toHaveProperty('topic')
  })

  it('sends the standard room name and topic, and drops your private name that would hide the new one', async () => {
    const f = await sdkFor(owner, client => {
      const room = holdGroup(client, '!group:test', 100)
      room.addAccountData([new MatrixEvent({ type: 'io.atum.title', content: { title: 'Mine' } })])
    })

    const name = vi.spyOn(f.client, 'setRoomName').mockResolvedValue({ event_id: '$name' })
    const topic = vi.spyOn(f.client, 'setRoomTopic').mockResolvedValue({ event_id: '$topic' })
    const accountData = vi.spyOn(f.client, 'setRoomAccountData').mockResolvedValue({})

    await expect(f.sdk.command({ kind: 'groupName', roomId: '!group:test', name: 'Weekend trip' })).resolves.toBeNull()
    expect(name).toHaveBeenCalledExactlyOnceWith('!group:test', 'Weekend trip')
    expect(accountData).toHaveBeenCalledExactlyOnceWith('!group:test', 'io.atum.title', {})

    await expect(f.sdk.command({ kind: 'groupTopic', roomId: '!group:test', topic: '' })).resolves.toBeNull()
    expect(topic).toHaveBeenCalledExactlyOnceWith('!group:test', '')
    expect(accountData).toHaveBeenCalledOnce()
  })

  it('refuses a room whose power levels do not allow it, and every chat that is not a personal group', async () => {
    const f = await sdkFor(owner, client => {
      holdGroup(client, '!member:test', 0)
      holdGroup(client, '!assistant:test', 100, { type: 'io.atum.assistant' })
      holdGroup(client, '!dm:test', 100)
      holdGroup(client, '!left:test', 100, { membership: 'leave' })
      client.store.storeAccountDataEvents([
        new MatrixEvent({ type: EventType.Direct, content: { '@bob:test': ['!dm:test'] } })
      ])
    })

    const name = vi.spyOn(f.client, 'setRoomName').mockResolvedValue({ event_id: '$name' })
    const topic = vi.spyOn(f.client, 'setRoomTopic').mockResolvedValue({ event_id: '$topic' })

    for (const roomId of ['!member:test', '!assistant:test', '!dm:test', '!left:test', '!missing:test']) {
      await expect(f.sdk.command({ kind: 'groupName', roomId, name: 'Trip' })).rejects.toThrow(
        'matrix_group_details_unavailable'
      )
      await expect(f.sdk.command({ kind: 'groupTopic', roomId, topic: 'Trip' })).rejects.toThrow(
        'matrix_group_details_unavailable'
      )
    }

    expect(name).not.toHaveBeenCalled()
    expect(topic).not.toHaveBeenCalled()
  })
})
