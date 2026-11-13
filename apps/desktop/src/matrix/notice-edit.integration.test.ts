// @vitest-environment node
import 'fake-indexeddb/auto'

import { EncryptionAlgorithm, type OlmMachine, RoomId, RoomSettings } from '@matrix-org/matrix-sdk-crypto-wasm'
import { createClient, EventType, MatrixEvent, Method, MsgType, type Room } from 'matrix-js-sdk'
import { logger, type Logger } from 'matrix-js-sdk/lib/logger'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { MATRIX_TRANSIENT_REDACTION_REASON } from '../../shared/matrix-transient-lines'

import { shownContent } from './message'
import { matrixNoticeEditPayload, matrixNoticeEditTransaction } from './notice-edit'
import { matrixNoticeTransaction, publishMatrixNotice, publishMatrixResult } from './publish-result'
import { matrixSdkErrorCode } from './sdk-error-code'
import { TestHomeserver } from './test-homeserver'
import { publishMatrixCron, sendMatrixTurn, sendWithTransaction } from './turn'
const OWNER = '@notice-proof:atum.test'
const quiet: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild: () => quiet }
const running: ReturnType<typeof createClient>[] = []
beforeEach(() => {
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => {})
  }

  vi.spyOn(logger, 'getChild').mockReturnValue(quiet)
})
afterEach(() => {
  for (const client of running.splice(0)) {
    client.stopClient()
  }

  vi.restoreAllMocks()
})

async function fixture(statusLine = false, encrypted = true, type?: string) {
  const server = new TestHomeserver(OWNER)

  const client = createClient({
    baseUrl: server.baseUrl,
    userId: OWNER,
    deviceId: 'MAC',
    accessToken: server.signIn('MAC'),
    fetchFn: server.fetch,
    logger: quiet
  })

  running.push(client)
  await client.initRustCrypto({
    cryptoDatabasePrefix: globalThis.crypto.randomUUID(),
    storageKey: globalThis.crypto.getRandomValues(new Uint8Array(32))
  })
  await client.startClient({ initialSyncLimit: 10, pollTimeout: 100 })
  await vi.waitFor(() => expect(client.isInitialSyncComplete()).toBe(true), { timeout: 30_000 })

  // A plain room is the agent's chat made the 0.20 way: the assistant room type, no encryption.
  // An encrypted one has no room type unless `type` names one (an agent's chat made before 0.20).
  const { room_id: roomId } = await client.createRoom(
    encrypted
      ? {
          initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
          ...(type ? { creation_content: { type } } : {})
        }
      : { creation_content: { type: 'io.atum.assistant' } }
  )

  await vi.waitFor(() => expect(client.getRoom(roomId)?.hasEncryptionStateEvent()).toBe(encrypted), { timeout: 30_000 })
  await vi.waitFor(() => expect(client.getRoom(roomId)?.getMyMembership()).toBe('join'), { timeout: 30_000 })
  const { event_id: eventId } = await client.sendTextMessage(roomId, 'Synthetic question')

  const command = {
    kind: 'publishNotice' as const,
    roomId,
    eventId,
    body: 'Waiting for approval',
    ...(statusLine ? { statusLine: true as const } : {})
  }

  const payload = await matrixNoticeEditPayload(client, command)

  const notice = payload
    ? (await client.sendEvent(roomId, EventType.RoomMessage, payload.content, payload.transactionId)).event_id
    : await publishMatrixNotice(client, command)

  return { client, command, notice }
}

it('cloud turn notices retry once under their transaction and follow-ups have distinct encrypted roots', async () => {
  const { client, command } = await fixture(true)
  const first = { ...command, transactionId: `atum-cn-${'a'.repeat(64)}` }
  const followup = { ...command, transactionId: `atum-cn-${'b'.repeat(64)}` }
  const root = await publishMatrixNotice(client, first)
  const retry = await publishMatrixNotice(client, first)
  const next = await publishMatrixNotice(client, followup)
  expect(retry).toBe(root)
  expect(next).not.toBe(root)
  const edit = await matrixNoticeEditPayload(client, { ...command, replaces: next, revision: 1, body: 'Working again' })
  expect(edit!.content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: next })
  expect(edit!.transactionId).toBe(matrixNoticeEditTransaction(next, 1))
})

