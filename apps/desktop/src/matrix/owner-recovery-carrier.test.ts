import { EventEmitter } from 'node:events'

import { ClientEvent, type MatrixClient } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixOwnerRecoveryEvent } from '../../shared/matrix-security'

import { ownerRecoveryCarrier } from './owner-recovery-carrier'

const ME = '@fixture-owner:atumplatform.com'
const THIS_MAC = 'ATUM_newmac'
const MACBOOK = 'ATUM_macbook'
const NONCE = 'ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM'
const TXN = '00000000-0000-4000-8000-3833bb080cbb'
// A sample, never a real key.
const KEY = 'EsTc Samp leKe yNot ReaL 0000 1111 2222 3333 4444 5555 6666'

const request = (): MatrixOwnerRecoveryEvent => ({
  type: 'io.atum.owner_recovery.request',
  content: { v: 1, nonce: NONCE, txn: TXN }
})

const grant = (): MatrixOwnerRecoveryEvent => ({
  type: 'io.atum.owner_recovery.grant',
  content: { v: 1, nonce: NONCE, txn: TXN, recoveryKey: KEY, keyId: 'qwen3.5-plus' }
})

function fixture(now: () => number = Date.now) {
  const client = new EventEmitter()
  const batch = {
    eventType: 'm.room.encrypted',
    batch: [{ userId: ME, deviceId: MACBOOK, payload: { algorithm: 'm.olm.v1.curve25519-aes-sha2' } }]
  }
  const crypto = { encryptToDeviceMessages: vi.fn(async () => batch) }
  const sendToDevice = vi.fn(async () => {})
  Object.assign(client, { getCrypto: () => crypto, sendToDevice, getUserId: () => ME, getDeviceId: () => THIS_MAC })
  const carrier = ownerRecoveryCarrier(client as unknown as MatrixClient, now)

  const receive = (
    event: MatrixOwnerRecoveryEvent | Record<string, unknown>,
    info: Record<string, unknown> | null = {}
  ) =>
    client.emit(ClientEvent.ReceivedToDeviceMessage, {
      message: { ...event, sender: (info?.sender as string) ?? ME },
      encryptionInfo:
        info === null
          ? null
          : { sender: ME, senderDevice: MACBOOK, senderCurve25519KeyBase64: 'curve', senderVerified: true, ...info }
    })

  return { batch, carrier, client, crypto, sendToDevice, receive }
}

afterEach(() => vi.clearAllMocks())

