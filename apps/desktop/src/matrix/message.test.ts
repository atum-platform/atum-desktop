import { readFileSync } from 'node:fs'

import { createClient, EventStatus, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_COMPANY_CHANNEL_BINDING, MATRIX_COMPANY_CHANNEL_ROOM_VERSION, MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import {
  matrixAdmitCompanyPresentation,
  matrixCompanyPresentationContent,
  matrixCompanyPresentationEdit
} from '../../shared/matrix-company-presentation'
import {
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT
} from '../../shared/matrix-company-private-cos'

import { matrixMessage } from './message'

const turn = '00000000-0000-4000-8000-31f949766961'

it('projects only a valid synthetic Stop target on a closed, non-owner cloud notice', () => {
  const stopEvent = `$atum-occurrence-${turn}`
  const content = { msgtype: 'm.notice', body: 'Resuming', 'io.atum.result': { status: 'resuming_on_device', stopEvent } }
  expect(matrixMessage(event(content, '@assistant:test'), '@owner:test', new Set())?.cloudStatus).toEqual({ code: 'resuming_on_device', stopEvent })
  expect(matrixMessage(event(content), '@owner:test', new Set())?.cloudStatus).toBeUndefined()
  expect(matrixMessage(event({ ...content, msgtype: 'm.text' }, '@assistant:test'), '@owner:test', new Set())?.cloudStatus).toBeUndefined()
  expect(matrixMessage(event({ ...content, 'io.atum.result': { status: 'stopped', stopEvent } }, '@assistant:test'), '@owner:test', new Set())?.cloudStatus).toEqual({ code: 'stopped' })
  expect(matrixMessage(event({ ...content, 'io.atum.result': { status: 'resuming_on_device', stopEvent: '$other' } }, '@assistant:test'), '@owner:test', new Set())?.cloudStatus).toEqual({ code: 'resuming_on_device' })
  const failure = matrixMessage(event({ msgtype: 'm.notice', body: 'fallback', 'io.atum.result': { status: 'failed' } }, '@assistant:test'), '@owner:test', new Set())
  expect(failure).toMatchObject({ notice: true, cloudStatus: { code: 'failed' } })
  expect(matrixMessage(event({ msgtype: 'm.text', body: 'fallback', 'io.atum.result': { status: 'failed' } }, '@assistant:test'), '@owner:test', new Set())?.cloudStatus).toBeUndefined()
})

function event(content: Record<string, unknown>, sender = '@owner:test') {
  return new MatrixEvent({
    type: EventType.RoomMessage,
    room_id: '!room:test',
    event_id: '$event',
    sender,
    origin_server_ts: 1,
    content
  })
}

const companyFile = {
  v: 1,
  company_id: '00000000-0000-4000-8000-8c031eadb7f3',
  channel_id: '00000000-0000-4000-8000-01670d853f95',
  file_id: '00000000-0000-4000-8000-f739b2d7b3b6',
  revision: 1,
  name: 'brief.pdf',
  content_type: 'application/pdf',
  size: 1_048_576,
  sha256: 'a'.repeat(64)
}

function companyRoom() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = new Room('!room:test', client, '@owner:test')
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: room.roomId,
      sender: '@owner:test',
      content: {
        type: MATRIX_COMPANY_CHANNEL_TYPE,
        room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
        [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId: companyFile.company_id, channelId: companyFile.channel_id }
      }
    })
  ])

  return room
}

function privateCosRoom() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@member:atum.example' })
  const room = new Room('!room:test', client, '@member:atum.example')
  const state = (type: string, content: object) => new MatrixEvent({
    type,
    state_key: '',
    room_id: room.roomId,
    sender: '@manager:atum.example',
    content
  })

  room.currentState.setStateEvents([
    state(EventType.RoomCreate, { type: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE, room_version: '11' }),
    state(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, {
      v: 1,
      classification: 'company_private_cos',
      companyId: '00000000-0000-4000-8000-540eb3b6436f',
      membershipIncarnation: '00000000-0000-4000-8000-7b0cac15d6b0',
      executorId: '00000000-0000-4000-8000-ed2914fe0e5a'
    })
  ])

  return room
}

it('projects the frozen greeting agent pill as a safe link instead of raw HTML', () => {
  const content = {
    msgtype: 'm.text',
    body: 'Welcome! Ask @Chief of Staff here.\n\nOpen company board: https://atumplatform.com/#atum-board/00000000-0000-4000-8000-540eb3b6436f/00000000-0000-4000-8000-7b0cac15d6b0',
    format: 'org.matrix.custom.html',
    formatted_body: 'Welcome! Ask <a href="https://matrix.to/#/@private-cos:atum.example">@Chief of Staff</a> here.<br><br><a href="https://atumplatform.com/#atum-board/00000000-0000-4000-8000-540eb3b6436f/00000000-0000-4000-8000-7b0cac15d6b0">Open company board</a>',
    'm.mentions': { user_ids: ['@member:atum.example'] }
  }
  const message = matrixMessage(
    event(content, '@private-cos:atum.example'),
    '@member:atum.example',
    new Set(),
    privateCosRoom()
  )

  expect(message?.privateCosAgentPill).toEqual({
    userId: '@private-cos:atum.example',
    label: '@Chief of Staff',
    href: 'https://matrix.to/#/@private-cos:atum.example'
  })
  expect(message?.privateCosBoardLink).toEqual({
    title: 'Open company board',
    href: 'https://atumplatform.com/#atum-board/00000000-0000-4000-8000-540eb3b6436f/00000000-0000-4000-8000-7b0cac15d6b0'
  })
  expect(message).not.toHaveProperty('formattedBody')
})

