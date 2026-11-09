import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  argsHash,
  canonicalJson,
  DeviceKeyError,
  type DeviceKeyRun,
  deviceMessageHash,
  deviceSignedBytes,
  keyId,
  originAssertionHash,
  requestDigestV2,
  SecureEnclaveDeviceKeys,
  verifyControllerSignature,
  verifyDeviceSignature
} from './device-key'
import { fakeDeviceKeyHelper } from './device-signer.fixture'

/** The platform contract packs this device implements, as vendored for every atum-app consumer. */
const packs = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/device-protocol/fixtures')
const fixture = (pack: string, name: string) => JSON.parse(readFileSync(join(packs, pack, 'fixtures', name), 'utf8'))
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('the device signs exactly the bytes the platform verifies', () => {
  it('canonical JSON reproduces every platform canonical vector', () => {
    const vectors = fixture('device-service', 'canonical.vectors.json').vectors as Record<string, string>[]
    expect(vectors.length).toBeGreaterThan(5)

    for (const vector of vectors) {
      if (vector.result === 'ok') {
        const canonical = canonicalJson(JSON.parse(vector.inputJson!))
        expect(canonical, vector.name).toBe(vector.canonical)
        expect(sha256Hex(canonical), vector.name).toBe(vector.sha256)
      } else {
        expect(() => canonicalJson(JSON.parse(vector.inputJson!)), vector.name).toThrow()
      }
    }
  })

  it('message hashes, key IDs and argument hashes match the device-service vectors', () => {
    const vectors = fixture('device-service', 'hashes.vectors.json').vectors as Record<string, any>[]
    let checked = 0

    for (const vector of vectors) {
      if (vector.kind === 'message') {
        expect(deviceSignedBytes(vector.type, vector.body).toString('utf8')).toBe(vector.signedBytesUtf8)
        expect(deviceMessageHash(vector.type, vector.body)).toBe(vector.hash)
        checked++
      } else if (vector.kind === 'kid') {
        expect(keyId(Buffer.from(vector.publicKey, 'base64url'))).toBe(vector.kid)
        checked++
      } else if (vector.kind === 'args') {
        expect(argsHash(vector.args)).toBe(vector.argsHash)
        checked++
      }
    }

    expect(checked).toBeGreaterThanOrEqual(6)
  })

  it('request digest v2 and the origin assertion hash match the cloud-answering vectors', () => {
    const vectors = fixture('cloud-answering', 'digest.vectors.json').vectors as Record<string, any>[]

    for (const vector of vectors.filter(each => each.version === 2)) {
      expect(requestDigestV2(vector.content), vector.name).toBe(vector.dg)
    }

    const { sig: _sig, ...assertion } = fixture('cloud-answering', 'origin.assertion.json')
    expect(originAssertionHash(assertion)).toBe(
      fixture('cloud-answering', 'origin-verified.case.json').facts.assertionHash
    )
  })

  it('checks controller Ed25519 and device ES256 signatures exactly as the vectors say', () => {
    const vectors = fixture('device-service', 'signatures.vectors.json').vectors as Record<string, any>[]

    for (const vector of vectors) {
      const bytes = deviceSignedBytes(vector.frame.type, vector.frame.body)

      const verdict =
        vector.signer === 'controller'
          ? verifyControllerSignature(vector.publicKey, bytes, vector.frame.sig)
          : verifyDeviceSignature(vector.publicKey, bytes, vector.frame.sig)

      expect(verdict, vector.name).toBe(vector.valid)
    }
  })

  it('never accepts a controller signature from a P-256 key or a device signature from an Ed25519 key', () => {
    const keys = fixture('device-service', 'public-keys.json').keys as { name: string; publicKey: string }[]
    const controller = keys.find(each => each.name === 'controller.active')!.publicKey
    const identity = keys.find(each => each.name === 'macbook.identity')!.publicKey
    const hello = fixture('device-service', 'hello.frame.json')
    const execute = fixture('device-service', 'execute.frame.json')

    expect(verifyDeviceSignature(identity, deviceSignedBytes('Hello', hello.body), hello.sig)).toBe(true)
    expect(verifyControllerSignature(identity, deviceSignedBytes('Hello', hello.body), hello.sig)).toBe(false)
    expect(verifyControllerSignature(controller, deviceSignedBytes('Execute', execute.body), execute.sig)).toBe(true)
    expect(verifyDeviceSignature(controller, deviceSignedBytes('Execute', execute.body), execute.sig)).toBe(false)
  })
})

