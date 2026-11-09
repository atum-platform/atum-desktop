import { describe, expect, it } from 'vitest'

import { verifyDeviceSignature } from '../device/device-key'

import { AGENT, COMPUTER, OWNER, signedRecipientRecord } from './__fixtures__/recipient-record'
import { SoftwareDeviceKeys, softwareEd25519, softwareRecipient } from './__fixtures__/software-keys'
import { cloudDeviceSignedBytes, parseRecipientKeyReadRequest } from './contract'
import {
  readTrustedRecipientKey,
  RECIPIENT_KEY_REQUEST_TTL_MS,
  type RecipientKeyDeps,
  RecipientKeyError
} from './recipient-key'

const NOW = 1_800_000_000_000
const signal = new AbortController().signal

async function harness(
  change: Partial<RecipientKeyDeps> = {},
  record: (options: Parameters<typeof signedRecipientRecord>[0]) => Record<string, any> = signedRecipientRecord
) {
  const controller = softwareEd25519()
  const device = new SoftwareDeviceKeys()
  const recipient = await softwareRecipient()
  const requests: any[] = []
  let ids = 0

  const deps: RecipientKeyDeps = {
    read: async request => {
      requests.push(request)

      return record({
        controller,
        hpkePublicKey: recipient.hpkePublicKey,
        hpkeKeyId: recipient.hpkeKeyId,
        now: NOW,
        request
      })
    },
    ownerUserId: OWNER,
    agentPrincipal: AGENT,
    computer: { computerId: COMPUTER, attachmentEpoch: 7 },
    identity: { kid: device.identity.kid, sign: bytes => device.signIdentity(bytes) },
    pinned: [{ kid: controller.kid, publicKey: controller.spki }],
    now: () => NOW,
    randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    randomNonce: () => 'N'.repeat(43),
    ...change
  }

  return { deps, controller, device, recipient, requests }
}

const refusal = async (deps: RecipientKeyDeps) => {
  try {
    await readTrustedRecipientKey(deps, signal)
  } catch (error) {
    return error instanceof RecipientKeyError ? error.reason : `unexpected: ${String(error)}`
  }

  return 'accepted'
}

