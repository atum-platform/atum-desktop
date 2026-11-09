import {
  createClient,
  EventType,
  type MatrixClient,
  MatrixEvent,
  NotificationCountType,
  ReceiptType,
  RelationType,
  Room
} from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixMessage } from '../../shared/matrix'
import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from '../../shared/matrix-company-channel-room'

import { matrixMessage } from './message'
import {
  MATRIX_COMPANY_THREADS_MAX,
  MATRIX_THREAD_ATTENTION,
  matrixCompanyThreads,
  matrixRoomTimelineEvents,
  matrixThreadAttention,
  matrixThreads,
  readMatrixThread,
  sendMatrixThreadReply,
  setMatrixThreadFollow,
  validThreadRootId
} from './threads'

const OWNER = '@owner:test'
const LINH = '@linh:test'
const ROOM_ID = '!team:test'

function fixture() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
  const room = new Room(ROOM_ID, client, OWNER)
  vi.spyOn(room, 'getType').mockReturnValue(MATRIX_COMPANY_CHANNEL_TYPE)
  vi.spyOn(room, 'getMyMembership').mockReturnValue('join')
  const sendEvent = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$sent' })
  const setRoomAccountData = vi.spyOn(client, 'setRoomAccountData').mockResolvedValue({})

  return { client, room, sendEvent, setRoomAccountData }
}

function event(type: string, sender: string, content: Record<string, unknown>, id: string, timestamp = 1) {
  return new MatrixEvent({
    type,
    room_id: ROOM_ID,
    event_id: id,
    sender,
    origin_server_ts: timestamp,
    content
  })
}

function message(value: MatrixEvent, thread = false): MatrixMessage {
  return {
    id: value.getId()!,
    sender: value.getSender()!,
    body: value.getContent().body as string,
    timestamp: value.getTs(),
    own: value.getSender() === OWNER,
    encrypted: false,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...(thread ? { thread: true as const, threadRootId: '$root', replyTo: '$root' } : {})
  }
}

async function add(room: Room, ...events: MatrixEvent[]) {
  await room.addLiveEvents(events, { addToState: false })
  await new Promise(resolve => setTimeout(resolve, 0))
}

function attention(room: Room, content: Record<string, unknown>) {
  room.addAccountData([new MatrixEvent({ type: MATRIX_THREAD_ATTENTION, content })])
}

afterEach(() => vi.restoreAllMocks())

describe('ordinary room thread rows', () => {
  it('merges standard and legacy rows only inside the cut window without reordering main or pending events', () => {
    const f = fixture()
    vi.mocked(f.room.getType).mockReturnValue(undefined)
    const first = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'first' }, '$first', 30)
    const pending = event(EventType.RoomMessage, OWNER, { msgtype: 'm.text', body: 'pending' }, '~pending', 5)
    const last = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'last' }, '$last', 40)
    const outside = event(EventType.RoomMessage, LINH, {
      msgtype: 'm.text', body: 'outside', 'io.atum.result': { invocation: 'old', transaction: 'old' }
    }, '$outside', 20)
    const legacy = event(EventType.RoomMessage, LINH, {
      msgtype: 'm.text', body: 'legacy', 'io.atum.result': { invocation: 'old', transaction: 'old' }
    }, '$legacy', 35)
    const standard = event(EventType.RoomMessage, LINH, {
      msgtype: 'm.text', body: 'standard',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$first', 'm.in_reply_to': { event_id: '$first' } }
    }, '$standard', 37)
    vi.spyOn(f.room, 'getThreads').mockReturnValue([{ events: [first, outside, standard, legacy] }] as never)

    const mainWindow = [first, pending, last]
    const merged = matrixRoomTimelineEvents(f.room, f.room.getLiveTimeline(), mainWindow)

    expect(merged.map(value => value.getId())).toEqual(['$first', '~pending', '$legacy', '$standard', '$last'])
    expect(merged.filter(value => mainWindow.includes(value))).toEqual(mainWindow)
  })

  it('does not enumerate or merge thread rows in Team Space rooms', () => {
    const f = fixture()
    const main = [event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'main' }, '$main', 30)]
    const getThreads = vi.spyOn(f.room, 'getThreads')

    expect(matrixRoomTimelineEvents(f.room, f.room.getLiveTimeline(), main)).toBe(main)
    expect(getThreads).not.toHaveBeenCalled()
  })
})