it('a real encrypted edit displays through shownContent and retains the original for old clients', async () => {
  const { client, command, notice } = await fixture(true)

  const payload = await matrixNoticeEditPayload(client, {
    ...command,
    replaces: notice,
    revision: 1,
    body: 'Working again'
  })

  expect(payload!.transactionId).toBe(matrixNoticeEditTransaction(notice, 1))
  const sent = await client.sendEvent(command.roomId, EventType.RoomMessage, payload!.content, payload!.transactionId)
  const root = new MatrixEvent(await client.fetchRoomEvent(command.roomId, notice))
  const edit = new MatrixEvent(await client.fetchRoomEvent(command.roomId, sent.event_id))
  expect(root.isEncrypted()).toBe(true)
  expect(edit.isEncrypted()).toBe(true)
  await client.decryptEventIfNeeded(root)
  await client.decryptEventIfNeeded(edit)
  root.makeReplaced(edit)
  expect(shownContent(root)).toMatchObject({
    edited: true,
    content: { msgtype: MsgType.Notice, body: 'Working again' }
  })
  expect(root.getOriginalContent().body).toBe('Waiting for approval')
  expect(edit.getContent()['m.new_content']['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: command.eventId } })
  expect(edit.getContent()).not.toHaveProperty('io.atum.result')

  // Independent display guard: a server-bundled replacement still needs the same sender.
  const foreign = new MatrixEvent({
    type: EventType.RoomMessage,
    sender: '@other:atum.test',
    content: { 'm.new_content': { msgtype: MsgType.Notice, body: 'Foreign replacement' } }
  })

  vi.spyOn(root, 'replacingEvent').mockReturnValue(foreign)
  expect(shownContent(root)).toMatchObject({ edited: false, content: { body: 'Waiting for approval' } })
}, 90_000)
it('refuses a different question, an edit target and a different sender', async () => {
  const { client, command, notice } = await fixture()
  await expect(
    matrixNoticeEditPayload(client, { ...command, eventId: '$other', replaces: notice, revision: 1 })
  ).rejects.toThrow('matrix_notice_replacement_invalid')
  const payload = await matrixNoticeEditPayload(client, { ...command, replaces: notice, revision: 1, body: 'Working' })
  const edit = await client.sendEvent(command.roomId, EventType.RoomMessage, payload!.content, payload!.transactionId)
  await expect(matrixNoticeEditPayload(client, { ...command, replaces: edit.event_id, revision: 2 })).rejects.toThrow(
    'matrix_notice_replacement_invalid'
  )
  vi.spyOn(client, 'getUserId').mockReturnValue('@other:atum.test')
  await expect(matrixNoticeEditPayload(client, { ...command, replaces: notice, revision: 2 })).rejects.toThrow(
    'matrix_notice_replacement_invalid'
  )
}, 90_000)
it('leaves legacy notices untouched and rejects invalid edits before fetching', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
  const fetch = vi.spyOn(client, 'fetchRoomEvent')
  const base = { roomId: '!room:test', eventId: '$question', body: 'Waiting' }
  expect(await matrixNoticeEditPayload(client, base)).toBeNull()

  for (const fields of [
    { revision: 1 },
    { replaces: '$notice' },
    { replaces: '$notice', revision: 0 },
    { replaces: '$notice', revision: Number.NaN },
    { replaces: 'notice', revision: 1 }
  ]) {
    await expect(matrixNoticeEditPayload(client, { ...base, ...fields })).rejects.toThrow('matrix_command_invalid')
  }

  expect(fetch).not.toHaveBeenCalled()
})

it('a live status uses a separate transaction from a previously posted legacy denial', async () => {
  const { client, command, notice: legacy } = await fixture()
  const payload = await matrixNoticeEditPayload(client, { ...command, statusLine: true })
  const send = () => client.sendEvent(command.roomId, EventType.RoomMessage, payload!.content, payload!.transactionId)
  const first = await sendWithTransaction(client, command.roomId, payload!.transactionId, send)
  const retry = await sendWithTransaction(client, command.roomId, payload!.transactionId, send)
  expect(first).not.toBe(legacy)
  expect(retry).toBe(first)
  const old = new MatrixEvent(await client.fetchRoomEvent(command.roomId, legacy))
  await client.decryptEventIfNeeded(old)
  expect(old.getContent().body).toBe(command.body)
}, 90_000)

// 0.20 shave-down: the agent's chat is plain, and its status line is edited there in place.
it('edits the agent\u2019s own plain status line in a plain chat, and never a plaintext one in an encrypted room', async () => {
  const plain = await fixture(true, false)
  const root = new MatrixEvent(await plain.client.fetchRoomEvent(plain.command.roomId, plain.notice))
  expect(root.isEncrypted()).toBe(false)

  const edit = await matrixNoticeEditPayload(plain.client, {
    ...plain.command,
    replaces: plain.notice,
    revision: 1,
    body: 'Working again'
  })

  expect(edit!.content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: plain.notice })
  plain.client.stopClient()

  // No downgrade: a plaintext notice that got into an encrypted room is not ours to edit.
  const encrypted = await fixture(true)

  const { event_id: forged } = await encrypted.client.http.authedRequest<{ event_id: string }>(
    Method.Put,
    `/rooms/${encodeURIComponent(encrypted.command.roomId)}/send/m.room.message/forged`,
    undefined,
    {
      msgtype: MsgType.Notice,
      body: 'Waiting',
      'm.relates_to': { 'm.in_reply_to': { event_id: encrypted.command.eventId } }
    }
  )

  await expect(
    matrixNoticeEditPayload(encrypted.client, {
      ...encrypted.command,
      replaces: forged,
      revision: 1,
      body: 'Working again'
    })
  ).rejects.toThrow('matrix_notice_replacement_invalid')
}, 90_000)

