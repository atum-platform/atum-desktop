import {
  createClient,
  Direction,
  EventStatus,
  EventType,
  type IRoomEvent,
  type MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
  Room
} from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { requestDigestV2 } from '../../../../packages/device-protocol/hashes'
import type { MatrixOriginAssertion } from '../../shared/matrix'
import { MATRIX_FIND_TURN, matrixCronRunId, matrixTurnContent } from '../../shared/matrix-turn'

import { findMatrixTurn, prepareMatrixCron, publishMatrixCron, sendMatrixTurn } from './turn'

const turnId = '00000000-0000-4000-8000-31f949766961'
const transactionId = `atum-q-${turnId}`

/** The agent's chat made the 0.20 way: the assistant room type, no encryption state. */
function plainAgentRoom(client: MatrixClient) {
  const room = new Room('!assistant:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: room.roomId,
      event_id: '$create',
      sender: '@owner:test',
      content: { type: 'io.atum.assistant' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)

  return room
}

/** A room this client holds with no room type and no encryption state (a people chat, or an
 * older chat of two), and the crypto store's record of it: plain, encrypted, or no answer. */
function untypedRoom(client: MatrixClient, store: boolean | Error = false) {
  const room = new Room('!plain:test', client, client.getSafeUserId())
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  vi.spyOn(client, 'getCrypto').mockReturnValue({
    isEncryptionEnabledInRoom: async () => {
      if (store instanceof Error) {
        throw store
      }

      return store
    }
  } as unknown as ReturnType<MatrixClient['getCrypto']>)

  return room
}

function encryptedRoom(client: MatrixClient) {
  const room = new Room('!assistant:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: room.roomId,
      event_id: '$encryption',
      sender: '@owner:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)

  return room
}

afterEach(() => {
  vi.useRealTimers()
})

it('sends the question with the turn marker under the fixed transaction ID', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$question' })

  const id = await sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'Hi', turnId, transactionId })

  expect(id).toBe('$question')
  expect(send).toHaveBeenCalledWith(
    room.roomId,
    EventType.RoomMessage,
    { msgtype: 'm.text', body: 'Hi', 'io.atum.turn': turnId },
    transactionId
  )
  await expect(
    sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'Hi', turnId, transactionId: 'other' })
  ).rejects.toThrow('matrix_command_invalid')
})

it('reuses the same transaction ID on a resend, across a token refresh and a restart', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = encryptedRoom(client)
  const failed = new MatrixEvent({ type: EventType.RoomMessage, room_id: room.roomId, content: {} })
  failed.setTxnId(transactionId)
  failed.setStatus(EventStatus.NOT_SENT)
  vi.spyOn(client, 'sendEvent').mockRejectedValueOnce(new Error('network'))
  await expect(
    sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'Hi', turnId, transactionId })
  ).rejects.toThrow()

  // The SDK keeps the failed local echo: the retry resends that very event.
  vi.spyOn(room, 'getEventForTxnId').mockImplementation(txn => (txn === transactionId ? failed : undefined))
  const resend = vi.spyOn(client, 'resendEvent').mockResolvedValue({ event_id: '$question' })
  expect(
    await sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'Hi', turnId, transactionId })
  ).toBe('$question')
  expect(resend).toHaveBeenCalledWith(failed, room)
  expect(failed.getTxnId()).toBe(transactionId)

  // A refreshed session or a restart has no local echo: a fresh send, same transaction ID.
  const refreshed = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test', accessToken: 'new' })
  const again = encryptedRoom(refreshed)
  const send = vi.spyOn(refreshed, 'sendEvent').mockResolvedValue({ event_id: '$question' })
  await sendMatrixTurn(refreshed, { kind: 'sendTurn', roomId: again.roomId, body: 'Hi', turnId, transactionId })
  expect(send.mock.calls[0]?.[3]).toBe(transactionId)
})

