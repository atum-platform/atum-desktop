/**
 * This Mac as an `atum.agent-home/2.1` executor (`signer: 'mac_executor'`).
 *
 * The key is the device service's identity key: the platform mirrors it into
 * `agent_home_mac_executor_keys` (one active key per `deviceServiceId`, `keyEpoch` = the
 * enrollment epoch) and admits a frame only when `signerKeyId` is that active key, `meta.deviceServiceId`
 * is the placement's exact Mac, the signature verifies, and the window `[issuedAt, expiresAt]` is
 * positive, at most two hours, and not over. This module is the Mac's half of that rule: it refuses to
 * sign unless the enrollment is active, still names the key it is about to sign with (an
 * enrollment epoch that moved, or a key that was replaced, is `key_mismatch`), and the frame is bound
 * to this device.
 *
 * Nothing here holds key material. `ExecutorKey` is a handle from `MacDeviceIdentity.executorKey()`:
 * the Secure Enclave signs, never prompts for an identity-key signature, and a request that cannot be
 * signed is a closed code, never a retry loop.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  agentHomeSignedBytes,
  type ExecutorSignedMeta,
  type HomeSignedAction,
  isKeyId,
  isUuid,
  SIGNED_MESSAGE_MAX_MS
} from './contract'

/** What `MacDeviceIdentity.executorKey()` returns while this Mac's enrollment is active. */
export interface ExecutorKey {
  deviceServiceId: string
  /** The enrollment epoch: the platform's `keyEpoch` for this device's key. */
  enrollmentEpoch: number
  /** `b64url(sha256(SPKI))` of the identity key the enrollment names. */
  identityKid: string
  /** ES256 over `bytes` with that key; the answer names the key that signed. */
  signIdentity(bytes: Uint8Array): Promise<{ kid: string; sig: string }>
}

export type ExecutorAuthFailure =
  | 'device_not_enrolled'
  | 'key_mismatch'
  | 'store_unavailable'
  | 'signing_failed'
  | 'invalid_frame'

export class ExecutorAuthError extends Error {
  constructor(readonly code: ExecutorAuthFailure) {
    super(`agent_home_${code}`)
    this.name = 'ExecutorAuthError'
  }
}

/** The subset of the device store the sequence counter lives in (`DeviceStateStore`). */
interface SequenceStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  failureCode(): string | null
}

export const EXECUTOR_SEQUENCE_KEY = 'agent-home-executor-sequence-v1'

/**
 * A frame lives five minutes, backdated five seconds. The platform's final admission refuses any
 * `issuedAt` later than its own clock (zero future skew, `decideAgentHomeAuthorityAdmission`) and a
 * lifetime over two hours; only the end of the window is otherwise checked, so backdating absorbs a Mac
 * whose clock runs a little fast, and nothing lives longer than it needs to.
 */
export const EXECUTOR_FRAME_TTL_MS = 5 * 60_000
export const EXECUTOR_FRAME_BACKDATE_MS = 5_000

export interface MacExecutorAuthOptions {
  /** The live handle, or null when this Mac has no active device enrollment. */
  key(): ExecutorKey | null
  store: SequenceStore
  now?(): number
  uuid?(): string
  random?(size: number): Uint8Array
}

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

export class MacExecutorAuth {
  constructor(private readonly options: MacExecutorAuthOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** The device this Mac signs as, or null when it is not enrolled. */
  deviceServiceId(): string | null {
    return this.options.key()?.deviceServiceId ?? null
  }

  /**
   * Next value of the durable, strictly increasing frame counter, stored before the frame is signed.
   * The platform refuses a reused nonce, command id or sequence per device while a frame could still be
   * live (at most two hours), so the counter never goes below the clock: a Mac whose store was lost still
   * numbers its next frame beyond every one it sent before. A frame is signed fresh for every attempt;
   * one that is sent twice is refused as a replay.
   */
  private nextSequence(deviceServiceId: string): number {
    const key = `${EXECUTOR_SEQUENCE_KEY}:${deviceServiceId}`
    const raw = this.options.store.getItem(key)

    if (this.options.store.failureCode()) {
      throw new ExecutorAuthError('store_unavailable')
    }

    const last = raw === null ? 0 : Number(raw)

    if (!Number.isSafeInteger(last) || last < 0) {
      throw new ExecutorAuthError('store_unavailable')
    }

    const next = Math.max(last + 1, this.now())

    try {
      this.options.store.setItem(key, String(next))
    } catch {
      throw new ExecutorAuthError('store_unavailable')
    }

    return next
  }

  /**
   * One signed frame. `build` receives the header (everything but `signature`) and returns the whole
   * body; the body is then signed under `action` with the domain-framed canonical bytes the Shell
   * checks. The returned body is the one to POST, signature included.
   */
  async sign<B extends { meta: Omit<ExecutorSignedMeta, 'signature'> }>(
    action: HomeSignedAction,
    build: (meta: Omit<ExecutorSignedMeta, 'signature'>) => B
  ): Promise<Omit<B, 'meta'> & { meta: ExecutorSignedMeta }> {
    const key = this.options.key()

    if (!key || !isUuid(key.deviceServiceId) || !isKeyId(key.identityKid)) {
      throw new ExecutorAuthError('device_not_enrolled')
    }

    const issuedAt = this.now() - EXECUTOR_FRAME_BACKDATE_MS
    const expiresAt = issuedAt + EXECUTOR_FRAME_TTL_MS

    if (!(expiresAt > issuedAt && expiresAt <= issuedAt + SIGNED_MESSAGE_MAX_MS) || issuedAt < 0) {
      throw new ExecutorAuthError('invalid_frame')
    }

    const header: Omit<ExecutorSignedMeta, 'signature'> = {
      requestId: this.options.uuid?.() ?? randomUUID(),
      commandId: this.options.uuid?.() ?? randomUUID(),
      signer: 'mac_executor',
      signerKeyId: key.identityKid,
      deviceServiceId: key.deviceServiceId,
      sequence: this.nextSequence(key.deviceServiceId),
      issuedAt,
      expiresAt,
      nonce: b64u(createHash('sha256').update(this.options.random?.(32) ?? randomBytes(32)).digest())
    }

    const body = build(header)
    const bytes = agentHomeSignedBytes(action, body)
    let signed: { kid: string; sig: string }

    try {
      signed = await key.signIdentity(bytes)
    } catch {
      throw new ExecutorAuthError('signing_failed')
    }

    // The key that signed must be the key the enrollment names and the frame claims: a key that was
    // replaced under a stale enrollment would produce a signature the platform cannot pin.
    if (signed.kid !== header.signerKeyId) {
      throw new ExecutorAuthError('key_mismatch')
    }

    const current = this.options.key()

    // Enrollment moved on while the Secure Enclave was signing (revoked, re-enrolled, another epoch).
    if (!current || current.deviceServiceId !== key.deviceServiceId || current.identityKid !== key.identityKid || current.enrollmentEpoch !== key.enrollmentEpoch) {
      throw new ExecutorAuthError('key_mismatch')
    }

    return { ...body, meta: { ...body.meta, signature: signed.sig } }
  }
}
