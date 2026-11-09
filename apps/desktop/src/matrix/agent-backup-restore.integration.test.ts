// @vitest-environment node
import 'fake-indexeddb/auto'

import { createClient, type MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { EventShieldReason } from 'matrix-js-sdk/lib/crypto-api'
import { type Logger, logger } from 'matrix-js-sdk/lib/logger'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { decryptMatrixInvocation } from './invocation-decryption-retry'
import { readMatrixInvocation } from './read-invocation'
import { matrixSecurity, recoveryKeyCache } from './security'
import { trustedMatrixSender } from './sender-trust'
import { TestHomeserver } from './test-homeserver'

const AGENT = '@restored-agent:atum.test'

const quiet: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return quiet
  }
}

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
    if (Date.now() >= deadline) {
      throw new Error(`agent_backup_timeout_${label}`)
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function device(server: TestHomeserver, id: string) {
  const cache = recoveryKeyCache()
  let uploads = 0

  const client = createClient({
    baseUrl: server.baseUrl,
    userId: AGENT,
    deviceId: id,
    accessToken: server.signIn(id),
    fetchFn: async (input, init) => {
      const response = await server.fetch(input, init)

      if (
        /^\/_matrix\/client\/(?:v3|r0)\/room_keys\/keys$/.test(new URL(String(input)).pathname) &&
        init?.method === 'PUT' &&
        response.ok
      ) {
        uploads++
      }

      return response
    },
    cryptoCallbacks: cache.callbacks,
    logger: quiet
  })

  await client.initRustCrypto({
    cryptoDatabasePrefix: `backup-${globalThis.crypto.randomUUID()}`,
    storageKey: globalThis.crypto.getRandomValues(new Uint8Array(32))
  })
  const security = matrixSecurity(client, cache, () => {})
  running.push({ client, security })
  client.getCrypto()!.globalBlacklistUnverifiedDevices = true
  await client.startClient({ initialSyncLimit: 10, pollTimeout: 100 })
  await until(() => client.isInitialSyncComplete(), 'sync')

  return { client, security, uploads: () => uploads }
}

it('restores a fresh executor’s pre-existing history from the agent backup (real Rust crypto)', async () => {
  const server = new TestHomeserver(AGENT)
  const original = await device(server, 'ORIGINAL')
  const key = await original.client.getCrypto()!.createRecoveryKeyFromPassphrase()

  try {
    await original.security.nativeCommand({ kind: 'agentIdentityCreate', key: key.encodedPrivateKey! })

    const { room_id: roomId } = await original.client.createRoom({
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
    })

    await until(() => !!original.client.getRoom(roomId)?.hasEncryptionStateEvent(), 'room')
    const { event_id: eventId } = await original.client.sendTextMessage(roomId, 'Synthetic pre-replacement history')
    await until(() => original.uploads() > 0, 'backup_upload')
    original.security.stop()
    original.client.stopClient()

    const replacement = await device(server, 'REPLACEMENT')
    const target = { roomId, eventId }
    const before = new MatrixEvent(await replacement.client.fetchRoomEvent(roomId, eventId))
    await replacement.client.decryptEventIfNeeded(before)
    expect(before.isDecryptionFailure()).toBe(true)
    await replacement.security.nativeCommand({ kind: 'agentIdentityRestore', key: key.encodedPrivateKey! })
    // Historical backup recovery is asynchronous. Exercise the actual helper
    // while imports arrive; never mock the SDK's decryption or reason selection.
    await until(async () => {
      const event = new MatrixEvent(await replacement.client.fetchRoomEvent(roomId, eventId))

      return !(await decryptMatrixInvocation(replacement.client, event)).isDecryptionFailure()
    }, 'history_restore')
    const viaRetry = await decryptMatrixInvocation(replacement.client, before)
    expect(viaRetry.isDecryptionFailure()).toBe(false)
    expect(viaRetry.getContent().body).toBe('Synthetic pre-replacement history')
    const restored = await readMatrixInvocation(replacement.client, target)
    expect(restored.content.body).toBe('Synthetic pre-replacement history')
    // Backup restores readability. SDK provenance remains authoritative for admission.
    const restoredWire = new MatrixEvent(await replacement.client.fetchRoomEvent(roomId, eventId))
    await replacement.client.decryptEventIfNeeded(restoredWire)
    const provenance = await replacement.client.getCrypto()!.getEncryptionInfoForEvent(restoredWire)
    const trust = await replacement.client.getCrypto()!.getDeviceVerificationStatus(AGENT, 'ORIGINAL')
    expect(restored.senderVerified).toBe(trustedMatrixSender(trust, provenance))
    expect({
      verified: trust?.isVerified(),
      reason: provenance?.shieldReason,
      admitted: restored.senderVerified
    }).toEqual({
      verified: true,
      reason: EventShieldReason.AUTHENTICITY_NOT_GUARANTEED,
      admitted: false
    })

    // A never-restored executor cannot read the history, even after the bounded retry.
    const unsigned = await device(server, 'UNSIGNED')

    const unreadable = await decryptMatrixInvocation(
      unsigned.client,
      new MatrixEvent(await unsigned.client.fetchRoomEvent(roomId, eventId))
    )

    expect(unreadable.isDecryptionFailure()).toBe(true)
    await expect(readMatrixInvocation(unsigned.client, target)).rejects.toThrow('matrix_invocation_untrusted')
    expect(
      (await replacement.client.getCrypto()!.getDeviceVerificationStatus(AGENT, 'UNSIGNED'))?.isVerified()
    ).not.toBe(true)
  } finally {
    key.privateKey.fill(0)
  }
}, 90_000)
