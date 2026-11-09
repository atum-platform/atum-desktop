// @vitest-environment node
import 'fake-indexeddb/auto'

import { createClient, type MatrixClient } from 'matrix-js-sdk'
import type { Logger } from 'matrix-js-sdk/lib/logger'
import { afterEach, describe, expect, it } from 'vitest'

import { readMatrixInvocation } from './read-invocation'
import { matrixSecurity, recoveryKeyCache } from './security'
import { TestHomeserver } from './test-homeserver'

const OWNER = '@trust-proof:atum.test'

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

const devices: Array<{ client: MatrixClient; security: ReturnType<typeof matrixSecurity> }> = []

afterEach(() => {
  for (const device of devices.splice(0)) {
    device.security.stop()
    device.client.stopClient()
  }
})

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000

  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error(`trust_proof_timeout: ${label}`)
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function backupKeyPresent(client: MatrixClient) {
  const key = await client.getCrypto()!.getSessionBackupPrivateKey()
  const present = !!key?.length
  key?.fill(0)

  return present
}

async function device(server: TestHomeserver, id: string) {
  const cache = recoveryKeyCache()
  let backupUploads = 0

  const client = createClient({
    baseUrl: server.baseUrl,
    userId: OWNER,
    deviceId: id,
    accessToken: server.signIn(id),
    fetchFn: async (input, init) => {
      const response = await server.fetch(input, init)

      if (String(input).includes('/room_keys/keys') && init?.method === 'PUT' && response.ok) {
        backupUploads += 1
      }

      return response
    },
    cryptoCallbacks: cache.callbacks,
    verificationMethods: ['m.sas.v1'],
    logger: quiet
  })

  await client.initRustCrypto({
    cryptoDatabasePrefix: `trust-proof-${globalThis.crypto.randomUUID()}`,
    storageKey: globalThis.crypto.getRandomValues(new Uint8Array(32))
  })
  const security = matrixSecurity(client, cache, () => {})
  const result = { client, security, backupUploads: () => backupUploads }
  devices.push(result)
  client.getCrypto()!.globalBlacklistUnverifiedDevices = true
  await client.startClient({ initialSyncLimit: 1, pollTimeout: 100 })
  await until(() => client.isInitialSyncComplete(), 'initial sync')

  return result
}

async function fixture() {
  const server = new TestHomeserver(OWNER)
  const mac = await device(server, 'MAC')
  const staged = (await mac.security.command({ kind: 'recoveryCreateKey' })) as { id: string }
  await mac.security.command({ kind: 'recoverySetUp', id: staged.id })
  await until(async () => !!(await mac.client.getCrypto()!.getActiveSessionBackupVersion()), 'backup setup')
  const phone = await device(server, 'PHONE')
  const unsigned = await device(server, 'UNSIGNED')

  return { mac, phone, unsigned }
}

async function compare(mac: Awaited<ReturnType<typeof device>>, phone: Awaited<ReturnType<typeof device>>) {
  await mac.security.command({ kind: 'verificationStart', userId: OWNER, deviceId: 'PHONE' })
  await until(() => phone.security.snapshot().verification?.state === 'requested', 'phone request')
  await phone.security.command({
    kind: 'verificationRespond',
    id: phone.security.snapshot().verification!.id,
    action: 'accept'
  })
  await until(() => mac.security.snapshot().verification?.state === 'ready', 'Mac ready')
  await mac.security.command({
    kind: 'verificationRespond',
    id: mac.security.snapshot().verification!.id,
    action: 'start'
  })
  await until(() => [mac, phone].every(d => d.security.snapshot().verification?.state === 'compare'), 'SAS comparison')
  expect(mac.security.snapshot().verification!.emoji).toEqual(phone.security.snapshot().verification!.emoji)
}

