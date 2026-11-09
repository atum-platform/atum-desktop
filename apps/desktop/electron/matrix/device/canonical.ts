/**
 * Canonical JSON and the device-protocol digests for the Mac's device service (Electron main).
 *
 * All device canonicalization uses packages/device-protocol/canonical.ts.
 * Digests and signature checks below preserve the main-process API.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

export const DEVICE_SERVICE_SIGNING_DOMAIN = 'atum.device-service.v1\0'

import { canonicalJson } from "../../../../../packages/device-protocol/canonical"
export { canonicalJson }

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest()

/** Unpadded base64url SHA-256 of arbitrary bytes or text. */
export function b64uSha256(input: Buffer | string): string {
  return sha256(typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url')
}

/** A device-service message's signed bytes: `utf8(domain + type + "\0") || utf8(canonicalJson(body))`. */
export function deviceSignedBytes(type: string, body: unknown): Buffer {
  return Buffer.from(`${DEVICE_SERVICE_SIGNING_DOMAIN}${type}\0${canonicalJson(body)}`, 'utf8')
}

/** `helloHash`, `commandHash`, `approvalHash`: unpadded base64url SHA-256 of the signed bytes. */
export function deviceMessageHash(type: string, body: unknown): string {
  return sha256(deviceSignedBytes(type, body)).toString('base64url')
}

/** `argsHash`: unpadded base64url SHA-256 of the canonical args. */
export function argsHash(args: Record<string, unknown>): string {
  return b64uSha256(canonicalJson(args))
}

/** A key ID: unpadded base64url SHA-256 of the SPKI DER. */
export function keyId(spkiDer: Buffer | Uint8Array): string {
  return sha256(Buffer.from(spkiDer)).toString('base64url')
}

/** Ed25519 (controller) signature check over the envelope's signed bytes. Never throws. */
export function verifyControllerSignature(type: string, body: unknown, spkiB64u: string, sigB64u: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiB64u, 'base64url'), format: 'der', type: 'spki' })

    if (key.asymmetricKeyType !== 'ed25519') {
      return false
    }

    const sig = Buffer.from(sigB64u, 'base64url')

    return sig.length === 64 && verify(null, deviceSignedBytes(type, body), key, sig)
  } catch {
    return false
  }
}

/** ES256 (device identity or approval key) signature check, IEEE P1363 `r||s`. Never throws. */
export function verifyDeviceSignature(type: string, body: unknown, spkiB64u: string, sigB64u: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiB64u, 'base64url'), format: 'der', type: 'spki' })

    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return false
    }

    const sig = Buffer.from(sigB64u, 'base64url')

    return (
      sig.length === 64 && verify('sha256', deviceSignedBytes(type, body), { key, dsaEncoding: 'ieee-p1363' }, sig)
    )
  } catch {
    return false
  }
}
