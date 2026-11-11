import { createClient, EventType, MatrixEvent, NotificationCountType, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import {
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT
} from '../../shared/matrix-company-private-cos'

import { conversationRoom } from './conversations'
import { matrixPreviewLine, matrixRoomDialogue, matrixRoomPreview, matrixRoomUnread } from './room-preview'

const me = '@minh:test'
const lan = '@lan:test'
const bao = '@bao:test'

let sequence = 0

function fixture() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: me })
  const room = new Room('!room:test', client, me)

  room.currentState.setStateEvents(
    [
      [me, 'Minh'],
      [lan, 'Lan'],
      [bao, undefined]
    ].map(
      ([userId, displayname]) =>
        new MatrixEvent({
          type: EventType.RoomMember,
          state_key: userId,
          sender: userId,
          room_id: room.roomId,
          content: { membership: 'join', ...(displayname ? { displayname } : {}) }
        })
    )
  )
  room.updateMyMembership('join')

  const event = (sender: string, content: Record<string, unknown>, type: string = EventType.RoomMessage) =>
    new MatrixEvent({
      type,
      event_id: `$e${++sequence}`,
      sender,
      room_id: room.roomId,
      origin_server_ts: 1_000 + sequence,
      content
    })

  const add = async (...events: MatrixEvent[]) => {
    await room.addLiveEvents(events, { addToState: false })

    return events.at(-1)!
  }

  const receipt = (eventId: string, type = 'm.read.private') =>
    room.addReceipt(
      new MatrixEvent({ type: EventType.Receipt, content: { [eventId]: { [type]: { [me]: { ts: Date.now() } } } } })
    )

  return { client, room, event, add, receipt }
}

