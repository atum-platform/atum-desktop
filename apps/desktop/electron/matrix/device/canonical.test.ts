import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  argsHash,
  canonicalJson,
  deviceMessageHash,
  deviceSignedBytes,
  keyId,
  verifyControllerSignature,
  verifyDeviceSignature
} from './canonical'

// The vendored platform pack (data, not source): the same vectors the controller and the
// platform are held to, so this main-process copy cannot drift from them.
const pack = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/device-protocol/fixtures/device-service/fixtures'
)

const read = (name: string) => JSON.parse(readFileSync(path.join(pack, name), 'utf8'))

describe('canonicalJson agrees with the platform canonical vectors', () => {
  const vectors = read('canonical.vectors.json').vectors as Array<Record<string, string>>

  it('has vectors to check', () => expect(vectors.length).toBeGreaterThan(3))

  for (const vector of vectors) {
    it(vector.name, () => {
      const parsed = JSON.parse(vector.inputJson)

      if (vector.result === 'ok') {
        const canonical = canonicalJson(parsed)
        expect(canonical).toBe(vector.canonical)
        expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(vector.sha256)
      } else {
        expect(() => canonicalJson(parsed)).toThrow()
      }
    })
  }
})

describe('device-service hashes agree with the vendored vectors', () => {
  const vectors = read('hashes.vectors.json').vectors as Array<Record<string, any>>

  for (const vector of vectors) {
    it(vector.name, () => {
      if (vector.kind === 'message') {
        expect(deviceMessageHash(vector.type, vector.body)).toBe(vector.hash)

        if (vector.signedBytesUtf8) {
          expect(deviceSignedBytes(vector.type, vector.body).toString('utf8')).toBe(vector.signedBytesUtf8)
        }
      } else if (vector.kind === 'kid') {
        expect(keyId(Buffer.from(vector.publicKey, 'base64url'))).toBe(vector.kid)
      } else if (vector.kind === 'args') {
        expect(argsHash(vector.args)).toBe(vector.argsHash)
      }
    })
  }

})

describe('signature checks agree with the vendored signature vectors', () => {
  const vectors = read('signatures.vectors.json').vectors as Array<Record<string, any>>

  for (const vector of vectors) {
    it(vector.name, () => {
      const { type, body, sig } = vector.frame
      const check = vector.signer === 'controller' ? verifyControllerSignature : verifyDeviceSignature
      expect(check(type, body, vector.publicKey, sig)).toBe(vector.valid)
    })
  }

  it('a controller check never accepts a P-256 key, nor a device check an Ed25519 key', () => {
    const controller = vectors.find(each => each.signer === 'controller' && each.valid)
    const device = vectors.find(each => each.signer === 'identity' && each.valid)
    expect(
      verifyDeviceSignature(controller.frame.type, controller.frame.body, controller.publicKey, controller.frame.sig)
    ).toBe(false)
    expect(
      verifyControllerSignature(device.frame.type, device.frame.body, device.publicKey, device.frame.sig)
    ).toBe(false)
  })

  it('malformed keys and signatures are a refusal, never a throw', () => {
    expect(verifyControllerSignature('Execute', {}, 'not-a-key', 'AAAA')).toBe(false)
    expect(verifyDeviceSignature('Hello', {}, '', '')).toBe(false)
  })
})