it('projects the frozen protected company channel and thread fixtures, but never their mxc variant', () => {
  const room = companyRoom()

  const channel = {
    msgtype: 'm.file',
    body: 'brief.pdf',
    info: { mimetype: 'application/pdf', size: 1_048_576 },
    'io.atum.company_file': companyFile
  }

  const thread = {
    ...channel,
    'm.relates_to': {
      rel_type: 'm.thread', event_id: '$thread-root', is_falling_back: true,
      'm.in_reply_to': { event_id: '$thread-root' }
    }
  }

  expect(matrixMessage(event(channel, '@linh:test'), '@owner:test', new Set(), room)).toMatchObject({
    attachment: true, attachmentSize: 1_048_576, body: 'brief.pdf'
  })
  expect(matrixMessage(event(channel, '@linh:test'), '@owner:test', new Set())).toMatchObject({ attachment: false })
  expect(matrixMessage(event(thread, '@linh:test'), '@owner:test', new Set(), room)).toMatchObject({
    attachment: true, thread: true, threadRootId: '$thread-root', replyTo: '$thread-root'
  })
  expect(matrixMessage(event({ ...channel, url: 'mxc://atum.example/plain-company-bytes' }, '@linh:test'), '@owner:test', new Set(), room))
    .toMatchObject({ attachment: false })
  expect(matrixMessage(event({ ...channel, file: { url: 'mxc://atum.example/encrypted-company-bytes' } }, '@linh:test'), '@owner:test', new Set(), room))
    .toMatchObject({ attachment: false })
  expect(matrixMessage(event({ ...channel, 'io.atum.company_file': { ...companyFile, channel_id: companyFile.company_id } }, '@linh:test'), '@owner:test', new Set(), room))
    .toMatchObject({ attachment: false })
})

it('projects the turn marker on a local-path question, without a result link', () => {
  const message = matrixMessage(
    event({ msgtype: 'm.text', body: 'Hi', 'io.atum.turn': turn }),
    '@owner:test',
    new Set()
  )

  expect(message).toMatchObject({ body: 'Hi', own: true, turn })
  expect(message).not.toHaveProperty('resultFor')
})

it('marks your own message sent only once the server has it, never while in flight or for anyone else', () => {
  const sent = matrixMessage(event({ msgtype: 'm.text', body: 'Hi' }), '@owner:test', new Set())
  expect(sent).toMatchObject({ sent: true, pending: false, failed: false })

  for (const status of [
    EventStatus.ENCRYPTING,
    EventStatus.QUEUED,
    EventStatus.SENDING,
    EventStatus.SENT,
    EventStatus.NOT_SENT,
    EventStatus.CANCELLED
  ]) {
    const echo = event({ msgtype: 'm.text', body: 'Hi' })
    echo.setStatus(status)
    expect(matrixMessage(echo, '@owner:test', new Set())).not.toHaveProperty('sent')
  }

  // A local echo still has no server ID, even with no status.
  const local = new MatrixEvent({
    type: EventType.RoomMessage,
    room_id: '!room:test',
    event_id: '~!room:test:m1',
    sender: '@owner:test',
    origin_server_ts: 1,
    content: { msgtype: 'm.text', body: 'Hi' }
  })

  expect(matrixMessage(local, '@owner:test', new Set())).not.toHaveProperty('sent')
  expect(matrixMessage(event({ msgtype: 'm.text', body: 'Hi' }, '@atum:test'), '@owner:test', new Set())).not.toHaveProperty(
    'sent'
  )
})

it('correlates a handed-off question by its handoff marker, so its sending Mac shows it once', () => {
  const message = matrixMessage(
    event({ msgtype: 'm.text', body: 'Hi', 'io.atum.handoff': turn }),
    '@owner:test',
    new Set()
  )

  expect(message).toMatchObject({ body: 'Hi', own: true, turn })
  expect(message).not.toHaveProperty('resultFor')
})

it('links a marked answer to its question like an old answer', () => {
  const answer = matrixMessage(
    event(
      {
        msgtype: 'm.text',
        body: 'Hello',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$question' },
        'io.atum.result': { invocation: turn, transaction: `atum-a-${turn}` },
        'io.atum.turn': turn
      },
      '@assistant:test'
    ),
    '@owner:test',
    new Set()
  )

  expect(answer).toMatchObject({ resultFor: '$question', replyTo: '$question', turn, own: false })
})

it('links a standard rich reply to its question without requiring a thread relation', () => {
  const answer = matrixMessage(
    event(
      {
        msgtype: 'm.text',
        body: 'Hello',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } },
        'io.atum.result': { invocation: turn, transaction: `atum-a-${turn}` },
        'io.atum.turn': turn
      },
      '@assistant:test'
    ),
    '@owner:test',
    new Set()
  )

  expect(answer).toMatchObject({ resultFor: '$question', replyTo: '$question', turn, own: false })
})

it('projects an ordinary human reply without treating it as an agent result', () => {
  const reply = matrixMessage(
    event({
      msgtype: 'm.text',
      body: 'Thanks',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } }
    }),
    '@owner:test',
    new Set()
  )

  expect(reply).toMatchObject({ replyTo: '$question', body: 'Thanks' })
  expect(reply).not.toHaveProperty('resultFor')
})

