/**
 * Test support only: a software stand-in for the Secure Enclave helper (`native/atum-device-key`).
 * Real P-256 keys in memory, so every signature the device service makes in a test verifies with
 * Node crypto exactly as the controller and DA verify the Secure Enclave's. Never imported by
 * shipping code.
 */
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

import {
  b64u,
  DeviceKeyError,
  type DeviceKeyPublic,
  type DeviceKeyRun,
  type DevicePublicKeys,
  type DeviceSignature,
  type DeviceSigner,
  keyId,
  sha256
} from './device-key'

export interface SoftwareKey {
  public: DeviceKeyPublic
  privateKey: KeyObject
}

export function softwareP256(): SoftwareKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })

  return { public: { kid: keyId(spki), spki: b64u(spki) }, privateKey }
}

export function softwareSign(key: SoftwareKey, bytes: Uint8Array): string {
  return b64u(sign('sha256', bytes, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }))
}

export type ApprovalOutcome = 'granted' | 'denied' | 'timeout'

/** A DeviceSigner over software keys that records every approval prompt it was asked for. */
export class SoftwareDeviceSigner implements DeviceSigner {
  identity = softwareP256()
  approval = softwareP256()
  readonly prompts: string[] = []
  outcome: ApprovalOutcome = 'granted'

  async existingKeys(): Promise<DevicePublicKeys> {
    return { identity: this.identity.public, approval: this.approval.public }
  }

  async publicKeys(): Promise<DevicePublicKeys> {
    return { identity: this.identity.public, approval: this.approval.public }
  }

  async signIdentity(bytes: Uint8Array): Promise<DeviceSignature> {
    return { kid: this.identity.public.kid, sig: softwareSign(this.identity, bytes) }
  }

  async signEnrollment(bytes: Uint8Array): Promise<DeviceSignature> {
    return { kid: this.approval.public.kid, sig: softwareSign(this.approval, bytes) }
  }

  async approve(bytes: Uint8Array, reason: string): Promise<DeviceSignature> {
    this.prompts.push(reason)

    if (this.outcome !== 'granted') {
      throw new DeviceKeyError(this.outcome === 'denied' ? 'approval_denied' : 'approval_timeout')
    }

    return { kid: this.approval.public.kid, sig: softwareSign(this.approval, bytes) }
  }

  async discard(): Promise<void> {
    this.identity = softwareP256()
    this.approval = softwareP256()
  }
}

/**
 * A fake `atum-device-key` process, speaking the helper's CLI contract (one JSON line, exit codes
 * 0/1/2) over software keys held per key directory.
 */
export function fakeDeviceKeyHelper(options: { outcome?: () => ApprovalOutcome; tamper?: 'kid' | 'signature' } = {}) {
  const dirs = new Map<string, { identity: SoftwareKey; approval: SoftwareKey }>()
  const calls: { args: string[]; env: Record<string, string>; timeoutMs: number }[] = []

  const run: DeviceKeyRun = async (_binary, args, { env, timeoutMs }) => {
    calls.push({ args, env, timeoutMs })
    const keyDir = args[args.indexOf('--keydir') + 1]!
    const [command, ...rest] = args.slice(0, args.indexOf('--keydir'))
    const reply = (status: number, value: Record<string, unknown>) => ({ status, stdout: `${JSON.stringify(value)}\n` })
    const info = (key: SoftwareKey) => ({ kid: key.public.kid, spki: key.public.spki })

    if (command === 'create') {
      const created = !dirs.has(keyDir)

      if (created) {
        dirs.set(keyDir, { identity: softwareP256(), approval: softwareP256() })
      }

      const keys = dirs.get(keyDir)!

      return reply(0, { ok: true, created, identity: info(keys.identity), approval: info(keys.approval) })
    }

    const keys = dirs.get(keyDir)

    if (command === 'delete') {
      dirs.delete(keyDir)

      return reply(0, { ok: true })
    }

    if (!keys) {
      return reply(1, { ok: false, error: command === 'public' ? 'keys_missing' : 'sign_identity_failed: missing' })
    }

    if (command === 'public') {
      return reply(0, { ok: true, identity: info(keys.identity), approval: info(keys.approval) })
    }

    if (command === 'sign-enrollment') {
      const framed = Buffer.from(rest[0] ?? '', 'base64url')
      const prefix = Buffer.from('atum.device-service.v1\0EnrollDevice\0', 'utf8')

      if (!framed.subarray(0, prefix.length).equals(prefix)) {
        return reply(1, { ok: false, error: 'enrollment_invalid' })
      }

      const other = softwareP256()
      const sig = softwareSign(options.tamper === 'signature' ? other : keys.approval, framed)
      const kid = options.tamper === 'kid' ? other.public.kid : keys.approval.public.kid

      return reply(0, { ok: true, kid, sig })
    }

    const digest = Buffer.from(rest[0] ?? '', 'base64url')

    if (digest.length !== 32) {
      return reply(1, { ok: false, error: 'digest_invalid' })
    }

    // The helper signs the digest itself (ECDSA over a precomputed SHA-256). Node only signs whole
    // messages, so a test registers the framed bytes first (`expect`) and the fake signs those:
    // the same signature the helper would make over their digest.
    const framed = pendingBytes.get(b64u(digest))

    if (!framed) {
      return reply(1, { ok: false, error: 'unknown digest' })
    }

    const signer = command === 'approve' ? keys.approval : keys.identity

    if (command === 'approve') {
      const outcome = options.outcome?.() ?? 'granted'

      if (outcome !== 'granted') {
        return reply(2, { ok: false, error: outcome === 'denied' ? 'approval_denied' : 'approval_timeout' })
      }
    }

    const other = softwareP256()
    const sig = softwareSign(options.tamper === 'signature' ? other : signer, framed)
    const kid = options.tamper === 'kid' ? other.public.kid : signer.public.kid

    return reply(0, { ok: true, kid, sig })
  }

  /** The bytes a test is about to have signed, registered under their digest. */
  const pendingBytes = new Map<string, Uint8Array>()
  const expect = (bytes: Uint8Array) => pendingBytes.set(b64u(sha256(bytes)), bytes)

  return { run, calls, expect, dirs }
}
