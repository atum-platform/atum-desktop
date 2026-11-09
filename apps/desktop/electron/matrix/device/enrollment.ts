/**
 * Enrolling this Mac's device service with the platform registry (S1 WS-3b; contract
 * `atum.device-service/1` "Keys, enrollment and rotation", DA routes `POST/GET/DELETE
 * /api/matrix/v1/device-services` and the public `GET /api/matrix/v1/cloud/controller-keys`).
 *
 * 1. Fetch the controller's signing keys; the device pins every active one.
 * 2. Send `EnrollDevice`, signed silently by the identity key and the approval key over
 *    `utf8("atum.device-service.v1\0EnrollDevice\0") || canonicalJson(body)`, and keep the pins.
 *
 * A new sign-in makes a new Matrix device, so the service is re-bound to it: the same keys, the next
 * enrollment epoch, and a third signature by the previous approval key. Enrollment is routine
 * owner-account setup; Touch ID remains reserved for protected commands and credentials.
 *
 * A Mac that lost its local record (a reinstall, a wiped vault) finds its own registration by its
 * identity key and adopts it when it already matches; a registration this Mac can no longer sign
 * for (its keys are gone) but that holds this Mac's Matrix device is revoked so a fresh enrollment
 * can take the device. A revoked enrollment is final: its keys are discarded and new ones made.
 */
import { randomUUID } from 'node:crypto'

import type { DeviceCapability } from './contracts'
import { DeviceKeyError, type DevicePublicKeys, deviceSignedBytes, type DeviceSigner } from './device-key'
import type { DeviceStateStore } from './epochs'

export const DEVICE_SCOPES: DeviceCapability[] = ['terminal', 'files', 'computer', 'send_file']

/** A controller signing key as `GET /cloud/controller-keys` lists it. */
export interface ControllerKeyRecord {
  kid: string
  alg: 'Ed25519'
  publicKey: string
  state: 'active' | 'retired'
  createdAt: number
}

/** A registration as DA returns it (`device_service_record`). */
export interface DeviceServiceRecord {
  deviceServiceId: string
  displayName: string
  platform: 'macos'
  identityKeyId: string
  approvalKeyId: string
  matrix: { deviceId: string; fingerprint: string }
  enrollmentEpoch: number
  scopes: DeviceCapability[]
  pinnedControllerKeys: string[]
  state: 'active' | 'revoked'
  revokeSeq: number
  createdAt: number
  rotatedAt: number | null
  revokedAt: number | null
}

export interface EnrollDeviceBody {
  deviceServiceId: string
  displayName: string
  platform: 'macos'
  osVersion: string
  identityKey: string
  approvalKey: string
  matrix: { userId: string; deviceId: string; fingerprint: string }
  enrollmentEpoch: number
  scopes: DeviceCapability[]
  controllerKeys: string[]
  issuedAt: number
  previousApprovalKid?: string
}

export interface EnrollDeviceRequest {
  body: EnrollDeviceBody
  sigs: { identity: string; approval: string; previousApproval?: string }
}

/** The DA calls enrollment needs; cloud-agent.ts implements them over the owner's grant. */
export interface DeviceEnrollmentTransport {
  controllerKeys(signal: AbortSignal): Promise<ControllerKeyRecord[]>
  list(signal: AbortSignal): Promise<DeviceServiceRecord[]>
  enroll(request: EnrollDeviceRequest, signal: AbortSignal): Promise<DeviceServiceRecord>
  revoke(deviceServiceId: string, signal: AbortSignal): Promise<DeviceServiceRecord>
}

/** This Mac's enrollment as the device keeps it (its own encrypted store, per owner). */
export interface DeviceEnrollmentRecord {
  v: 1
  ownerUserId: string
  deviceServiceId: string
  enrollmentEpoch: number
  identityKid: string
  approvalKid: string
  matrixDeviceId: string
  matrixFingerprint: string
  scopes: DeviceCapability[]
  pinnedControllerKeys: string[]
  /** The pinned keys' public halves (Ed25519 SPKI, base64url): what frames are checked against. */
  controllerKeys: { kid: string; publicKey: string }[]
  revokeSeq: number
  state: 'active' | 'revoked'
  updatedAt: number
}

/** The owner's Matrix device on this Mac, which the service is bound to. */
export interface DeviceEnrollmentOwner {
  userId: string
  deviceId: string
  fingerprint: string
}

