import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { EncryptedStore } from '../../encrypted-store'

import { originAssertionHash, originSignedBytes, requestDigestV2, verifyDeviceSignature } from './device-key'
import { SoftwareDeviceSigner } from './device-signer.fixture'
import { DEVICE_ORIGIN, DeviceOrigin } from './origin'

const packs = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/device-protocol/fixtures')
const fixture = (name: string) => JSON.parse(readFileSync(join(packs, 'cloud-answering', 'fixtures', name), 'utf8'))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function store() {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-origin-'))
  directories.push(directory)

  return new EncryptedStore(path.join(directory, 'device-service.json'), {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })
}

const verified = fixture('origin-verified.case.json')
const expected = fixture('origin.assertion.json')
const { 'io.atum.origin': _origin, ...content } = fixture('origin.content.json')

function origin(
  options: { now?: () => number; nonce?: () => string; signer?: SoftwareDeviceSigner; ae?: number } = {}
) {
  const signer = options.signer ?? new SoftwareDeviceSigner()
  const vault = store()
  let clock = expected.t as number

  const subject = new DeviceOrigin({
    store: vault,
    signer,
    identity: () => ({
      deviceServiceId: expected.dsid,
      identityKid: signer.identity.public.kid,
      enrollmentEpoch: expected.ee
    }),
    accountEpoch: () => options.ae ?? expected.ae,
    bootId: () => expected.boot,
    now: options.now ?? (() => clock),
    nonce: options.nonce ?? (() => expected.n)
  })

  return { subject, signer, vault, advance: (ms: number) => (clock += ms) }
}

const owner = { userId: expected.owner, deviceId: expected.dev, fingerprint: expected.fpr }
const input = { transactionId: 'atum-q-1', roomId: expected.room, agentUserId: expected.agent, owner, content }

describe('the origin assertion this Mac signs', () => {
  it('is exactly the contract assertion for the fixture message, signed by this Mac', async () => {
    const { subject, signer } = origin()
    const assertion = (await subject.assert(input))!

    const { sig, kid, ...fields } = assertion
    const { sig: _sig, kid: _kid, ...contract } = expected
    expect(fields).toEqual(contract)
    expect(assertion.dg).toBe(verified.facts.contentDigest)
    expect(kid).toBe(signer.identity.public.kid)

    const { sig: _unused, ...unsigned } = assertion
    expect(verifyDeviceSignature(signer.identity.public.spki, originSignedBytes(unsigned), sig)).toBe(true)
  })

  it('frames the signature as the platform does: the fixture signature verifies under our framing', () => {
    const { sig, ...unsigned } = expected

    const identityKey = verified.registry.find(
      (row: { identityKeyId: string }) => row.identityKeyId === expected.kid
    ).identityKey

    expect(verifyDeviceSignature(identityKey, originSignedBytes(unsigned), sig)).toBe(true)
    expect(originAssertionHash(unsigned)).toBe(verified.facts.assertionHash)
  })

  it('covers every byte of the content: a changed body is a different digest', async () => {
    const { subject } = origin()

    const changed = (await subject.assert({
      ...input,
      transactionId: 'atum-q-2',
      content: { ...content, body: `${content.body}!` }
    }))!

    expect(changed.dg).not.toBe(expected.dg)
    expect(changed.dg).toBe(requestDigestV2({ ...content, body: `${content.body}!` }))
  })

  it('is reused for a re-send of the same question while fresh, and minted again when too old', async () => {
    let nonce = 0
    const { subject, advance } = origin({ nonce: () => `nonce-${String(++nonce).padStart(16, '0')}` })

    const first = await subject.assert(input)
    advance(60_000)
    expect(await subject.assert(input)).toEqual(first)

    advance(DEVICE_ORIGIN.reuseMs)
    const second = await subject.assert(input)
    expect(second!.n).not.toBe(first!.n)
  })

  it('is minted again after an account switch, never reused across account epochs', async () => {
    let ae = 7
    const signer = new SoftwareDeviceSigner()
    const vault = store()
    let n = 0

    const subject = new DeviceOrigin({
      store: vault,
      signer,
      identity: () => ({ deviceServiceId: expected.dsid, identityKid: signer.identity.public.kid, enrollmentEpoch: 3 }),
      accountEpoch: () => ae,
      bootId: () => expected.boot,
      now: () => expected.t,
      nonce: () => `n-${String(++n).padStart(20, '0')}`
    })

    const before = await subject.assert(input)
    ae = 8
    const after = await subject.assert(input)

    expect(after!.ae).toBe(8)
    expect(after!.n).not.toBe(before!.n)
  })

  it('is not made at all on a Mac without an active enrollment', async () => {
    const subject = new DeviceOrigin({
      store: store(),
      signer: new SoftwareDeviceSigner(),
      identity: () => null,
      accountEpoch: () => 1,
      bootId: () => expected.boot
    })

    expect(await subject.assert(input)).toBeNull()
  })

  it('refuses content that already carries an assertion, and malformed bindings', async () => {
    const { subject } = origin()

    await expect(subject.assert({ ...input, content: { ...content, 'io.atum.origin': expected } })).rejects.toThrow(
      'device_origin_invalid'
    )
    await expect(subject.assert({ ...input, roomId: 'not-a-room' })).rejects.toThrow('device_origin_invalid')
    await expect(subject.assert({ ...input, owner: { ...owner, fingerprint: 'short' } })).rejects.toThrow(
      'device_origin_invalid'
    )
  })
})