it('waits for an attempt already in flight instead of sending a second event', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = encryptedRoom(client)
  const pending = new MatrixEvent({ type: EventType.RoomMessage, room_id: room.roomId, content: {} })
  pending.setStatus(EventStatus.SENDING)
  vi.spyOn(room, 'getEventForTxnId').mockReturnValue(pending)
  const send = vi.spyOn(client, 'sendEvent')

  const result = sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'Hi', turnId, transactionId })
  pending.event.event_id = '$question'
  pending.setStatus(EventStatus.SENT)
  pending.emit(MatrixEventEvent.Status, pending, EventStatus.SENT)

  expect(await result).toBe('$question')
  expect(send).not.toHaveBeenCalled()
})

/** An origin assertion main signed over `content` (its fields only matter here, not the signature). */
function originFor(content: Record<string, unknown>, roomId: string): MatrixOriginAssertion {
  return {
    v: 1,
    dsid: '00000000-0000-4000-8000-b86a6ca39e23',
    kid: 'rffnGV1sIeV_YF241ah2Rtdt62T-8NUOYu99JYRAF1Y',
    ee: 3,
    ae: 7,
    boot: '00000000-0000-4000-8000-354570CD5E97',
    n: 'W_YlvsBfdmBcLLPLPUrIgA',
    t: 1791100798500,
    owner: '@owner:test',
    agent: '@agent:test',
    room: roomId,
    dev: 'MACBOOKQ7ZK',
    fpr: 'aI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho',
    dg: requestDigestV2(content),
    sig: 'A'.repeat(86)
  }
}

it("carries this Mac's origin assertion when it covers exactly the content it sends", async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$question' })
  const content = matrixTurnContent({ body: 'Make hello.txt', turnId, handoff: true })
  const origin = originFor(content, room.roomId)

  await sendMatrixTurn(client, {
    kind: 'sendTurn',
    roomId: room.roomId,
    body: 'Make hello.txt',
    turnId,
    transactionId,
    handoff: true,
    cloud: true,
    origin
  })

  const sent = send.mock.calls[0]![2] as unknown as Record<string, unknown>
  expect(sent).toEqual({
    msgtype: 'm.text',
    body: 'Make hello.txt',
    'io.atum.handoff': turnId,
    'io.atum.origin': origin
  })
  // The digest the controller recomputes from what was sent is the assertion's.
  expect(requestDigestV2(sent)).toBe(origin.dg)
  expect(send.mock.calls[0]![3]).toBe(transactionId)
})

it("signs a cloud question's reply relation too: the cloud reads the quote, and the digest covers it", async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$question' })
  const content = matrixTurnContent({ body: 'And the mini?', turnId, handoff: true, replyTo: '$earlier' })
  const origin = originFor(content, room.roomId)

  const command = {
    kind: 'sendTurn' as const,
    roomId: room.roomId,
    body: 'And the mini?',
    turnId,
    transactionId,
    handoff: true as const,
    cloud: true as const
  }

  // Dropping the relation is a different message: refused, never sent bare.
  await expect(sendMatrixTurn(client, { ...command, origin })).rejects.toThrow('matrix_origin_mismatch')

  await sendMatrixTurn(client, { ...command, replyTo: '$earlier', origin })
  const sent = send.mock.calls[0]![2] as unknown as Record<string, unknown>
  expect(sent).toMatchObject({
    'io.atum.handoff': turnId,
    'm.relates_to': { 'm.in_reply_to': { event_id: '$earlier' } },
    'io.atum.origin': origin
  })
  expect(requestDigestV2(sent)).toBe(origin.dg)
})