describe('the recovery key between one person’s own devices', () => {
  it('sends only the two fixed messages, encrypted, to another device of the same person', async () => {
    const f = fixture()

    await f.carrier.command({
      kind: 'ownerRecoveryToDeviceSend',
      recipient: { userId: ME, deviceId: MACBOOK },
      event: grant()
    })
    expect(f.crypto.encryptToDeviceMessages).toHaveBeenCalledExactlyOnceWith(
      'io.atum.owner_recovery.grant',
      [{ userId: ME, deviceId: MACBOOK }],
      grant().content
    )
    expect(f.sendToDevice).toHaveBeenCalledExactlyOnceWith(
      f.batch.eventType,
      new Map([[ME, new Map([[MACBOOK, f.batch.batch[0]!.payload]])]])
    )

    for (const [recipient, event] of [
      [{ userId: '@someone:atumplatform.com', deviceId: MACBOOK }, grant()],
      [{ userId: ME, deviceId: THIS_MAC }, grant()],
      [
        { userId: ME, deviceId: MACBOOK },
        { ...grant(), type: 'm.room.message' }
      ],
      [
        { userId: ME, deviceId: MACBOOK },
        { ...request(), content: { ...request().content, extra: 1 } }
      ],
      [
        { userId: ME, deviceId: MACBOOK },
        { ...grant(), content: { ...grant().content, recoveryKey: 'not\na key' } }
      ],
      [
        { userId: ME, deviceId: MACBOOK },
        { ...request(), content: { ...request().content, nonce: 'short' } }
      ]
    ] as const) {
      await expect(
        f.carrier.command({ kind: 'ownerRecoveryToDeviceSend', recipient, event: event as MatrixOwnerRecoveryEvent })
      ).rejects.toThrow('matrix_owner_recovery_invalid')
    }

    expect(f.crypto.encryptToDeviceMessages).toHaveBeenCalledOnce()
  })

  it('opens the encrypted channel with an empty m.dummy, only to another device of the same person', async () => {
    const f = fixture()

    await f.carrier.command({ kind: 'ownerRecoveryChannelOpen', recipient: { userId: ME, deviceId: MACBOOK } })
    expect(f.crypto.encryptToDeviceMessages).toHaveBeenCalledExactlyOnceWith(
      'm.dummy',
      [{ userId: ME, deviceId: MACBOOK }],
      {}
    )
    expect(f.sendToDevice).toHaveBeenCalledExactlyOnceWith(
      f.batch.eventType,
      new Map([[ME, new Map([[MACBOOK, f.batch.batch[0]!.payload]])]])
    )

    for (const recipient of [
      { userId: '@someone:atumplatform.com', deviceId: MACBOOK },
      { userId: ME, deviceId: THIS_MAC },
      { userId: ME, deviceId: 'not a device' }
    ]) {
      await expect(f.carrier.command({ kind: 'ownerRecoveryChannelOpen', recipient })).rejects.toThrow(
        'matrix_owner_recovery_invalid'
      )
    }

    expect(f.crypto.encryptToDeviceMessages).toHaveBeenCalledOnce()
  })

  it('does not report an encrypted handoff sent until the homeserver accepts it', async () => {
    const f = fixture()
    let accept!: () => void
    const accepted = new Promise<void>(resolve => {
      accept = resolve
    })
    f.sendToDevice.mockReturnValueOnce(accepted)
    let settled = false
    const sent = f.carrier
      .command({ kind: 'ownerRecoveryToDeviceSend', recipient: { userId: ME, deviceId: MACBOOK }, event: grant() })
      .then(() => {
        settled = true
      })

    await Promise.resolve()
    expect(f.sendToDevice).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    accept()
    await sent
    expect(settled).toBe(true)
  })

  it('propagates a rejected encrypted handoff so the approval nonce retry can ask again', async () => {
    const f = fixture()
    f.sendToDevice.mockRejectedValueOnce(new Error('offline'))

    await expect(
      f.carrier.command({ kind: 'ownerRecoveryToDeviceSend', recipient: { userId: ME, deviceId: MACBOOK }, event: grant() })
    ).rejects.toThrow('offline')
    expect(f.sendToDevice).toHaveBeenCalledOnce()
  })

  it('accepts only what the SDK decrypted from a device this one verified, of the same person', async () => {
    const f = fixture()

    f.receive(grant(), null) // sent in clear
    f.receive(grant(), { senderVerified: false }) // a device not verified here
    f.receive(grant(), { sender: '@someone:atumplatform.com' }) // another person
    f.receive(grant(), { senderDevice: undefined })
    f.receive(grant(), { senderDevice: THIS_MAC }) // this device itself
    f.receive({ ...grant(), type: 'm.room.message' })
    f.receive({ ...grant(), content: { ...grant().content, keyId: undefined } })

    await expect(f.carrier.command({ kind: 'ownerRecoveryToDeviceRead', senderDeviceId: MACBOOK })).resolves.toEqual([])

    f.receive(grant())
    const read = await f.carrier.command({ kind: 'ownerRecoveryToDeviceRead', senderDeviceId: MACBOOK })
    expect(read).toEqual([expect.objectContaining({ ...grant(), senderDeviceId: MACBOOK })])

    // Read once: nothing stays behind.
    await expect(f.carrier.command({ kind: 'ownerRecoveryToDeviceRead', senderDeviceId: MACBOOK })).resolves.toEqual([])
  })

  it('names the comparison by the SDK’s own transaction ID, and never anything with spaces or too long', async () => {
    const f = fixture()

    for (const txn of ['mxJ9TBzv3Q0wQ6c1', 'm1791198990752.0', TXN]) {
      await f.carrier.command({
        kind: 'ownerRecoveryToDeviceSend',
        recipient: { userId: ME, deviceId: MACBOOK },
        event: { type: 'io.atum.owner_recovery.request', content: { v: 1, nonce: NONCE, txn } }
      })
    }

    for (const txn of ['', 'has space', 'x'.repeat(256), 'tab\there']) {
      await expect(
        f.carrier.command({
          kind: 'ownerRecoveryToDeviceSend',
          recipient: { userId: ME, deviceId: MACBOOK },
          event: { type: 'io.atum.owner_recovery.request', content: { v: 1, nonce: NONCE, txn } }
        })
      ).rejects.toThrow('matrix_owner_recovery_invalid')
    }

    expect(f.crypto.encryptToDeviceMessages).toHaveBeenCalledTimes(3)
  })

  it('keeps the newest messages when many arrive unread: a device asking again is never shut out', async () => {
    const f = fixture()
    const nonce = (index: number) => `${String(index).padStart(2, '0')}${NONCE.slice(2)}`

    for (let index = 0; index < 40; index++) {
      f.receive({ type: 'io.atum.owner_recovery.request', content: { v: 1, nonce: nonce(index), txn: TXN } })
    }

    const read = (await f.carrier.command({
      kind: 'ownerRecoveryToDeviceRead',
      senderDeviceId: MACBOOK
    })) as Array<{ content: { nonce: string } }>

    expect(read).toHaveLength(32)
    expect(read.at(-1)!.content.nonce).toBe(nonce(39))
    expect(read[0]!.content.nonce).toBe(nonce(8))
  })

  it('reads one device’s messages, leaves another’s, and holds nothing after it stops', async () => {
    const f = fixture()
    f.receive(request(), { senderDevice: 'ATUM_other' })
    f.receive(request())

    expect(await f.carrier.command({ kind: 'ownerRecoveryToDeviceRead', senderDeviceId: MACBOOK })).toHaveLength(1)
    expect(await f.carrier.command({ kind: 'ownerRecoveryToDeviceRead', senderDeviceId: 'ATUM_other' })).toHaveLength(1)

    f.receive(request())
    f.carrier.stop()
    expect(f.client.listenerCount(ClientEvent.ReceivedToDeviceMessage)).toBe(0)
    await expect(f.carrier.command({ kind: 'ownerRecoveryToDeviceRead', senderDeviceId: MACBOOK })).rejects.toThrow(
      'matrix_owner_recovery_stopped'
    )
  })

  it('says why it dropped each message, by reason only, so a quiet handoff can be explained', async () => {
    let time = Date.UTC(2026, 9, 9, 7)
    const f = fixture(() => time)

    f.receive(grant(), null)
    f.receive(grant(), { senderVerified: false })
    f.receive(request(), { senderVerified: false })
    f.receive(grant(), { sender: '@someone:atumplatform.com' })
    f.receive(grant(), { senderDevice: undefined })
    f.receive(grant(), { senderDevice: THIS_MAC })
    f.receive({ ...grant(), content: { ...grant().content, keyId: undefined } })
    // Not an owner-recovery message at all: not this carrier's to count.
    f.receive({ ...grant(), type: 'm.room.message' })

    const drops = await f.carrier.command({ kind: 'ownerRecoveryDrops' })
    expect(drops).toEqual(
      expect.arrayContaining([
        { reason: 'not_encrypted', count: 1 },
        { reason: 'unverified_sender', count: 2 },
        { reason: 'other_person', count: 1 },
        { reason: 'unknown_sender', count: 1 },
        { reason: 'own_device', count: 1 },
        { reason: 'invalid', count: 1 }
      ])
    )
    expect(drops).toHaveLength(6)
    // Reasons and counts only: never the key, the nonce, the person or a device.
    const text = JSON.stringify(drops)

    for (const secret of [KEY, NONCE, TXN, ME, MACBOOK, THIS_MAC]) {
      expect(text).not.toContain(secret)
    }

    // Read once.
    await expect(f.carrier.command({ kind: 'ownerRecoveryDrops' })).resolves.toEqual([])

    // A drop from an earlier handoff is not reported as this one's.
    f.receive(grant(), { senderVerified: false })
    time += 11 * 60 * 1000
    await expect(f.carrier.command({ kind: 'ownerRecoveryDrops' })).resolves.toEqual([])

    // A message pushed out by newer ones unread is a drop too.
    for (let index = 0; index < 33; index++) {
      f.receive(request())
    }

    await expect(f.carrier.command({ kind: 'ownerRecoveryDrops' })).resolves.toEqual([{ reason: 'overflow', count: 1 }])
  })
})
