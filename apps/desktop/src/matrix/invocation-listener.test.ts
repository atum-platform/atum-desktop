import { EventEmitter } from 'node:events'

import {
  ClientEvent,
  Direction,
  EventType,
  type IRoomEvent,
  type MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
  RoomEvent
} from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { scanMatrixInvocations, watchMatrixInvocations } from './invocation-listener'
import { PLAIN_ANSWER_MS } from './plain-room'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()

  const client = Object.assign(new EventEmitter(), {
    decryptEventIfNeeded: vi.fn(async (_event: MatrixEvent) => {}),
    getRoom: vi.fn(() => ({ getMyMembership: (): string => 'join', hasEncryptionStateEvent: (): boolean => true }))
  })

  const offer = vi.fn()
  const listener = watchMatrixInvocations(client as unknown as MatrixClient, offer)

  const watch = {
    id: 'watch',
    roomId: '!room:test',
    since: Date.now() - 1000,
    until: Date.now() + 1000,
    sender: { userId: '@owner:test', deviceId: 'OWNER' }
  }

  const event = (content = { msgtype: 'm.text', body: 'hello' }, fields = {}) => {
    const e = new MatrixEvent({
      type: EventType.RoomMessage,
      room_id: watch.roomId,
      event_id: '$message',
      sender: watch.sender.userId,
      origin_server_ts: Date.now(),
      content,
      ...fields
    })

    e.makeEncrypted(EventType.RoomMessageEncrypted, {}, 'curve', 'ed')

    return e
  }

  const timeline = (e: MatrixEvent, data = { liveEvent: true, fromCache: false }, toStart = false, removed = false) =>
    client.emit(RoomEvent.Timeline, e, undefined, toStart, removed, data)

  return { client, offer, listener, watch, event, timeline }
}

it('is off by default and admits only new SDK live encrypted text after ready and explicit opt-in', () => {
  const f = fixture()
  f.timeline(f.event())
  f.listener.set(f.watch)
  f.timeline(f.event())
  expect(f.offer).not.toHaveBeenCalled()
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  const e = f.event()
  f.timeline(e)
  f.client.emit(MatrixEventEvent.Decrypted, e)
  f.timeline(e)
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: f.watch.id, roomId: f.watch.roomId, eventId: '$message' })
  f.listener.stop()
  f.timeline(f.event())
  expect(f.offer).toHaveBeenCalledTimes(1)
  expect(f.client.listenerCount(RoomEvent.Timeline)).toBe(0)
})

it('excludes history/cache/backfill, relations, other rooms/senders, redactions, local echoes and stale timestamps', () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  f.timeline(f.event(), { liveEvent: false, fromCache: false })
  f.timeline(f.event(), { liveEvent: true, fromCache: true })
  f.timeline(f.event(), undefined, true)
  f.timeline(f.event(), undefined, false, true)

  for (const fields of [
    { origin_server_ts: f.watch.since },
    { origin_server_ts: Date.now() + 1 },
    { room_id: '!other:test' },
    { sender: '@other:test' }
  ]) {
    f.timeline(f.event(undefined, fields))
  }

  const related = f.event({ msgtype: 'm.text', body: 'edit', 'm.relates_to': {} } as { msgtype: string; body: string })
  f.timeline(related)
  const redacted = f.event()
  vi.spyOn(redacted, 'isRedacted').mockReturnValue(true)
  f.timeline(redacted)
  const plaintext = f.event()
  vi.spyOn(plaintext, 'getWireType').mockReturnValue(EventType.RoomMessage)
  f.timeline(plaintext)
  const echo = f.event()
  vi.spyOn(echo, 'getId').mockReturnValue('~local')
  f.timeline(echo)
  f.client.getRoom.mockReturnValue({ getMyMembership: () => 'leave', hasEncryptionStateEvent: () => true })
  f.timeline(f.event())
  expect(f.offer).not.toHaveBeenCalled()
  f.listener.stop()
})