describe("the device's origin log (admission step 9)", () => {
  const eventId = verified.message.eventId as string

  it('binds the assertion to the event the chat server returned, and to nothing else', async () => {
    const { subject } = origin()
    const assertion = (await subject.assert(input))!
    const { sig: _sig, ...unsigned } = assertion
    const assertionHash = originAssertionHash(unsigned)

    expect(subject.matches({ assertionHash, roomId: input.roomId, eventId })).toBe(false)

    const receipts = subject.sent(input.transactionId, input.roomId, eventId)
    expect(receipts).toEqual([{ assertionHash, roomId: input.roomId, eventId }])

    expect(subject.matches({ assertionHash, roomId: input.roomId, eventId })).toBe(true)
    // A genuine assertion presented with another event is origin_not_mine.
    expect(subject.matches({ assertionHash, roomId: input.roomId, eventId: '$someOtherEvent' })).toBe(false)
    expect(subject.matches({ assertionHash, roomId: '!other:atumplatform.com', eventId })).toBe(false)
  })

  it('survives a restart between the send and its acknowledgement', async () => {
    const signer = new SoftwareDeviceSigner()
    const vault = store()

    const make = () =>
      new DeviceOrigin({
        store: vault,
        signer,
        identity: () => ({
          deviceServiceId: expected.dsid,
          identityKid: signer.identity.public.kid,
          enrollmentEpoch: 3
        }),
        accountEpoch: () => 7,
        bootId: () => expected.boot,
        now: () => expected.t,
        nonce: () => expected.n
      })

    const assertion = (await make().assert(input))!
    // The app quit before the SDK answered; after the restart a read-back found the event.
    const restarted = make()
    const { sig: _sig, ...unsigned } = assertion
    expect(restarted.sent(input.transactionId, input.roomId, eventId)).toHaveLength(1)
    expect(restarted.matches({ assertionHash: originAssertionHash(unsigned), roomId: input.roomId, eventId })).toBe(
      true
    )
  })

  it('logs every assertion minted for a transaction against the event, so a deduplicated re-send still matches', async () => {
    let clock = expected.t as number
    let n = 0
    const { subject } = origin({ now: () => clock, nonce: () => `n-${String(++n).padStart(20, '0')}` })

    const first = (await subject.assert(input))!
    clock += DEVICE_ORIGIN.reuseMs + 1
    const second = (await subject.assert(input))!

    // The server kept the first content (same transaction); either assertion may be the event's.
    const receipts = subject.sent(input.transactionId, input.roomId, eventId)
    expect(receipts).toHaveLength(2)

    for (const assertion of [first, second]) {
      const { sig: _sig, ...unsigned } = assertion
      expect(subject.matches({ assertionHash: originAssertionHash(unsigned), roomId: input.roomId, eventId })).toBe(
        true
      )
    }
  })

  it('offers each receipt until it went out, and forgets entries after the nonce window', async () => {
    let clock = expected.t as number
    const { subject } = origin({ now: () => clock })
    await subject.assert(input)
    const [receipt] = subject.sent(input.transactionId, input.roomId, eventId)

    expect(subject.unreceipted()).toEqual([receipt])
    subject.receipted([receipt!])
    expect(subject.unreceipted()).toEqual([])

    clock += DEVICE_ORIGIN.logMs + 1
    await subject.assert({ ...input, transactionId: 'atum-q-later' })
    subject.sent('atum-q-later', input.roomId, '$later')
    expect(subject.matches(receipt!)).toBe(false)
  })

  it('logs nothing for an unknown transaction or another room', async () => {
    const { subject } = origin()
    await subject.assert(input)

    expect(subject.sent('atum-q-unknown', input.roomId, eventId)).toEqual([])
    expect(subject.sent(input.transactionId, '!elsewhere:atumplatform.com', eventId)).toEqual([])
  })
})
