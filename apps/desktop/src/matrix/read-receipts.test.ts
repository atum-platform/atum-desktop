import {
  ClientEvent,
  createClient,
  EventStatus,
  EventType,
  type MatrixClient,
  MatrixEvent,
  Room,
  RoomEvent,
  SyncState
} from 'matrix-js-sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'

import { latestSettledEvent, matrixReadReceipts, READ_MAX_WAIT_MS, READ_RETRY_MS, READ_SETTLE_MS } from './read-receipts'

const alice = '@alice:test'
const bob = '@bob:test'
const stops: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop()
  }

  vi.useRealTimers()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

function joinedRoom(client: MatrixClient, id: string, encrypted: boolean) {
  const room = new Room(id, client, alice)
  room.currentState.setStateEvents([
    ...(encrypted
      ? [
          new MatrixEvent({
            type: EventType.RoomEncryption,
            state_key: '',
            room_id: id,
            sender: alice,
            content: { algorithm: 'm.megolm.v1.aes-sha2' }
          })
        ]
      : []),
    ...[alice, bob].map(
      userId =>
        new MatrixEvent({
          type: EventType.RoomMember,
          state_key: userId,
          room_id: id,
          sender: userId,
          content: { membership: 'join' }
        })
    )
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)

  return room
}

/** The actual SDK client and Room models; only the read-markers HTTP request is replaced. */
function fixture({ encrypted = true }: { encrypted?: boolean } = {}) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: alice, deviceId: 'DEVICE' })
  const room = joinedRoom(client, '!room:test', encrypted)
  const other = joinedRoom(client, '!other:test', encrypted)
  const write = vi.spyOn(client, 'setRoomReadMarkersHttpRequest').mockResolvedValue({})
  let selected: string | null = room.roomId
  let ready = true
  let shareActivity = true
  const receipts = matrixReadReceipts(client, {
    selected: () => selected,
    ready: () => ready,
    shareActivity: () => shareActivity
  })
  stops.push(receipts.stop)

  /** What sync does for a new event at the live end: add it, then tell listeners. */
  const arrive = async (
    target: Room,
    id: string,
    { sender = bob, type = EventType.RoomMessage as string }: { sender?: string; type?: string } = {}
  ) => {
    const event = new MatrixEvent({
      event_id: id,
      room_id: target.roomId,
      type,
      sender,
      origin_server_ts: Date.now(),
      content: type === EventType.RoomMessage ? { msgtype: 'm.text', body: id } : { algorithm: 'm.megolm.v1.aes-sha2' }
    })

    await target.addLiveEvents([event], { addToState: false })
    client.emit(RoomEvent.Timeline, event, target, false, false, { liveEvent: true, timeline: target.getLiveTimeline() })

    return event
  }

  const ownReceipt = (target: Room, eventId: string, type = 'm.read.private') => {
    const event = new MatrixEvent({
      type: EventType.Receipt,
      content: { [eventId]: { [type]: { [alice]: { ts: Date.now() } } } }
    })

    target.addReceipt(event)
    client.emit(RoomEvent.Receipt, event, target)
  }

  return {
    client,
    room,
    other,
    write,
    receipts,
    arrive,
    ownReceipt,
    select: (id: string | null) => (selected = id),
    setReady: (value: boolean) => (ready = value),
    setShareActivity: (value: boolean) => (shareActivity = value)
  }
}

const settle = () => vi.advanceTimersByTimeAsync(READ_SETTLE_MS)

it('acknowledges the newest event of the conversation on screen once, with a public receipt and the read marker', async () => {
  const f = fixture()
  await f.arrive(f.room, '$first')
  await f.arrive(f.room, '$last')

  f.receipts.attend(f.room.roomId)
  expect(f.write).not.toHaveBeenCalled()
  await settle()
  // The public receipt (m.read) names the newest event: other people can see it.
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$last', '$last', undefined)

  // Saying the same thing again, or more time passing, sends nothing new.
  f.receipts.attend(f.room.roomId)
  await vi.advanceTimersByTimeAsync(READ_MAX_WAIT_MS * 3)
  expect(f.write).toHaveBeenCalledOnce()
})

it('acknowledges a legacy thread reply shown in an ordinary room, but leaves Team Space receipts per-thread', async () => {
  const f = fixture({ encrypted: false })
  await f.arrive(f.room, '$root')
  const legacy = new MatrixEvent({
    event_id: '$legacy-reply',
    room_id: f.room.roomId,
    type: EventType.RoomMessage,
    sender: bob,
    origin_server_ts: Date.now() + 1,
    content: {
      msgtype: 'm.text',
      body: 'legacy reply',
      'io.atum.result': { invocation: 'old', transaction: 'old' },
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' }
    }
  })
  const getThreads = vi.spyOn(f.room, 'getThreads').mockReturnValue([{ events: [legacy] }] as never)

  expect(latestSettledEvent(f.room)?.getId()).toBe('$legacy-reply')
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$legacy-reply', '$legacy-reply', undefined)

  getThreads.mockClear()
  vi.spyOn(f.room, 'getType').mockReturnValue(MATRIX_COMPANY_CHANNEL_TYPE)
  expect(latestSettledEvent(f.room)?.getId()).toBe('$root')
  expect(getThreads).not.toHaveBeenCalled()
})

