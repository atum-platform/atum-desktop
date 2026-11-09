// @vitest-environment node
import 'fake-indexeddb/auto'

import { createClient, type MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'
import { logger, type Logger } from 'matrix-js-sdk/lib/logger'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { initializeMatrixDeviceIsolation } from './device-isolation'
import { matrixMessage } from './message'
import { matrixSecurity, recoveryKeyCache } from './security'
import { TestHomeserver } from './test-homeserver'
const OWNER = '@isolation-proof:atum.test'
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

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30_000

  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('isolation_proof_timeout')
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

// The encrypted timeline event can arrive before its to-device Megolm key.
// Wait only for that transport race; an isolation refusal must remain a refusal.
async function decryptWhenKeyArrives(client: MatrixClient, roomId: string, eventId: string) {
  let event: MatrixEvent
  await until(async () => {
    event = new MatrixEvent(await client.fetchRoomEvent(roomId, eventId))
    await client.decryptEventIfNeeded(event)

    return event.decryptionFailureReason !== DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID
  })

  return event!
}

async function device(server: TestHomeserver, deviceId: string, isolation: 'all' | 'signed', keySharing?: 'all') {
  const cache = recoveryKeyCache()

  const client = createClient({
    baseUrl: server.baseUrl,
    userId: OWNER,
    deviceId,
    accessToken: server.signIn(deviceId),
    cryptoCallbacks: cache.callbacks,
    fetchFn: server.fetch,
    logger: quiet
  })

  await client.initRustCrypto({
    cryptoDatabasePrefix: globalThis.crypto.randomUUID(),
    storageKey: globalThis.crypto.getRandomValues(new Uint8Array(32))
  })
  initializeMatrixDeviceIsolation(client.getCrypto()!, isolation, keySharing)
  const security = matrixSecurity(client, cache, () => {})
  running.push({ client, security })
  await client.startClient({ initialSyncLimit: 10, pollTimeout: 100 })
  await until(() => client.isInitialSyncComplete())

  return { client, security }
}

it.each(['all', 'signed'] as const)(
  'real Rust incoming policy in %s: unsigned refusal stays distinct from signed readability',
  async isolation => {
    const server = new TestHomeserver(OWNER)
    const mac = await device(server, 'MAC', isolation)
    const recovery = await mac.client.getCrypto()!.createRecoveryKeyFromPassphrase()

    try {
      await mac.security.nativeCommand({ kind: 'agentIdentityCreate', key: recovery.encodedPrivateKey! })
      // A noncompliant external unsigned sender stays on legacy transport only in this fixture.
      const phone = await device(server, 'PHONE', 'all', 'all')

      const { room_id: roomId } = await mac.client.createRoom({
        initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
      })

      await until(() => !!phone.client.getRoom(roomId)?.hasEncryptionStateEvent())
      await until(async () => !!(await mac.client.getCrypto()!.getDeviceVerificationStatus(OWNER, 'PHONE')))
      const unsigned = await phone.client.sendTextMessage(roomId, 'Synthetic unsigned sender')
      const first = await decryptWhenKeyArrives(mac.client, roomId, unsigned.event_id)

      if (isolation === 'signed') {
        expect(first.decryptionFailureReason).toBe(DecryptionFailureCode.UNSIGNED_SENDER_DEVICE)
        expect(matrixMessage(first, OWNER, new Set())).toMatchObject({
          decryptionFailed: true,
          decryptionReason: 'sender_unverified'
        })
      } else {
        expect(first.isDecryptionFailure()).toBe(false)
      }

      await mac.client.getCrypto()!.crossSignDevice('PHONE')
      await until(
        async () => !!(await mac.client.getCrypto()!.getDeviceVerificationStatus(OWNER, 'PHONE'))?.crossSigningVerified
      )
      const signed = await phone.client.sendTextMessage(roomId, 'Synthetic signed sender')
      const second = await decryptWhenKeyArrives(mac.client, roomId, signed.event_id)
      expect(second.isDecryptionFailure()).toBe(false)
      expect(second.getContent().body).toBe('Synthetic signed sender')
    } finally {
      recovery.privateKey.fill(0)
    }
  },
  90_000
)
