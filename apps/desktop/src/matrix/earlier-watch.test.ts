import { ClientEvent, createClient, EventType, MatrixEvent, MatrixEventEvent, Room, RoomEvent } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { watchEarlierConversations } from './earlier-watch'
import { PLAIN_ANSWER_MS } from './plain-room'

/** An earlier assistant room the agent is in: encrypted (made before 0.20), or plain (0.20).
 * `stored` is the crypto store's own record of the room (plain-room.ts). */
function fixture(options: { plain?: boolean; stored?: boolean } = {}) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!old:test', client, '@agent:test')
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: room.roomId,
      sender: '@owner:test',
      content: { type: MATRIX_ASSISTANT_ROOM_TYPE }
    }),
    ...(options.plain
      ? []
      : [
          new MatrixEvent({
            type: EventType.RoomEncryption,
            state_key: '',
            room_id: room.roomId,
            sender: '@owner:test',
            content: { algorithm: 'm.megolm.v1.aes-sha2' }
          })
        ])
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  vi.spyOn(client, 'getCrypto').mockReturnValue({
    isEncryptionEnabledInRoom: async () => options.stored ?? !options.plain
  } as unknown as ReturnType<typeof client.getCrypto>)
  const decrypt = vi.spyOn(client, 'decryptEventIfNeeded').mockResolvedValue()
  const offer = vi.fn()
  const watcher = watchEarlierConversations(client, offer)
  const since = Date.now() - 1_000
  watcher.set({ owner: '@owner:test', since })
  client.emit(ClientEvent.Sync, 'SYNCING' as never, null)

  const event = (changes: Record<string, unknown> = {}, encrypted = !options.plain) => {
    const value = new MatrixEvent({
      type: EventType.RoomMessage,
      sender: '@owner:test',
      room_id: room.roomId,
      event_id: '$owner',
      origin_server_ts: Date.now(),
      content: { msgtype: 'm.text', body: 'Synthetic text' },
      ...changes
    })

    if (encrypted) {
      value.makeEncrypted(EventType.RoomMessageEncrypted, {}, 'synthetic-curve', 'synthetic-ed')
    }
    return value
  }
  const timeline = (value: MatrixEvent, data = { liveEvent: true, fromCache: false }) => {
    client.emit(RoomEvent.Timeline, value, room, false, false, { ...data, timeline: room.getLiveTimeline() })
  }
  return { client, room, offer, watcher, event, timeline, decrypt }
}

it('offers only identifier hints for a live owner message once and stops cleanly', async () => {
  const f = fixture()
  const event = f.event()
  f.timeline(event)
  f.client.emit(MatrixEventEvent.Decrypted, event)
  f.timeline(event)
  await Promise.resolve()
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: 'earlier', roomId: f.room.roomId, eventId: '$owner' })
  expect(f.decrypt).toHaveBeenCalledWith(event)
  f.watcher.stop()
  f.timeline(f.event())
  expect(f.offer).toHaveBeenCalledTimes(1)
  expect(f.client.listenerCount(RoomEvent.Timeline)).toBe(0)
})

it('excludes history, other senders, edits, decryption waits, and ordinary groups', async () => {
  const f = fixture()
  f.timeline(f.event(), { liveEvent: false, fromCache: false })
  f.timeline(f.event(), { liveEvent: true, fromCache: true })
  f.timeline(f.event({ sender: '@someone:test' }))
  f.timeline(
    f.event({
      content: { msgtype: 'm.text', body: 'edit', 'm.relates_to': { rel_type: 'm.replace', event_id: '$other' } }
    })
  )
  const failed = f.event()
  vi.spyOn(failed, 'isDecryptionFailure').mockReturnValue(true)
  f.timeline(failed)
  const group = new Room('!group:test', f.client, '@agent:test')
  f.client.store.storeRoom(group)
  f.timeline(f.event({ room_id: group.roomId }))
  await Promise.resolve()
  expect(f.offer).not.toHaveBeenCalled()
  f.watcher.stop()
})

/** Lets the crypto store's answer (a promise) arrive before the test looks. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

// 0.20 agent chats are plain: the owner writing in an earlier plain chat still gets the
// closed-room notice, so the watch hears their message there as sent.
it('hears the owner’s plain message in an earlier plain assistant room, once', async () => {
  const f = fixture({ plain: true })
  const event = f.event()
  f.timeline(event)
  f.timeline(event)
  await settle()
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: 'earlier', roomId: f.room.roomId, eventId: '$owner' })
  f.watcher.stop()
})

it('never hears a plaintext in an encrypted room, nor where the crypto store knows the room is encrypted', async () => {
  const encrypted = fixture()
  encrypted.timeline(encrypted.event({}, false))
  await settle()
  expect(encrypted.offer).not.toHaveBeenCalled()
  encrypted.watcher.stop()

  // No encryption state synced yet, but the crypto store says encrypted: no downgrade.
  const unsynced = fixture({ plain: true, stored: true })
  unsynced.timeline(unsynced.event())
  await settle()
  expect(unsynced.offer).not.toHaveBeenCalled()
  // Its encrypted messages are still heard.
  unsynced.timeline(unsynced.event({ event_id: '$cipher' }, true))
  await settle()
  expect(unsynced.offer).toHaveBeenCalledExactlyOnceWith({ watchId: 'earlier', roomId: unsynced.room.roomId, eventId: '$cipher' })
  unsynced.watcher.stop()
})

// A crypto store that does not answer in time passes the hint on; main reads the message again.
it('passes the owner’s plain message on while the crypto store has not answered', async () => {
  const f = fixture({ plain: true })
  vi.mocked(f.client.getCrypto).mockReturnValue({
    isEncryptionEnabledInRoom: () => new Promise<boolean>(() => {})
  } as unknown as ReturnType<typeof f.client.getCrypto>)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    f.timeline(f.event())
    await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)
    expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: 'earlier', roomId: f.room.roomId, eventId: '$owner' })
  } finally {
    vi.useRealTimers()
    f.watcher.stop()
  }
})

it('never hears an encrypted message where the room is plain by both its state and the crypto store', async () => {
  const f = fixture({ plain: true })
  f.timeline(f.event({}, true))
  await settle()
  expect(f.offer).not.toHaveBeenCalled()
  f.watcher.stop()
})

it('keeps hearing the owner through a reconnecting sync, including the first response after it (R4)', async () => {
  const f = fixture()
  f.client.emit(ClientEvent.Sync, 'RECONNECTING' as never, 'SYNCING' as never, { error: new Error('network') } as never)
  f.client.emit(ClientEvent.Sync, 'CATCHUP' as never, 'RECONNECTING' as never, { catchingUp: true } as never)
  // The response that brings the missed message is applied while the state is still CATCHUP.
  const event = f.event()
  f.timeline(event)
  f.client.emit(MatrixEventEvent.Decrypted, event)
  await Promise.resolve()
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: 'earlier', roomId: f.room.roomId, eventId: '$owner' })
  f.watcher.stop()
})

it('hears nothing once the client stopped, until a sync is back', async () => {
  const f = fixture()
  f.client.emit(ClientEvent.Sync, 'STOPPED' as never, 'SYNCING' as never)
  const event = f.event()
  f.timeline(event)
  f.client.emit(MatrixEventEvent.Decrypted, event)
  await Promise.resolve()
  expect(f.offer).not.toHaveBeenCalled()
  f.watcher.stop()
})