it('acknowledges a standard thread reply flattened into an ordinary room, so its unread count clears', async () => {
  const f = fixture({ encrypted: false })
  await f.arrive(f.room, '$root')
  const reply = new MatrixEvent({
    event_id: '$thread-reply',
    room_id: f.room.roomId,
    type: EventType.RoomMessage,
    sender: bob,
    origin_server_ts: Date.now() + 1,
    content: { msgtype: 'm.text', body: 'from Element', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } }
  })
  vi.spyOn(f.room, 'getThreads').mockReturnValue([{ events: [reply] }] as never)

  expect(latestSettledEvent(f.room)?.getId()).toBe('$thread-reply')
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$thread-reply', '$thread-reply', undefined)

  vi.spyOn(f.room, 'getType').mockReturnValue(MATRIX_COMPANY_CHANNEL_TYPE)
  expect(latestSettledEvent(f.room)?.getId()).toBe('$root')
})

it('keeps the receipt private when the person turns shared activity off', async () => {
  const f = fixture()
  f.setShareActivity(false)
  await f.arrive(f.room, '$last')

  f.receipts.attend(f.room.roomId)
  await settle()
  // `m.read` stays unset and `m.read.private` names the event: badges still clear here,
  // nobody else learns when the person read.
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$last', undefined, '$last')

  // Turning it back on sends the public receipt for what comes next.
  f.setShareActivity(true)
  await f.arrive(f.room, '$next')
  await settle()
  expect(f.write).toHaveBeenLastCalledWith(f.room.roomId, '$next', '$next', undefined)
})

it('acknowledges each new message while the conversation stays on screen, a burst as one receipt', async () => {
  const f = fixture()
  await f.arrive(f.room, '$first')
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenLastCalledWith(f.room.roomId, '$first', '$first', undefined)

  await f.arrive(f.room, '$a')
  await vi.advanceTimersByTimeAsync(100)
  await f.arrive(f.room, '$b')
  await vi.advanceTimersByTimeAsync(100)
  await f.arrive(f.room, '$c')
  await settle()
  expect(f.write).toHaveBeenCalledTimes(2)
  expect(f.write).toHaveBeenLastCalledWith(f.room.roomId, '$c', '$c', undefined)

  // An endless stream (a reply growing by edits) is still acknowledged at least this often.
  for (let index = 0; index < 30; index++) {
    await f.arrive(f.room, `$edit${index}`)
    await vi.advanceTimersByTimeAsync(100)
  }

  expect(f.write.mock.calls.length).toBeGreaterThanOrEqual(3)
  await settle()
  expect(f.write).toHaveBeenLastCalledWith(f.room.roomId, '$edit29', '$edit29', undefined)
})

it('never acknowledges while nothing is on screen, another room is, or the window is in the background', async () => {
  const f = fixture()
  await f.arrive(f.room, '$first')
  await settle()
  expect(f.write).not.toHaveBeenCalled()

  // On screen, then the window loses focus before the receipt settles.
  f.receipts.attend(f.room.roomId)
  f.receipts.attend(null)
  await settle()
  await f.arrive(f.room, '$while-away')
  await vi.advanceTimersByTimeAsync(READ_MAX_WAIT_MS)
  expect(f.write).not.toHaveBeenCalled()

  // The renderer attends a room the SDK has not selected: neither side is sure, so nothing.
  f.receipts.attend(f.other.roomId)
  await f.arrive(f.other, '$elsewhere')
  await vi.advanceTimersByTimeAsync(READ_MAX_WAIT_MS)
  expect(f.write).not.toHaveBeenCalled()

  // Both agree: what arrived while away is acknowledged now.
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$while-away', '$while-away', undefined)
})

it('acknowledges the newest event again when it changes while a receipt is in flight', async () => {
  const f = fixture()
  const pending = deferred<{}>()
  f.write.mockReturnValueOnce(pending.promise)
  await f.arrive(f.room, '$question')
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$question', '$question', undefined)

  // The agent's reply streams in while the first receipt is still in flight: one request at a time.
  await f.arrive(f.room, '$reply', { sender: '@agent:test' })
  await vi.advanceTimersByTimeAsync(READ_MAX_WAIT_MS)
  expect(f.write).toHaveBeenCalledOnce()

  pending.resolve({})
  await settle()
  expect(f.write).toHaveBeenCalledTimes(2)
  expect(f.write).toHaveBeenLastCalledWith(f.room.roomId, '$reply', '$reply', undefined)
})