it('refuses to send a question whose origin assertion covers other words or another room', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$question' })

  const command = {
    kind: 'sendTurn' as const,
    roomId: room.roomId,
    body: 'Make hello.txt',
    turnId,
    transactionId,
    handoff: true as const,
    cloud: true as const
  }

  const signed = matrixTurnContent({ body: 'Make hello.txt', turnId, handoff: true })

  const otherWords = originFor(matrixTurnContent({ body: 'Delete everything', turnId, handoff: true }), room.roomId)
  await expect(sendMatrixTurn(client, { ...command, origin: otherWords })).rejects.toThrow('matrix_origin_mismatch')

  const otherRoom = originFor(signed, '!elsewhere:test')
  await expect(sendMatrixTurn(client, { ...command, origin: otherRoom })).rejects.toThrow('matrix_origin_mismatch')

  // The handoff marker is part of the signed content: an assertion over the same words without it
  // covers a different message.
  const unmarked = originFor(matrixTurnContent({ body: 'Make hello.txt', turnId }), room.roomId)
  await expect(sendMatrixTurn(client, { ...command, origin: unmarked })).rejects.toThrow('matrix_origin_mismatch')

  // A cloud question is always handed off, and only a cloud question carries an origin.
  const good = originFor(signed, room.roomId)
  await expect(sendMatrixTurn(client, { ...command, handoff: undefined, origin: good })).rejects.toThrow(
    'matrix_command_invalid'
  )
  await expect(sendMatrixTurn(client, { ...command, cloud: undefined, origin: good })).rejects.toThrow(
    'matrix_command_invalid'
  )

  const extra = { ...originFor(signed, room.roomId), extra: 1 } as unknown as MatrixOriginAssertion
  await expect(sendMatrixTurn(client, { ...command, origin: extra })).rejects.toThrow('matrix_origin_mismatch')

  expect(send).not.toHaveBeenCalled()
})

function roomEvent(id: string, ts: number, content: Record<string, unknown>, sender = '@owner:test'): IRoomEvent {
  return {
    type: EventType.RoomMessage,
    event_id: id,
    room_id: '!room:test',
    sender,
    origin_server_ts: ts,
    content
  } as IRoomEvent
}

function lookupClient(live: MatrixEvent[], pages: IRoomEvent[][], token: string | null = 'live') {
  const createMessagesRequest = vi.fn(async (_room: string, from: string | null) => {
    const index = from === null || from === 'live' ? 0 : Number(from?.slice(4))
    const chunk = pages[index] ?? []

    return { chunk, start: String(from), end: index + 1 < pages.length ? `page${index + 1}` : undefined }
  })

  const client = {
    getRoom: () => ({
      getMyMembership: () => 'join',
      getLiveTimeline: () => ({ getEvents: () => live, getPaginationToken: () => token })
    }),
    createMessagesRequest,
    decryptEventIfNeeded: vi.fn(async () => {})
  } as unknown as MatrixClient

  return { client, createMessagesRequest }
}

const since = 1_000_000_000

const find = (client: MatrixClient) =>
  findMatrixTurn(client, { kind: 'findTurn', roomId: '!room:test', turnId, sender: '@owner:test', since })

it('finds the turn in the live timeline without paging', async () => {
  const { client, createMessagesRequest } = lookupClient(
    [new MatrixEvent(roomEvent('$question', since + 10, { msgtype: 'm.text', body: 'Hi', 'io.atum.turn': turnId }))],
    []
  )

  expect(await find(client)).toEqual({ state: 'found', eventId: '$question' })
  expect(createMessagesRequest).not.toHaveBeenCalled()
})

it('finds the turn on an older page', async () => {
  const { client } = lookupClient(
    [new MatrixEvent(roomEvent('$later', since + 50, { msgtype: 'm.text', body: 'later' }))],
    [[roomEvent('$question', since + 10, { msgtype: 'm.text', body: 'Hi', 'io.atum.turn': turnId })]]
  )

  expect(await find(client)).toEqual({ state: 'found', eventId: '$question' })
})

it('reads the current server tail before declaring absence from a restored stale timeline', async () => {
  const before = since - MATRIX_FIND_TURN.skewMs - 1

  const { client, createMessagesRequest } = lookupClient(
    [new MatrixEvent(roomEvent('$cached', before, { body: 'cached before the interrupted send' }))],
    [[roomEvent('$accepted', since + 10, { 'io.atum.turn': turnId, body: 'already posted' })]],
    'stale-cached-token'
  )

  expect(await find(client)).toEqual({ state: 'found', eventId: '$accepted' })
  expect(createMessagesRequest).toHaveBeenCalledWith('!room:test', null, MATRIX_FIND_TURN.pageSize, Direction.Backward)
})