it('projects a Team Space thread root separately from its flat reply target', () => {
  const reply = matrixMessage(
    event({
      msgtype: 'm.text',
      body: 'Tuesday works',
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: '$root',
        'm.in_reply_to': { event_id: '$previous' }
      }
    }),
    '@owner:test',
    new Set(),
    companyRoom()
  )

  expect(reply).toMatchObject({ thread: true, threadRootId: '$root', replyTo: '$previous' })
  expect(reply).not.toHaveProperty('resultFor')
})

it("marks the assistant's notice as status, never as an answer to the message it names", () => {
  const notice = matrixMessage(
    event(
      {
        msgtype: 'm.notice',
        body: 'I couldn’t read the message you replied to — could you say it again?',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$held' } }
      },
      '@assistant:test'
    ),
    '@owner:test',
    new Set()
  )

  expect(notice).toMatchObject({ notice: true, replyTo: '$held', own: false })
  expect(notice).not.toHaveProperty('resultFor')
  expect(matrixMessage(event({ msgtype: 'm.text', body: 'Hello' }), '@owner:test', new Set())).not.toHaveProperty(
    'notice'
  )
})

it('still reads old-shape answers, which carry only io.atum.result', () => {
  const old = matrixMessage(
    event(
      {
        msgtype: 'm.text',
        body: 'Done',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$request' },
        'io.atum.result': { invocation: 'i', transaction: 't' }
      },
      '@assistant:test'
    ),
    '@owner:test',
    new Set()
  )

  expect(old).toMatchObject({ resultFor: '$request', body: 'Done' })
  expect(old).not.toHaveProperty('turn')
})

it('ignores a malformed marker and hides ignored senders', () => {
  expect(
    matrixMessage(event({ msgtype: 'm.text', body: 'x', 'io.atum.turn': 'nope' }), null, new Set())
  ).not.toHaveProperty('turn')
  expect(matrixMessage(event({ msgtype: 'm.text', body: 'x' }), null, new Set(['@owner:test']))).toBeNull()
})

it("carries a file's size as its own event states it, and nothing it can't trust", () => {
  const file = (info: unknown) =>
    matrixMessage(
      event({ msgtype: 'm.file', body: 'menu.pdf', file: { url: 'mxc://test/a' }, info }, '@linh:test'),
      '@owner:test',
      new Set()
    )

  expect(file({ size: 482_133 })).toMatchObject({ attachment: true, body: 'menu.pdf', attachmentSize: 482_133 })

  for (const info of [undefined, null, {}, { size: -1 }, { size: 1.5 }, { size: '12' }]) {
    expect(file(info)).not.toHaveProperty('attachmentSize')
  }

  // Only a file has a size.
  expect(
    matrixMessage(event({ msgtype: 'm.text', body: 'hi', info: { size: 3 } }), '@owner:test', new Set())
  ).not.toHaveProperty('attachmentSize')
})

it('shows a photo (m.image) as an attachment like a file, and never a video', () => {
  const media = (msgtype: string) =>
    matrixMessage(
      event({ msgtype, body: 'IMG_1.jpg', file: { url: 'mxc://test/a' }, info: { size: 99 } }, '@linh:test'),
      '@owner:test',
      new Set()
    )

  expect(media('m.image')).toMatchObject({ attachment: true, body: 'IMG_1.jpg', attachmentSize: 99 })
  expect(media('m.video')).toMatchObject({ attachment: false })
})