/** What the server holds for an event: its type on the wire (`m.room.encrypted` or plaintext). */
async function wireType(client: ReturnType<typeof createClient>, roomId: string, eventId: string) {
  return (await client.http.authedRequest<{ type: string }>(Method.Get, `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`)).type
}

const TURN = '1c5a2e1e-6c2f-4a57-9d7b-2f0c7b3f1a10'
const RUN = '2d6b3f2f-7d3a-4b68-8e8c-3a1d8c4a2b21'

/** Everything an agent posts and this Mac sends to an agent, into one room, each under its fixed
 * transaction: answer, status line, question, scheduled result. */
function everyPost(client: ReturnType<typeof createClient>, roomId: string, question: string) {
  return [
    () =>
      publishMatrixResult(client, {
        kind: 'publishResult',
        roomId,
        eventId: question,
        body: 'Answer',
        invocationId: 'invocation',
        transactionId: 'transaction'
      }),
    () => publishMatrixNotice(client, { kind: 'publishNotice', roomId, eventId: question, body: 'Working' }),
    () => sendMatrixTurn(client, { kind: 'sendTurn', roomId, body: 'Next', turnId: TURN, transactionId: `atum-q-${TURN}` }),
    () => publishMatrixCron(client, { kind: 'publishCron', roomId, body: 'Brief', runId: RUN, jobId: 'job-1' })
  ]
}

/** The four posts' events as the test homeserver names them (device and transaction). */
const everyPostEvent = (question: string) =>
  ['transaction', matrixNoticeTransaction(question), `atum-q-${TURN}`, `atum-c-${RUN}`].map(transaction => `$MAC-${transaction}`)

/** Posts everything in turn; returns each event's wire type. */
async function postEverything(client: ReturnType<typeof createClient>, roomId: string, question: string) {
  const posted: string[] = []

  for (const post of everyPost(client, roomId, question)) {
    posted.push(await post())
  }

  return Promise.all(posted.map(eventId => wireType(client, roomId, eventId)))
}