it('cannot prove absence from an old cache when the server is unreachable', async () => {
  const { client, createMessagesRequest } = lookupClient(
    [new MatrixEvent(roomEvent('$cached', since - MATRIX_FIND_TURN.skewMs - 1, { body: 'cached' }))], []
  )

  createMessagesRequest.mockRejectedValueOnce(new Error('offline'))
  expect(await find(client)).toEqual({ state: 'unknown' })
})

it('does not treat ciphertext still waiting for decryption as evidence of absence', async () => {
  const event = new MatrixEvent({ ...roomEvent('$encrypted', since + 10, { ciphertext: 'fixture' }), type: EventType.RoomMessageEncrypted })
  const { client } = lookupClient([event], [], null)
  expect(event.isDecryptionFailure()).toBe(false)
  expect(await find(client)).toEqual({ state: 'unknown' })
  expect(client.decryptEventIfNeeded).toHaveBeenCalledWith(event)
})

it('proves absence only once the scan reaches before the turn began', async () => {
  const before = since - MATRIX_FIND_TURN.skewMs - 1

  const { client } = lookupClient(
    [new MatrixEvent(roomEvent('$later', since + 50, { msgtype: 'm.text', body: 'later' }))],
    [[roomEvent('$older', before, { msgtype: 'm.text', body: 'older' })]]
  )

  expect(await find(client)).toEqual({ state: 'absent' })
})

it('is unknown, never absent, when an event from the sender cannot be decrypted', async () => {
  const before = since - MATRIX_FIND_TURN.skewMs - 1
  const undecryptable = new MatrixEvent(roomEvent('$mystery', since + 20, { msgtype: 'm.text', body: '' }))
  vi.spyOn(undecryptable, 'isDecryptionFailure').mockReturnValue(true)
  const { client } = lookupClient([undecryptable], [[roomEvent('$older', before, { msgtype: 'm.text', body: 'x' })]])
  expect(await find(client)).toEqual({ state: 'unknown' })
})

it('is unknown when the page budget runs out before the turn began', async () => {
  const pages = Array.from({ length: MATRIX_FIND_TURN.pages + 1 }, (_, index) => [
    roomEvent(`$p${index}`, since + 100 - index, { msgtype: 'm.text', body: 'recent' })
  ])

  const { client, createMessagesRequest } = lookupClient([], pages)
  expect(await find(client)).toEqual({ state: 'unknown' })
  expect(createMessagesRequest).toHaveBeenCalledTimes(MATRIX_FIND_TURN.pages)
})

it('is unknown at the deadline', async () => {
  vi.useFakeTimers()

  const client = {
    getRoom: () => ({
      getMyMembership: () => 'join',
      getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => 'live' })
    }),
    createMessagesRequest: vi.fn(() => new Promise(() => {}))
  } as unknown as MatrixClient

  const result = find(client)
  await vi.advanceTimersByTimeAsync(MATRIX_FIND_TURN.deadlineMs + 1)
  expect(await result).toEqual({ state: 'unknown' })
})

it('proves absence when the fresh server history is empty', async () => {
  const { client } = lookupClient([new MatrixEvent(roomEvent('$other', since + 5, { msgtype: 'm.text', body: 'x' }))], [], null)
  expect(await find(client)).toEqual({ state: 'absent' })
})

it('is unknown while the turn\'s own echo is still in flight, so nothing is re-sent under it', async () => {
  const echo = new MatrixEvent(roomEvent('~local', since + 1, { msgtype: 'm.text', body: 'Hi', 'io.atum.turn': turnId }))
  echo.setStatus(EventStatus.SENDING)
  const before = since - MATRIX_FIND_TURN.skewMs - 1
  const { client } = lookupClient([echo], [[roomEvent('$older', before, { msgtype: 'm.text', body: 'x' })]])
  expect(await find(client)).toEqual({ state: 'unknown' })
})

// Scheduled posts (readiness plan §4.5): once per Hermes run, found again by its marker.
const executionId = '0000000000004000800061f1dcf0c470'
const runId = matrixCronRunId(executionId)!