it('offers encrypted file events without downloading and excludes plaintext-file URLs', () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  const content = { msgtype: 'm.file', body: 'report.txt', file: { url: 'mxc://test/file' } }
  f.timeline(f.event(content))
  expect(f.offer).toHaveBeenCalledTimes(1)
  f.timeline(f.event({ msgtype: 'm.file', body: 'no encrypted media' }))
  expect(f.offer).toHaveBeenCalledTimes(1)
  f.listener.stop()
})

it.each(['off', 'replaced', 'offline', 'expired'] as const)(
  'does not turn deferred decryption into execution after %s',
  async boundary => {
    const f = fixture()
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    const e = f.event()
    const type = vi.spyOn(e, 'getType').mockReturnValue(EventType.RoomMessageEncrypted)
    f.timeline(e)

    if (boundary === 'off') {
      f.listener.set(null)
    }

    if (boundary === 'replaced') {
      f.listener.set({ ...f.watch, id: 'new' })
    }

    if (boundary === 'offline') {
      // A stopped client is an outage; a reconnecting one is not (below).
      f.client.emit(ClientEvent.Sync, 'STOPPED')
      f.client.emit(ClientEvent.Sync, 'SYNCING')
    }

    if (boundary === 'expired') {
      await vi.advanceTimersByTimeAsync(1000)
    }

    type.mockRestore()
    f.client.emit(MatrixEventEvent.Decrypted, e)
    expect(f.offer).not.toHaveBeenCalled()
    f.listener.stop()
  }
)

it('accepts a successfully decrypted live candidate, not an unrelated deferred event', () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'PREPARED')
  const e = f.event()
  const type = vi.spyOn(e, 'getType').mockReturnValue(EventType.RoomMessageEncrypted)
  f.timeline(e)
  type.mockRestore()
  f.client.emit(MatrixEventEvent.Decrypted, f.event())
  expect(f.offer).not.toHaveBeenCalled()
  f.client.emit(MatrixEventEvent.Decrypted, e)
  expect(f.offer).toHaveBeenCalledTimes(1)
  f.listener.stop()
})

it('asks the SDK to decrypt admitted ciphertext rather than assuming timeline events arrive decrypted', async () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  const e = f.event()
  const type = vi.spyOn(e, 'getType').mockReturnValue(EventType.RoomMessageEncrypted)
  f.client.decryptEventIfNeeded.mockImplementation(async () => {
    type.mockRestore()
  })
  f.timeline(e)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.client.decryptEventIfNeeded).toHaveBeenCalledExactlyOnceWith(e)
  expect(f.offer).toHaveBeenCalledTimes(1)
  f.listener.stop()
})

it('uses SDK-normalized local age across homeserver clock skew, but still rejects old history', () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  f.timeline(f.event(undefined, { origin_server_ts: Date.now() + 80, unsigned: { age: 0 } }))
  f.timeline(f.event(undefined, { origin_server_ts: Date.now() - 8000, unsigned: { age: 0 } }))
  expect(f.offer).toHaveBeenCalledTimes(2)
  f.timeline(f.event(undefined, { origin_server_ts: Date.now() + 80, unsigned: { age: 5000 } }))
  expect(f.offer).toHaveBeenCalledTimes(2)
  f.listener.stop()
})

it('requires a new opt-in after the client stopped instead of resuming the old watch', () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  f.client.emit(ClientEvent.Sync, 'STOPPED')
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  f.timeline(f.event())
  expect(f.offer).not.toHaveBeenCalled()
  f.listener.set({ ...f.watch, id: 'new' })
  f.timeline(f.event())
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: 'new', roomId: f.watch.roomId, eventId: '$message' })
  f.listener.stop()
})