describe('standard Matrix thread replies', () => {
  it('sends one flat m.thread relation rooted in a server message', async () => {
    const f = fixture()
    const root = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Launch?' }, '$root')
    // Remote SDK events can carry either null or undefined; only a real local status is pending.
    Reflect.set(root, 'status', undefined)
    await add(f.room, root)

    await expect(sendMatrixThreadReply(f.client, f.room, 'Tuesday', '$root', '$root', [LINH, LINH])).resolves.toBe(
      '$sent'
    )
    expect(f.sendEvent).toHaveBeenCalledExactlyOnceWith(ROOM_ID, EventType.RoomMessage, {
      msgtype: 'm.text',
      body: 'Tuesday',
      'm.relates_to': {
        rel_type: RelationType.Thread,
        event_id: '$root',
        'm.in_reply_to': { event_id: '$root' }
      },
      'm.mentions': { user_ids: [LINH] }
    })
  })

  it('uses the same flat thread contract in a joined company DM', async () => {
    const f = fixture()
    vi.mocked(f.room.getType).mockReturnValue(MATRIX_COMPANY_CONVERSATION_TYPE)
    await add(f.room, event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Launch?' }, '$root'))

    await expect(sendMatrixThreadReply(f.client, f.room, 'Tuesday', '$root')).resolves.toBe('$sent')
    expect(f.sendEvent).toHaveBeenCalledExactlyOnceWith(ROOM_ID, EventType.RoomMessage, expect.objectContaining({
      body: 'Tuesday',
      'm.relates_to': expect.objectContaining({ rel_type: RelationType.Thread, event_id: '$root' })
    }))
  })

  it.each([
    ['archived company channel', MATRIX_COMPANY_CHANNEL_TYPE],
    ['read-only company conversation', MATRIX_COMPANY_CONVERSATION_TYPE]
  ])('blocks replies in an %s before sending', async (_label, roomType) => {
    const f = fixture()
    vi.mocked(f.room.getType).mockReturnValue(roomType)
    vi.spyOn(f.room, 'maySendMessage').mockReturnValue(false)
    await add(f.room, event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Launch?' }, '$root'))

    await expect(sendMatrixThreadReply(f.client, f.room, 'Tuesday', '$root')).rejects.toThrow(
      'matrix_thread_unavailable'
    )
    expect(f.sendEvent).not.toHaveBeenCalled()
  })

  it('rejects an unknown root, a sibling reply target and malformed event ids before sending', async () => {
    const f = fixture()
    await add(
      f.room,
      event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root'),
      event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Sibling' }, '$sibling')
    )

    await expect(sendMatrixThreadReply(f.client, f.room, 'x', '$missing')).rejects.toThrow('matrix_message_changed')
    await expect(sendMatrixThreadReply(f.client, f.room, 'x', '$root', '$sibling')).rejects.toThrow(
      'matrix_message_changed'
    )
    await expect(sendMatrixThreadReply(f.client, f.room, 'x', '~local')).rejects.toThrow('matrix_message_changed')
    expect(f.sendEvent).not.toHaveBeenCalled()
  })

  it('rejects a thread reply as another thread root at every write boundary', async () => {
    const f = fixture()
    const root = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root')
    const child = event(
      EventType.RoomMessage,
      LINH,
      {
        msgtype: 'm.text',
        body: 'Child',
        'm.relates_to': {
          rel_type: RelationType.Thread,
          event_id: '$root',
          'm.in_reply_to': { event_id: '$root' }
        }
      },
      '$child'
    )
    await add(f.room, root, child)

    await expect(sendMatrixThreadReply(f.client, f.room, 'nested', '$child')).rejects.toThrow(
      'matrix_message_changed'
    )
    await expect(setMatrixThreadFollow(f.client, f.room, '$child', true)).rejects.toThrow('matrix_message_changed')
    await expect(readMatrixThread(f.client, f.room, '$child')).rejects.toThrow('matrix_message_changed')
    expect(f.sendEvent).not.toHaveBeenCalled()
    expect(f.setRoomAccountData).not.toHaveBeenCalled()
  })

  it('never creates a Team Space thread in a personal or legacy group room', async () => {
    const f = fixture()
    vi.mocked(f.room.getType).mockReturnValue(undefined)
    await add(f.room, event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root'))

    await expect(sendMatrixThreadReply(f.client, f.room, 'x', '$root')).rejects.toThrow('matrix_thread_unavailable')
    await expect(setMatrixThreadFollow(f.client, f.room, '$root', true)).rejects.toThrow('matrix_thread_unavailable')
    await expect(readMatrixThread(f.client, f.room, '$root')).rejects.toThrow('matrix_thread_unavailable')
    expect(f.sendEvent).not.toHaveBeenCalled()
    expect(f.setRoomAccountData).not.toHaveBeenCalled()
  })
})

describe('thread attention', () => {
  it('fails malformed account data closed to defaults and validates only server event ids', () => {
    const f = fixture()
    attention(f.room, { v: 1, followed: ['$root'], unfollowed: ['$root'] })
    expect(matrixThreadAttention(f.room)).toEqual({ followed: new Set(), unfollowed: new Set() })
    expect(validThreadRootId('$root')).toBe(true)
    expect(validThreadRootId('root')).toBe(false)
    expect(validThreadRootId('~local')).toBe(false)
  })

  it('writes an explicit follow or unfollow without changing channel access', async () => {
    const f = fixture()
    await add(f.room, event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root'))
    attention(f.room, { v: 1, followed: [], unfollowed: [] })

    await setMatrixThreadFollow(f.client, f.room, '$root', true)
    expect(f.setRoomAccountData).toHaveBeenCalledExactlyOnceWith(ROOM_ID, MATRIX_THREAD_ATTENTION, {
      v: 1,
      followed: ['$root'],
      unfollowed: []
    })

    f.setRoomAccountData.mockClear()
    attention(f.room, { v: 1, followed: ['$root'], unfollowed: [] })
    await setMatrixThreadFollow(f.client, f.room, '$root', false)
    expect(f.setRoomAccountData).toHaveBeenCalledExactlyOnceWith(ROOM_ID, MATRIX_THREAD_ATTENTION, {
      v: 1,
      followed: [],
      unfollowed: ['$root']
    })
  })

  it('bounds private follow preferences before another account-data write', async () => {
    const f = fixture()
    await add(f.room, event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$new'))
    attention(f.room, {
      v: 1,
      followed: Array.from({ length: 1_000 }, (_, index) => `$followed-${index}`),
      unfollowed: []
    })

    await expect(setMatrixThreadFollow(f.client, f.room, '$new', true)).rejects.toThrow('matrix_thread_limit')
    expect(f.setRoomAccountData).not.toHaveBeenCalled()
  })

  it('projects bounded replies, participants, unread state and manual unfollow precedence', () => {
    const f = fixture()
    const root = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root', 10)
    const reply = event(
      EventType.RoomMessage,
      OWNER,
      {
        msgtype: 'm.text',
        body: 'Reply',
        'm.relates_to': {
          rel_type: RelationType.Thread,
          event_id: '$root',
          'm.in_reply_to': { event_id: '$root' }
        }
      },
      '$reply',
      20
    )
    attention(f.room, { v: 1, followed: [], unfollowed: ['$root'] })
    vi.spyOn(f.room, 'getThreads').mockReturnValue([
      {
        rootEvent: root,
        events: [root, reply],
        length: 1,
        replyToEvent: reply,
        hasCurrentUserParticipated: true
      }
    ] as never)
    vi.spyOn(f.room, 'getThreadUnreadNotificationCount').mockImplementation((_id, type) =>
      type === NotificationCountType.Highlight ? 2 : 1
    )

    expect(matrixThreads(f.room, OWNER, value => message(value, value === reply))).toEqual([
      {
        root: message(root),
        replies: [message(reply, true)],
        participantIds: [LINH, OWNER],
        replyCount: 1,
        lastActivityAt: 20,
        unread: true,
        highlights: 2,
        followed: false
      }
    ])
  })

  it('aggregates joined company channels and conversations with stable ordering and privacy fences', () => {
    const native = (roomId: string, roomType: string | undefined, membership: string, rootId: string, timestamp: number) => {
      const root = new MatrixEvent({
        type: EventType.RoomMessage,
        room_id: roomId,
        event_id: rootId,
        sender: LINH,
        origin_server_ts: timestamp,
        content: { msgtype: 'm.text', body: rootId }
      })

      return {
        roomId,
        getType: () => roomType,
        getMyMembership: () => membership,
        getAccountData: () => undefined,
        getThreads: () => [{
          id: rootId,
          rootEvent: root,
          events: [root],
          length: 1,
          replyToEvent: root,
          hasCurrentUserParticipated: false
        }],
        findEventById: (id: string) => id === rootId ? root : undefined,
        getThreadUnreadNotificationCount: () => 0
      } as unknown as Room
    }

    const channel = native('!channel:test', MATRIX_COMPANY_CHANNEL_TYPE, 'join', '$b', 20)
    const dm = native('!dm:test', MATRIX_COMPANY_CONVERSATION_TYPE, 'join', '$a', 20)
    const left = native('!left:test', MATRIX_COMPANY_CHANNEL_TYPE, 'leave', '$newest', 40)
    const personal = native('!personal:test', undefined, 'join', '$personal', 50)
    const byId = new Map([channel, dm, left, personal].map(room => [room.roomId, room]))
    const projected = [
      { id: channel.roomId, name: 'channel', membership: 'join' as const, encrypted: false,
        companyChannel: { companyId: 'company-1', channelId: 'channel-1' } },
      { id: dm.roomId, name: 'dm', membership: 'join' as const, encrypted: false,
        companyConversation: { companyId: 'company-1', conversationId: 'dm-1' } },
      { id: left.roomId, name: 'left', membership: 'join' as const, encrypted: false,
        companyChannel: { companyId: 'company-1', channelId: 'left-1' } },
      { id: personal.roomId, name: 'personal', membership: 'join' as const, encrypted: false,
        companyChannel: { companyId: 'company-1', channelId: 'stale-1' } },
      { id: '!invite:test', name: 'invite', membership: 'invite' as const, encrypted: false,
        companyChannel: { companyId: 'company-1', channelId: 'invite-1' } }
    ]

    const result = matrixCompanyThreads(
      projected,
      roomId => byId.get(roomId) ?? null,
      OWNER,
      value => message(value),
      1000
    )

    expect(result.map(thread => [thread.roomId, thread.root.id, thread.companyId])).toEqual([
      ['!dm:test', '$a', 'company-1'],
      ['!channel:test', '$b', 'company-1']
    ])
  })

  it('reprojects only the company room whose thread list changed', () => {
    const native = (roomId: string, rootId: string, timestamp: number) => {
      const roots = [event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: rootId }, rootId, timestamp)]
      const threads = roots.map(root => ({
        id: root.getId()!, rootEvent: root, events: [root], length: 0, replyToEvent: root,
        hasCurrentUserParticipated: false
      }))
      const room = {
        roomId,
        getType: () => MATRIX_COMPANY_CHANNEL_TYPE,
        getMyMembership: () => 'join',
        getAccountData: () => undefined,
        getThreads: () => threads,
        findEventById: (id: string) => roots.find(root => root.getId() === id),
        getThreadUnreadNotificationCount: () => 0
      } as unknown as Room

      return { room, roots, threads }
    }

    const first = native('!first:test', '$first', 10)
    const second = native('!second:test', '$second', 20)
    const rooms = [first.room, second.room]
    const byId = new Map(rooms.map(room => [room.roomId, room]))
    const projected = rooms.map((room, index) => ({
      id: room.roomId, name: `room-${index}`, membership: 'join' as const, encrypted: false,
      companyChannel: { companyId: 'company-1', channelId: `channel-${index}` }
    }))
    const project = vi.fn((value: MatrixEvent) => message(value))

    matrixCompanyThreads(projected, roomId => byId.get(roomId) ?? null, OWNER, project, 200, 'display-v1')
    matrixCompanyThreads(projected, roomId => byId.get(roomId) ?? null, OWNER, project, 200, 'display-v1')
    expect(project.mock.calls.map(([value]) => value.getId())).toEqual(['$first', '$second'])

    const added = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Added' }, '$added', 30)
    first.roots.push(added)
    first.threads.push({
      id: '$added', rootEvent: added, events: [added], length: 0, replyToEvent: added,
      hasCurrentUserParticipated: false
    })

    matrixCompanyThreads(projected, roomId => byId.get(roomId) ?? null, OWNER, project, 200, 'display-v1')
    expect(project.mock.calls.map(([value]) => value.getId())).toEqual(['$first', '$second', '$first', '$added'])
  })

  it('hard caps the merged company thread projection at 200 newest roots', () => {
    const nativeRooms = Array.from({ length: 3 }, (_, roomIndex) => {
      const roomId = `!room-${roomIndex}:test`
      const roots = Array.from({ length: 100 }, (_, index) =>
        event(
          EventType.RoomMessage,
          LINH,
          { msgtype: 'm.text', body: `Thread ${roomIndex}-${index}` },
          `$root-${roomIndex}-${index}`,
          roomIndex * 100 + index + 1
        )
      )

      return {
        roomId,
        getType: () => MATRIX_COMPANY_CHANNEL_TYPE,
        getMyMembership: () => 'join',
        getAccountData: () => undefined,
        getThreads: () =>
          roots.map(root => ({
            id: root.getId(),
            rootEvent: root,
            events: [root],
            length: 1,
            replyToEvent: root,
            hasCurrentUserParticipated: false
          })),
        findEventById: (id: string) => roots.find(root => root.getId() === id),
        getThreadUnreadNotificationCount: () => 0
      } as unknown as Room
    })
    const byId = new Map(nativeRooms.map(room => [room.roomId, room]))
    const projected = nativeRooms.map((room, index) => ({
      id: room.roomId,
      name: `room-${index}`,
      membership: 'join' as const,
      encrypted: false,
      companyChannel: { companyId: 'company-1', channelId: `channel-${index}` }
    }))

    const result = matrixCompanyThreads(
      projected,
      roomId => byId.get(roomId) ?? null,
      OWNER,
      value => message(value),
      1_000
    )

    expect(result).toHaveLength(MATRIX_COMPANY_THREADS_MAX)
    expect(result[0]?.root.id).toBe('$root-2-99')
    expect(result.at(-1)?.lastActivityAt).toBe(101)
  })

  it('keeps a redacted reply as a thread tombstone even when redaction removed its relation', () => {
    const f = fixture()
    const root = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root', 10)
    const reply = event(
      EventType.RoomMessage,
      OWNER,
      {
        msgtype: 'm.text',
        body: 'Reply',
        'm.relates_to': {
          rel_type: RelationType.Thread,
          event_id: '$root',
          'm.in_reply_to': { event_id: '$root' }
        }
      },
      '$reply',
      20
    )
    reply.makeRedacted(
      new MatrixEvent({
        type: EventType.RoomRedaction,
        room_id: ROOM_ID,
        event_id: '$redaction',
        sender: OWNER,
        redacts: '$reply',
        content: {}
      }),
      f.room
    )
    vi.spyOn(f.room, 'getThreads').mockReturnValue([
      { rootEvent: root, events: [root, reply], length: 1, replyToEvent: reply, hasCurrentUserParticipated: true }
    ] as never)
    vi.spyOn(f.room, 'getThreadUnreadNotificationCount').mockReturnValue(0)

    const projected = matrixThreads(f.room, OWNER, value => matrixMessage(value, OWNER, new Set(), f.room))

    expect(projected[0]).toMatchObject({
      replyCount: 1,
      replies: [{ id: '$reply', redacted: true, thread: true, threadRootId: '$root' }]
    })
  })

  it('recovers a known thread root when the list entry has not attached it yet', () => {
    const f = fixture()
    const root = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root', 10)
    vi.spyOn(f.room, 'findEventById').mockImplementation(id => (id === '$root' ? root : undefined))
    vi.spyOn(f.room, 'getThreads').mockReturnValue([
      {
        id: '$root',
        rootEvent: undefined,
        events: [],
        length: 0,
        replyToEvent: null,
        hasCurrentUserParticipated: false
      }
    ] as never)
    vi.spyOn(f.room, 'getThreadUnreadNotificationCount').mockReturnValue(0)

    expect(matrixThreads(f.room, OWNER, value => message(value))).toMatchObject([
      { root: { id: '$root' }, replies: [], replyCount: 0 }
    ])
  })

  it('acknowledges the latest server reply and clears only local thread counters', async () => {
    const f = fixture()
    const root = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root', 10)
    const reply = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Reply' }, '$reply', 20)
    await add(f.room, root)
    const setUnread = vi.fn()
    vi.spyOn(f.room, 'getThread').mockReturnValue({ events: [root, reply], setUnread } as never)
    const sendReadReceipt = vi.spyOn(f.client as MatrixClient, 'sendReadReceipt').mockResolvedValue({})

    await readMatrixThread(f.client, f.room, '$root')
    expect(sendReadReceipt).toHaveBeenCalledExactlyOnceWith(reply, ReceiptType.ReadPrivate)
    expect(setUnread.mock.calls).toEqual([
      [NotificationCountType.Total, 0],
      [NotificationCountType.Highlight, 0]
    ])
  })

  it('does not clear unread state until a server reply is available to acknowledge', async () => {
    const f = fixture()
    const root = event(EventType.RoomMessage, LINH, { msgtype: 'm.text', body: 'Root' }, '$root', 10)
    await add(f.room, root)
    const setUnread = vi.fn()
    vi.spyOn(f.room, 'getThread').mockReturnValue({ events: [root], setUnread } as never)
    const sendReadReceipt = vi.spyOn(f.client as MatrixClient, 'sendReadReceipt').mockResolvedValue({})

    await readMatrixThread(f.client, f.room, '$root')
    expect(sendReadReceipt).not.toHaveBeenCalled()
    expect(setUnread).not.toHaveBeenCalled()
  })
})
