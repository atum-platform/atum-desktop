import { createClient, EventStatus, EventType, type MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import {
  editMatrixMessage,
  markMatrixRoomUnread,
  matrixMarkedUnread,
  matrixTyping,
  reactToMatrixMessage,
  redactMatrixMessage,
  sendMatrixReply,
  sendMatrixText,
  sendMatrixTyping
} from './message-commands'

const owner = '@owner:test'
const linh = '@linh:test'

let count = 0

function fixture(roomId = '!room:test') {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: owner })
  const sendEvent = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$sent' })
  const redactEvent = vi.spyOn(client, 'redactEvent').mockResolvedValue({ event_id: '$redaction' })
  const setRoomAccountData = vi.spyOn(client, 'setRoomAccountData').mockResolvedValue({})
  const readMarkers = vi.spyOn(client, 'setRoomReadMarkersHttpRequest').mockResolvedValue({})
  const sendTyping = vi.spyOn(client, 'sendTyping').mockResolvedValue({})
  const room = new Room(roomId, client, owner)

  return { client, room, sendEvent, redactEvent, setRoomAccountData, readMarkers, sendTyping }
}

function roomEvent(
  room: Room,
  type: string,
  sender: string,
  content: Record<string, unknown>,
  id = `$e${++count}`
): MatrixEvent {
  return new MatrixEvent({ type, room_id: room.roomId, event_id: id, sender, origin_server_ts: ++count, content })
}

async function add(room: Room, ...events: MatrixEvent[]) {
  await room.addLiveEvents(events, { addToState: false })
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => vi.restoreAllMocks())

describe('replies', () => {
  it('sends standard user and room mention metadata together', async () => {
    const f = fixture()

    await expect(sendMatrixText(f.client, f.room, 'Hi @linh and @channel', [linh, linh], true)).resolves.toBe('$sent')
    expect(f.sendEvent).toHaveBeenCalledExactlyOnceWith('!room:test', EventType.RoomMessage, {
      msgtype: 'm.text',
      body: 'Hi @linh and @channel',
      'm.mentions': { user_ids: [linh], room: true }
    })
  })

  it("answers a message of the same room with a standard rich reply, and refuses anything else's id", async () => {
    const f = fixture()
    const other = fixture('!other:test')
    await add(f.room, roomEvent(f.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'Dinner?' }, '$m'))
    await add(other.room, roomEvent(other.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'x' }, '$elsewhere'))

    await expect(sendMatrixReply(f.client, f.room, 'Yes!', '$m')).resolves.toBe('$sent')
    expect(f.sendEvent).toHaveBeenCalledExactlyOnceWith('!room:test', EventType.RoomMessage, {
      msgtype: 'm.text',
      body: 'Yes!',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$m' } }
    })

    // Another room's message, an unknown id and a local echo are never a reply's target.
    for (const target of ['$elsewhere', '$unknown', '~!room:test:local']) {
      await expect(sendMatrixReply(f.client, f.room, 'Yes!', target)).rejects.toThrow('matrix_message_changed')
    }

    expect(f.sendEvent).toHaveBeenCalledTimes(1)
  })
})

