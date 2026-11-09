// @vitest-environment node
import 'fake-indexeddb/auto'

import { createClient, type MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'
import { type Logger, logger } from 'matrix-js-sdk/lib/logger'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { matrixDecryptionReason } from '../../shared/matrix-decryption-reason'

import { matrixMessage } from './message'
import { matrixSecurity, recoveryKeyCache } from './security'
import { TestHomeserver } from './test-homeserver'

const OWNER = '@key-recovery:atum.test'
const quiet: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild: () => quiet }
const running: Array<{ client: MatrixClient; security: ReturnType<typeof matrixSecurity> }> = []

beforeEach(() => {
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => {})
  }

  vi.spyOn(logger, 'getChild').mockReturnValue(quiet)
})

afterEach(() => {
  for (const d of running.splice(0)) {
    d.security.stop()
    d.client.stopClient()
  }

  vi.restoreAllMocks()
})

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000

  while (!(await check())) {
    if (Date.now() >= deadline) {throw new Error(`key_recovery_timeout_${label}`)}
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function device(server: TestHomeserver, deviceId: string, withholdToDevice = false) {
  const cache = recoveryKeyCache()
  let uploaded = false

  const client = createClient({
    baseUrl: server.baseUrl,
    userId: OWNER,
    deviceId,
    accessToken: server.signIn(deviceId),
    cryptoCallbacks: cache.callbacks,
    logger: quiet,
    fetchFn: async (input, init) => {
      const response = await server.fetch(input, init)
      const path = new URL(String(input)).pathname

      if (path.endsWith('/room_keys/keys') && init?.method === 'PUT' && response.ok) {uploaded = true}

      if (withholdToDevice && path.endsWith('/sync') && response.ok) {
        const data = await response.json()
        data.to_device = { events: [] }

        return new Response(JSON.stringify(data), { status: response.status, headers: response.headers })
      }

      return response
    }
  })

  await client.initRustCrypto({
    cryptoDatabasePrefix: globalThis.crypto.randomUUID(),
    storageKey: globalThis.crypto.getRandomValues(new Uint8Array(32))
  })
  const security = matrixSecurity(client, cache, () => {})
  running.push({ client, security })
  await client.startClient({ initialSyncLimit: 10, pollTimeout: 100 })
  await until(() => client.isInitialSyncComplete(), 'sync')

  return { client, security, uploaded: () => uploaded }
}

it('projects a real missing-session reason and human Restore makes the message readable', async () => {
  const server = new TestHomeserver(OWNER)
  const owner = await device(server, 'MAC')
  const key = await owner.client.getCrypto()!.createRecoveryKeyFromPassphrase()

  try {
    await owner.security.nativeCommand({ kind: 'agentIdentityCreate', key: key.encodedPrivateKey! })
    // The receiving Mac exists before the event. Suppress only its test transport's
    // room-key delivery to reproduce a lost current session, with real Rust crypto.
    const reader = await device(server, 'READER', true)
    owner.client.getCrypto()!.globalBlacklistUnverifiedDevices = false

    const { room_id: roomId } = await owner.client.createRoom({
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
    })

    await until(
      () =>
        !!owner.client.getRoom(roomId)?.hasEncryptionStateEvent() &&
        !!reader.client.getRoom(roomId)?.hasEncryptionStateEvent(),
      'room'
    )
    const { event_id: eventId } = await owner.client.sendTextMessage(roomId, 'Synthetic missing-key message')
    const event = new MatrixEvent(await reader.client.fetchRoomEvent(roomId, eventId))
    await reader.client.decryptEventIfNeeded(event)
    expect(event.isDecryptionFailure()).toBe(true)
    expect(event.decryptionFailureReason).toBe(DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID)
    expect(matrixDecryptionReason(event.decryptionFailureReason)).toBe('waiting_for_key')
    expect(matrixMessage(event, OWNER, new Set())).toMatchObject({
      decryptionFailed: true,
      decryptionReason: 'waiting_for_key',
      body: ''
    })
    await until(owner.uploaded, 'backup')
    // The user's explicit recovery command, never an automatic UI recovery.
    await reader.security.command({ kind: 'recoveryRestore', key: key.encodedPrivateKey! })
    await until(() => reader.security.snapshot().recovery === 'ready', 'restore')
    const restored = new MatrixEvent(await reader.client.fetchRoomEvent(roomId, eventId))
    await reader.client.decryptEventIfNeeded(restored)
    expect(matrixMessage(restored, OWNER, new Set())).toMatchObject({
      decryptionFailed: false,
      body: 'Synthetic missing-key message'
    })
  } finally {
    key.privateKey.fill(0)
  }
}, 90_000)