export type DeviceEnrollmentFailure =
  | 'unavailable'
  | 'keys_unavailable'
  | 'approval_denied'
  | 'approval_timeout'
  | 'approval_unavailable'
  | 'refused'
  | 'invalid'

export class DeviceEnrollmentError extends Error {
  constructor(
    readonly code: DeviceEnrollmentFailure,
    /** DA's reason for a refusal (`bad_signature`, `rotation_unauthorized`, …). */
    readonly reason?: string
  ) {
    super(`device_enrollment_${code}${reason ? `:${reason}` : ''}`)
    this.name = 'DeviceEnrollmentError'
  }
}

/** A DA refusal as the transport reports it: status and the contract reason. */
export class DeviceRegistryError extends Error {
  constructor(
    readonly status: number,
    readonly reason?: string
  ) {
    super(`device_registry_${status}${reason ? `_${reason}` : ''}`)
    this.name = 'DeviceRegistryError'
  }
}

export type RevokeOutcome =
  | { outcome: 'applied' }
  | { outcome: 'ignored'; reason: 'other_service' | 'other_epoch' | 'older_revoke' | 'not_active' }

const RECORD_KEY = 'device-enrollment-v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KID = /^[A-Za-z0-9_-]{43}$/
const SPKI_ED25519 = /^[A-Za-z0-9_-]{59}$/
const DEVICE = /^[!-~]{1,255}$/
const FINGERPRINT = /^[A-Za-z0-9+/]{43}$/

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')
}

export class DeviceEnrollment {
  private flight?: Promise<DeviceEnrollmentRecord>