it('maps a Hermes execution ID to its run ID, and nothing else', () => {
  expect(runId).toBe('00000000-0000-4000-8000-61f1dcf0c470')
  expect(matrixCronRunId('not-hex')).toBeUndefined()
  expect(matrixCronRunId(executionId.toUpperCase())).toBeUndefined()
  // Hex that is not a v4 UUID is not a run ID.
  expect(matrixCronRunId('9f1c2d3e4b5a16c7a8b9c0d1e2f3a4b5')).toBeUndefined()
})

it('posts a scheduled result as the agent with the run marker under a transaction fixed per run', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$brief' })

  const id = await publishMatrixCron(client, { kind: 'publishCron', roomId: room.roomId, body: 'Brief', runId, jobId: 'job-1' })

  expect(id).toBe('$brief')
  expect(send).toHaveBeenCalledWith(
    room.roomId,
    EventType.RoomMessage,
    { msgtype: 'm.text', body: 'Brief', 'io.atum.cron': { run: runId, job: 'job-1' } },
    `atum-c-${runId}`
  )

  // A latched assistant's scheduled post may summarize Google data: it carries the mark.
  await publishMatrixCron(client, { kind: 'publishCron', roomId: room.roomId, body: 'Brief', runId, jobId: 'job-1', google: true })
  expect(send.mock.lastCall![2]).toEqual({
    msgtype: 'm.text',
    body: 'Brief',
    'io.atum.cron': { run: runId, job: 'job-1' },
    'io.atum.provenance': { v: 1, google: true }
  })

  await publishMatrixCron(client, { kind: 'publishCron', roomId: room.roomId, body: 'Quiet brief', runId, jobId: 'job-1', notify: false })
  expect(send.mock.lastCall![2]).toEqual({
    msgtype: 'm.notice',
    body: 'Quiet brief',
    'io.atum.cron': { run: runId, job: 'job-1' }
  })

  for (const bad of [{ runId: 'nope' }, { body: '  ' }, { body: 'x'.repeat(16001) }, { jobId: '' }]) {
    await expect(
      publishMatrixCron(client, { kind: 'publishCron', roomId: room.roomId, body: 'Brief', runId, jobId: 'job-1', ...bad })
    ).rejects.toThrow('matrix_command_invalid')
  }
})

it("posts a check-in's nudge beside its run marker, and never a malformed one", async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$nudge' })

  const nudge = {
    kind: 'deadline' as const,
    key: 'quote-lan',
    text: 'Quote for Lan is due today.',
    source: 'files' as const,
    action: 'draft' as const
  }

  const post = { kind: 'publishCron' as const, roomId: room.roomId, body: nudge.text, runId, jobId: 'a7c4ec4e0001' }

  expect(await publishMatrixCron(client, { ...post, nudge })).toBe('$nudge')
  expect(send.mock.calls[0]![2]).toEqual({
    msgtype: 'm.text',
    body: nudge.text,
    'io.atum.cron': { run: runId, job: 'a7c4ec4e0001' },
    'io.atum.nudge': nudge
  })

  await expect(
    publishMatrixCron(client, { ...post, nudge: { ...nudge, action: 'send' } as unknown as typeof nudge })
  ).rejects.toThrow('matrix_command_invalid')
  expect(send).toHaveBeenCalledTimes(1)
})

it('never posts a scheduled result into a plain room that is not the agent\u2019s chat', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = untypedRoom(client)
  const send = vi.spyOn(client, 'sendEvent')

  await expect(
    publishMatrixCron(client, { kind: 'publishCron', roomId: room.roomId, body: 'Brief', runId, jobId: 'job-1' })
  ).rejects.toThrow('matrix_encrypted_room_required')
  expect(send).not.toHaveBeenCalled()
})