describe('a reconnecting sync is a blip, not an outage (R4)', () => {
  it('keeps the watch and answers a message that arrives in the first response after the blip', () => {
    const f = fixture()
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.client.emit(ClientEvent.Sync, 'RECONNECTING', 'SYNCING', { error: new Error('network') })
    // Nothing arrives while the long-poll is down, and nothing is offered meanwhile.
    f.client.emit(ClientEvent.Sync, 'CATCHUP', 'RECONNECTING', { catchingUp: true })
    // The first response is applied while the state is still CATCHUP.
    f.timeline(f.event())
    expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: f.watch.id, roomId: f.watch.roomId, eventId: '$message' })
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.listener.stop()
  })

  it('keeps a candidate still decrypting through the blip', () => {
    const f = fixture()
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    const e = f.event()
    const type = vi.spyOn(e, 'getType').mockReturnValue(EventType.RoomMessageEncrypted)
    f.timeline(e)
    f.client.emit(ClientEvent.Sync, 'RECONNECTING')
    f.client.emit(ClientEvent.Sync, 'CATCHUP')
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    type.mockRestore()
    f.client.emit(MatrixEventEvent.Decrypted, e)
    expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: f.watch.id, roomId: f.watch.roomId, eventId: '$message' })
    f.listener.stop()
  })

  it('keeps the watch through an ERROR inside the grace, and drops it by itself once the grace runs out', async () => {
    const f = fixture()
    const watch = { ...f.watch, until: Date.now() + 10 * 60_000 }
    f.listener.set(watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.client.emit(ClientEvent.Sync, 'ERROR', 'RECONNECTING', { error: new Error('502') })

    await vi.advanceTimersByTimeAsync(119_000)
    f.timeline(f.event())
    expect(f.offer).toHaveBeenCalledTimes(1)

    // No sync event says the outage went on: the grace alone ends it.
    await vi.advanceTimersByTimeAsync(2_000)
    f.timeline(f.event(undefined, { event_id: '$later' }))
    expect(f.offer).toHaveBeenCalledTimes(1)

    // The network is back, but the watch is gone: the next watch must be asked for again.
    f.client.emit(ClientEvent.Sync, 'CATCHUP')
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.timeline(f.event(undefined, { event_id: '$after' }))
    expect(f.offer).toHaveBeenCalledTimes(1)
    f.listener.set({ ...watch, id: 'new' })
    f.timeline(f.event(undefined, { event_id: '$new' }))
    expect(f.offer).toHaveBeenLastCalledWith({ watchId: 'new', roomId: watch.roomId, eventId: '$new' })
    f.listener.stop()
  })

  it('drops the watch at once for a refused token', () => {
    const f = fixture()
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.client.emit(ClientEvent.Sync, 'ERROR', 'SYNCING', { error: { errcode: 'M_UNKNOWN_TOKEN' } })
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.timeline(f.event())
    expect(f.offer).not.toHaveBeenCalled()
    f.listener.stop()
  })
})

it('uses the automatic server boundary for live admission and still excludes a local-turn marker', () => {
  const f = fixture()
  const watch = { ...f.watch, since: Date.now() + 60_000, automatic: { windowStart: Date.now() - 15 * 60_000 } }
  f.listener.set(watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  f.timeline(f.event())
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: watch.id, roomId: watch.roomId, eventId: '$message' })
  f.timeline(
    f.event({ msgtype: 'm.text', body: 'local', 'io.atum.turn': 'a-marker' } as { msgtype: string; body: string })
  )
  expect(f.offer).toHaveBeenCalledTimes(1)
  f.listener.stop()
})

it('admits a question handed off by a Mac with a guest copy, as the phone would send it', () => {
  const f = fixture()
  const watch = { ...f.watch, since: Date.now() + 60_000, automatic: { windowStart: Date.now() - 15 * 60_000 } }
  f.listener.set(watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  f.timeline(
    f.event({
      msgtype: 'm.text',
      body: 'handed off',
      'io.atum.handoff': '00000000-0000-4000-8000-31f949766961'
    } as { msgtype: string; body: string })
  )
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: watch.id, roomId: watch.roomId, eventId: '$message' })
  f.listener.stop()
})