describe("Matrix's own message features in the projection (launch night)", () => {
  const owner = '@owner:test'
  const linh = '@linh:test'

  function room() {
    const client = createClient({ baseUrl: 'https://matrix.test', userId: owner })

    return new Room('!room:test', client, owner)
  }

  let count = 0

  function roomEvent(type: string, sender: string, content: Record<string, unknown>, id = `$e${++count}`) {
    return new MatrixEvent({ type, room_id: '!room:test', event_id: id, sender, origin_server_ts: count, content })
  }

  async function timeline(target: Room, ...events: MatrixEvent[]) {
    await target.addLiveEvents(events, { addToState: false })
    // Relations aggregate asynchronously (an edit is applied once it is known to be valid).
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  const project = (target: Room, id: string, ignored = new Set<string>()) =>
    matrixMessage(target.findEventById(id)!, owner, ignored, target)

  it('removes a synthetic Stop offer when the assistant edits the same notice to a terminal state', async () => {
    const target = room()

    const original = roomEvent(EventType.RoomMessage, '@assistant:test', {
      msgtype: 'm.notice', body: 'Resuming',
      'io.atum.result': { status: 'resuming_on_device', stopEvent: `$atum-followup-${turn}.${turn}` }
    }, '$resuming')

    await timeline(target, original)
    expect(project(target, '$resuming')?.cloudStatus?.stopEvent).toBeTruthy()

    const edit = roomEvent(EventType.RoomMessage, '@assistant:test', {
      msgtype: 'm.notice', body: '* Stopped',
      'm.new_content': { msgtype: 'm.notice', body: 'Stopped', 'io.atum.result': { status: 'stopped' } },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$resuming' }
    })

    await timeline(target, edit)
    await vi.waitFor(() => expect(project(target, '$resuming')?.cloudStatus).toEqual({ code: 'stopped' }))
  })

  it("shows a message's latest edit from its own sender, marked edited, with its markers as first sent", async () => {
    const target = room()
    const question = roomEvent(EventType.RoomMessage, owner, { msgtype: 'm.text', body: 'Plan Hue', 'io.atum.turn': turn }, '$q')

    const edit = roomEvent(EventType.RoomMessage, owner, {
      msgtype: 'm.text',
      body: '* Plan Huế',
      'm.new_content': { msgtype: 'm.text', body: 'Plan Huế' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$q' }
    })

    await timeline(target, question, edit)

    await vi.waitFor(() => expect(project(target, '$q')).toMatchObject({
      body: 'Plan Huế', edited: true, editedAt: edit.getTs(), turn
    }))
    // The edit itself is never a bubble of its own.
    expect(project(target, edit.getId()!)).toBeNull()
  })

  it('never applies an edit from anyone but the sender', async () => {
    const target = room()
    const original = roomEvent(EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'See you at 7' }, '$linh')

    const forged = roomEvent(EventType.RoomMessage, owner, {
      msgtype: 'm.text',
      body: '* See you never',
      'm.new_content': { msgtype: 'm.text', body: 'See you never' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$linh' }
    })

    await timeline(target, original, forged)
    // Even a replacement the server bundled is checked again here.
    target.findEventById('$linh')!.makeReplaced(forged)

    expect(project(target, '$linh')).toMatchObject({ body: 'See you at 7' })
    expect(project(target, '$linh')).not.toHaveProperty('edited')
  })

  it('keeps a deleted message as an empty, deleted line, and drops a deleted reaction', async () => {
    const target = room()
    const message = roomEvent(EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'oops' }, '$gone')

    const reaction = roomEvent(
      EventType.Reaction,
      linh,
      { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$gone', key: '👍' } },
      '$r'
    )

    await timeline(target, message, reaction)

    const redaction = (redacts: string) =>
      new MatrixEvent({ type: EventType.RoomRedaction, room_id: '!room:test', event_id: `$x-${redacts}`, sender: linh, redacts, content: {} })

    target.findEventById('$gone')!.makeRedacted(redaction('$gone'), target)
    target.findEventById('$r')!.makeRedacted(redaction('$r'), target)

    expect(project(target, '$gone')).toMatchObject({ id: '$gone', sender: linh, body: '', redacted: true })
    expect(project(target, '$gone')).not.toHaveProperty('reactions')
    expect(project(target, '$r')).toBeNull()
  })

  it('counts each person once per reaction, marks yours, and leaves out people you ignore', async () => {
    const target = room()
    const message = roomEvent(EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'Dinner?' }, '$m')

    const react = (sender: string, key: string) =>
      roomEvent(EventType.Reaction, sender, { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$m', key } })

    await timeline(
      target,
      message,
      react(linh, '👍'),
      // The same person's second identical reaction (another app sent it twice) counts once.
      react(linh, '👍'),
      react(owner, '👍'),
      react(owner, '❤️'),
      react('@spam:test', '😂')
    )

    expect(project(target, '$m', new Set(['@spam:test']))?.reactions).toEqual([
      { key: '👍', count: 2, own: true, senders: [linh, owner] },
      { key: '❤️', count: 1, own: true, senders: [owner] }
    ])
  })

  it("flattens another app's ordinary-room thread as a rich reply, but keeps Team Space threads", async () => {
    const target = room()
    await timeline(
      target,
      roomEvent(EventType.RoomMessage, linh, { msgtype: 'm.text', body: 'Root' }, '$root'),
      roomEvent(
        EventType.RoomMessage,
        linh,
        { msgtype: 'm.text', body: 'In the thread', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } },
        '$t'
      ),
      // An old answer was a thread relation too: it stays an answer, not a thread message.
      roomEvent(
        EventType.RoomMessage,
        '@assistant:test',
        {
          msgtype: 'm.text',
          body: 'Done',
          'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          'io.atum.result': { invocation: 'i', transaction: 't' }
        },
        '$old'
      )
    )

    expect(project(target, '$t')).toMatchObject({ replyTo: '$root' })
    expect(project(target, '$t')).not.toHaveProperty('thread')

    vi.spyOn(target, 'getType').mockReturnValue(MATRIX_COMPANY_CHANNEL_TYPE)
    expect(project(target, '$t')).toMatchObject({ thread: true, threadRootId: '$root', replyTo: '$root' })
    expect(project(target, '$old')).toMatchObject({ resultFor: '$root' })
    expect(project(target, '$old')).not.toHaveProperty('thread')
  })

  it('never reads your own reply as an answer, even with its turn marker', async () => {
    const target = room()
    await timeline(
      target,
      roomEvent(
        EventType.RoomMessage,
        owner,
        { msgtype: 'm.text', body: 'And for 3 days?', 'io.atum.turn': turn, 'm.relates_to': { 'm.in_reply_to': { event_id: '$a' } } },
        '$reply'
      )
    )

    expect(project(target, '$reply')).toMatchObject({ replyTo: '$a', turn, own: true })
    expect(project(target, '$reply')).not.toHaveProperty('resultFor')
  })
})

// 0.20: a plain chat's file names a plain mxc URL (what this app, phones and Element X send
// there). It shows as a file only in a room without encryption; in an encrypted room plain media
// is never offered (no downgrade).
it('shows a plain file in a plain chat as a file, and never in an encrypted chat', () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })

  const roomWith = (encrypted: boolean) => {
    const room = new Room('!room:test', client, '@owner:test')

    if (encrypted) {
      room.currentState.setStateEvents([
        new MatrixEvent({
          type: EventType.RoomEncryption,
          state_key: '',
          room_id: room.roomId,
          sender: '@owner:test',
          content: { algorithm: 'm.megolm.v1.aes-sha2' }
        })
      ])
    }

    return room
  }

  const plainFile = () =>
    event({ msgtype: 'm.file', body: 'notes.txt', url: 'mxc://test/notes', info: { size: 4 } }, '@linh:test')

  expect(matrixMessage(plainFile(), '@owner:test', new Set(), roomWith(false), false, true)).toMatchObject({
    attachment: true,
    body: 'notes.txt',
    attachmentSize: 4
  })
  expect(matrixMessage(plainFile(), '@owner:test', new Set(), roomWith(true), false, true)).toMatchObject({
    attachment: false
  })
  // No encryption state synced yet, but the crypto store says the room is encrypted (or has not
  // answered): the plain URL is not a file there.
  expect(matrixMessage(plainFile(), '@owner:test', new Set(), roomWith(false), false, false)).toMatchObject({
    attachment: false
  })
})