// A routine's post refused as "not this room" is dropped for good (cron-delivery.ts DEFINITIVE).
// A crypto store that has not answered is no such refusal: the post fails as any passing failure
// does, so delivery keeps it and tries again.
it('keeps a scheduled result for later when the crypto store has not answered, never drops it as refused', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = untypedRoom(client, new Error('store busy'))
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$brief' })
  const post = { kind: 'publishCron' as const, roomId: room.roomId, body: 'Brief', runId, jobId: 'job-1' }

  await expect(publishMatrixCron(client, post)).rejects.toThrow('matrix_operation_failed')
  expect(send).not.toHaveBeenCalled()

  // The store answers: an older encrypted chat of two takes the post, encrypted by the SDK.
  vi.mocked(client.getCrypto).mockReturnValue({ isEncryptionEnabledInRoom: async () => true } as never)
  await expect(publishMatrixCron(client, post)).resolves.toBe('$brief')
})

it('finds a scheduled post by its run marker, and only with the cron marker', async () => {
  const posted = new MatrixEvent(
    roomEvent('$brief', since + 10, { msgtype: 'm.text', body: 'Brief', 'io.atum.cron': { run: runId, job: 'job-1' } }, '@agent:test')
  )

  const before = since - MATRIX_FIND_TURN.skewMs - 1
  const { client } = lookupClient([posted], [[roomEvent('$older', before, { msgtype: 'm.text', body: 'x' })]])

  const lookup = (marker?: 'cron') =>
    findMatrixTurn(client, { kind: 'findTurn', roomId: '!room:test', turnId: runId, sender: '@agent:test', since, marker })

  expect(await lookup('cron')).toEqual({ state: 'found', eventId: '$brief' })
  expect(await lookup()).toEqual({ state: 'absent' })
})

it('sends a handed-off question with the handoff marker, never the local-turn marker', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$question' })

  await sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'Hi', turnId, transactionId, handoff: true })

  // Every answering Mac skips the local-turn marker; this one must reach the agent's home.
  expect(send).toHaveBeenCalledWith(
    room.roomId,
    EventType.RoomMessage,
    { msgtype: 'm.text', body: 'Hi', 'io.atum.handoff': turnId },
    transactionId
  )
})

it('finds a handed-off question by its handoff marker, and only with that marker', async () => {
  const handedOff = new MatrixEvent(
    roomEvent('$question', since + 10, { msgtype: 'm.text', body: 'Hi', 'io.atum.handoff': turnId })
  )

  const before = since - MATRIX_FIND_TURN.skewMs - 1
  const { client } = lookupClient([handedOff], [[roomEvent('$older', before, { msgtype: 'm.text', body: 'x' })]])

  const lookup = (marker?: 'handoff') =>
    findMatrixTurn(client, { kind: 'findTurn', roomId: '!room:test', turnId, sender: '@owner:test', since, marker })

  expect(await lookup('handoff')).toEqual({ state: 'found', eventId: '$question' })
  expect(await lookup()).toEqual({ state: 'absent' })
})

it('finds one part of a split answer only by its own position, and proves another part absent', async () => {
  const part = (id: string, ts: number, index: number) =>
    roomEvent(
      id,
      ts,
      { msgtype: 'm.text', body: `part ${index}`, 'io.atum.turn': turnId, 'io.atum.part': { index, count: 3 } },
      '@agent:test'
    )

  const before = since - MATRIX_FIND_TURN.skewMs - 1

  const { client } = lookupClient(
    [new MatrixEvent(part('$part-1', since + 20, 1)), new MatrixEvent(part('$part-0', since + 10, 0))],
    [[roomEvent('$older', before, { msgtype: 'm.text', body: 'x' }, '@agent:test')]]
  )

  const lookup = (index: number) =>
    findMatrixTurn(client, { kind: 'findTurn', roomId: '!room:test', turnId, sender: '@agent:test', since, part: index })

  expect(await lookup(0)).toEqual({ state: 'found', eventId: '$part-0' })
  expect(await lookup(1)).toEqual({ state: 'found', eventId: '$part-1' })
  expect(await lookup(2)).toEqual({ state: 'absent' })
  await expect(lookup(-1)).rejects.toThrow('matrix_command_invalid')
})