function scanEvent(
  eventId: string,
  timestamp: number,
  content: Record<string, unknown> = { msgtype: 'm.text', body: eventId }
) {
  return {
    type: EventType.RoomMessageEncrypted,
    event_id: eventId,
    room_id: '!room:test',
    sender: '@owner:test',
    origin_server_ts: timestamp,
    content
  } as IRoomEvent
}

function scanClient(
  pages: IRoomEvent[][],
  decrypt: (event: MatrixEvent) => Promise<void> = async event => {
    vi.spyOn(event, 'getType').mockReturnValue(EventType.RoomMessage)
  }
) {
  const createMessagesRequest = vi.fn(async (_room: string, from: string | null) => {
    const index = from === null ? 0 : Number(from)

    return { chunk: pages[index] ?? [], end: index + 1 < pages.length ? String(index + 1) : undefined }
  })

  const client = {
    getRoom: () => ({ getMyMembership: () => 'join', hasEncryptionStateEvent: () => true }),
    createMessagesRequest,
    decryptEventIfNeeded: vi.fn(decrypt)
  } as unknown as MatrixClient

  return { client, createMessagesRequest }
}

function automaticWatch() {
  return {
    id: 'automatic',
    roomId: '!room:test',
    since: 9_999,
    until: 10_000,
    sender: { userId: '@owner:test', deviceId: 'OWNER' },
    automatic: { windowStart: 1_000 }
  }
}

it('scans at most four server pages and returns server-timestamp-stable chronological hints', async () => {
  const { client, createMessagesRequest } = scanClient([
    [
      scanEvent('$new', 3_000),
      scanEvent('$old', 2_000),
      scanEvent('$relation', 1_900, { msgtype: 'm.text', body: 'r', 'm.relates_to': {} })
    ]
  ])

  await expect(scanMatrixInvocations(client, automaticWatch())).resolves.toEqual({
    hints: [
      { watchId: 'automatic', roomId: '!room:test', eventId: '$old' },
      { watchId: 'automatic', roomId: '!room:test', eventId: '$new' }
    ],
    complete: true,
    undecryptable: false
  })
  expect(createMessagesRequest).toHaveBeenCalledWith('!room:test', null, 50, Direction.Backward)
})

it('does not call a decryption hole or page-cap exhaustion complete', async () => {
  const failed = scanClient([[scanEvent('$locked', 2_000)]], async () => {
    throw new Error('missing_key')
  })

  await expect(scanMatrixInvocations(failed.client, automaticWatch())).resolves.toEqual({
    hints: [],
    complete: false,
    undecryptable: true
  })

  const pages = Array.from({ length: 5 }, (_, page) => [scanEvent(`$${page}`, 2_000 + page)])
  const exhausted = scanClient(pages)
  await expect(scanMatrixInvocations(exhausted.client, automaticWatch())).resolves.toMatchObject({
    hints: expect.any(Array),
    complete: false,
    undecryptable: false
  })
  expect(exhausted.createMessagesRequest).toHaveBeenCalledTimes(4)
})

it('continues through an empty page when the server supplies a next token', async () => {
  const { client, createMessagesRequest } = scanClient([[], [scanEvent('$after-empty', 2_000)]])

  await expect(scanMatrixInvocations(client, automaticWatch())).resolves.toEqual({
    hints: [{ watchId: 'automatic', roomId: '!room:test', eventId: '$after-empty' }],
    complete: true,
    undecryptable: false
  })
  expect(createMessagesRequest).toHaveBeenCalledTimes(2)
})

it('rejects a scan without an automatic durable boundary', async () => {
  const { client } = scanClient([])
  const { automatic: _automatic, ...legacy } = automaticWatch()

  await expect(scanMatrixInvocations(client, legacy)).rejects.toThrow('matrix_invocation_scan_invalid')
})