it('retries a failed receipt a few times, then waits for the next change', async () => {
  const f = fixture()
  f.write.mockRejectedValue(new Error('offline'))
  await f.arrive(f.room, '$last')
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenCalledTimes(1)

  for (const [index, delay] of READ_RETRY_MS.entries()) {
    await vi.advanceTimersByTimeAsync(delay)
    expect(f.write).toHaveBeenCalledTimes(index + 2)
  }

  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(f.write).toHaveBeenCalledTimes(READ_RETRY_MS.length + 1)

  // Coming back to the conversation tries again, and success ends the retries.
  f.write.mockResolvedValue({})
  f.receipts.attend(null)
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenCalledTimes(READ_RETRY_MS.length + 2)
  expect(f.write).toHaveBeenLastCalledWith(f.room.roomId, '$last', '$last', undefined)
})

it('acknowledges past messages it cannot decrypt, and in unencrypted conversations too', async () => {
  const f = fixture()
  await f.arrive(f.room, '$readable')
  const locked = await f.arrive(f.room, '$locked', { type: EventType.RoomMessageEncrypted })
  vi.spyOn(locked, 'isDecryptionFailure').mockReturnValue(true)
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$locked', '$locked', undefined)

  const plain = fixture({ encrypted: false })
  await plain.arrive(plain.room, '$plain')
  plain.receipts.attend(plain.room.roomId)
  await settle()
  expect(plain.write).toHaveBeenCalledExactlyOnceWith(plain.room.roomId, '$plain', '$plain', undefined)
})

it('sends nothing when its own receipt already covers the newest event, here or from another device', async () => {
  const f = fixture()
  await f.arrive(f.room, '$first')
  await f.arrive(f.room, '$last')
  f.ownReceipt(f.room, '$last')
  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).not.toHaveBeenCalled()

  // An older receipt does not cover the newest event; a public one counts as much as a private one.
  await f.arrive(f.room, '$newer')
  f.ownReceipt(f.room, '$newer', 'm.read')
  await f.arrive(f.room, '$newest')
  await settle()
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$newest', '$newest', undefined)
})

it('waits for a sent message to have its server id before acknowledging it', async () => {
  const f = fixture()
  await f.arrive(f.room, '$before')

  const echo = new MatrixEvent({
    event_id: '~local-1',
    room_id: f.room.roomId,
    type: EventType.RoomMessage,
    sender: alice,
    content: { msgtype: 'm.text', body: 'mine' }
  })

  echo.setStatus(EventStatus.SENDING)
  await f.room.addLiveEvents([echo], { addToState: false })
  expect(latestSettledEvent(f.room)?.getId()).toBe('$before')

  f.receipts.attend(f.room.roomId)
  await settle()
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$before', '$before', undefined)

  echo.setStatus(null)
  echo.setUnsigned({})
  vi.spyOn(echo, 'getId').mockReturnValue('$mine')
  f.client.emit(RoomEvent.LocalEchoUpdated, echo, f.room, '~local-1', EventStatus.SENDING)
  await settle()
  expect(f.write).toHaveBeenLastCalledWith(f.room.roomId, '$mine', '$mine', undefined)
})

it('holds receipts while offline and sends what is on screen once sync is back', async () => {
  const f = fixture()
  f.setReady(false)
  await f.arrive(f.room, '$queued')
  f.receipts.attend(f.room.roomId)
  await vi.advanceTimersByTimeAsync(READ_MAX_WAIT_MS)
  expect(f.write).not.toHaveBeenCalled()

  f.setReady(true)
  f.client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Error)
  await settle()
  expect(f.write).toHaveBeenCalledExactlyOnceWith(f.room.roomId, '$queued', '$queued', undefined)
})

it('stops for good: a stopped session neither sends nor listens', async () => {
  const f = fixture()
  await f.arrive(f.room, '$last')
  f.receipts.attend(f.room.roomId)
  f.receipts.stop()
  await f.arrive(f.room, '$after')
  f.receipts.attend(null)
  f.receipts.attend(f.room.roomId)
  await vi.advanceTimersByTimeAsync(READ_MAX_WAIT_MS * 2)
  expect(f.write).not.toHaveBeenCalled()
  expect(f.client.listenerCount(RoomEvent.Timeline)).toBe(0)

  // Leaving a selected room ends it there too.
  const g = fixture()
  await g.arrive(g.room, '$gone')
  g.room.updateMyMembership('leave')
  g.receipts.attend(g.room.roomId)
  await settle()
  expect(g.write).not.toHaveBeenCalled()
  g.select(null)
})
