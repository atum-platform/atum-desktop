// @vitest-environment node
import { EventType, type MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { DecryptionFailureCode, EventShieldColour } from 'matrix-js-sdk/lib/crypto-api'
import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_PLAIN_SENDER_DEVICE, type MatrixInvocationMessage } from '../../shared/matrix'
import { MATRIX_FIND_TURN } from '../../shared/matrix-turn'

import { readWorkAnswer, trustedWorkReply } from './work-question'
it('requires exact room, sender, relation and encryption trust', () => {
  const message: MatrixInvocationMessage = {
    roomId: '!dm:test',
    eventId: '$answer',
    sender: '@agent:test',
    wireType: 'm.room.message',
    roomPlain: true,
    senderDevice: MATRIX_PLAIN_SENDER_DEVICE,
    senderVerified: true,
    timestamp: 1,
    related: true,
    content: { msgtype: 'm.text', body: 'answer', replyTo: '$question' }
  }

  const check = (m: MatrixInvocationMessage) => trustedWorkReply(m, '!dm:test', '@agent:test', '$question')
  expect(check(message)).toBe(true)

  for (const patch of [
    { roomId: '!wrong:test' },
    { sender: '@wrong:test' },
    { senderVerified: false },
    { thread: true as const },
    { content: { ...message.content, replyTo: '$other' } },
    { content: { ...message.content, msgtype: 'm.notice' } }
  ]) {
    expect(check({ ...message, ...patch })).toBe(false)
  }

  const encrypted = { ...message, roomPlain: undefined, wireType: 'm.room.encrypted', senderDevice: 'TRUSTED' }
  expect(check(encrypted)).toBe(true)
  expect(check({ ...encrypted, senderVerified: false })).toBe(false)
  expect(check({ ...encrypted, wireType: 'm.room.message' })).toBe(false)
})

afterEach(() => vi.useRealTimers())

const query = { roomId: '!dm:test', agentId: '@agent:test', eventId: '$question', requestId: 'test-request' }

function answer(id: string, part = 1, parts = 1, extra: Record<string, unknown> = {}) {
  return {
    room_id: query.roomId,
    event_id: id,
    type: EventType.RoomMessage,
    sender: query.agentId,
    origin_server_ts: 1,
    content: {
      msgtype: 'm.text',
      body: id.slice(1),
      'm.relates_to': { 'm.in_reply_to': { event_id: query.eventId } },
      'io.atum.work_answer': {
        v: 1,
        state: 'answered',
        request_id: query.requestId,
        data_class: 'non_google',
        part,
        parts
      },
      ...extra
    }
  }
}

function historyFixture(encrypted = false) {
  const live: MatrixEvent[] = []
  const pages = new Map<string | null, { chunk: ReturnType<typeof answer>[]; end?: string }>()
  const events = new Map<string, ReturnType<typeof answer>>()

  const add = (...items: ReturnType<typeof answer>[]) => {
    for (const item of items) {
      events.set(item.event_id, item)
    }
  }

  const getMyMembership = vi.fn(() => 'join')

  const fetchRoomEvent = vi.fn(async (_room: string, id: string) => {
    const event = events.get(id)!

    return encrypted ? { ...event, type: EventType.RoomMessageEncrypted, content: {} } : event
  })

  const decryptEventIfNeeded = vi.fn(async (event: MatrixEvent) => {
    vi.spyOn(event, 'getType').mockReturnValue(EventType.RoomMessage)
    vi.spyOn(event, 'getContent').mockReturnValue(events.get(event.getId()!)!.content)
    vi.spyOn(event, 'getSenderKey').mockReturnValue('curve')
    vi.spyOn(event, 'getClaimedEd25519Key').mockReturnValue('ed')
  })

  const createMessagesRequest = vi.fn(async (_room: string, from: string | null) => pages.get(from) ?? { chunk: [] })

  const client = {
    getRoom: () => ({
      roomId: query.roomId,
      getMyMembership,
      hasEncryptionStateEvent: () => encrypted,
      getLiveTimeline: () => ({ getEvents: () => live })
    }),
    getCrypto: () => ({
      isEncryptionEnabledInRoom: async () => encrypted,
      getUserDeviceInfo: async () =>
        new Map([
          [
            query.agentId,
            new Map([['trusted', { deviceId: 'trusted', getIdentityKey: () => 'curve', getFingerprint: () => 'ed' }]])
          ]
        ]),
      getDeviceVerificationStatus: async () => ({ isVerified: () => true }),
      getEncryptionInfoForEvent: async () => ({ shieldColour: EventShieldColour.NONE, shieldReason: null })
    }),
    createMessagesRequest,
    fetchRoomEvent,
    decryptEventIfNeeded
  } as unknown as MatrixClient

  return { add, client, createMessagesRequest, decryptEventIfNeeded, fetchRoomEvent, live, pages }
}