describe('the Secure Enclave helper wrapper', () => {
  const keyDir = '/tmp/atum-device-keys-test/owner'

  it('creates keys once and signs Hello bytes that verify against the identity key', async () => {
    const fake = fakeDeviceKeyHelper()
    const keys = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir, run: fake.run })
    const bytes = deviceSignedBytes('Hello', { a: 1 })
    fake.expect(bytes)

    const pub = await keys.publicKeys()
    const signature = await keys.signIdentity(bytes)

    expect(signature.kid).toBe(pub.identity.kid)
    expect(verifyDeviceSignature(pub.identity.spki, bytes, signature.sig)).toBe(true)
    expect(fake.calls.filter(call => call.args[0] === 'create')).toHaveLength(1)
    // The helper receives the digest of the framed bytes, never the bytes, and no environment.
    const sign = fake.calls.find(call => call.args[0] === 'sign-identity')!
    expect(sign.args[1]).toBe(createHash('sha256').update(bytes).digest('base64url'))
    expect(sign.args.slice(-2)).toEqual(['--keydir', keyDir])
    expect(sign.env).toEqual({})
  })

  it('signs only an enrollment frame with the approval key and does not enter the approval path', async () => {
    const fake = fakeDeviceKeyHelper()
    const keys = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir, run: fake.run })
    const bytes = deviceSignedBytes('EnrollDevice', { deviceServiceId: 'device' })
    const pub = await keys.publicKeys()

    const signature = await keys.signEnrollment(bytes)

    expect(signature.kid).toBe(pub.approval.kid)
    expect(verifyDeviceSignature(pub.approval.spki, bytes, signature.sig)).toBe(true)
    const sign = fake.calls.find(call => call.args[0] === 'sign-enrollment')!
    expect(sign.args[1]).toBe(Buffer.from(bytes).toString('base64url'))
    expect(fake.calls.some(call => call.args[0] === 'approve')).toBe(false)

    await expect(keys.signEnrollment(deviceSignedBytes('Approve', {}))).rejects.toMatchObject({ code: 'failed' })
  })

  it('refuses a signature that does not verify, or names another key', async () => {
    for (const tamper of ['signature', 'kid'] as const) {
      const fake = fakeDeviceKeyHelper({ tamper })
      const keys = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir, run: fake.run })
      const bytes = deviceSignedBytes('Proof', { b: 2 })
      fake.expect(bytes)

      await expect(keys.signIdentity(bytes)).rejects.toMatchObject({ code: 'failed' })
    }
  })

  it('maps a declined or timed-out approval to its own code and never returns a signature', async () => {
    for (const outcome of ['denied', 'timeout'] as const) {
      const fake = fakeDeviceKeyHelper({ outcome: () => outcome })
      const keys = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir, run: fake.run })
      const bytes = deviceSignedBytes('EnrollDevice', { c: 3 })
      fake.expect(bytes)

      await expect(keys.approve(bytes, 'enroll this Mac')).rejects.toMatchObject({
        code: outcome === 'denied' ? 'approval_denied' : 'approval_timeout'
      })
    }
  })

  it('passes the 10 minute approval window to the helper and the reason as the prompt', async () => {
    const fake = fakeDeviceKeyHelper()
    const keys = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir, run: fake.run })
    const bytes = deviceSignedBytes('EnrollDevice', { d: 4 })
    fake.expect(bytes)

    const pub = await keys.publicKeys()
    const signature = await keys.approve(bytes, 'cho phép T dùng máy Mac này')

    expect(verifyDeviceSignature(pub.approval.spki, bytes, signature.sig)).toBe(true)
    const call = fake.calls.find(each => each.args[0] === 'approve')!
    expect(call.args[2]).toBe('cho phép T dùng máy Mac này')
    expect(call.env).toEqual({ ATUM_APPROVE_TIMEOUT: '600' })
    expect(call.timeoutMs).toBeGreaterThan(600_000)
  })

  it('shows one approval prompt at a time', async () => {
    const fake = fakeDeviceKeyHelper()
    let active = 0
    let most = 0

    const run: typeof fake.run = async (binary, args, options) => {
      if (args[0] === 'approve') {
        active++
        most = Math.max(most, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active--
      }

      return fake.run(binary, args, options)
    }

    const keys = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir, run })
    const first = deviceSignedBytes('A', {})
    const second = deviceSignedBytes('B', {})
    fake.expect(first)
    fake.expect(second)

    await Promise.all([keys.approve(first, 'one'), keys.approve(second, 'two')])
    expect(most).toBe(1)
  })

  it('reports missing keys without making any, and an unavailable helper as unavailable', async () => {
    const fake = fakeDeviceKeyHelper()
    const keys = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir, run: fake.run })

    expect(await keys.existingKeys()).toBeNull()
    expect(fake.dirs.size).toBe(0)

    const none = new SecureEnclaveDeviceKeys({ binary: null, keyDir })
    await expect(none.publicKeys()).rejects.toBeInstanceOf(DeviceKeyError)
    await expect(none.publicKeys()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('makes new keys after discard', async () => {
    const fake = fakeDeviceKeyHelper()
    const keys = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir, run: fake.run })
    const before = await keys.publicKeys()

    await keys.discard()
    const after = await keys.publicKeys()

    expect(after.identity.kid).not.toBe(before.identity.kid)
    expect(after.approval.kid).not.toBe(before.approval.kid)
  })
})