describe('reading the computer’s key', () => {
  it('returns the key a pinned controller signed for this owner, computer, epoch and agent', async () => {
    const { deps, recipient } = await harness()

    await expect(readTrustedRecipientKey(deps, signal)).resolves.toEqual({
      computerId: COMPUTER,
      attachmentEpoch: 7,
      hpkePublicKey: recipient.hpkePublicKey,
      hpkeKeyId: recipient.hpkeKeyId
    })
  })

  it('asks as the owner client, signed by this Mac’s identity key, bound to the computer and epoch', async () => {
    const { deps, device, requests } = await harness()
    await readTrustedRecipientKey(deps, signal)

    const request = parseRecipientKeyReadRequest(requests[0])
    expect(request).toMatchObject({ ownerUserId: OWNER, computerId: COMPUTER, attachmentEpoch: 7 })
    expect(request.meta).toMatchObject({
      signer: 'owner_client',
      signerKeyId: device.identity.kid,
      issuedAt: NOW,
      expiresAt: NOW + RECIPIENT_KEY_REQUEST_TTL_MS
    })

    // The signature covers the device-service/3 signed bytes of the request, and not the Touch ID approval key.
    const bytes = cloudDeviceSignedBytes('browser.import.recipient-key.read', request)

    expect(verifyDeviceSignature(device.identity.spki, bytes, request.meta.signature)).toBe(true)
    expect(verifyDeviceSignature(device.approval.spki, bytes, request.meta.signature)).toBe(false)
    expect(device.approvals).toEqual([])
  })

  it('never reuses a request or command id, so a replay is a different request', async () => {
    const { deps, requests } = await harness()
    await readTrustedRecipientKey(deps, signal)
    await readTrustedRecipientKey(deps, signal)

    expect(requests[0].meta.requestId).not.toBe(requests[1].meta.requestId)
    expect(requests[0].meta.commandId).not.toBe(requests[1].meta.commandId)
  })

  it('refuses a key signed by a controller this Mac never pinned', async () => {
    const { deps } = await harness({ pinned: [] })

    expect(await refusal(deps)).toBe('unpinned_controller_key')

    const stranger = softwareEd25519()
    const other = await harness({ pinned: [{ kid: stranger.kid, publicKey: stranger.spki }] })

    expect(await refusal(other.deps)).toBe('unpinned_controller_key')
  })

  it('refuses a forged signature: a pinned key id claimed with another key’s signature', async () => {
    const { deps, controller } = await harness()
    const forger = softwareEd25519()

    const forged = await harness({}, options =>
      signedRecipientRecord({ ...options, controller: forger, meta: { signerKeyId: controller.kid } })
    )

    expect(await refusal({ ...forged.deps, pinned: deps.pinned })).toBe('forged_controller_signature')
  })

  it('refuses a record changed after it was signed, including a swapped public key', async () => {
    const attacker = await softwareRecipient()

    const swapped = await harness({}, options =>
      signedRecipientRecord({
        ...options,
        tamper: record => {
          record.hpkePublicKey = attacker.hpkePublicKey
          record.hpkeKeyId = attacker.hpkeKeyId
        }
      })
    )

    expect(await refusal(swapped.deps)).toBe('forged_controller_signature')

    const moved = await harness({}, options =>
      signedRecipientRecord({ ...options, tamper: record => (record.attachmentEpoch = 8) })
    )

    expect(await refusal(moved.deps)).toBe('forged_controller_signature')
  })

  it.each([
    ['another owner', { binding: { ownerUserId: '@other:atum.example' } }, 'wrong_owner'],
    ['another computer', { binding: { computerId: '00000000-0000-4000-8000-f6222a1106ee' } }, 'wrong_computer'],
    ['a stale epoch', { attachmentEpoch: 6 }, 'stale_attachment_epoch']
  ])('refuses a validly signed record for %s', async (_name, change, reason) => {
    const { deps } = await harness({}, options => signedRecipientRecord({ ...options, ...change }))

    expect(await refusal(deps)).toBe(reason)
  })

  it('refuses a validly signed record for a different agent’s computer', async () => {
    const { deps } = await harness({}, options =>
      signedRecipientRecord({ ...options, binding: { agentPrincipal: '00000000-0000-4000-8000-e8d95748107a' } })
    )

    expect(await refusal(deps)).toBe('wrong_agent')
  })

  it('refuses a key id that does not hash the key, even when the controller signed it', async () => {
    const { deps } = await harness({}, options => signedRecipientRecord({ ...options, hpkeKeyId: 'E'.repeat(43) }))

    expect(await refusal(deps)).toBe('hpke_key_id_mismatch')
  })

  // The platform answers with the record the controller signed when it published (a 15 s window), however long ago:
  // the epoch fences the key, so the record's own clock decides nothing here.
  it.each([
    ['published an hour ago', { issuedAt: NOW - 3_600_000, expiresAt: NOW - 3_600_000 + 15_000 }],
    ['published a day ago', { issuedAt: NOW - 86_400_000, expiresAt: NOW - 86_400_000 + 15_000 }],
    [
      'published by a controller whose clock is ahead of this Mac’s',
      { issuedAt: NOW + 120_000, expiresAt: NOW + 135_000 }
    ]
  ])('accepts a record that was %s', async (_name, meta) => {
    const { deps, recipient } = await harness({}, options => signedRecipientRecord({ ...options, meta }))

    await expect(readTrustedRecipientKey(deps, signal)).resolves.toMatchObject({ hpkeKeyId: recipient.hpkeKeyId })
  })

  it.each([
    ['good for longer than a signed message may be', { issuedAt: NOW, expiresAt: NOW + 7_200_001 }],
    ['never valid', { issuedAt: NOW, expiresAt: NOW }],
    ['over before it began', { issuedAt: NOW, expiresAt: NOW - 1 }]
  ])('refuses a record whose lifetime is %s', async (_name, meta) => {
    const { deps } = await harness({}, options => signedRecipientRecord({ ...options, meta }))

    expect(await refusal(deps)).toBe('record_malformed')
  })

  it('still refuses an old record once the computer has moved to another epoch', async () => {
    // The Mac reads epoch 7 from the platform; the controller's old record is for epoch 6.
    const { deps } = await harness({}, options =>
      signedRecipientRecord({
        ...options,
        attachmentEpoch: 6,
        meta: { issuedAt: NOW - 3_600_000, expiresAt: NOW - 3_600_000 + 15_000 }
      })
    )

    expect(await refusal(deps)).toBe('stale_attachment_epoch')
  })

  it.each([
    ['not an object', () => 'nope'],
    [
      'an extra field',
      (options: Parameters<typeof signedRecipientRecord>[0]) =>
        signedRecipientRecord({ ...options, extra: { surprise: true } })
    ],
    [
      'a missing field',
      (options: Parameters<typeof signedRecipientRecord>[0]) =>
        signedRecipientRecord({ ...options, tamper: record => delete record.pinning })
    ]
  ])('refuses a malformed answer: %s', async (_name, make) => {
    const { deps } = await harness({}, make as never)

    expect(await refusal(deps)).toBe('record_malformed')
  })

  it('fails closed when the identity key cannot sign or answers as another key', async () => {
    const { deps } = await harness({
      identity: {
        kid: 'K'.repeat(43),
        sign: async () => {
          throw new Error('locked')
        }
      }
    })

    expect(await refusal(deps)).toBe('identity_signature_failed')

    const other = await harness({
      identity: { kid: 'K'.repeat(43), sign: async () => ({ kid: 'L'.repeat(43), sig: 'S'.repeat(86) }) }
    })

    expect(await refusal(other.deps)).toBe('identity_signature_failed')
  })
})