// Main moves a watch's end when the credential that admits it is renewed (its
// credential-renewal.ts; launch checklist G1-12, RT slice 2).
it('keeps what a watch has seen when its end moves later, and admits past the old end', async () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  const e = f.event()
  const type = vi.spyOn(e, 'getType').mockReturnValue(EventType.RoomMessageEncrypted)
  f.timeline(e)

  f.listener.set({ ...f.watch, until: f.watch.until + 60_000 })
  await vi.advanceTimersByTimeAsync(1_000)

  type.mockRestore()
  f.client.emit(MatrixEventEvent.Decrypted, e)
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: f.watch.id, roomId: f.watch.roomId, eventId: '$message' })

  // Already offered: moving the end again does not offer it twice.
  f.listener.set({ ...f.watch, until: f.watch.until + 120_000 })
  f.client.emit(MatrixEventEvent.Decrypted, e)
  expect(f.offer).toHaveBeenCalledTimes(1)
  f.listener.stop()
})

it.each([
  ['an earlier end', { until: Date.now() + 500 }],
  ['another start', { since: Date.now() - 2_000 }],
  ['another sender device', { sender: { userId: '@owner:test', deviceId: 'OTHER' } }],
  ['another recovery window', { automatic: { windowStart: 1 } }]
])('treats %s as a new watch, dropping what the old one was decrypting', (_name, change) => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  const e = f.event()
  const type = vi.spyOn(e, 'getType').mockReturnValue(EventType.RoomMessageEncrypted)
  f.timeline(e)

  f.listener.set({ ...f.watch, ...change })
  type.mockRestore()
  f.client.emit(MatrixEventEvent.Decrypted, e)
  expect(f.offer).not.toHaveBeenCalled()
  f.listener.stop()
})

// The agent-room contract (shared/matrix-turn-intake.ts): only a new top-level message from the
// owner starts a turn; everything done to a message is never a turn and never re-runs one.
it('never offers an edit, a reaction, a thread message or a deleted message as a turn', () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')

  const encrypted = (type: string, content: Record<string, unknown>, wire: Record<string, unknown> = {}) => {
    const e = new MatrixEvent({
      type,
      room_id: f.watch.roomId,
      event_id: '$message',
      sender: f.watch.sender.userId,
      origin_server_ts: Date.now(),
      content
    })

    e.makeEncrypted(EventType.RoomMessageEncrypted, wire, 'curve', 'ed')

    return e
  }

  const edit = { rel_type: 'm.replace', event_id: '$question' }
  const text = { msgtype: 'm.text', body: 'Plan Huế' }

  for (const e of [
    encrypted(EventType.RoomMessage, { ...text, 'm.new_content': text, 'm.relates_to': edit }),
    // An edit whose relation is only outside the ciphertext is still an edit.
    encrypted(EventType.RoomMessage, { ...text, 'm.new_content': text }, { 'm.relates_to': edit }),
    encrypted(EventType.Reaction, { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$answer', key: '👍' } }),
    encrypted(EventType.RoomMessage, { ...text, 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } }),
    // A thread message's reply fallback does not make it a plain reply.
    encrypted(EventType.RoomMessage, {
      ...text,
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root', 'm.in_reply_to': { event_id: '$answer' } }
    }),
    // Nor does a harmless reply outside the ciphertext hide an edit inside it.
    encrypted(
      EventType.RoomMessage,
      { ...text, 'm.new_content': text, 'm.relates_to': edit },
      { 'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } } }
    ),
    // A reply only the clear text names is not the sender's: the server could have added it.
    encrypted(EventType.RoomMessage, text, { 'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } } })
  ]) {
    f.timeline(e)
    f.client.emit(MatrixEventEvent.Decrypted, e)
  }

  const deleted = f.event()
  vi.spyOn(deleted, 'isRedacted').mockReturnValue(true)
  f.timeline(deleted)

  expect(f.offer).not.toHaveBeenCalled()
  // The same room, sender and window still admit a plain new message.
  f.timeline(f.event())
  expect(f.offer).toHaveBeenCalledTimes(1)
  f.listener.stop()
})

it('offers a reply sent from the phone as a new turn, once', () => {
  const f = fixture()
  f.listener.set(f.watch)
  f.client.emit(ClientEvent.Sync, 'SYNCING')

  const reply = f.event({
    msgtype: 'm.text',
    body: 'And tomorrow?',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } }
  } as { msgtype: string; body: string })

  f.timeline(reply)
  f.client.emit(MatrixEventEvent.Decrypted, reply)
  f.timeline(reply)
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: f.watch.id, roomId: f.watch.roomId, eventId: '$message' })
  f.listener.stop()
})