describe('a helper failure names its cause (device_key_failed, 10-12→10-20)', () => {
  const keys = (run: DeviceKeyRun) => new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir: '/keys', run })
  const created = async () => {
    const fake = fakeDeviceKeyHelper()
    const real = new SecureEnclaveDeviceKeys({ binary: '/helper', keyDir: '/keys', run: fake.run })

    return { fake, public: await real.publicKeys() }
  }

  it('carries the helper\'s own error and exit status on the error, with message still the closed code', async () => {
    const { fake } = await created()

    const failing = keys(async (binary, args, options) =>
      args[0] === 'sign-identity'
        ? { status: 1, stdout: '{"error":"sign_identity_failed: Error Domain=NSOSStatusErrorDomain Code=-25308","ok":false}\n' }
        : fake.run(binary, args, options)
    )

    const error = await failing.signIdentity(new Uint8Array([1, 2, 3])).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DeviceKeyError)
    expect((error as DeviceKeyError).message).toBe('device_key_failed')
    expect((error as DeviceKeyError).detail).toBe(
      'sign-identity: sign_identity_failed: Error Domain=NSOSStatusErrorDomain Code=-25308 (status 1)'
    )
  })

  it('names how the process ended when it printed nothing', async () => {
    const { fake } = await created()

    const killed = keys(async (binary, args, options) =>
      args[0] === 'sign-identity' ? { status: null, stdout: '', failure: 'killed SIGTERM' } : fake.run(binary, args, options)
    )

    const error = await killed.signIdentity(new Uint8Array([1])).catch((caught: unknown) => caught)
    expect((error as DeviceKeyError).detail).toBe('sign-identity: killed SIGTERM (status none)')
  })

  it('keeps the detail log-safe: printable ASCII, bounded, never raw bytes', () => {
    const detail = new DeviceKeyError('failed', `bad \u0000\n\u00e9 ${'x'.repeat(500)}`).detail!
    expect(detail).toMatch(/^[\x20-\x7e]+$/)
    expect(detail.length).toBeLessThanOrEqual(200)
  })
})
