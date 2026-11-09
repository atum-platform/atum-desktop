import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
  MATRIX_COMPANY_CHANNEL_TYPE,
  MATRIX_COMPANY_CONVERSATION_BINDING,
  MATRIX_COMPANY_CONVERSATION_TYPE
} from '../../shared/matrix-company-channel-room'

import { companyFileContext, companyFileReference, sendCompanyFile } from './company-files'

const ROOM_ID = '!channel:test'
const OWNER = '@owner:test'
const COMPANY_ID = '00000000-0000-4000-8000-8c031eadb7f3'
const CHANNEL_ID = '00000000-0000-4000-8000-01670d853f95'
const REQUEST_ID = '00000000-0000-4000-8000-6b8e755910f9'

const FILE = {
  v: 1 as const,
  company_id: COMPANY_ID,
  channel_id: CHANNEL_ID,
  file_id: '00000000-0000-4000-8000-f739b2d7b3b6',
  revision: 1 as const,
  name: 'brief.pdf',
  content_type: 'application/pdf',
  size: 1_048_576,
  sha256: 'a'.repeat(64)
}
const CONVERSATION_ID = '00000000-0000-4000-8000-16b7785de2e4'
const CONVERSATION_FILE = {
  v: 2 as const,
  company_id: COMPANY_ID,
  audience: { kind: 'conversation' as const, conversation_id: CONVERSATION_ID },
  file_id: '00000000-0000-4000-8000-3850afc27747',
  revision: 1 as const,
  name: 'private.txt',
  content_type: 'text/plain',
  size: 7,
  sha256: 'b'.repeat(64)
}

function event(content: Record<string, unknown>, eventId: string, type = EventType.RoomMessage) {
  return new MatrixEvent({ type, room_id: ROOM_ID, event_id: eventId, sender: OWNER, origin_server_ts: 1, content })
}

function fixture() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
  const room = new Room(ROOM_ID, client, OWNER)
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: ROOM_ID,
      event_id: '$create',
      sender: OWNER,
      content: {
        type: MATRIX_COMPANY_CHANNEL_TYPE,
        room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
        [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId: COMPANY_ID, channelId: CHANNEL_ID }
      }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const sendEvent = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$sent' })

  return { client, room, sendEvent }
}