it('sends a question that replies to a message as a standard rich reply, under the same transaction', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$question' })

  await sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'And for 3 days?', turnId, transactionId, replyTo: '$answer' })
  expect(send).toHaveBeenCalledWith(
    room.roomId,
    EventType.RoomMessage,
    {
      msgtype: 'm.text',
      body: 'And for 3 days?',
      'io.atum.turn': turnId,
      'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } }
    },
    transactionId
  )

  // Never with the handoff marker for another Mac (it would refuse it), never a malformed id; a
  // cloud question keeps its reply, but is never sent without the handoff marker.
  for (const extra of [
    { handoff: true as const, replyTo: '$answer' },
    { cloud: true as const, replyTo: '$answer' },
    { replyTo: 'answer' },
    { replyTo: `$${'x'.repeat(1024)}` }
  ]) {
    await expect(
      sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'Hi', turnId, transactionId, ...extra })
    ).rejects.toThrow('matrix_command_invalid')
  }

  expect(send).toHaveBeenCalledTimes(1)
})

it('still finds an edited question by the marker it was sent with, so it is never sent again', async () => {
  const question = new MatrixEvent(roomEvent('$question', since + 10, { msgtype: 'm.text', body: 'Hi', 'io.atum.turn': turnId }))

  const edit = new MatrixEvent(
    roomEvent('$edit', since + 20, {
      msgtype: 'm.text',
      body: '* Hello',
      'm.new_content': { msgtype: 'm.text', body: 'Hello' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$question' }
    })
  )

  // The SDK shows the edit's words for the question from now on; its marker is in what was sent.
  question.makeReplaced(edit)
  const { client } = lookupClient([question, edit], [])

  expect(await find(client)).toEqual({ state: 'found', eventId: '$question' })
})

// 0.20 shave-down: the agent's chat is plain. This Mac types to it with its origin attached, and
// routines post there.
it('sends a question with its origin assertion into the agent\u2019s plain chat', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = plainAgentRoom(client)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$question' })
  const content = matrixTurnContent({ body: 'Make hello.txt', turnId, handoff: true })
  const origin = originFor(content, room.roomId)

  await sendMatrixTurn(client, {
    kind: 'sendTurn',
    roomId: room.roomId,
    body: 'Make hello.txt',
    turnId,
    transactionId,
    handoff: true,
    cloud: true,
    origin
  })

  const sent = send.mock.calls[0]![2] as unknown as Record<string, unknown>
  expect(sent['io.atum.origin']).toEqual(origin)
  expect(requestDigestV2(sent)).toBe(origin.dg)
  // The origin check is unchanged: another room's assertion is refused.
  await expect(
    sendMatrixTurn(client, {
      kind: 'sendTurn',
      roomId: room.roomId,
      body: 'Make hello.txt',
      turnId,
      transactionId,
      handoff: true,
      cloud: true,
      origin: originFor(content, '!other:test')
    })
  ).rejects.toThrow('matrix_origin_mismatch')
})

it('posts a scheduled result into the agent\u2019s plain chat', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = plainAgentRoom(client)
  vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$brief' })

  await expect(
    publishMatrixCron(client, { kind: 'publishCron', roomId: room.roomId, body: 'Brief', runId, jobId: 'job-1' })
  ).resolves.toBe('$brief')
})

it('never sends a question into a plain room that is not the agent\u2019s chat', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const room = untypedRoom(client)
  const send = vi.spyOn(client, 'sendEvent')

  await expect(
    sendMatrixTurn(client, { kind: 'sendTurn', roomId: room.roomId, body: 'Hi', turnId, transactionId })
  ).rejects.toThrow('matrix_encrypted_room_required')
  expect(send).not.toHaveBeenCalled()
})

it('prepares the same cron marker without sending, for D1 publication', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = encryptedRoom(client)
  const send = vi.spyOn(client, 'sendEvent')
  Object.assign(client, { shouldEncryptEventForRoom: async () => false })

  const event = await prepareMatrixCron(client, { kind: 'prepareCron', roomId: room.roomId,
    body: 'saved output', runId, jobId: 'schedule' })

  expect(event).toEqual({ eventType: 'm.room.message', content: { msgtype: 'm.text', body: 'saved output',
    'io.atum.cron': { run: runId, job: 'schedule' } } })
  expect(send).not.toHaveBeenCalled()
})