  constructor(
    private readonly deps: {
      /** The device store, scoped to this owner. */
      store: DeviceStateStore
      signer: DeviceSigner & { discard?(): Promise<void> }
      transport: DeviceEnrollmentTransport
      displayName(): string
      osVersion(): string
      scopes?: DeviceCapability[]
      now?(): number
      uuid?(): string
      log?(line: string): void
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The record this Mac keeps, active or revoked; null when it has none or cannot read it. */
  current(): DeviceEnrollmentRecord | null {
    const raw = this.deps.store.getItem(RECORD_KEY)

    if (this.deps.store.failureCode() || !raw) {
      return null
    }

    try {
      const value = JSON.parse(raw) as DeviceEnrollmentRecord

      return value?.v === 1 && UUID.test(value.deviceServiceId) && KID.test(value.identityKid) ? value : null
    } catch {
      return null
    }
  }

  /** The active enrollment bound to this owner's current Matrix device on this Mac, if any. */
  activeFor(owner: DeviceEnrollmentOwner): DeviceEnrollmentRecord | null {
    const record = this.current()

    return record?.state === 'active' &&
      record.ownerUserId === owner.userId &&
      record.matrixDeviceId === owner.deviceId &&
      record.matrixFingerprint === owner.fingerprint
      ? record
      : null
  }

  /** A pinned controller key's public half, or null for a key this device does not trust. */
  controllerKey(kid: string): string | null {
    const record = this.current()

    if (record?.state !== 'active' || !record.pinnedControllerKeys.includes(kid)) {
      return null
    }

    return record.controllerKeys.find(key => key.kid === kid)?.publicKey ?? null
  }

  /**
   * Enrolled and bound to this Matrix device. One enrollment at a time: concurrent callers share it.
   */
  ensure(
    owner: DeviceEnrollmentOwner,
    signal: AbortSignal,
    options: { refreshPins?: boolean; verifyRegistry?: boolean } = {}
  ): Promise<DeviceEnrollmentRecord> {
    const active = this.activeFor(owner)

    if (active && !options.refreshPins && !options.verifyRegistry) {
      return Promise.resolve(active)
    }

    this.flight ??= this.enroll(owner, signal, options.refreshPins === true, options.verifyRegistry === true).finally(() => {
      this.flight = undefined
    })

    return this.flight
  }

  private write(record: DeviceEnrollmentRecord): void {
    this.deps.store.setItem(RECORD_KEY, JSON.stringify(record))
  }

  private async keys(): Promise<DevicePublicKeys> {
    try {
      // `create` used to rotate a pre-silent-enrollment Secure Enclave pair. Looking first keeps
      // that pair — and therefore the registry's physical-Mac identity — stable across an app
      // update. A genuinely empty key directory still falls through and creates the new shape.
      const existing = await this.deps.signer.existingKeys?.()

      if (existing) {
        return existing
      }

      return await this.deps.signer.publicKeys()
    } catch (error) {
      throw new DeviceEnrollmentError(
        error instanceof DeviceKeyError && error.code === 'unavailable' ? 'unavailable' : 'keys_unavailable'
      )
    }
  }

  private async freshKeys(): Promise<DevicePublicKeys> {
    if (!this.deps.signer.discard) {
      throw new DeviceEnrollmentError('keys_unavailable')
    }

    await this.deps.signer.discard()

    return this.keys()
  }

  private async enroll(
    owner: DeviceEnrollmentOwner,
    signal: AbortSignal,
    refreshPins: boolean,
    verifyRegistry: boolean
  ): Promise<DeviceEnrollmentRecord> {
    if (
      !DEVICE.test(owner.deviceId) ||
      !FINGERPRINT.test(owner.fingerprint) ||
      !/^@[!-9;-~]+:[!-~]+$/.test(owner.userId)
    ) {
      throw new DeviceEnrollmentError('invalid')
    }

    try {
      return await this.attempt(owner, signal, refreshPins, verifyRegistry)
    } catch (error) {
      // The owner revoked this registration elsewhere: it is final, so this Mac starts over with
      // new keys silently instead of failing on every launch.
      if (error instanceof DeviceEnrollmentError && error.reason === 'revoked') {
        const record = this.current()

        if (record) {
          this.write({ ...record, state: 'revoked', updatedAt: this.now() })
        }

        return this.attempt(owner, signal, false, true)
      }

      throw error
    }
  }

  private async attempt(
    owner: DeviceEnrollmentOwner,
    signal: AbortSignal,
    refreshPins: boolean,
    verifyRegistry: boolean
  ): Promise<DeviceEnrollmentRecord> {
    let keys = await this.keys()
    let record = this.current()

    if (record && record.ownerUserId !== owner.userId) {
      record = null
    }

    // A revoked enrollment never comes back, and DA keeps its key IDs unique forever.
    if (record?.state === 'revoked') {
      keys = await this.freshKeys()
      record = null
    }

    // Keys changed under the record (made again): that registration can no longer be signed for.
    if (record && record.identityKid !== keys.identity.kid) {
      record = null
    }

    const pins = await this.pins(signal)

    // Bound here already and every active controller key pinned: nothing to sign.
    if (
      record?.state === 'active' &&
      record.matrixDeviceId === owner.deviceId &&
      record.matrixFingerprint === owner.fingerprint &&
      pins.every(pin => record!.pinnedControllerKeys.includes(pin.kid)) &&
      !verifyRegistry
    ) {
      return record
    }

    // A signature is needed: read what the registry holds first, so a rotation always builds on the
    // registry's epoch (never on a local record that missed an applied answer) and a registration
    // that already matches is adopted without asking the owner.
    const listed = await this.registry(() => this.deps.transport.list(signal))
    let mine = listed.find(row => row.identityKeyId === keys.identity.kid)

    if (mine?.state === 'revoked') {
      keys = await this.freshKeys()
      mine = undefined
    }

    // Another registration holding this Mac's Matrix device, under keys this Mac no longer has, was
    // this Mac's own before its keys were lost: it blocks a new enrollment of this device.
    for (const stale of listed.filter(
      row => row.state === 'active' && row.matrix.deviceId === owner.deviceId && row.identityKeyId !== keys.identity.kid
    )) {
      this.deps.log?.(
        `[Device] revoking a stale registration ${stale.deviceServiceId.slice(0, 8)} of this Matrix device`
      )
      await this.registry(() => this.deps.transport.revoke(stale.deviceServiceId, signal))
    }

    if (mine) {
      const adopted = this.adopt(mine, owner, keys, pins)

      if (adopted && !refreshPins) {
        return adopted
      }
    }

    let base: { deviceServiceId: string; enrollmentEpoch: number; approvalKid: string } | null = mine
      ? {
          deviceServiceId: mine.deviceServiceId,
          enrollmentEpoch: mine.enrollmentEpoch,
          approvalKid: mine.approvalKeyId
        }
      : null

    // A rotation must be signed by the previous approval key. When that key is gone, the old
    // registration is left to the owner to revoke and this Mac enrolls afresh.
    if (base && base.approvalKid !== keys.approval.kid) {
      base = null
    }

    try {
      return await this.submit(owner, keys, pins, base, signal)
    } catch (error) {
      // A rotation the registry has already applied (its answer was lost) reads as unauthorized:
      // adopt what the registry holds when it already says what this Mac would send.
      if (base && error instanceof DeviceEnrollmentError && error.reason === 'rotation_unauthorized') {
        const listed = await this.registry(() => this.deps.transport.list(signal))
        const mine = listed.find(row => row.identityKeyId === keys.identity.kid)
        const adopted = mine ? this.adopt(mine, owner, keys, pins) : null

        if (adopted) {
          return adopted
        }
      }

      throw error
    }
  }

  /** Every active controller key, as the device will pin them. */
  private async pins(signal: AbortSignal): Promise<{ kid: string; publicKey: string }[]> {
    const keys = await this.registry(() => this.deps.transport.controllerKeys(signal))

    const active = keys
      .filter(
        key => key.state === 'active' && key.alg === 'Ed25519' && KID.test(key.kid) && SPKI_ED25519.test(key.publicKey)
      )
      .map(key => ({ kid: key.kid, publicKey: key.publicKey }))
      .sort((a, b) => (a.kid < b.kid ? -1 : 1))
      .slice(0, 8)

    if (!active.length) {
      throw new DeviceEnrollmentError('unavailable')
    }

    return active
  }

  /** A registration that already says exactly what this Mac would enroll: kept as is, no prompt. */
  private adopt(
    row: DeviceServiceRecord,
    owner: DeviceEnrollmentOwner,
    keys: DevicePublicKeys,
    pins: { kid: string; publicKey: string }[]
  ): DeviceEnrollmentRecord | null {
    if (
      row.state !== 'active' ||
      row.identityKeyId !== keys.identity.kid ||
      row.approvalKeyId !== keys.approval.kid ||
      row.matrix.deviceId !== owner.deviceId ||
      row.matrix.fingerprint !== owner.fingerprint ||
      !pins.every(pin => row.pinnedControllerKeys.includes(pin.kid))
    ) {
      return null
    }

    const current = this.current()
    if (
      current?.state === 'active' &&
      current.ownerUserId === owner.userId &&
      current.deviceServiceId === row.deviceServiceId &&
      current.enrollmentEpoch === row.enrollmentEpoch &&
      current.identityKid === row.identityKeyId &&
      current.approvalKid === row.approvalKeyId &&
      current.matrixDeviceId === row.matrix.deviceId &&
      current.matrixFingerprint === row.matrix.fingerprint &&
      current.revokeSeq === row.revokeSeq &&
      sameSet(current.scopes, row.scopes) &&
      sameSet(current.pinnedControllerKeys, row.pinnedControllerKeys) &&
      pins.every(pin => current.controllerKeys.some(key => key.kid === pin.kid && key.publicKey === pin.publicKey))
    ) {
      return current
    }

    return this.remember(row, owner, pins)
  }

  private remember(
    row: DeviceServiceRecord,
    owner: DeviceEnrollmentOwner,
    pins: { kid: string; publicKey: string }[]
  ): DeviceEnrollmentRecord {
    const record: DeviceEnrollmentRecord = {
      v: 1,
      ownerUserId: owner.userId,
      deviceServiceId: row.deviceServiceId,
      enrollmentEpoch: row.enrollmentEpoch,
      identityKid: row.identityKeyId,
      approvalKid: row.approvalKeyId,
      matrixDeviceId: row.matrix.deviceId,
      matrixFingerprint: row.matrix.fingerprint,
      scopes: row.scopes,
      pinnedControllerKeys: row.pinnedControllerKeys,
      controllerKeys: pins.filter(pin => row.pinnedControllerKeys.includes(pin.kid)),
      revokeSeq: row.revokeSeq,
      state: 'active',
      updatedAt: this.now()
    }

    this.write(record)
    this.deps.log?.(`[Device] enrolled ${record.deviceServiceId.slice(0, 8)} at epoch ${record.enrollmentEpoch}`)

    return record
  }

  private async submit(
    owner: DeviceEnrollmentOwner,
    keys: DevicePublicKeys,
    pins: { kid: string; publicKey: string }[],
    base: { deviceServiceId: string; enrollmentEpoch: number; approvalKid: string } | null,
    signal: AbortSignal
  ): Promise<DeviceEnrollmentRecord> {
    // No control characters (DA refuses them), at most 64 characters.
    const printable = Array.from(this.deps.displayName(), char =>
      char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? ' ' : char
    )
      .join('')
      .trim()

    const displayName = Array.from(printable || 'Mac')
      .slice(0, 64)
      .join('')

    const osVersion = /^[0-9]+(?:[.][0-9]+)*$/.test(this.deps.osVersion()) ? this.deps.osVersion().slice(0, 32) : '0'

    const body: EnrollDeviceBody = {
      deviceServiceId: base?.deviceServiceId ?? this.deps.uuid?.() ?? randomUUID(),
      displayName,
      platform: 'macos',
      osVersion,
      identityKey: keys.identity.spki,
      approvalKey: keys.approval.spki,
      matrix: { userId: owner.userId, deviceId: owner.deviceId, fingerprint: owner.fingerprint },
      enrollmentEpoch: base ? base.enrollmentEpoch + 1 : 1,
      scopes: this.deps.scopes ?? DEVICE_SCOPES,
      controllerKeys: pins.map(pin => pin.kid),
      issuedAt: this.now(),
      ...(base ? { previousApprovalKid: base.approvalKid } : {})
    }

    const bytes = deviceSignedBytes('EnrollDevice', body)
    let identity: { kid: string; sig: string }
    let approval: { kid: string; sig: string }

    try {
      identity = await this.deps.signer.signIdentity(bytes)
      approval = await this.deps.signer.signEnrollment(bytes)
    } catch {
      throw new DeviceEnrollmentError('keys_unavailable')
    }

    if (identity.kid !== keys.identity.kid || approval.kid !== keys.approval.kid) {
      throw new DeviceEnrollmentError('keys_unavailable')
    }

    // The previous approval key is the current one here, so the same silent signature covers both.
    const request: EnrollDeviceRequest = {
      body,
      sigs: { identity: identity.sig, approval: approval.sig, ...(base ? { previousApproval: approval.sig } : {}) }
    }

    const row = await this.registry(() => this.deps.transport.enroll(request, signal))

    if (
      row.deviceServiceId !== body.deviceServiceId ||
      row.enrollmentEpoch !== body.enrollmentEpoch ||
      row.identityKeyId !== keys.identity.kid ||
      row.approvalKeyId !== keys.approval.kid ||
      row.matrix.deviceId !== owner.deviceId ||
      row.matrix.fingerprint !== owner.fingerprint ||
      row.state !== 'active' ||
      !sameSet(row.pinnedControllerKeys, body.controllerKeys)
    ) {
      throw new DeviceEnrollmentError('invalid')
    }

    return this.remember(row, owner, pins)
  }

  private async registry<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof DeviceEnrollmentError) {
        throw error
      }

      if (error instanceof DeviceRegistryError) {
        throw error.status >= 500 || error.status === 0
          ? new DeviceEnrollmentError('unavailable')
          : new DeviceEnrollmentError('refused', error.reason)
      }

      throw new DeviceEnrollmentError('unavailable')
    }
  }

  /**
   * A `Revoke` the connection has already verified (pinned key, valid signature). Applied only to
   * this service, at this enrollment epoch, with a `revokeSeq` newer than any seen: a delayed older
   * revoke can never undo a newer one, and a revoke for another epoch changes nothing.
   */
  applyRevoke(body: { deviceServiceId: string; enrollmentEpoch: number; revokeSeq: number }): RevokeOutcome {
    const record = this.current()

    if (!record || record.state !== 'active') {
      return { outcome: 'ignored', reason: 'not_active' }
    }

    if (body.deviceServiceId !== record.deviceServiceId) {
      return { outcome: 'ignored', reason: 'other_service' }
    }

    if (body.enrollmentEpoch !== record.enrollmentEpoch) {
      return { outcome: 'ignored', reason: 'other_epoch' }
    }

    if (!Number.isSafeInteger(body.revokeSeq) || body.revokeSeq <= record.revokeSeq) {
      return { outcome: 'ignored', reason: 'older_revoke' }
    }

    this.write({ ...record, state: 'revoked', revokeSeq: body.revokeSeq, updatedAt: this.now() })
    this.deps.log?.(`[Device] enrollment ${record.deviceServiceId.slice(0, 8)} revoked by the controller`)

    return { outcome: 'applied' }
  }
}