describe('edits', () => {
  it('changes your own text message with a standard m.replace, carrying only what it shows', async () => {
    const f = fixture()
    await add(
      f.room,
      roomEvent(f.room, EventType.RoomMessage, owner, { msgtype: 'm.text', body: 'Plan Hue', 'io.atum.turn': 'marker' }, '$q')
    )

    await expect(editMatrixMessage(f.client, f.room, '$q', '  Plan Huế ')).resolves.toBe('$sent')
    expect(f.sendEvent).toHaveBeenCalledExactlyOnceWith('!room:test', EventType.RoomMessage, {
      msgtype: 'm.text',
      body: '* Plan Huế',
      'm.new_content': { msgtype: 'm.text', body: 'Plan Huế' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$q' }
    })
  })

  it("never edits someone else's message, a file, an edit, a deleted message or empty words", async () => {
    const f = fixture()
    await add(
      f.room,
      roomEvent(f.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'Hers' }, '$hers'),
      roomEvent(f.room, EventType.RoomMessage, owner, { msgtype: 'm.file', body: 'a.pdf', file: { url: 'mxc://a' } }, '$file'),
      roomEvent(f.room, EventType.RoomMessage, owner, { msgtype: 'm.text', body: 'Mine' }, '$mine'),
      roomEvent(
        f.room,
        EventType.RoomMessage,
        owner,
        { msgtype: 'm.text', body: '* x', 'm.new_content': { msgtype: 'm.text', body: 'x' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$mine' } },
        '$edit'
      )
    )
    const gone = roomEvent(f.room, EventType.RoomMessage, owner, { msgtype: 'm.text', body: 'Gone' }, '$gone')
    await add(f.room, gone)
    gone.makeRedacted(
      new MatrixEvent({ type: EventType.RoomRedaction, room_id: '!room:test', event_id: '$x', sender: owner, redacts: '$gone', content: {} }),
      f.room
    )

    for (const target of ['$hers', '$file', '$edit', '$gone']) {
      await expect(editMatrixMessage(f.client, f.room, target, 'New words')).rejects.toThrow('matrix_message_changed')
    }

    await expect(editMatrixMessage(f.client, f.room, '$mine', '   ')).rejects.toThrow('matrix_message_changed')
    expect(f.sendEvent).not.toHaveBeenCalled()
  })
})

describe('deleting', () => {
  it('deletes only your own message, by a standard redaction', async () => {
    const f = fixture()
    await add(
      f.room,
      roomEvent(f.room, EventType.RoomMessage, owner, { msgtype: 'm.text', body: 'Mine' }, '$mine'),
      roomEvent(f.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'Hers' }, '$hers')
    )

    await redactMatrixMessage(f.client, f.room, '$mine')
    expect(f.redactEvent).toHaveBeenCalledExactlyOnceWith('!room:test', '$mine')
    await expect(redactMatrixMessage(f.client, f.room, '$hers')).rejects.toThrow('matrix_message_changed')
    await expect(redactMatrixMessage(f.client, f.room, '$missing')).rejects.toThrow('matrix_message_changed')
    expect(f.redactEvent).toHaveBeenCalledTimes(1)
  })
})

describe('reactions', () => {
  const reaction = (room: Room, sender: string, key: string, id?: string) =>
    roomEvent(room, EventType.Reaction, sender, { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$m', key } }, id)

  it('adds your reaction once, however often it is asked for', async () => {
    const f = fixture()
    await add(f.room, roomEvent(f.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'Dinner?' }, '$m'))

    await reactToMatrixMessage(f.client, f.room, '$m', '👍', true)
    expect(f.sendEvent).toHaveBeenCalledExactlyOnceWith('!room:test', EventType.Reaction, {
      'm.relates_to': { rel_type: 'm.annotation', event_id: '$m', key: '👍' }
    })

    await add(f.room, reaction(f.room, owner, '👍', '$mine'))
    await reactToMatrixMessage(f.client, f.room, '$m', '👍', true)
    expect(f.sendEvent).toHaveBeenCalledTimes(1)
  })

  it("takes back every reaction of yours with that key, and never anyone else's", async () => {
    const f = fixture()
    await add(
      f.room,
      roomEvent(f.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'Dinner?' }, '$m'),
      reaction(f.room, owner, '👍', '$mine-1'),
      // Another app of yours sent the same reaction again.
      reaction(f.room, owner, '👍', '$mine-2'),
      reaction(f.room, owner, '❤️', '$heart'),
      reaction(f.room, linh, '👍', '$hers')
    )

    await reactToMatrixMessage(f.client, f.room, '$m', '👍', false)
    expect(f.redactEvent.mock.calls.map(call => call[1]).sort()).toEqual(['$mine-1', '$mine-2'])
    expect(f.sendEvent).not.toHaveBeenCalled()
  })

  it('cancels a reaction of yours that never left, rather than deleting it', async () => {
    const f = fixture()
    await add(f.room, roomEvent(f.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'Dinner?' }, '$m'))
    const unsent = reaction(f.room, owner, '😂', '$unsent')
    await add(f.room, unsent)
    unsent.setStatus(EventStatus.NOT_SENT)
    const cancel = vi.spyOn(f.client, 'cancelPendingEvent').mockImplementation(() => {})

    await reactToMatrixMessage(f.client, f.room, '$m', '😂', false)
    expect(cancel).toHaveBeenCalledExactlyOnceWith(unsent)
    expect(f.redactEvent).not.toHaveBeenCalled()
  })

  it('reacts only to a message of this room', async () => {
    const f = fixture()

    await expect(reactToMatrixMessage(f.client, f.room, '$nowhere', '👍', true)).rejects.toThrow('matrix_message_changed')
    expect(f.sendEvent).not.toHaveBeenCalled()
  })
})

