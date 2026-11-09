import { EventEmitter } from 'node:events'

import { ClientEvent, EventType, type MatrixClient, MatrixEvent, MatrixEventEvent, RoomEvent } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { MATRIX_GROUP_WATCH_ID } from '../../shared/matrix-group-room'

import { watchMatrixGroupTurns } from './group-turns'
import { PLAIN_ANSWER_MS } from './plain-room'

afterEach(() => vi.useRealTimers())

const AGENT = '@agent:test'
const OWNER = '@owner:test'
const LINH = '@linh:test'
const GROUP = '!group:test'
const PLAIN_GROUP = '!plain-group:test'

/** An agent host's SDK as the watch sees it: the agent's own account, a group it is in, a group
 * without encryption (every group since 0.20), its private room with the owner, and an app group. */
function fixture() {
  vi.useFakeTimers()

  const room = (roomId: string, type?: string, direct = false, encrypted = true) => ({
    roomId,
    getMyMembership: (): string => 'join',
    hasEncryptionStateEvent: () => encrypted,
    getType: () => type,
    getInvitedAndJoinedMemberCount: () => (direct ? 2 : 3),
    getDMInviter: () => (direct ? OWNER : undefined),
    getMembers: () => [],
    findEventById: vi.fn((_id: string): { getSender(): string } | undefined => undefined)
  })

  const rooms: Record<string, ReturnType<typeof room>> = {
    [GROUP]: room(GROUP),
    [PLAIN_GROUP]: room(PLAIN_GROUP, undefined, false, false),
    '!private:test': room('!private:test', MATRIX_ASSISTANT_ROOM_TYPE),
    '!app-group:test': room('!app-group:test', 'io.atum.app_group.v1'),
    // A private chat from before private rooms had their type: made direct, just the two.
    '!older-private:test': room('!older-private:test', undefined, true)
  }

  const client = Object.assign(new EventEmitter(), {
    getUserId: () => AGENT,
    getSyncState: vi.fn((): string | null => null),
    decryptEventIfNeeded: vi.fn(async (_event: MatrixEvent) => {}),
    getRoom: vi.fn((id: string) => rooms[id] ?? null),
    getAccountData: () => undefined,
    // The crypto store's own record of each room (plain-room.ts): as synced unless `stored` says.
    getCrypto: () => ({
      isEncryptionEnabledInRoom: async (id: string) => stored[id] ?? rooms[id]?.hasEncryptionStateEvent() ?? true
    })
  })

  const stored: Record<string, boolean> = {}

  const offer = vi.fn()
  const watch = watchMatrixGroupTurns(client as unknown as MatrixClient, offer)
  let sequence = 0

  const event = (content: Record<string, unknown>, fields: Record<string, unknown> = {}, encrypted = true) => {
    sequence += 1

    const e = new MatrixEvent({
      type: EventType.RoomMessage,
      room_id: GROUP,
      event_id: `$m${sequence}`,
      sender: OWNER,
      origin_server_ts: Date.now(),
      content,
      ...fields
    })

    if (encrypted) {
      e.makeEncrypted(EventType.RoomMessageEncrypted, {}, 'curve', 'ed')
    }

    return e
  }

  /** A message as sent in the group without encryption. */
  const plain = (content: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
    event(content, { room_id: PLAIN_GROUP, ...fields }, false)

  const mention = (who = AGENT) => ({ msgtype: 'm.text', body: `@${who} hi`, 'm.mentions': { user_ids: [who] } })

  const timeline = (e: MatrixEvent, data = { liveEvent: true, fromCache: false }) =>
    client.emit(RoomEvent.Timeline, e, undefined, false, false, data)

  const arm = () => {
    watch.set({ owner: OWNER, since: Date.now() - 1_000 })
    client.emit(ClientEvent.Sync, 'SYNCING')
  }

  return { client, rooms, stored, offer, watch, event, plain, mention, timeline, arm }
}

/** Lets the crypto store's answer (a promise) arrive before the test looks. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

it('offers the owner’s @mention in a group without encryption, and never anyone else’s message there', async () => {
  const f = fixture()
  f.arm()

  const own = f.plain(f.mention())
  f.timeline(own)
  // Only its owner can ask it, in a plain group as in an encrypted one.
  f.timeline(f.plain(f.mention(), { sender: LINH }))
  f.timeline(f.plain(f.mention(), { sender: '@other-agent:test' }))
  f.timeline(f.plain(f.mention(), { sender: AGENT }))
  await settle()

  expect(f.offer).toHaveBeenCalledExactlyOnceWith({
    watchId: MATRIX_GROUP_WATCH_ID,
    roomId: PLAIN_GROUP,
    eventId: own.getId()
  })
})

it('never offers a plaintext message in an encrypted group, even the owner’s (no downgrade)', async () => {
  const f = fixture()
  f.arm()

  f.timeline(f.event(f.mention(), {}, false))
  // Nor an encrypted message where the group's messages arrive as sent.
  f.timeline(f.event(f.mention(), { room_id: PLAIN_GROUP }))
  await settle()

  expect(f.offer).not.toHaveBeenCalled()
})

it('never offers a plaintext in a group the crypto store knows is encrypted, though its state has not synced', async () => {
  const f = fixture()
  f.stored[PLAIN_GROUP] = true
  f.arm()

  f.timeline(f.plain(f.mention()))
  await settle()
  expect(f.offer).not.toHaveBeenCalled()

  // Its encrypted messages are heard there.
  const e = f.event(f.mention(), { room_id: PLAIN_GROUP })
  f.timeline(e)
  await settle()
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: MATRIX_GROUP_WATCH_ID, roomId: PLAIN_GROUP, eventId: e.getId() })
})

// A crypto store that does not answer in time passes the hint on rather than drop it (there is no
// scan behind this watch); main reads the message again, which asks the store again.
it('passes the owner’s @mention in a plain group on while the crypto store has not answered', async () => {
  const f = fixture()
  Object.assign(f.client, { getCrypto: () => ({ isEncryptionEnabledInRoom: () => new Promise<boolean>(() => {}) }) })
  f.arm()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const own = f.plain(f.mention())
    f.timeline(own)
    await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)
    expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: MATRIX_GROUP_WATCH_ID, roomId: PLAIN_GROUP, eventId: own.getId() })
  } finally {
    vi.useRealTimers()
  }
})

it('offers the owner’s @mention of this agent in a group, once, and only once armed and synced', () => {
  const f = fixture()
  f.timeline(f.event(f.mention()))
  expect(f.offer).not.toHaveBeenCalled()

  f.arm()
  const e = f.event(f.mention())
  f.timeline(e)
  f.client.emit(MatrixEventEvent.Decrypted, e)
  f.timeline(e)
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: MATRIX_GROUP_WATCH_ID, roomId: GROUP, eventId: e.getId() })

  f.watch.stop()
  f.timeline(f.event(f.mention()))
  expect(f.offer).toHaveBeenCalledOnce()
  expect(f.client.listenerCount(RoomEvent.Timeline)).toBe(0)
})

it('never offers anyone else’s message or anything outside a group, including files and notices', () => {
  const f = fixture()
  f.arm()

  // Another member naming the agent: only its owner can ask it.
  f.timeline(f.event(f.mention(), { sender: LINH }))
  // Another assistant naming it: no agent starts another's turn.
  f.timeline(f.event(f.mention(), { sender: '@other-agent:test' }))
  // The agent's own message.
  f.timeline(f.event(f.mention(), { sender: AGENT }))
  f.timeline(f.event({ msgtype: 'm.notice', body: 'status' }))
  f.timeline(f.event({ msgtype: 'm.file', body: 'file', url: 'mxc://test/file' }))
  // Its private room and an app group have their own paths.
  f.timeline(f.event(f.mention(), { room_id: '!private:test' }))
  f.timeline(f.event(f.mention(), { room_id: '!app-group:test' }))
  f.timeline(f.event(f.mention(), { room_id: '!older-private:test' }))
  // History, a cached page, an edit and a thread.
  f.timeline(f.event(f.mention()), { liveEvent: false, fromCache: false })
  f.timeline(f.event(f.mention()), { liveEvent: true, fromCache: true })
  f.timeline(f.event({ ...f.mention(), 'm.relates_to': { rel_type: 'm.replace', event_id: '$x' } }))
  f.timeline(f.event({ ...f.mention(), 'm.relates_to': { rel_type: 'm.thread', event_id: '$x' } }))
  // Sent before the watch began.
  f.timeline(f.event(f.mention(), { origin_server_ts: Date.now() - 5_000 }))

  expect(f.offer).not.toHaveBeenCalled()
})

it('offers owner replies as hints; native authority chooses their participation', () => {
  const f = fixture()
  f.arm()
  f.rooms[GROUP]!.findEventById.mockImplementation(id => ({ getSender: () => (id === '$answer' ? AGENT : LINH) }))

  const reply = (to: string, extra: Record<string, unknown> = {}) =>
    f.event({
      msgtype: 'm.text',
      body: 'and tomorrow?',
      'm.relates_to': { 'm.in_reply_to': { event_id: to } },
      ...extra
    })

  const own = reply('$answer')
  f.timeline(own)
  const theirs = reply('$theirs')
  f.timeline(theirs)
  // Answering someone else's message while naming the agent asks the agent about it.
  const named = reply('$theirs', { 'm.mentions': { user_ids: [AGENT] } })
  f.timeline(named)

  expect(f.offer.mock.calls.map(([hint]) => hint.eventId)).toEqual([own.getId(), theirs.getId(), named.getId()])
})

it('offers fresh plain owner text and text naming others without granting a turn', () => {
  const f = fixture()
  f.arm()
  const plain = f.event({ msgtype: 'm.text', body: 'hello all' })
  const named = f.event(f.mention(LINH))
  f.timeline(plain)
  f.timeline(named)
  expect(f.offer.mock.calls.map(([hint]) => hint.eventId)).toEqual([plain.getId(), named.getId()])
})

it('offers a reply to a message this host hasn’t loaded: main reads it and decides', () => {
  const f = fixture()
  f.arm()
  const e = f.event({ msgtype: 'm.text', body: 'this?', 'm.relates_to': { 'm.in_reply_to': { event_id: '$old' } } })
  f.timeline(e)
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: MATRIX_GROUP_WATCH_ID, roomId: GROUP, eventId: e.getId() })
})


it('offers only a named own-assistant stamped continuation as a hint, never content authority', () => {
  const f = fixture(), other = '@other-agent:test'
  f.watch.set({ owner: OWNER, since: Date.now() - 1_000, agentIds: [AGENT, other] })
  f.client.emit(ClientEvent.Sync, 'SYNCING')
  const chain = { origin: '$owner', parent: '$request', depth: 1 }
  f.timeline(f.event(f.mention(), { sender: other }))
  f.timeline(f.event({ ...f.mention(), 'io.atum.chain': { ...chain, depth: 4 } }, { sender: other }))
  f.timeline(f.event({ ...f.mention(), 'io.atum.chain': chain }, { sender: LINH }))
  f.timeline(f.event({ ...f.mention(), 'io.atum.chain': chain }, { sender: AGENT }))
  expect(f.offer).not.toHaveBeenCalled()
  const event = f.event({ ...f.mention(), 'io.atum.chain': chain }, { sender: other })
  f.timeline(event)
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: MATRIX_GROUP_WATCH_ID, roomId: GROUP, eventId: event.getId() })
})

it('refreshes the own-assistant roster without reopening history or offering existing hints twice', () => {
  const f = fixture(), other = '@new-agent:test'
  const since = Date.now() - 1_000
  f.client.getSyncState.mockReturnValue('SYNCING')
  f.watch.set({ owner: OWNER, since, agentIds: [AGENT] })
  const ownerEvent = f.event(f.mention())
  f.timeline(ownerEvent)

  f.watch.set({ owner: OWNER, since, agentIds: [AGENT, other] })
  f.timeline(ownerEvent)
  f.client.emit(MatrixEventEvent.Decrypted, ownerEvent)
  const content = { ...f.mention(), 'io.atum.chain': { origin: '$owner', parent: '$request', depth: 1 } }
  f.timeline(f.event(content, { sender: other, origin_server_ts: since - 1 }))
  f.timeline(f.event(content, { sender: LINH }))
  const continuation = f.event(content, { sender: other })
  f.timeline(continuation)
  expect(f.offer.mock.calls.map(([hint]) => hint.eventId)).toEqual([ownerEvent.getId(), continuation.getId()])
})

it('preserves pending decryption on a roster refresh but retires it when a new live window starts', () => {
  const f = fixture(), other = '@new-agent:test'
  const since = Date.now() - 1_000
  f.client.getSyncState.mockReturnValue('SYNCING')
  f.watch.set({ owner: OWNER, since, agentIds: [AGENT] })
  const pending = f.event(f.mention())
  const failed = vi.spyOn(pending, 'isDecryptionFailure').mockReturnValue(true)
  f.timeline(pending)
  f.watch.set({ owner: OWNER, since, agentIds: [AGENT, other] })
  failed.mockReturnValue(false)
  f.client.emit(MatrixEventEvent.Decrypted, pending)
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: MATRIX_GROUP_WATCH_ID, roomId: GROUP, eventId: pending.getId() })

  const retired = f.event(f.mention())
  const retiredFailure = vi.spyOn(retired, 'isDecryptionFailure').mockReturnValue(true)
  f.timeline(retired)
  f.watch.set({ owner: OWNER, since: Date.now() })
  retiredFailure.mockReturnValue(false)
  f.client.emit(MatrixEventEvent.Decrypted, retired)
  expect(f.offer).toHaveBeenCalledOnce()
})

it('keeps hearing the owner through a reconnecting sync, including the first response after it (R4)', async () => {
  const f = fixture()
  f.arm()
  f.client.emit(ClientEvent.Sync, 'RECONNECTING', 'SYNCING', { error: new Error('network') })
  f.client.emit(ClientEvent.Sync, 'CATCHUP', 'RECONNECTING', { catchingUp: true })

  // The response that brings the missed message is applied while the state is still CATCHUP.
  const e = f.event(f.mention())
  f.timeline(e)
  await settle()

  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ watchId: MATRIX_GROUP_WATCH_ID, roomId: GROUP, eventId: e.getId() })
})

it('hears nothing once the client stopped', async () => {
  const f = fixture()
  f.arm()
  f.client.emit(ClientEvent.Sync, 'STOPPED', 'SYNCING')
  f.timeline(f.event(f.mention()))
  await settle()

  expect(f.offer).not.toHaveBeenCalled()
})