// 0.20 no-downgrade rule on the send side, the in-session gap: this client's synced view of an
// encrypted room lacks its encryption state for a moment while the crypto store and the SDK's
// encryptor for it both exist (modelled by hiding the state from the view). What an agent posts
// there goes out encrypted, and a plaintext notice found there is not one to edit.
it.each([
  ['an agent’s chat made before 0.20', 'io.atum.assistant'],
  ['an untyped room', undefined]
])('in-session gap: posts only ciphertext into an encrypted room whose encryption state this view lacks: %s', async (_name, type) => {
  const lagging = await fixture(true, true, type)
  const room = lagging.client.getRoom(lagging.command.roomId)!
  // The synced view shows no encryption; the crypto store still has the room as encrypted.
  vi.spyOn(room, 'hasEncryptionStateEvent').mockReturnValue(false)
  await expect(lagging.client.getCrypto()!.isEncryptionEnabledInRoom(room.roomId)).resolves.toBe(true)

  expect(await postEverything(lagging.client, room.roomId, lagging.command.eventId)).toEqual([
    'm.room.encrypted',
    'm.room.encrypted',
    'm.room.encrypted',
    'm.room.encrypted'
  ])

  const { event_id: forged } = await lagging.client.http.authedRequest<{ event_id: string }>(
    Method.Put,
    `/rooms/${encodeURIComponent(room.roomId)}/send/m.room.message/forged-lagging`,
    undefined,
    {
      msgtype: MsgType.Notice,
      body: 'Waiting',
      'm.relates_to': { 'm.in_reply_to': { event_id: lagging.command.eventId } }
    }
  )

  await expect(
    matrixNoticeEditPayload(lagging.client, { ...lagging.command, replaces: forged, revision: 1, body: 'Working again' })
  ).rejects.toThrow('matrix_notice_replacement_invalid')
}, 90_000)

it('still posts plaintext into the agent’s plain chat, where the crypto store agrees', async () => {
  const plain = await fixture(true, false)
  const roomId = plain.command.roomId
  await expect(plain.client.getCrypto()!.isEncryptionEnabledInRoom(roomId)).resolves.toBe(false)

  expect(await postEverything(plain.client, roomId, plain.command.eventId)).toEqual([
    'm.room.message',
    'm.room.message',
    'm.room.message',
    'm.room.message'
  ])
}, 90_000)