it('waits for all numbered parts and keeps protection across duplicate sync and edits', async () => {
  const f = historyFixture()
  const first = answer('$first', 1, 2)
  const second = answer('$second', 2, 2, { 'io.atum.provenance': { v: 1, google: true } })

  const edit = answer('$edit', 1, 2, {
    'm.relates_to': { rel_type: 'm.replace', event_id: first.event_id, 'm.in_reply_to': { event_id: query.eventId } }
  })

  const notice = answer('$notice', 1, 2, { msgtype: 'm.notice' })

  const waiting = answer('$waiting', 1, 2, {
    'io.atum.work_answer': { ...first.content['io.atum.work_answer'], state: 'waiting' }
  })

  f.add(first, second, edit, notice, waiting)
  f.live.push(new MatrixEvent(second))
  f.pages.set(null, { chunk: [edit, notice, waiting, second] })
  expect(await readWorkAnswer(f.client, query)).toBeUndefined()
  f.pages.set(null, { chunk: [edit, second, first, first] })
  f.fetchRoomEvent.mockClear()
  expect(await readWorkAnswer(f.client, query)).toEqual({ body: 'first\nsecond', dataClass: 'google' })
  expect(f.fetchRoomEvent.mock.calls.filter(([, id]) => id === second.event_id)).toHaveLength(1)
})

it('retries a missing encrypted session via the native invocation reader', async () => {
  vi.useFakeTimers()
  const f = historyFixture(true)
  const result = answer('$encrypted')
  f.add(result)
  f.live.push(new MatrixEvent({ ...result, type: EventType.RoomMessageEncrypted, content: {} }))
  f.decryptEventIfNeeded.mockImplementationOnce(async event => {
    vi.spyOn(event, 'isDecryptionFailure').mockReturnValue(true)
    vi.spyOn(event, 'decryptionFailureReason', 'get').mockReturnValue(
      DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID
    )
  })
  const pending = readWorkAnswer(f.client, query)
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(pending).resolves.toEqual({ body: 'encrypted', dataClass: 'non_google' })
  expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(2)
})

it('recovers past 100 events after reconnect and bounds the number of history requests', async () => {
  const f = historyFixture()

  const unrelated = Array.from({ length: MATRIX_FIND_TURN.pageSize }, (_, i) => ({
    ...answer(`$other-${i}`),
    sender: '@other:test'
  }))

  for (let page = 0; page < MATRIX_FIND_TURN.pages; page++) {
    f.pages.set(page ? String(page) : null, { chunk: unrelated, end: String(page + 1) })
  }

  f.createMessagesRequest.mockRejectedValueOnce(new Error('offline'))
  expect(await readWorkAnswer(f.client, query)).toBeUndefined()
  expect(await readWorkAnswer(f.client, query)).toBeUndefined()
  expect(f.createMessagesRequest).toHaveBeenCalledTimes(MATRIX_FIND_TURN.pages + 1)

  const result = answer('$caught-up')
  f.add(result)
  f.pages.set('2', { chunk: [result, { ...answer(query.eventId), sender: '@owner:test' }] })
  expect(await readWorkAnswer(f.client, query)).toEqual({ body: 'caught-up', dataClass: 'non_google' })
  expect(f.fetchRoomEvent).toHaveBeenCalledTimes(1)
})