it('projects the agent’s progress line for a render hook, never marked edited, and never a stranger’s', () => {
  const marker = (revision: number, phase: 'working' | 'settled' = 'working', kind = 'interim') =>
    ({ profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase, kind, revision }) as const

  const content = { msgtype: 'm.notice', body: 'Mình sẽ đọc lịch.', 'io.atum.progress': marker(0) }
  const root = event(content, '@assistant:test')
  const edit = event({
    msgtype: 'm.notice',
    body: '* Sắp xong.',
    'm.new_content': { msgtype: 'm.notice', body: 'Sắp xong.', 'io.atum.progress': marker(2, 'settled', 'settled') },
    'm.relates_to': { rel_type: 'm.replace', event_id: '$event' },
    'io.atum.progress': marker(2, 'settled', 'settled')
  }, '@assistant:test')

  expect(matrixMessage(root, '@owner:test', new Set())).toMatchObject({ notice: true, progress: marker(0) })
  root.makeReplaced(edit)
  const shown = matrixMessage(root, '@owner:test', new Set())!
  expect(shown).toMatchObject({ body: 'Sắp xong.', notice: true, progress: marker(2, 'settled', 'settled') })
  expect(shown.edited).toBeUndefined()

  // An ordinary edited notice still reads edited; a marker that is not the contract's is ignored.
  const plain = event({ msgtype: 'm.notice', body: 'Waiting' }, '@assistant:test')
  plain.makeReplaced(event({ msgtype: 'm.notice', body: '* Waited', 'm.new_content': { msgtype: 'm.notice', body: 'Waited' },
    'm.relates_to': { rel_type: 'm.replace', event_id: '$event' } }, '@assistant:test'))
  expect(matrixMessage(plain, '@owner:test', new Set())).toMatchObject({ edited: true })
  expect(matrixMessage(plain, '@owner:test', new Set())?.progress).toBeUndefined()
  expect(matrixMessage(event({ ...content, 'io.atum.progress': { ...marker(0), scope: 'room' } }, '@assistant:test'), '@owner:test', new Set())?.progress).toBeUndefined()
  expect(matrixMessage(event({ ...content, msgtype: 'm.text' }, '@assistant:test'), '@owner:test', new Set())?.progress).toBeUndefined()
  // The owner's own copy of the marker is never read as the agent's line.
  expect(matrixMessage(event(content, '@owner:test'), '@owner:test', new Set())?.progress).toBeUndefined()
})

it('projects the agent\u2019s interim remark as a real message that is not the answer, and never a stranger\u2019s', () => {
  const content = { msgtype: 'm.text', body: 'Để mình xem video này rồi tóm tắt nhé.', 'io.atum.interim': true }
  const remark = matrixMessage(event(content, '@assistant:test'), '@owner:test', new Set())!
  expect(remark).toMatchObject({ body: content.body, interim: true })
  // An ordinary message: not a notice, not a result, not edited.
  expect(remark.notice).toBeUndefined()
  expect(remark.resultFor).toBeUndefined()
  expect(matrixMessage(event({ msgtype: 'm.text', body: 'plain' }, '@assistant:test'), '@owner:test', new Set())?.interim).toBeUndefined()
  // Only exactly `true` on an m.text counts; the owner's own copy of the marker is never the agent's.
  expect(matrixMessage(event({ ...content, 'io.atum.interim': 'true' }, '@assistant:test'), '@owner:test', new Set())?.interim).toBeUndefined()
  expect(matrixMessage(event({ ...content, msgtype: 'm.notice' }, '@assistant:test'), '@owner:test', new Set())?.interim).toBeUndefined()
  expect(matrixMessage(event(content, '@owner:test'), '@owner:test', new Set())?.interim).toBeUndefined()
})

const botUser = '@app-moon:atumplatform.com'
const botMetadata = {
  version: 'io.atum.bot_api/1',
  bot_id: '00000000-0000-4000-8000-f6222a1106ee',
  public_message_id: 43,
  fallback_text: 'Sign in: https://moon.example/sign-in'
}