it('never turns a scanned edit or thread message into a recovered turn, reads what was first sent, and recovers a reply', async () => {
  const { client } = scanClient([
    [
      scanEvent('$edit', 2_400, {
        msgtype: 'm.text',
        body: '* changed',
        'm.new_content': { msgtype: 'm.text', body: 'changed' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$plain' }
      }),
      scanEvent('$reply', 2_300, { msgtype: 'm.text', body: 'and?', 'm.relates_to': { 'm.in_reply_to': { event_id: '$plain' } } }),
      scanEvent('$thread', 2_200, { msgtype: 'm.text', body: 'side', 'm.relates_to': { rel_type: 'm.thread', event_id: '$plain' } }),
      scanEvent('$plain', 2_000)
    ]
  ])

  await expect(scanMatrixInvocations(client, automaticWatch())).resolves.toEqual({
    hints: [
      { watchId: 'automatic', roomId: '!room:test', eventId: '$plain' },
      // A pure reply is a new message; main reads what it quotes before the turn runs.
      { watchId: 'automatic', roomId: '!room:test', eventId: '$reply' }
    ],
    complete: true,
    undecryptable: false
  })
})

it('a cloud room-set watch offers new messages and replies from any watched room and names each hint’s own room', () => {
  const f = fixture()
  f.listener.set({ ...f.watch, roomIds: ['!room:test', '!second:test'], sender: { userId: '@owner:test', deviceId: '*' } })
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  f.timeline(f.event(undefined, { room_id: '!second:test', event_id: '$second' }))
  const reply = { msgtype: 'm.text', body: 'and this?', 'm.relates_to': { 'm.in_reply_to': { event_id: '$earlier' } } }
  f.timeline(f.event(reply as { msgtype: string; body: string }, { event_id: '$reply' }))
  const edit = { msgtype: 'm.text', body: '* fixed', 'm.relates_to': { rel_type: 'm.replace', event_id: '$earlier' } }
  f.timeline(f.event(edit as { msgtype: string; body: string }, { event_id: '$edit' }))
  f.timeline(f.event(undefined, { room_id: '!unwatched:test', event_id: '$elsewhere' }))
  expect(f.offer.mock.calls.map(([hint]) => [hint.roomId, hint.eventId])).toEqual([['!second:test', '$second'], ['!room:test', '$reply']])
  f.listener.stop()
})

it('a watch with `threads` (the cloud brain) also offers a thread message, so it can say it does not answer there', () => {
  const f = fixture()
  f.listener.set({ ...f.watch, threads: true })
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  const thread = { msgtype: 'm.text', body: 'side note', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } }
  f.timeline(f.event(thread as { msgtype: string; body: string }, { event_id: '$thread' }))
  // Edits and reactions are still never offered.
  const edit = { msgtype: 'm.text', body: '* fixed', 'm.relates_to': { rel_type: 'm.replace', event_id: '$earlier' } }
  f.timeline(f.event(edit as { msgtype: string; body: string }, { event_id: '$edit' }))
  expect(f.offer.mock.calls.map(([hint]) => hint.eventId)).toEqual(['$thread'])
  f.listener.stop()
})

