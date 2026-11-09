/**
 * Software stand-ins for the keys the browser import meets, for tests only: the owner's Secure Enclave keys
 * (P-256, one that signs without a prompt and one that asks for a Touch ID), the controller's Ed25519 key, and the
 * computer's HPKE recipient key. No test uses the real Secure Enclave helper or any real key.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js'

import type { ApprovalSigner } from '../../device/approvals'
import { DeviceKeyError, type DeviceSignature } from '../../device/device-key'
import { BROWSER_IMPORT_HPKE_INFO, browserImportHpkeKeyId } from '../contract'

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const kidOf = (spki: Buffer) => createHash('sha256').update(spki).digest('base64url')

export interface SoftwareKey {
  kid: string
  /** The SPKI DER, unpadded base64url. */
  spki: string
  sign(bytes: Uint8Array): string
}

export function softwareP256(): SoftwareKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  return {
    kid: kidOf(spki),
    spki: b64u(spki),
    sign: bytes => b64u(sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }))
  }
}

export function softwareEd25519(): SoftwareKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  return {
    kid: kidOf(spki),
    spki: b64u(spki),
    sign: bytes => b64u(sign(null, bytes, privateKey))
  }
}

export type ApprovalBehaviour = 'approve' | 'deny' | 'timeout' | 'unavailable' | 'wrong_key' | 'bad_signature'

/** The owner's device keys: an identity key that never prompts and an approval key that asks, and records what it was asked. */
export class SoftwareDeviceKeys implements ApprovalSigner {
  readonly identity = softwareP256()
  readonly approval = softwareP256()
  behaviour: ApprovalBehaviour = 'approve'
  readonly approvals: { bytes: Uint8Array; reason: string }[] = []
  readonly identitySignatures: Uint8Array[] = []
  private readonly stranger = softwareP256()

  async signIdentity(bytes: Uint8Array): Promise<DeviceSignature> {
    this.identitySignatures.push(bytes)

    return { kid: this.identity.kid, sig: this.identity.sign(bytes) }
  }

  async approve(bytes: Uint8Array, reason: string): Promise<DeviceSignature> {
    this.approvals.push({ bytes, reason })

    switch (this.behaviour) {
      case 'deny':
        throw new DeviceKeyError('approval_denied')

      case 'timeout':
        throw new DeviceKeyError('approval_timeout')

      case 'unavailable':
        throw new DeviceKeyError('approval_unavailable')

      case 'wrong_key':
        return { kid: this.stranger.kid, sig: this.stranger.sign(bytes) }

      case 'bad_signature':
        return { kid: this.approval.kid, sig: this.approval.sign(Buffer.from('some other bytes')) }

      default:
        return { kid: this.approval.kid, sig: this.approval.sign(bytes) }
    }
  }
}

export interface SoftwareRecipient {
  hpkePublicKey: string
  hpkeKeyId: string
  /** Open an envelope's ciphertext as the computer would, with the given AAD. */
  open(input: { encapsulatedKey: string; ciphertext: string; aad: Uint8Array; info?: string }): Promise<Uint8Array>
}

/** A computer's HPKE key pair. */
export async function softwareRecipient(): Promise<SoftwareRecipient> {
  const suite = new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm })
  const pair = await suite.kem.generateKeyPair()
  const hpkePublicKey = b64u(new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey)))

  return {
    hpkePublicKey,
    hpkeKeyId: browserImportHpkeKeyId(hpkePublicKey),
    open: async ({ encapsulatedKey, ciphertext, aad, info }) =>
      new Uint8Array(
        await suite.open(
          {
            recipientKey: pair.privateKey,
            enc: Buffer.from(encapsulatedKey, 'base64url'),
            info: new TextEncoder().encode(info ?? BROWSER_IMPORT_HPKE_INFO)
          },
          Buffer.from(ciphertext, 'base64url'),
          aad
        )
      )
  }
}