it('projects bot-api metadata from the official bot’s own message', () => {
  const message = matrixMessage(
    event(
      {
        msgtype: 'm.text',
        body: 'Choose one',
        format: 'org.matrix.custom.html',
        formatted_body: 'Choose <strong>one</strong>',
        'io.atum.bot_api': botMetadata
      },
      botUser
    ),
    '@owner:test',
    new Set()
  )

  expect(message?.botApi).toMatchObject({
    version: 'io.atum.bot_api/1',
    publicMessageId: 43,
    formattedBody: 'Choose <strong>one</strong>'
  })
  expect(message?.attachment).toBe(false)
})

it('never trusts bot-api metadata from a person or from the owner’s own event', () => {
  const content = {
    msgtype: 'm.text',
    body: 'Choose one',
    'io.atum.bot_api': botMetadata
  }

  expect(matrixMessage(event(content, '@linh:test'), '@owner:test', new Set())?.botApi).toBeUndefined()
  expect(matrixMessage(event(content, '@owner:test'), '@owner:test', new Set())?.botApi).toBeUndefined()
})

it('projects bounded native URL keyboard metadata from the official bot', () => {
  const keyboard = [[{ label: 'Sign in', kind: 'url' as const, url: 'https://moon.example' }]]
  const message = matrixMessage(
    event(
      {
        msgtype: 'm.text',
        body: 'Choose one',
        'io.atum.bot_api': { ...botMetadata, keyboard }
      },
      botUser
    ),
    '@owner:test',
    new Set()
  )

  expect(message?.botApi?.keyboard).toEqual(keyboard)
  expect(message?.body).toBe('Choose one')
})

it('keeps a legacy app-contract message exactly as it was', () => {
  const message = matrixMessage(event({ msgtype: 'm.text', body: 'Hello' }, botUser), '@owner:test', new Set())

  expect(message?.botApi).toBeUndefined()
  expect(message?.body).toBe('Hello')
})

it('projects a bot-api photo as a photo, not a generic file card', () => {
  const message = matrixMessage(
    event(
      {
        msgtype: 'm.image',
        body: 'Please inspect this',
        file: { url: 'mxc://test/photo', key: { kty: 'oct' } },
        info: { mimetype: 'image/jpeg', size: 2_048, w: 1_280, h: 960 },
        'io.atum.bot_api': {
          ...botMetadata,
          photo: { file_ref: 'mref_0123456789abcdef', width: 1_280, height: 960, mime_type: 'image/jpeg', caption: 'Please inspect this' }
        }
      },
      botUser
    ),
    '@owner:test',
    new Set()
  )

  // The ordinary file card remains available if renderer-side catalog/device authorization
  // cannot prove this event. An authorized bubble prefers the bot-api photo over it.
  expect(message?.attachment).toBe(true)
  expect(message?.botApi?.photo).toMatchObject({
    fileRef: 'mref_0123456789abcdef',
    width: 1_280,
    height: 960,
    mimeType: 'image/jpeg'
  })
})

it('drops metadata from a redacted bot message', () => {
  const raw = new MatrixEvent({
    type: EventType.RoomMessage,
    room_id: '!room:test',
    event_id: '$redacted',
    sender: botUser,
    origin_server_ts: 1,
    content: { msgtype: 'm.text', body: 'Choose one', 'io.atum.bot_api': botMetadata },
    unsigned: { redacted_because: { type: EventType.RoomMessage } } as never
  })

  expect(matrixMessage(raw, '@owner:test', new Set())).toMatchObject({ redacted: true })
  expect(matrixMessage(raw, '@owner:test', new Set())?.botApi).toBeUndefined()
})