// 0.20: agent, bot, people and group chats are plain rooms; a message counts as it arrives in
// its room (plain without encryption, encrypted with it), never otherwise.
describe('rooms without end-to-end encryption', () => {
  /** Lets the crypto store's answer (a promise) arrive before the test looks. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
  }

  function plainFixture() {
    const f = fixture()
    let encrypted = false
    // The crypto store's own record of the room (plain-room.ts): as synced unless a test says so.
    const stored: { encrypted?: boolean } = {}
    f.client.getRoom.mockImplementation(() => ({
      getMyMembership: () => 'join',
      hasEncryptionStateEvent: () => encrypted
    }))
    Object.assign(f.client, {
      getCrypto: () => ({ isEncryptionEnabledInRoom: async () => stored.encrypted ?? encrypted })
    })

    const plain = (content = { msgtype: 'm.text', body: 'hello' }, fields = {}) =>
      new MatrixEvent({
        type: EventType.RoomMessage,
        room_id: f.watch.roomId,
        event_id: '$message',
        sender: f.watch.sender.userId,
        origin_server_ts: Date.now(),
        content,
        ...fields
      })

    return {
      ...f,
      plain,
      stored,
      encrypt: () => {
        encrypted = true
      }
    }
  }

  it('offers a live plain message once, without asking to decrypt it', async () => {
    const f = plainFixture()
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    const e = f.plain()
    f.timeline(e)
    f.timeline(e)
    await settle()
    expect(f.offer).toHaveBeenCalledExactlyOnceWith({
      watchId: f.watch.id,
      roomId: f.watch.roomId,
      eventId: '$message'
    })
    expect(f.client.decryptEventIfNeeded).not.toHaveBeenCalled()
    // An edit, a reply only in name, another sender: never.
    f.timeline(
      f.plain({ msgtype: 'm.text', body: '* x', 'm.relates_to': { rel_type: 'm.replace', event_id: '$a' } } as never, {
        event_id: '$edit'
      })
    )
    f.timeline(f.plain(undefined, { event_id: '$other', sender: '@other:test' }))
    await settle()
    expect(f.offer).toHaveBeenCalledTimes(1)
    f.listener.stop()
  })

  it('never offers a ciphertext in a plain room, nor a plaintext once the room turns encryption on', async () => {
    const f = plainFixture()
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.timeline(f.event())
    f.client.emit(MatrixEventEvent.Decrypted, f.event())
    await settle()
    f.encrypt()
    f.timeline(f.plain(undefined, { event_id: '$late' }))
    await settle()
    expect(f.offer).not.toHaveBeenCalled()
    f.listener.stop()
  })

  it('never offers a plaintext where the crypto store knows the room is encrypted, though its state has not synced', async () => {
    const f = plainFixture()
    f.stored.encrypted = true
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.timeline(f.plain())
    await settle()
    expect(f.offer).not.toHaveBeenCalled()
    // The same room's encrypted message is still heard there.
    const e = f.event(undefined, { event_id: '$cipher' })
    f.timeline(e)
    await settle()
    expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: f.watch.id, roomId: f.watch.roomId, eventId: '$cipher' })
    f.listener.stop()
  })

  it('never offers a plaintext message in an encrypted room (no downgrade)', () => {
    const f = fixture()
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    f.timeline(
      new MatrixEvent({
        type: EventType.RoomMessage,
        room_id: f.watch.roomId,
        event_id: '$plain',
        sender: f.watch.sender.userId,
        origin_server_ts: Date.now(),
        content: { msgtype: 'm.text', body: 'hello' }
      })
    )
    expect(f.offer).not.toHaveBeenCalled()
    f.listener.stop()
  })

  function plainScanClient(pages: IRoomEvent[][], encrypted = () => false, stored = false) {
    const { client, createMessagesRequest } = scanClient(pages)
    Object.assign(client, {
      getRoom: () => ({ roomId: '!room:test', getMyMembership: () => 'join', hasEncryptionStateEvent: encrypted }),
      getCrypto: () => ({ isEncryptionEnabledInRoom: async () => stored })
    })

    return { client, createMessagesRequest }
  }

  const plainScanEvent = (eventId: string, timestamp: number) => ({
    ...scanEvent(eventId, timestamp),
    type: EventType.RoomMessage
  })

  it('scans a plain room completely, with plain candidates and no decryption', async () => {
    const { client } = plainScanClient([
      [plainScanEvent('$new', 3_000), scanEvent('$cipher', 2_500), plainScanEvent('$old', 2_000)]
    ])

    await expect(scanMatrixInvocations(client, automaticWatch())).resolves.toEqual({
      hints: [
        { watchId: 'automatic', roomId: '!room:test', eventId: '$old' },
        { watchId: 'automatic', roomId: '!room:test', eventId: '$new' }
      ],
      complete: true,
      undecryptable: false
    })
    expect(client.decryptEventIfNeeded).not.toHaveBeenCalled()
  })

  it('takes no plaintext as a scan candidate where the crypto store knows the room is encrypted', async () => {
    const { client } = plainScanClient([[plainScanEvent('$plain', 3_000), scanEvent('$cipher', 2_000)]], () => false, true)
    await expect(scanMatrixInvocations(client, automaticWatch())).resolves.toMatchObject({
      hints: [{ watchId: 'automatic', roomId: '!room:test', eventId: '$cipher' }]
    })
  })

  it('drops a plain scan whose room turned encryption on meanwhile', async () => {
    let calls = 0
    const { client } = plainScanClient([[plainScanEvent('$new', 3_000)]], () => calls++ > 0)
    await expect(scanMatrixInvocations(client, automaticWatch())).resolves.toEqual({
      hints: [],
      complete: false,
      undecryptable: false
    })
  })

  // A crypto store that does not answer in time (PLAIN_ANSWER_MS) is no answer: the scan fails, so
  // main retries the catch-up with its backoff. Never a ciphertext-only scan that calls a plain
  // room's window complete and empty, never an "incomplete" that stops listening until the owner
  // resumes it.
  it('fails the scan, at its start or its end, while the crypto store has not answered', async () => {
    for (const stall of ['start', 'end'] as const) {
      const { client, createMessagesRequest } = plainScanClient([[plainScanEvent('$new', 3_000)]])
      let asks = 0
      Object.assign(client, {
        getCrypto: () => ({
          isEncryptionEnabledInRoom: () =>
            (stall === 'start' ? asks++ === 0 : asks++ > 0) ? new Promise<boolean>(() => {}) : Promise.resolve(false)
        })
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      try {
        const scan = scanMatrixInvocations(client, automaticWatch())
        scan.catch(() => {})
        await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)
        await expect(scan).rejects.toThrow('matrix_invocation_scan_invalid')
        expect(createMessagesRequest).toHaveBeenCalledTimes(stall === 'start' ? 0 : 1)
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('passes a live plain message on while the crypto store has not answered; main reads it again', async () => {
    const f = plainFixture()
    Object.assign(f.client, { getCrypto: () => ({ isEncryptionEnabledInRoom: () => new Promise<boolean>(() => {}) }) })
    f.listener.set(f.watch)
    f.client.emit(ClientEvent.Sync, 'SYNCING')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      f.timeline(f.plain())
      await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)
    } finally {
      vi.useRealTimers()
    }

    expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: f.watch.id, roomId: f.watch.roomId, eventId: '$message' })
    f.listener.stop()
  })

  it('never takes a plaintext event in an encrypted room as a scan candidate', async () => {
    const { client } = scanClient([[plainScanEvent('$plain', 3_000), scanEvent('$cipher', 2_000)]])
    await expect(scanMatrixInvocations(client, automaticWatch())).resolves.toMatchObject({
      hints: [{ watchId: 'automatic', roomId: '!room:test', eventId: '$cipher' }]
    })
  })
})