describe('Element-style verification and Matrix backup secret sharing (real Rust crypto)', () => {
  it('cross-signs the phone after SAS and gives it the backup key without the Atum recovery carrier', async () => {
    const { mac, phone, unsigned } = await fixture()
    expect((await mac.client.getCrypto()!.getDeviceVerificationStatus(OWNER, 'PHONE'))?.crossSigningVerified).toBe(
      false
    )
    expect(await backupKeyPresent(phone.client)).toBe(false)
    await compare(mac, phone)
    await Promise.all(
      [mac, phone].map(d =>
        d.security.command({
          kind: 'verificationRespond',
          id: d.security.snapshot().verification!.id,
          action: 'confirm'
        })
      )
    )
    await until(() => mac.security.snapshot().verification?.state === 'done', 'SAS completion')
    await mac.security.nativeCommand({ kind: 'approveOwnDevice', deviceId: 'PHONE' })
    await until(
      async () =>
        (await mac.client.getCrypto()!.getDeviceVerificationStatus(OWNER, 'PHONE'))?.crossSigningVerified === true,
      'phone signature'
    )
    await until(async () => {
      const key = await phone.client.getCrypto()!.getSessionBackupPrivateKey()
      const present = !!key?.length
      key?.fill(0)

      return present
    }, 'Matrix backup secret delivery')
    const macKey = await mac.client.getCrypto()!.getSessionBackupPrivateKey()
    const phoneKey = await phone.client.getCrypto()!.getSessionBackupPrivateKey()

    // Never pass key bytes to an assertion: failed assertions print their operands.
    const same =
      !!macKey && !!phoneKey && macKey.length === phoneKey.length && macKey.every((b, i) => b === phoneKey[i])

    macKey?.fill(0)
    phoneKey?.fill(0)
    expect(same).toBe(true)
    await phone.client.getCrypto()!.checkKeyBackupAndEnable()
    await until(async () => !!(await phone.client.getCrypto()!.getActiveSessionBackupVersion()), 'phone backup enabled')

    const { room_id: roomId } = await mac.client.createRoom({
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
    })

    await until(
      () => [mac, phone, unsigned].every(d => d.client.getRoom(roomId)?.hasEncryptionStateEvent()),
      'encrypted room sync'
    )
    const { event_id: eventId } = await phone.client.sendTextMessage(roomId, 'Synthetic trust proof')
    const invocation = await readMatrixInvocation(mac.client, { roomId, eventId })
    expect(invocation.senderVerified).toBe(true)
    expect(invocation.content.body).toBe('Synthetic trust proof')
    await until(() => phone.backupUploads() > 0, 'phone session backup upload')
    // This phone has the room key but remains unsigned. Decrypting its message
    // must not grant execution authority (invocation.ts rejects this projection).
    unsigned.client.getCrypto()!.globalBlacklistUnverifiedDevices = false
    const unsignedEvent = await unsigned.client.sendTextMessage(roomId, 'Synthetic unsigned sender')

    const admitted = await readMatrixInvocation(mac.client, { roomId, eventId: unsignedEvent.event_id }).then(
      message => message.senderVerified,
      error => {
        expect(error.message).toBe('matrix_invocation_untrusted')

        return false
      }
    )

    expect(admitted).toBe(false)
    expect((await mac.client.getCrypto()!.getDeviceVerificationStatus(OWNER, 'UNSIGNED'))?.isVerified()).toBe(false)
    expect(await backupKeyPresent(unsigned.client)).toBe(false)

    // A second create must not overwrite the shared fixture's first timeline.
    const secondRoomRefused = await mac.client.createRoom({}).then(
      () => false,
      error => error?.errcode === 'M_INVALID_PARAM'
    )

    expect(secondRoomRefused).toBe(true)
    expect((await readMatrixInvocation(mac.client, { roomId, eventId })).senderVerified).toBe(true)
  }, 90_000)

  it.each(['cancel', 'mismatch'] as const)(
    'does not sign or share secrets after %s',
    async action => {
      const { mac, phone } = await fixture()
      await compare(mac, phone)
      await mac.security.command({ kind: 'verificationRespond', id: mac.security.snapshot().verification!.id, action })
      await until(() => phone.security.snapshot().verification?.state === 'cancelled', 'phone cancellation')
      await expect(mac.security.nativeCommand({ kind: 'approveOwnDevice', deviceId: 'PHONE' })).rejects.toThrow(
        'matrix_verification_stale'
      )
      expect((await mac.client.getCrypto()!.getDeviceVerificationStatus(OWNER, 'PHONE'))?.crossSigningVerified).toBe(
        false
      )
      expect(await backupKeyPresent(phone.client)).toBe(false)
    },
    90_000
  )
})