describe('company agent progress and interim remarks (agent-turns/1.6)', () => {
  const AGENT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  const TASK = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f'
  const INVOCATION = 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a'
  const MEMBER = 'e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8a9b'
  const channelAudience = { kind: 'channel', channelId: companyFile.channel_id }
  const privateAudience = { kind: 'private', memberPrincipal: MEMBER, membershipIncarnation: '00000000-0000-4000-8000-7b0cac15d6b0' }
  const thread = { rel_type: 'm.thread', event_id: '$root', is_falling_back: false, 'm.in_reply_to': { event_id: '$trigger' } }

  const marker = (companyId: string, audience: object, patch: Record<string, unknown> = {}) => ({
    profile: 'atum.agent-turns/1.6',
    scope: 'company',
    companyId,
    agentPrincipal: AGENT,
    audience,
    roomId: '!room:test',
    threadRootEventId: '$root',
    taskId: TASK,
    invocationId: INVOCATION,
    revision: 0,
    ...patch
  })

  const progress = (companyId = companyFile.company_id, audience: object = channelAudience, patch: Record<string, unknown> = {}) => ({
    msgtype: 'm.notice',
    body: 'Reading the board.',
    'io.atum.progress': { phase: 'working', kind: 'todo', ...marker(companyId, audience, patch) },
    'm.relates_to': thread
  })

  const interim = (companyId = companyFile.company_id, audience: object = channelAudience) => ({
    msgtype: 'm.text',
    body: 'Let me check the board first.',
    'io.atum.interim': true,
    'io.atum.company': marker(companyId, audience),
    'm.relates_to': thread
  })

  const edit = (content: Record<string, unknown>) => event({
    ...content,
    body: `* ${content.body as string}`,
    'm.new_content': content,
    'm.relates_to': { rel_type: 'm.replace', event_id: '$event' }
  }, '@cos:test')

  it('projects a channel thread line with its identity, never as an edit', () => {
    const shown = matrixMessage(event(progress(), '@cos:test'), '@owner:test', new Set(), companyRoom())!

    expect(shown).toMatchObject({
      notice: true,
      thread: true,
      threadRootId: '$root',
      replyTo: '$trigger',
      progress: { profile: 'atum.agent-turns/1.6', scope: 'company', phase: 'working', kind: 'todo', revision: 0 },
      company: { companyId: companyFile.company_id, agentPrincipal: AGENT, audience: channelAudience, taskId: TASK, triggerEventId: '$trigger' }
    })
    expect(shown.interim).toBeUndefined()
  })

  it('projects a channel interim remark as a real message carrying the identity', () => {
    const shown = matrixMessage(event(interim(), '@cos:test'), '@owner:test', new Set(), companyRoom())!

    expect(shown).toMatchObject({ interim: true, body: 'Let me check the board first.', company: { taskId: TASK } })
    expect(shown.progress).toBeUndefined()
  })

  it('projects a private Chief of Staff room line only for that room marker', () => {
    const shown = matrixMessage(
      event(progress('00000000-0000-4000-8000-540eb3b6436f', privateAudience), '@cos:test'),
      '@member:atum.example',
      new Set(),
      privateCosRoom()
    )

    expect(shown?.company?.audience).toEqual(privateAudience)
    expect(shown?.progress?.scope).toBe('company')

    const rejoined = matrixMessage(
      event(progress('00000000-0000-4000-8000-540eb3b6436f', { ...privateAudience, membershipIncarnation: TASK }), '@cos:test'),
      '@member:atum.example',
      new Set(),
      privateCosRoom()
    )

    expect(rejoined?.company).toBeUndefined()
    expect(rejoined?.progress).toBeUndefined()
  })

  it('ignores a marker that does not match the room, its binding, or comes from you', () => {
    const cases: Array<[Record<string, unknown>, Parameters<typeof matrixMessage>[3], string?]> = [
      [progress(), undefined],
      [progress(companyFile.file_id), companyRoom()],
      [progress(companyFile.company_id, { kind: 'channel', channelId: companyFile.file_id }), companyRoom()],
      [progress(companyFile.company_id, channelAudience, { roomId: '!other:test' }), companyRoom()],
      [progress('00000000-0000-4000-8000-540eb3b6436f', privateAudience), companyRoom()],
      [progress(companyFile.company_id, channelAudience), privateCosRoom()],
      [progress(), companyRoom(), '@owner:test'],
      [{ ...progress(), 'm.relates_to': { ...thread, event_id: '$elsewhere' } }, companyRoom()],
      [{ ...interim(), 'io.atum.company': { garbage: true } }, companyRoom()]
    ]

    for (const [content, room, sender] of cases) {
      const shown = matrixMessage(event(content, sender ?? '@cos:test'), '@owner:test', new Set(), room)

      expect(shown?.company).toBeUndefined()
      expect(shown?.progress).toBeUndefined()
      expect(shown?.interim).toBeUndefined()
    }
  })

  it('reads the latest revision of a line, and ignores an edit that changes the turn or goes back', () => {
    const settle = (patch: Record<string, unknown>) => {
      const root = event(progress(), '@cos:test')

      root.makeReplaced(edit({ ...progress(companyFile.company_id, channelAudience, { revision: 2, ...patch }) }))

      return matrixMessage(root, '@owner:test', new Set(), companyRoom())
    }

    const settled = settle({})

    expect(settled).toMatchObject({ progress: { revision: 2 }, company: { revision: 2 } })
    expect(settled?.edited).toBeUndefined()

    // An edit naming another turn is not applied: the original line stays as it was.
    expect(settle({ taskId: MEMBER })).toMatchObject({ body: 'Reading the board.', company: { taskId: TASK, revision: 0 } })

    const late = event(progress(companyFile.company_id, channelAudience, { revision: 5 }), '@cos:test')

    late.makeReplaced(edit(progress(companyFile.company_id, channelAudience, { revision: 1 })))
    expect(matrixMessage(late, '@owner:test', new Set(), companyRoom())).toMatchObject({ company: { revision: 5 } })
  })

  describe('edits in revision order with a terminal fence (late edits never resurrect a line)', () => {
    const revision = (value: number, phase: 'working' | 'settled', ts: number, sender = '@cos:test') => {
      const replacement = edit(progress(companyFile.company_id, channelAudience, {
        revision: value, phase, kind: phase === 'settled' ? 'settled' : 'todo'
      }))

      return new MatrixEvent({ ...replacement.event, event_id: `$edit-${value}-${ts}`, origin_server_ts: ts, sender })
    }

    const project = (edits: MatrixEvent[], latest = edits.at(-1)) => {
      const room = companyRoom()
      const root = event(progress(), '@cos:test')

      vi.spyOn(room.relations, 'getChildEventsForEvent').mockImplementation((id, relType) =>
        id === '$event' && relType === 'm.replace' ? ({ getRelations: () => edits } as never) : undefined)

      if (latest) {
        root.makeReplaced(latest)
      }

      return matrixMessage(root, '@owner:test', new Set(), room)
    }

    it('keeps a settled revision when a lower revision arrives later, whatever its timestamp', () => {
      expect(project([revision(5, 'settled', 5), revision(1, 'working', 9)])?.progress).toMatchObject({ phase: 'settled', revision: 5 })
    })

    it('never reads past settled, even a higher revision', () => {
      expect(project([revision(2, 'settled', 2), revision(6, 'working', 9)])?.progress).toMatchObject({ phase: 'settled', revision: 2 })
      expect(project([revision(6, 'working', 1), revision(2, 'settled', 9)])?.progress).toMatchObject({ phase: 'settled', revision: 2 })
    })

    it('applies the highest revision while working, and ignores another sender\'s edit', () => {
      expect(project([revision(3, 'working', 3), revision(2, 'working', 9)])?.progress).toMatchObject({ phase: 'working', revision: 3 })
      expect(project([revision(4, 'settled', 9, '@linh:test')])?.progress).toMatchObject({ phase: 'working', revision: 0 })
    })

    it('reads a settled original as settled whatever edits follow', () => {
      const room = companyRoom()
      const root = event(progress(companyFile.company_id, channelAudience, { phase: 'settled', kind: 'settled' }), '@cos:test')

      root.makeReplaced(revision(1, 'working', 9))
      expect(matrixMessage(root, '@owner:test', new Set(), room)?.progress).toMatchObject({ phase: 'settled', revision: 0 })
    })
  })

  describe('every frozen 1.6 pack fixture through the real projection', () => {
    const pack = '../../../../packages/device-protocol/fixtures/agent-turns-v1.6/'
    const read = (file: string) => JSON.parse(readFileSync(new URL(pack + file, import.meta.url), 'utf8')) as Record<string, unknown>
    const contract = read('contract.json') as unknown as { fixtures: Array<{ file: string; message?: string; expect: string }> }
    const rows = contract.fixtures.filter(row => row.message?.startsWith('company.'))
    const PACK_ROOM = '!company:example.test'
    const PACK_COMPANY = '00000000-0000-4000-8000-a00000000001'
    const PACK_AGENT = '00000000-0000-4000-8000-a00000000002'

    const packRoom = (audience: 'channel' | 'private') => {
      const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
      const room = new Room(PACK_ROOM, client, '@owner:test')

      const state = (type: string, content: object) =>
        new MatrixEvent({ type, state_key: '', room_id: PACK_ROOM, sender: '@manager:test', content })

      room.currentState.setStateEvents(audience === 'channel'
        ? [state(EventType.RoomCreate, {
            type: MATRIX_COMPANY_CHANNEL_TYPE,
            room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
            [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId: PACK_COMPANY, channelId: '00000000-0000-4000-8000-a00000000003' }
          })]
        : [
            state(EventType.RoomCreate, { type: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE, room_version: '11' }),
            state(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, {
              v: 1,
              classification: 'company_private_cos',
              companyId: PACK_COMPANY,
              membershipIncarnation: '00000000-0000-4000-8000-a00000000007',
              executorId: '00000000-0000-4000-8000-a0000000000e'
            })
          ])

      return room
    }

    const packEvent = (content: Record<string, unknown>, id: string, ts = 1) =>
      new MatrixEvent({ type: EventType.RoomMessage, room_id: PACK_ROOM, event_id: id, sender: '@cos:test', origin_server_ts: ts, content })

    const binding = (audience: 'channel' | 'private') => ({
      companyId: PACK_COMPANY,
      agentPrincipal: PACK_AGENT,
      agentUserId: '@cos:test',
      roomId: PACK_ROOM,
      audience: audience === 'channel'
        ? { kind: 'channel' as const, channelId: '00000000-0000-4000-8000-a00000000003' }
        : {
            kind: 'private' as const,
            memberPrincipal: '00000000-0000-4000-8000-a00000000006',
            membershipIncarnation: '00000000-0000-4000-8000-a00000000007'
          }
    })

    it('covers every company message fixture of the pack', () => {
      expect(rows.length).toBeGreaterThanOrEqual(8)
      expect(rows.some(row => row.message?.endsWith('_edit') && row.expect === 'reject')).toBe(true)
    })

    it.each(rows.map(row => [row.file, row.message!, row.expect] as const))('%s (%s) is %s', (file, kind, expected) => {
      const audience = file.includes('-private-') ? 'private' : 'channel'
      const stream = kind.includes('progress') ? 'progress' : 'interim'
      const room = packRoom(audience)
      const content = read(file)
      const edit = kind.endsWith('_edit')

      // An edit applies to the pack's accepted original of the same audience and stream.
      const original = edit ? packEvent(read(`fixtures/company-${audience}-${stream}.json`), '$original') : packEvent(content, '$original')

      if (edit) {
        expect(Boolean(matrixCompanyPresentationEdit(content, '$original'))).toBe(expected === 'accept')
        original.makeReplaced(packEvent(content, '$edit', 2))
      } else {
        expect(Boolean(matrixCompanyPresentationContent(content))).toBe(expected === 'accept')
      }

      const projected = matrixMessage(original, '@owner:test', new Set(), room)!
      const [shown] = matrixAdmitCompanyPresentation([projected], binding(audience), '$root')

      if (expected === 'accept') {
        expect(shown?.company).toMatchObject({ companyId: PACK_COMPANY, revision: edit ? 1 : 0 })
        expect(stream === 'progress' ? shown?.progress?.scope : shown?.interim).toBe(stream === 'progress' ? 'company' : true)
      } else if (edit) {
        // A rejected edit is never applied: the original stays exactly what it was.
        expect(shown?.company?.revision).toBe(0)
        expect(shown?.edited).toBeUndefined()
      } else {
        expect(shown?.company).toBeUndefined()
        expect(shown?.progress).toBeUndefined()
        expect(shown?.interim).toBeUndefined()
      }
    })
  })
})