async function add(room: Room, ...events: MatrixEvent[]) {
  await room.addLiveEvents(events, { addToState: false })
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('protected Team Space company files', () => {
  it('returns only the immutable channel context and validated flat relation ids', async () => {
    const f = fixture()
    const root = event({ msgtype: 'm.text', body: 'Root' }, '$root')

    const reply = event({
      msgtype: 'm.text', body: 'Reply',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root', 'm.in_reply_to': { event_id: '$root' } }
    }, '$reply')

    await add(f.room, root, reply)

    expect(companyFileContext(f.room)).toEqual({
      companyId: COMPANY_ID, target: { kind: 'channel', channelId: CHANNEL_ID }, roomId: ROOM_ID
    })
    expect(companyFileContext(f.room, '$root', '$reply')).toEqual({
      companyId: COMPANY_ID, target: { kind: 'channel', channelId: CHANNEL_ID }, roomId: ROOM_ID,
      threadRootId: '$root', replyTo: '$reply'
    })
  })

  it('binds a protected v2 thread attachment to the exact company conversation', async () => {
    const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
    const room = new Room(ROOM_ID, client, OWNER)
    room.currentState.setStateEvents([new MatrixEvent({
      type: EventType.RoomCreate, state_key: '', room_id: ROOM_ID, event_id: '$create', sender: OWNER,
      content: {
        type: MATRIX_COMPANY_CONVERSATION_TYPE,
        room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
        [MATRIX_COMPANY_CONVERSATION_BINDING]: {
          companyId: COMPANY_ID, conversationId: CONVERSATION_ID, conversationKind: 'group_dm',
          participantSetDigest: 'c'.repeat(64)
        }
      }
    })])
    room.updateMyMembership('join')
    client.store.storeRoom(room)
    const root = event({ msgtype: 'm.text', body: 'Root' }, '$root')
    await add(room, root)
    const sendEvent = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$sent' })

    expect(companyFileContext(room, '$root')).toEqual({
      companyId: COMPANY_ID, target: { kind: 'conversation', conversationId: CONVERSATION_ID },
      roomId: ROOM_ID, threadRootId: '$root', replyTo: '$root'
    })
    await expect(sendCompanyFile(client, room, { requestId: REQUEST_ID, file: CONVERSATION_FILE,
      matrixTransactionId: `atum-cf-${REQUEST_ID}`, threadRootId: '$root' })).resolves.toBe('$sent')
    expect(sendEvent.mock.calls[0]![2]).toMatchObject({
      'io.atum.company_file': CONVERSATION_FILE,
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' }
    })
    expect(sendEvent.mock.calls[0]![2]).not.toHaveProperty('url')
    expect(sendEvent.mock.calls[0]![2]).not.toHaveProperty('file')
  })

  it('sends the exact channel and frozen flat-thread content under the stable transaction', async () => {
    const f = fixture()
    const root = event({ msgtype: 'm.text', body: 'Root' }, '$root')
    await add(f.room, root)
    const transactionId = `atum-cf-${REQUEST_ID}`

    await expect(sendCompanyFile(f.client, f.room, { requestId: REQUEST_ID, file: FILE, matrixTransactionId: transactionId }))
      .resolves.toBe('$sent')
    expect(f.sendEvent).toHaveBeenLastCalledWith(ROOM_ID, EventType.RoomMessage, {
      msgtype: 'm.file', body: 'brief.pdf', info: { mimetype: 'application/pdf', size: 1_048_576 },
      'io.atum.company_file': FILE
    }, transactionId)
    expect(f.sendEvent.mock.calls[0]![2]).not.toHaveProperty('url')
    expect(f.sendEvent.mock.calls[0]![2]).not.toHaveProperty('file')

    await expect(sendCompanyFile(f.client, f.room, {
      requestId: REQUEST_ID, file: FILE, matrixTransactionId: transactionId, threadRootId: '$root'
    })).resolves.toBe('$sent')
    expect(f.sendEvent).toHaveBeenLastCalledWith(ROOM_ID, EventType.RoomMessage, {
      msgtype: 'm.file', body: 'brief.pdf', info: { mimetype: 'application/pdf', size: 1_048_576 },
      'io.atum.company_file': FILE,
      'm.relates_to': {
        rel_type: 'm.thread', event_id: '$root', is_falling_back: true, 'm.in_reply_to': { event_id: '$root' }
      }
    }, transactionId)
  })

  it('reuses an existing Matrix transaction rather than publishing a second reference', async () => {
    const f = fixture()
    const transactionId = `atum-cf-${REQUEST_ID}`
    const existing = event({ msgtype: 'm.file', body: FILE.name }, '$published')
    Reflect.set(existing, 'status', null)
    vi.spyOn(f.room, 'getEventForTxnId').mockReturnValue(existing)

    await expect(sendCompanyFile(f.client, f.room, { requestId: REQUEST_ID, file: FILE, matrixTransactionId: transactionId }))
      .resolves.toBe('$published')
    expect(f.sendEvent).not.toHaveBeenCalled()
  })

  it('refuses non-Team-Space, nested, malformed, and mismatched requests before sending', async () => {
    const f = fixture()
    const root = event({ msgtype: 'm.text', body: 'Root' }, '$root')

    const child = event({
      msgtype: 'm.text', body: 'Child',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root', 'm.in_reply_to': { event_id: '$root' } }
    }, '$child')

    await add(f.room, root, child)

    await expect(sendCompanyFile(f.client, f.room, {
      requestId: REQUEST_ID, file: FILE, matrixTransactionId: `atum-cf-${REQUEST_ID}`, threadRootId: '$child'
    })).rejects.toThrow('matrix_message_changed')
    await expect(sendCompanyFile(f.client, f.room, {
      requestId: REQUEST_ID, file: FILE, matrixTransactionId: 'atum-cf-other'
    })).rejects.toThrow('matrix_company_file_unavailable')
    await expect(sendCompanyFile(f.client, f.room, {
      requestId: REQUEST_ID, file: { ...FILE, channel_id: COMPANY_ID }, matrixTransactionId: `atum-cf-${REQUEST_ID}`
    })).rejects.toThrow('matrix_company_file_unavailable')
    vi.spyOn(f.room, 'getMyMembership').mockReturnValue('leave')
    expect(() => companyFileContext(f.room)).toThrow('matrix_company_file_unavailable')
    expect(f.sendEvent).not.toHaveBeenCalled()
  })

  it('re-fetches only the exact strict protected reference, never a Matrix media URL', async () => {
    const f = fixture()
    const content = { msgtype: 'm.file', body: FILE.name, info: { mimetype: FILE.content_type, size: FILE.size }, 'io.atum.company_file': FILE }
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue({
      type: EventType.RoomMessage, room_id: ROOM_ID, event_id: '$file', sender: OWNER, content
    } as never)

    await expect(companyFileReference(f.client, f.room, '$file')).resolves.toEqual(FILE)
    expect(f.client.fetchRoomEvent).toHaveBeenCalledExactlyOnceWith(ROOM_ID, '$file')

    vi.mocked(f.client.fetchRoomEvent).mockResolvedValue({
      type: EventType.RoomMessage, room_id: ROOM_ID, event_id: '$file', sender: OWNER,
      content: { ...content, url: 'mxc://atum.example/forbidden' }
    } as never)
    await expect(companyFileReference(f.client, f.room, '$file')).rejects.toThrow('matrix_company_file_unavailable')

    vi.mocked(f.client.fetchRoomEvent).mockResolvedValue({
      type: EventType.RoomMessage, room_id: ROOM_ID, event_id: '$file', sender: OWNER,
      content: { msgtype: 'm.file', body: FILE.name, info: { mimetype: FILE.content_type, size: FILE.size } }
    } as never)
    await expect(companyFileReference(f.client, f.room, '$file')).rejects.toThrow('matrix_company_file_unavailable')

    await expect(companyFileReference(f.client, f.room, 'not-an-event')).rejects.toThrow('matrix_company_file_unavailable')
    expect(f.client.fetchRoomEvent).toHaveBeenCalledTimes(3)
  })

  it('rejects a received protected file whose flat relation names a nested root', async () => {
    const f = fixture()
    const root = event({ msgtype: 'm.text', body: 'Root' }, '$root')

    const child = event({
      msgtype: 'm.text', body: 'Child',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root', 'm.in_reply_to': { event_id: '$root' } }
    }, '$child')

    await add(f.room, root, child)
    vi.spyOn(f.client, 'fetchRoomEvent').mockResolvedValue({
      type: EventType.RoomMessage, room_id: ROOM_ID, event_id: '$file', sender: OWNER,
      content: {
        msgtype: 'm.file', body: FILE.name, info: { mimetype: FILE.content_type, size: FILE.size },
        'io.atum.company_file': FILE,
        'm.relates_to': {
          rel_type: 'm.thread', event_id: '$child', is_falling_back: true, 'm.in_reply_to': { event_id: '$child' }
        }
      }
    } as never)

    await expect(companyFileReference(f.client, f.room, '$file')).rejects.toThrow('matrix_message_changed')
  })
})
