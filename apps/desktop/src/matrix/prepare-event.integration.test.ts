// @vitest-environment node
import 'fake-indexeddb/auto'

import { createClient, EventType, type MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'
import { logger, type Logger } from 'matrix-js-sdk/lib/logger'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { initializeMatrixDeviceIsolation } from './device-isolation'
import { prepareMatrixEvent } from './prepare-event'
import { TestHomeserver } from './test-homeserver'

const OWNER = '@prepare-proof:atum.test'
const quiet: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild: () => quiet }
const running: MatrixClient[] = []

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

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30_000

  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('prepare_proof_timeout')
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function device(server: TestHomeserver, deviceId: string) {
  const client = createClient({
    baseUrl: server.baseUrl,
    userId: OWNER,
    deviceId,
    accessToken: server.signIn(deviceId),
    fetchFn: server.fetch,
    logger: quiet
  })

  await client.initRustCrypto({
    cryptoDatabasePrefix: globalThis.crypto.randomUUID(),
    storageKey: globalThis.crypto.getRandomValues(new Uint8Array(32))
  })
  // The legacy policy: keys go to every device of the room, and nothing needs to be cross-signed for this proof.
  initializeMatrixDeviceIsolation(client.getCrypto()!, 'all', 'all')
  running.push(client)
  await client.startClient({ initialSyncLimit: 10, pollTimeout: 100 })
  await until(() => client.isInitialSyncComplete())

  return client
}

// The encrypted event can reach a device before its to-device Megolm key; wait only for that race.
async function decryptWhenKeyArrives(client: MatrixClient, roomId: string, eventId: string) {
  let event: MatrixEvent
  await until(async () => {
    event = new MatrixEvent(await client.fetchRoomEvent(roomId, eventId))
    await client.decryptEventIfNeeded(event)

    return event.decryptionFailureReason !== DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID
  })

  return event!
}

it(
  'prepares the bytes of an encrypted room without sending, and another session sends them as they are',
  async () => {
    const server = new TestHomeserver(OWNER)
    const agent = await device(server, 'AGENT')
    const reader = await device(server, 'READER')

    const { room_id: roomId } = await agent.createRoom({
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
    })

    await until(() => !!agent.getRoom(roomId)?.hasEncryptionStateEvent() && !!reader.getRoom(roomId)?.hasEncryptionStateEvent())
    // Each device must know the other before the room key can go to it.
    await until(async () => !!(await agent.getCrypto()!.getDeviceVerificationStatus(OWNER, 'READER')))

    const content = {
      msgtype: 'm.text',
      body: 'prepared here, sent elsewhere',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$question:atum.test' } },
      'io.atum.result': { invocation: 'invocation-1', transaction: 'atum-prepared-1' }
    }

    const prepared = await prepareMatrixEvent(agent, agent.getRoom(roomId)!, EventType.RoomMessage, content)

    // The wire form: megolm ciphertext, the session and the device that encrypted it. Not a word of the answer.
    expect(prepared.eventType).toBe('m.room.encrypted')
    expect(prepared.content).toMatchObject({ algorithm: 'm.megolm.v1.aes-sha2', device_id: 'AGENT' })
    expect(typeof prepared.content.ciphertext).toBe('string')
    expect(typeof prepared.content.session_id).toBe('string')
    expect(JSON.stringify(prepared.content)).not.toContain('prepared here')
    // Plain JSON the platform can store byte for byte.
    expect(JSON.parse(JSON.stringify(prepared.content))).toEqual(prepared.content)

    // Nothing was sent: the other device sees no message in the room.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(reader.getRoom(roomId)!.getLiveTimeline().getEvents().filter(event => event.getWireType() === EventType.RoomMessageEncrypted)).toHaveLength(0)

    // Another session of the same user (the platform's publisher) puts the bytes into the room under a fixed transaction.
    const worker = server.signIn('PUBLISHER')

    const send = () =>
      server.fetch(
        `${server.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${prepared.eventType}/atum-prepared-1`,
        {
          method: 'PUT',
          headers: { authorization: `Bearer ${worker}`, 'content-type': 'application/json' },
          body: JSON.stringify(prepared.content)
        }
      )

    const response = await send()
    expect(response.status).toBe(200)
    const { event_id: eventId } = (await response.json()) as { event_id: string }

    const received = await decryptWhenKeyArrives(reader, roomId, eventId)
    expect(received.isDecryptionFailure()).toBe(false)
    expect(received.getContent()).toMatchObject({
      body: 'prepared here, sent elsewhere',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$question:atum.test' } },
      'io.atum.result': { transaction: 'atum-prepared-1' }
    })
  },
  90_000
)

it('prepares what a room without encryption would be sent: the message itself, unchanged', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!plain:test', client, client.getSafeUserId())
  const content = { msgtype: 'm.text', body: 'in the clear', 'm.relates_to': { 'm.in_reply_to': { event_id: '$q' } } }

  await expect(prepareMatrixEvent(client, room, EventType.RoomMessage, content)).resolves.toEqual({
    eventType: 'm.room.message',
    content
  })
})

it('refuses, rather than send in the clear, an encrypted room whose client cannot encrypt', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!secret:test', client, client.getSafeUserId())

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

  await expect(prepareMatrixEvent(client, room, EventType.RoomMessage, { msgtype: 'm.text', body: 'secret' })).rejects.toThrow(
    'matrix_prepare_unsupported'
  )
})

it('refuses when the client no longer has the members of its send path it relies on', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!any:test', client, client.getSafeUserId())
  // Only this instance: the member is shadowed, the client class itself is left alone.
  Object.defineProperty(client, 'shouldEncryptEventForRoom', { value: undefined, configurable: true })

  await expect(prepareMatrixEvent(client, room, EventType.RoomMessage, { msgtype: 'm.text', body: 'x' })).rejects.toThrow(
    'matrix_prepare_unsupported'
  )
})