// The restart case: the SDK's store saves sync only every few minutes, so a restart can replay a
// cached sync without the room's encryption state while the crypto store already has the room as
// encrypted. The SDK then has no encryptor for the room and refuses to send ("unconfigured room"):
// nothing reaches the server, the failure is the SDK's ordinary one (never a refusal of the room,
// which callers treat as final), and once sync brings the encryption state the same post goes out
// encrypted under its own transaction.
it('restart from a stale sync: sends nothing until this client can encrypt for the room, then the same post encrypted', async () => {
  const restarted = await fixture(true, false)
  const { roomId, eventId: question } = restarted.command
  const room = restarted.client.getRoom(roomId)!

  const crypto = restarted.client.getCrypto() as unknown as {
    olmMachine: OlmMachine
    onCryptoEvent(room: Room, event: MatrixEvent): Promise<void>
  }

  const settings = new RoomSettings()
  settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2
  await crypto.olmMachine.setRoomSettings(new RoomId(roomId), settings)
  expect(room.hasEncryptionStateEvent()).toBe(false)
  await expect(restarted.client.getCrypto()!.isEncryptionEnabledInRoom(roomId)).resolves.toBe(true)

  const posts = everyPost(restarted.client, roomId, question)

  for (const post of posts) {
    const failure = await post().then(
      () => null,
      (error: unknown) => error
    )

    // The SDK's own refusal, not this module's: the room was admitted as encrypted.
    expect(String(failure)).toMatch(/unconfigured room/)
    expect(matrixSdkErrorCode(failure)).toBe('matrix_operation_failed')
  }

  for (const eventId of everyPostEvent(question)) {
    await expect(wireType(restarted.client, roomId, eventId)).rejects.toThrow()
  }

  // Sync brings the room's encryption state: the SDK makes its encryptor, and each retry sends the
  // same post, encrypted, under its own transaction.
  await crypto.onCryptoEvent(
    room,
    new MatrixEvent({
      type: 'm.room.encryption',
      state_key: '',
      room_id: roomId,
      sender: OWNER,
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
  )

  const retried: string[] = []

  for (const post of posts) {
    retried.push(await post())
  }

  expect(retried).toEqual(everyPostEvent(question))
  expect(await Promise.all(retried.map(eventId => wireType(restarted.client, roomId, eventId)))).toEqual([
    'm.room.encrypted',
    'm.room.encrypted',
    'm.room.encrypted',
    'm.room.encrypted'
  ])
}, 90_000)

// agent-turns/1.3: the progress line is one notice, edited in place, carrying io.atum.progress.
it('publishes and edits one progress line that shows without "edited" and keeps its marker for old clients', async () => {
  const { client, command } = await fixture(true, false)
  const transactionId = `atum-cp-${'c'.repeat(64)}`
  const marker = (revision: number, kind: 'interim' | 'todo' | 'settled' = 'interim') =>
    ({ profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: kind === 'settled' ? 'settled' : 'working', kind, revision }) as const

  const original = { ...command, body: 'Mình sẽ kiểm tra lịch.', progress: marker(0), transactionId }
  const root = await publishMatrixNotice(client, original)
  expect(await publishMatrixNotice(client, original)).toBe(root)

  const payload = await matrixNoticeEditPayload(client, {
    ...command, body: 'Đã kiểm tra\n✓ Đọc lịch', replaces: root, revision: 1, progress: marker(1, 'todo')
  })

  expect(payload!.content['io.atum.progress']).toEqual(marker(1, 'todo'))
  expect((payload!.content as unknown as Record<string, Record<string, unknown>>)['m.new_content']!['io.atum.progress']).toEqual(marker(1, 'todo'))
  const sent = await client.sendEvent(command.roomId, EventType.RoomMessage, payload!.content, payload!.transactionId)
  const rootEvent = new MatrixEvent(await client.fetchRoomEvent(command.roomId, root))
  rootEvent.makeReplaced(new MatrixEvent(await client.fetchRoomEvent(command.roomId, sent.event_id)))
  expect(rootEvent.getOriginalContent()['io.atum.progress']).toEqual(marker(0))
  expect(shownContent(rootEvent).content['io.atum.progress']).toEqual(marker(1, 'todo'))

  // A status-line edit never replaces a progress line, a progress edit never a status line, and the
  // marker must match the revision: nothing reaches the network for a malformed one.
  await expect(matrixNoticeEditPayload(client, { ...command, replaces: root, revision: 2 }))
    .rejects.toThrow('matrix_notice_replacement_invalid')
  await expect(matrixNoticeEditPayload(client, { ...command, replaces: root, revision: 2, progress: marker(5) }))
    .rejects.toThrow('matrix_command_invalid')
  await expect(matrixNoticeEditPayload(client, { ...command, progress: marker(0) }))
    .rejects.toThrow('matrix_command_invalid')
  await expect(publishMatrixNotice(client, { ...original, group: true })).rejects.toThrow('matrix_command_invalid')
  await expect(matrixNoticeEditPayload(client, { ...command, replaces: root, revision: 2, progress: { ...marker(2), scope: 'room' } as never }))
    .rejects.toThrow('matrix_command_invalid')
}, 90_000)

it('posts an interim remark as a real m.text message the agent can retry safely, never a notice or a group message', async () => {
  for (const encrypted of [false, true]) {
    const { client, command } = await fixture(true, encrypted)
    const transactionId = `atum-ci-${'d'.repeat(64)}`
    const remark = { kind: 'publishNotice' as const, roomId: command.roomId, eventId: command.eventId, body: 'Để mình xem video này rồi tóm tắt nhé.', interim: true as const, transactionId }
    const id = await publishMatrixNotice(client, remark)
    expect(await publishMatrixNotice(client, remark)).toBe(id)

    const event = new MatrixEvent(await client.fetchRoomEvent(command.roomId, id))
    await client.decryptEventIfNeeded(event)
    expect(event.isEncrypted()).toBe(encrypted)
    expect(event.getContent()).toEqual({ msgtype: MsgType.Text, body: remark.body, 'io.atum.interim': true })

    // A refusal never reaches the network: wrong transaction, an empty or long body, a group, or mixed with another line kind.
    const room = { roomId: command.roomId, eventId: command.eventId }
    await expect(publishMatrixNotice(client, { ...remark, transactionId: `atum-cn-${'d'.repeat(64)}` })).rejects.toThrow('matrix_command_invalid')
    await expect(publishMatrixNotice(client, { ...remark, transactionId: undefined })).rejects.toThrow('matrix_command_invalid')
    await expect(publishMatrixNotice(client, { ...remark, body: '   ' })).rejects.toThrow('matrix_command_invalid')
    await expect(publishMatrixNotice(client, { ...remark, body: 'x'.repeat(1_001) })).rejects.toThrow('matrix_command_invalid')
    await expect(publishMatrixNotice(client, { ...remark, group: true })).rejects.toThrow('matrix_command_invalid')
    await expect(publishMatrixNotice(client, { ...remark, statusLine: true })).rejects.toThrow('matrix_command_invalid')
    await expect(publishMatrixNotice(client, { ...remark, replaces: id, revision: 1 })).rejects.toThrow('matrix_command_invalid')
    expect(room.roomId).toBe(command.roomId)
  }
}, 120_000)

it('removes the agent’s own ended progress line (and its interim remark), and only those', async () => {
  const { client, command } = await fixture(true, false)
  const marker = { profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: 'working', kind: 'todo', revision: 0 } as const
  const room = { roomId: command.roomId, eventId: command.eventId }
  const line = await publishMatrixNotice(client, { ...command, body: 'Đang đọc…', progress: marker, transactionId: `atum-cp-${'e'.repeat(64)}` })
  const remark = await publishMatrixNotice(client, { kind: 'publishNotice', ...room, body: 'Để mình xem.', interim: true, transactionId: `atum-ci-${'e'.repeat(64)}` })
  const outcome = await publishMatrixNotice(client, { ...command, body: 'Máy Mac đang tắt.', transactionId: `atum-cn-${'e'.repeat(64)}` })
  const ownerMessage = command.eventId
  const remove = (replaces: string) => ({ kind: 'publishNotice' as const, ...room, body: '', redact: true as const, replaces })

  // An outcome notice, the owner's own message and a stranger's event can never be removed this way.
  await expect(publishMatrixNotice(client, remove(outcome))).rejects.toThrow('matrix_notice_replacement_invalid')
  await expect(publishMatrixNotice(client, remove(ownerMessage))).rejects.toThrow('matrix_notice_replacement_invalid')
  await expect(publishMatrixNotice(client, { ...remove(line), body: 'x' })).rejects.toThrow('matrix_command_invalid')
  await expect(publishMatrixNotice(client, { ...remove(line), group: true })).rejects.toThrow('matrix_command_invalid')
  await expect(publishMatrixNotice(client, { ...remove(line), progress: marker })).rejects.toThrow('matrix_command_invalid')
  await expect(publishMatrixNotice(client, { ...remove(line), eventId: remark })).rejects.toThrow('matrix_notice_replacement_invalid')

  expect(await publishMatrixNotice(client, remove(line))).toBe(line)
  expect(await publishMatrixNotice(client, remove(remark))).toBe(remark)
  // Already gone: removing again is quiet, so a retried removal never fails the turn.
  expect(await publishMatrixNotice(client, remove(line))).toBe(line)

  await vi.waitFor(async () => {
    expect(new MatrixEvent(await client.fetchRoomEvent(command.roomId, line)).getContent()).toEqual({})
    expect(new MatrixEvent(await client.fetchRoomEvent(command.roomId, remark)).getContent()).toEqual({})
  })
  // Removed with the agent-turns reason, so a reader shows no "deleted" tombstone for it.
  const because = new MatrixEvent(await client.fetchRoomEvent(command.roomId, line)).getRedactionEvent()
  expect(because && 'content' in because ? because.content.reason : undefined).toBe(MATRIX_TRANSIENT_REDACTION_REASON)
  // The outcome notice is untouched.
  expect(new MatrixEvent(await client.fetchRoomEvent(command.roomId, outcome)).getContent().body).toBe('Máy Mac đang tắt.')
}, 90_000)