describe('a chat row’s preview line', () => {
  it('reads an answer as its words, without its markdown', () => {
    expect(
      matrixPreviewLine(
        [
          '## Day 1: **settle in**',
          '- Afternoon walk around [Xuân Hương Lake](https://maps.example/lake)',
          '1. Coffee at a `hillside` café',
          '```',
          'not a fence',
          '```',
          '> a *quiet* morning'
        ].join('\n')
      )
    ).toBe('Day 1: settle in Afternoon walk around Xuân Hương Lake Coffee at a hillside café not a fence a quiet morning')
    // Arithmetic and snake_case words keep their characters.
    expect(matrixPreviewLine('2*3*4 = 24, see my_file_name')).toBe('2*3*4 = 24, see my_file_name')
    expect([...matrixPreviewLine('word '.repeat(80))].length).toBeLessThanOrEqual(140)
    expect(matrixPreviewLine('word '.repeat(80)).endsWith('…')).toBe(true)
  })

  it('previews the latest message as the transcript shows it: its latest own edit, never an edit or a reaction', async () => {
    const { room, event, add } = fixture()
    await add(event(me, { msgtype: 'm.text', body: 'Dinner Saturday?' }))
    const answer = await add(event(lan, { msgtype: 'm.text', body: 'Yes, 7pm' }))

    const edit = event(lan, {
      msgtype: 'm.text',
      body: '* Yes, 8pm',
      'm.new_content': { msgtype: 'm.text', body: 'Yes, 8pm' },
      'm.relates_to': { rel_type: 'm.replace', event_id: answer.getId() }
    })

    await add(
      edit,
      event(me, { 'm.relates_to': { rel_type: 'm.annotation', event_id: answer.getId(), key: '👍' } }, EventType.Reaction)
    )
    answer.makeReplaced(edit)

    expect(matrixRoomPreview(room, me)).toMatchObject({ own: false, sender: 'Lan', kind: 'text', text: 'Yes, 8pm' })
    expect(matrixRoomPreview(room, me)?.at).toBe(answer.getTs())
  })

  it('names files and media by what they are, a deleted message as deleted, and an unread one as waiting', async () => {
    const { room, event, add } = fixture()

    await add(event(lan, { msgtype: 'm.file', body: 'menu-october.pdf', url: 'mxc://test/file' }))
    expect(matrixRoomPreview(room, me)).toMatchObject({ kind: 'file', text: 'menu-october.pdf' })

    await add(event(me, { msgtype: 'm.image', body: 'IMG_2031.jpg', url: 'mxc://test/image' }))
    expect(matrixRoomPreview(room, me)).toEqual({ own: true, kind: 'image', at: expect.any(Number) })

    const deleted = await add(event(bao, { msgtype: 'm.text', body: 'oops' }))
    deleted.makeRedacted(
      new MatrixEvent({ type: EventType.RoomRedaction, event_id: '$redaction', sender: bao, redacts: deleted.getId(), content: {} }),
      room
    )
    // Someone without a display name goes by their handle, never their address.
    expect(matrixRoomPreview(room, me)).toMatchObject({ kind: 'deleted', sender: 'bao' })

    await add(event(lan, { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' }, EventType.RoomMessageEncrypted))
    expect(matrixRoomPreview(room, me)).toMatchObject({ kind: 'unreadable', sender: 'Lan' })
  })

  it('drops a reply’s quoted fallback, and leaves out people you ignore', async () => {
    const { room, event, add } = fixture()
    const original = await add(event(me, { msgtype: 'm.text', body: 'Book a table?' }))

    await add(
      event(lan, {
        msgtype: 'm.text',
        body: `> <${me}> Book a table?\n\nDone, the window table`,
        'm.relates_to': { 'm.in_reply_to': { event_id: original.getId() } }
      }),
      event(bao, { msgtype: 'm.text', body: 'spam' })
    )

    expect(matrixRoomPreview(room, me, new Set([bao]))).toMatchObject({ sender: 'Lan', text: 'Done, the window table' })
  })
})

describe('the agent’s progress line in a chat row', () => {
  it('is never the preview: the row keeps the last message until the answer arrives', async () => {
    const { room, event, add } = fixture()
    await add(event(me, { msgtype: 'm.text', body: 'What is on today?' }))
    await add(
      event(lan, {
        msgtype: 'm.notice',
        body: 'Mình sẽ đọc lịch.',
        'io.atum.progress': { profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: 'working', kind: 'interim', revision: 0 }
      })
    )

    expect(matrixRoomPreview(room, me)).toMatchObject({ own: true, text: 'What is on today?' })

    await add(event(lan, { msgtype: 'm.text', body: 'Two meetings today.' }))
    expect(matrixRoomPreview(room, me)).toMatchObject({ sender: 'Lan', text: 'Two meetings today.' })
  })
})

describe('a company agent’s working line in a chat row (agent-turns/1.6)', () => {
  const COMPANY = '00000000-0000-4000-8000-a00000000001'
  const INCARNATION = '00000000-0000-4000-8000-a00000000007'
  const cos = '@cos:test'
  const manager = '@manager:test'

  const line = (roomId: string) => ({
    msgtype: 'm.notice',
    body: 'Checking the next step.',
    'io.atum.progress': {
      profile: 'atum.agent-turns/1.6',
      scope: 'company',
      companyId: COMPANY,
      agentPrincipal: '00000000-0000-4000-8000-a00000000002',
      audience: { kind: 'private', memberPrincipal: '00000000-0000-4000-8000-a00000000006', membershipIncarnation: INCARNATION },
      roomId,
      threadRootEventId: '$root',
      taskId: '00000000-0000-4000-8000-a00000000004',
      invocationId: '00000000-0000-4000-8000-a00000000005',
      revision: 0,
      phase: 'working',
      kind: 'todo'
    },
    'm.relates_to': { rel_type: 'm.thread', event_id: '$root', is_falling_back: false, 'm.in_reply_to': { event_id: '$root' } }
  })

  /** A private Chief of Staff room as the platform makes it: created by the manager (who left), you and its agent joined. */
  function privateCos(extra: string[] = []) {
    const { room, event, add } = fixture()

    const state = (type: string, content: object, stateKey = '', sender = manager) =>
      new MatrixEvent({ type, state_key: stateKey, sender, room_id: room.roomId, content })

    room.currentState.setStateEvents([
      state(EventType.RoomCreate, { type: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE, room_version: '11' }),
      state(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, {
        v: 1,
        classification: 'company_private_cos',
        companyId: COMPANY,
        membershipIncarnation: INCARNATION,
        executorId: '00000000-0000-4000-8000-a0000000000e'
      }),
      state(EventType.RoomMember, { membership: 'leave' }, lan, lan),
      state(EventType.RoomMember, { membership: 'leave' }, bao, bao),
      state(EventType.RoomMember, { membership: 'join' }, cos, cos),
      ...extra.map(userId => state(EventType.RoomMember, { membership: 'join' }, userId, userId))
    ])

    return { room, event, add }
  }

  it('skips the bound agent’s line in its private room: the row keeps the last message', async () => {
    const { room, event, add } = privateCos()

    await add(event(me, { msgtype: 'm.text', body: 'Plan the launch' }))
    await add(event(cos, line(room.roomId)))

    expect(matrixRoomPreview(room, me)).toMatchObject({ own: true, text: 'Plan the launch' })
  })

  it('never lets another member hide a message with a company marker, in a company or a personal room', async () => {
    const shared = privateCos([lan])

    await shared.add(shared.event(me, { msgtype: 'm.text', body: 'Plan the launch' }))
    await shared.add(shared.event(lan, line(shared.room.roomId)))
    expect(matrixRoomPreview(shared.room, me)).toMatchObject({ text: 'Checking the next step.' })

    const personal = fixture()

    await personal.add(personal.event(me, { msgtype: 'm.text', body: 'Hi' }))
    await personal.add(personal.event(lan, line(personal.room.roomId)))
    expect(matrixRoomPreview(personal.room, me)).toMatchObject({ sender: 'Lan', text: 'Checking the next step.' })
  })
})

describe('a chat’s unread state', () => {
  it('is unread while someone else’s newest message is past your receipt, and read once it is not', async () => {
    const { room, event, add, receipt } = fixture()
    const mine = await add(event(me, { msgtype: 'm.text', body: 'Hi' }))

    // Your own message reads everything before it.
    expect(matrixRoomUnread(room, me)).toBe(false)

    const theirs = await add(event(lan, { msgtype: 'm.text', body: 'Hello!' }))
    expect(matrixRoomUnread(room, me)).toBe(true)
    // An ignored person's message never makes a chat unread.
    expect(matrixRoomUnread(room, me, new Set([lan]))).toBe(false)

    // A private receipt (what Atum sends) reads it, as a public one does.
    receipt(theirs.getId()!)
    expect(matrixRoomUnread(room, me)).toBe(false)

    // An edit or a reaction after it is not a new message.
    await add(
      event(lan, {
        msgtype: 'm.text',
        body: '* Hello again',
        'm.new_content': { msgtype: 'm.text', body: 'Hello again' },
        'm.relates_to': { rel_type: 'm.replace', event_id: theirs.getId() }
      }),
      event(lan, { 'm.relates_to': { rel_type: 'm.annotation', event_id: mine.getId(), key: '❤️' } }, EventType.Reaction)
    )
    expect(matrixRoomUnread(room, me)).toBe(false)
  })

  it('projects counts, highlights, unread and the preview onto the room, ordered by its latest message', async () => {
    const { client, room, event, add } = fixture()
    const message = await add(event(lan, { msgtype: 'm.text', body: '@Minh can you look?' }))
    const reaction = event(bao, { 'm.relates_to': { rel_type: 'm.annotation', event_id: message.getId(), key: '👀' } }, EventType.Reaction)
    await add(reaction)

    room.setUnreadNotificationCount(NotificationCountType.Total, 2)
    room.setUnreadNotificationCount(NotificationCountType.Highlight, 1)
    room.setThreadUnreadNotificationCount('$thread', NotificationCountType.Total, 3)

    const projected = conversationRoom(client, room)

    expect(projected).toMatchObject({
      // The room's count and its threads' together.
      unreadNotifications: 5,
      highlights: 1,
      unread: true,
      preview: { own: false, sender: 'Lan', kind: 'text', text: '@Minh can you look?' }
    })
    // A reaction does not move the chat up the list: it is as recent as its latest message.
    expect(projected.lastActiveAt).toBe(message.getTs())
    expect(reaction.getTs()).toBeGreaterThan(message.getTs())
  })

  it('enumerates loaded legacy threads once for all row fields', async () => {
    const { client, room, event, add } = fixture()
    await add(event(lan, { msgtype: 'm.text', body: 'Loaded' }))
    const getThreads = vi.spyOn(room, 'getThreads')

    conversationRoom(client, room)
    expect(getThreads).toHaveBeenCalledOnce()
  })
})

describe('whether anyone has spoken in an assistant’s chat (the first run’s test of a new account)', () => {
  /** A chat whose loaded history starts at its creation, as a new account's does. */
  async function assistantChat(type: string = MATRIX_ASSISTANT_ROOM_TYPE) {
    const f = fixture()

    const create = new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      event_id: '$create',
      sender: me,
      room_id: f.room.roomId,
      origin_server_ts: 500,
      content: { creator: me, type }
    })

    f.room.currentState.setStateEvents([create])
    await f.room.addLiveEvents([create], { addToState: false })

    return f
  }

  it('is none for a chat that reaches its creation and holds no message, and says nothing otherwise', async () => {
    const { room, add, event } = await assistantChat()

    expect(matrixRoomDialogue(room)).toBe('none')

    // Only state, a reaction or a receipt-like event: still nobody has spoken.
    await add(event(me, { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$create', key: '👍' } }, EventType.Reaction))
    expect(matrixRoomDialogue(room)).toBe('none')

    // A timeline that does not begin at the room's creation cannot say there never was a message.
    const { room: partial, add: addPartial, event: partialEvent } = fixture()
    expect(matrixRoomDialogue(partial)).toBeUndefined()
    await addPartial(
      partialEvent(me, { name: 'Atum' }, EventType.RoomName),
      partialEvent(lan, { membership: 'join' }, EventType.RoomMember)
    )
    expect(matrixRoomDialogue(partial)).toBeUndefined()
  })

  it('is started by any message of either side, readable or not, deleted or edited', async () => {
    for (const make of [
      (event: ReturnType<typeof fixture>['event']) => event(me, { msgtype: 'm.text', body: 'Bông' }),
      (event: ReturnType<typeof fixture>['event']) => event(lan, { msgtype: 'm.text', body: 'Hi Minh' }),
      // An answer this device cannot read yet is still an answer.
      (event: ReturnType<typeof fixture>['event']) =>
        event(lan, { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' }, EventType.RoomMessageEncrypted),
      (event: ReturnType<typeof fixture>['event']) => event(me, { url: 'mxc://test/sticker' }, EventType.Sticker),
      // The agent's one progress line is a message of its own: a turn happened.
      (event: ReturnType<typeof fixture>['event']) => event(lan, { msgtype: 'm.notice', body: 'Working…' })
    ]) {
      const { room, add, event } = await assistantChat()
      await add(make(event))
      expect(matrixRoomDialogue(room)).toBe('started')
    }

    const { room, add, event } = await assistantChat()
    const deleted = await add(event(me, { msgtype: 'm.text', body: 'oops' }))

    deleted.makeRedacted(
      new MatrixEvent({ type: EventType.RoomRedaction, event_id: '$redaction', sender: me, redacts: deleted.getId(), content: {} }),
      room
    )
    expect(matrixRoomDialogue(room)).toBe('started')
  })

  it('is started even when the loaded history is only the latest part of a long one', async () => {
    const { room, add, event } = fixture()

    await add(event(lan, { msgtype: 'm.text', body: 'Welcome back' }))
    expect(matrixRoomDialogue(room)).toBe('started')
  })

  it('is projected onto an assistant’s chat only', async () => {
    const assistant = await assistantChat()
    expect(conversationRoom(assistant.client, assistant.room).dialogue).toBe('none')

    await assistant.add(assistant.event(me, { msgtype: 'm.text', body: 'Hi' }))
    expect(conversationRoom(assistant.client, assistant.room).dialogue).toBe('started')

    // An ordinary chat carries no such field: nobody reads its dialogue for the first run.
    const people = fixture()
    await people.add(people.event(lan, { msgtype: 'm.text', body: 'Dinner?' }))
    expect(Object.hasOwn(conversationRoom(people.client, people.room), 'dialogue')).toBe(false)
  })
})