describe('typing', () => {
  it('lists who is typing, never you or someone you ignore', () => {
    const f = fixture()

    const member = (userId: string, typing: boolean, membership = 'join') =>
      ({ userId, typing, membership }) as unknown as ReturnType<Room['getMembers']>[number]

    vi.spyOn(f.room, 'getMembers').mockReturnValue([
      member(owner, true),
      member(linh, true),
      member('@quan:test', false),
      member('@spam:test', true),
      member('@gone:test', true, 'leave')
    ])

    expect(matrixTyping(f.room, owner, new Set(['@spam:test']))).toEqual([linh])
  })

  it("tells a chat with people, and never your assistant's room", async () => {
    const people = fixture()
    vi.spyOn(people.room, 'getMyMembership').mockReturnValue('join')
    await sendMatrixTyping(people.client, people.room, true)
    expect(people.sendTyping).toHaveBeenCalledExactlyOnceWith('!room:test', true, 30_000)

    const assistant = fixture('!assistant:test')
    vi.spyOn(assistant.room, 'getMyMembership').mockReturnValue('join')
    vi.spyOn(assistant.room, 'getType').mockReturnValue(MATRIX_ASSISTANT_ROOM_TYPE)
    await sendMatrixTyping(assistant.client, assistant.room, true)
    expect(assistant.sendTyping).not.toHaveBeenCalled()
  })
})

describe('marking a chat unread', () => {
  function accountData(room: Room, type: string, content: Record<string, unknown>) {
    room.addAccountData([new MatrixEvent({ type, content })])
  }

  it('reads the standard mark first, and the older name only when there is none', () => {
    const f = fixture()
    expect(matrixMarkedUnread(f.room)).toBe(false)
    accountData(f.room, 'com.famedly.marked_unread', { unread: true })
    expect(matrixMarkedUnread(f.room)).toBe(true)
    accountData(f.room, 'm.marked_unread', { unread: false })
    expect(matrixMarkedUnread(f.room)).toBe(false)
  })

  it('marks unread with the standard name, and read under both names with a private acknowledgement', async () => {
    const f = fixture()
    await markMatrixRoomUnread(f.client, f.room, true)
    expect(f.setRoomAccountData).toHaveBeenCalledExactlyOnceWith('!room:test', 'm.marked_unread', { unread: true })

    f.setRoomAccountData.mockClear()
    accountData(f.room, 'm.marked_unread', { unread: true })
    accountData(f.room, 'com.famedly.marked_unread', { unread: true })
    await add(f.room, roomEvent(f.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'New' }, '$new'))
    await markMatrixRoomUnread(f.client, f.room, false)
    expect(f.setRoomAccountData.mock.calls).toEqual([
      ['!room:test', 'm.marked_unread', { unread: false }],
      ['!room:test', 'com.famedly.marked_unread', { unread: false }]
    ])
    // Read up to the newest message, privately: the receipt is never public.
    expect(f.readMarkers).toHaveBeenCalledExactlyOnceWith('!room:test', '$new', undefined, '$new')
  })

  it('clears the mark of a chat opened on screen without acknowledging anything itself', async () => {
    const f = fixture()
    accountData(f.room, 'm.marked_unread', { unread: true })
    await add(f.room, roomEvent(f.room, EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'New' }, '$new'))

    await markMatrixRoomUnread(f.client, f.room, false, { acknowledge: false })
    expect(f.setRoomAccountData).toHaveBeenCalledExactlyOnceWith('!room:test', 'm.marked_unread', { unread: false })
    expect(f.readMarkers).not.toHaveBeenCalled()
  })

  it('writes nothing for a chat that was never marked', async () => {
    const f = fixture()
    await markMatrixRoomUnread(f.client as MatrixClient, f.room, false, { acknowledge: false })
    expect(f.setRoomAccountData).not.toHaveBeenCalled()
  })
})
