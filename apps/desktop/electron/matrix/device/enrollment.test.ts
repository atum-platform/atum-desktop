import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EncryptedStore, type SafeStorageLike } from '../../encrypted-store'

import { b64u, deviceSignedBytes, keyId, verifyDeviceSignature } from './device-key'
import { SoftwareDeviceSigner } from './device-signer.fixture'
import {
  type ControllerKeyRecord,
  DeviceEnrollment,
  DeviceEnrollmentError,
  type DeviceEnrollmentTransport,
  DeviceRegistryError,
  type DeviceServiceRecord,
  type EnrollDeviceRequest
} from './enrollment'

const packs = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/device-protocol/fixtures')
const fixture = (name: string) => JSON.parse(readFileSync(join(packs, 'device-service', 'fixtures', name), 'utf8'))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value),
  decryptString: value => value.toString()
}

function vault() {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-enrollment-'))
  directories.push(directory)

  return new EncryptedStore(path.join(directory, 'device-service.json'), safeStorage)
}

function controllerKey(state: 'active' | 'retired' = 'active'): ControllerKeyRecord {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })

  return { kid: keyId(spki), alg: 'Ed25519', publicKey: b64u(spki), state, createdAt: 1790236800000 }
}

const ownerUserId = '@owner-3f9a1c7e5b2d:atumplatform.com'

const owner = {
  userId: ownerUserId,
  deviceId: 'MACBOOKQ7ZK',
  fingerprint: 'aI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho'
}

interface Row extends DeviceServiceRecord {
  approvalKey: string
}

/**
 * The registry's rules as the contract writes them (spec/device-service/v1, migration 0180): ES256 in
 * route code over the EnrollDevice signed bytes by both keys, the previous approval key for a
 * rotation, the epoch chain, revocation, conflicts and known controller keys.
 */
function registry(keys: ControllerKeyRecord[]) {
  const rows = new Map<string, Row>()
  const requests: EnrollDeviceRequest[] = []
  let unavailable = false
  let loseNextAnswer = false

  const refuse = (status: number, reason: string) => {
    throw new DeviceRegistryError(status, reason)
  }

  const transport: DeviceEnrollmentTransport = {
    async controllerKeys() {
      if (unavailable) {
        throw new DeviceRegistryError(503)
      }

      return keys
    },
    async list() {
      if (unavailable) {
        throw new DeviceRegistryError(503)
      }

      return [...rows.values()].map(({ approvalKey: _key, ...row }) => row)
    },
    async revoke(id) {
      const row = rows.get(id)!
      row.state = 'revoked'
      row.revokeSeq += 1
      row.revokedAt = Date.now()

      return row
    },
    async enroll(request) {
      if (unavailable) {
        throw new DeviceRegistryError(503)
      }

      requests.push(request)
      const { body, sigs } = request
      const bytes = deviceSignedBytes('EnrollDevice', body)

      if (
        !verifyDeviceSignature(body.identityKey, bytes, sigs.identity) ||
        !verifyDeviceSignature(body.approvalKey, bytes, sigs.approval)
      ) {
        refuse(400, 'bad_signature')
      }

      if (body.matrix.userId !== ownerUserId) {
        refuse(403, 'wrong_owner')
      }

      if (!body.controllerKeys.every(kid => keys.some(key => key.kid === kid && key.state === 'active'))) {
        refuse(400, 'unknown_controller_key')
      }

      const identityKeyId = keyId(Buffer.from(body.identityKey, 'base64url'))
      const approvalKeyId = keyId(Buffer.from(body.approvalKey, 'base64url'))
      const stored = rows.get(body.deviceServiceId)

      if (stored?.state === 'revoked') {
        refuse(403, 'revoked')
      }

      if (stored) {
        const authorized =
          body.enrollmentEpoch === stored.enrollmentEpoch + 1 &&
          body.previousApprovalKid === stored.approvalKeyId &&
          sigs.previousApproval !== undefined &&
          verifyDeviceSignature(stored.approvalKey, bytes, sigs.previousApproval)

        if (!authorized) {
          refuse(403, 'rotation_unauthorized')
        }
      } else if (body.enrollmentEpoch !== 1) {
        refuse(403, 'rotation_unauthorized')
      }

      for (const other of rows.values()) {
        if (other.deviceServiceId === body.deviceServiceId) {
          continue
        }

        if (other.identityKeyId === identityKeyId || other.approvalKeyId === approvalKeyId) {
          refuse(409, 'key_conflict')
        }

        if (other.state === 'active' && other.matrix.deviceId === body.matrix.deviceId) {
          refuse(409, 'enrollment_conflict')
        }
      }

      const row: Row = {
        deviceServiceId: body.deviceServiceId,
        displayName: body.displayName,
        platform: 'macos',
        identityKeyId,
        approvalKeyId,
        approvalKey: body.approvalKey,
        matrix: { deviceId: body.matrix.deviceId, fingerprint: body.matrix.fingerprint },
        enrollmentEpoch: body.enrollmentEpoch,
        scopes: body.scopes,
        pinnedControllerKeys: body.controllerKeys,
        state: 'active',
        revokeSeq: stored?.revokeSeq ?? 0,
        createdAt: stored?.createdAt ?? Date.now(),
        rotatedAt: stored ? Date.now() : null,
        revokedAt: null
      }

      rows.set(row.deviceServiceId, row)

      if (loseNextAnswer) {
        loseNextAnswer = false
        throw new DeviceRegistryError(0)
      }

      const { approvalKey: _key, ...answer } = row

      return answer
    }
  }

  return {
    transport,
    rows,
    requests,
    down: (value: boolean) => (unavailable = value),
    loseNextAnswer: () => (loseNextAnswer = true)
  }
}

function enrollment(
  options: { keys?: ControllerKeyRecord[]; store?: EncryptedStore; signer?: SoftwareDeviceSigner } = {}
) {
  const keys = options.keys ?? [controllerKey(), controllerKey('retired')]
  const da = registry(keys)
  const signer = options.signer ?? new SoftwareDeviceSigner()
  const store = options.store ?? vault()

  const subject = new DeviceEnrollment({
    store,
    signer,
    transport: da.transport,
    displayName: () => 'MacBook Pro',
    osVersion: () => '26.6.2'
  })

  return { subject, da, signer, store, keys }
}

const signal = () => new AbortController().signal

describe('enrolling this Mac', () => {
  it('pins the active controller key silently', async () => {
    const { subject, da, signer, keys } = enrollment()

    const record = await subject.ensure(owner, signal())

    expect(signer.prompts).toEqual([])
    expect(da.requests).toHaveLength(1)

    const { body, sigs } = da.requests[0]!
    // Exactly the contract's EnrollDevice body: the same fields as the platform fixture.
    expect(Object.keys(body).sort()).toEqual(Object.keys(fixture('enroll.request.json').body).sort())
    expect(body).toMatchObject({
      platform: 'macos',
      osVersion: '26.6.2',
      displayName: 'MacBook Pro',
      identityKey: signer.identity.public.spki,
      approvalKey: signer.approval.public.spki,
      matrix: owner,
      enrollmentEpoch: 1,
      scopes: ['terminal', 'files', 'computer', 'send_file'],
      controllerKeys: [keys[0]!.kid]
    })
    expect(Object.keys(sigs).sort()).toEqual(['approval', 'identity'])

    expect(record).toMatchObject({
      deviceServiceId: body.deviceServiceId,
      enrollmentEpoch: 1,
      identityKid: signer.identity.public.kid,
      approvalKid: signer.approval.public.kid,
      pinnedControllerKeys: [keys[0]!.kid],
      state: 'active'
    })
    expect(subject.activeFor(owner)?.deviceServiceId).toBe(body.deviceServiceId)
    expect(subject.controllerKey(keys[0]!.kid)).toBe(keys[0]!.publicKey)
    // A retired key is never trusted, even though the registry still lists it.
    expect(subject.controllerKey(keys[1]!.kid)).toBeNull()
  })

  it('asks nothing and sends nothing once enrolled and bound to this Matrix device', async () => {
    const { subject, da, signer } = enrollment()
    await subject.ensure(owner, signal())

    await subject.ensure(owner, signal())

    expect(signer.prompts).toHaveLength(0)
    expect(da.requests).toHaveLength(1)
  })

  it('re-enrolls silently when the registry no longer has the locally remembered service', async () => {
    const { subject, da, signer } = enrollment()
    const first = await subject.ensure(owner, signal())
    da.rows.delete(first.deviceServiceId)

    const repaired = await subject.ensure(owner, signal(), { verifyRegistry: true })

    expect(repaired.deviceServiceId).not.toBe(first.deviceServiceId)
    expect(repaired.enrollmentEpoch).toBe(1)
    expect(da.requests).toHaveLength(2)
    expect(signer.prompts).toEqual([])
  })

  it('re-binds to the new Matrix device after a sign-in: next epoch, signed by the previous approval key', async () => {
    const { subject, da, signer } = enrollment()
    const first = await subject.ensure(owner, signal())
    const signedInAgain = { ...owner, deviceId: 'MACBOOKNEW2' }

    expect(subject.activeFor(signedInAgain)).toBeNull()
    const rebound = await subject.ensure(signedInAgain, signal())

    const { body, sigs } = da.requests[1]!
    expect(body).toMatchObject({
      deviceServiceId: first.deviceServiceId,
      enrollmentEpoch: 2,
      previousApprovalKid: signer.approval.public.kid,
      matrix: signedInAgain
    })
    expect(Object.keys(sigs).sort()).toEqual(['approval', 'identity', 'previousApproval'])
    expect(rebound).toMatchObject({
      deviceServiceId: first.deviceServiceId,
      enrollmentEpoch: 2,
      matrixDeviceId: 'MACBOOKNEW2'
    })
    expect(signer.prompts).toHaveLength(0)
  })

  it('adopts its own registration after losing its local record, with no prompt', async () => {
    const signer = new SoftwareDeviceSigner()
    const keys = [controllerKey()]
    const first = enrollment({ signer, keys })
    const record = await first.subject.ensure(owner, signal())

    // A wiped vault: same keys, same registry, no local record.
    const again = new DeviceEnrollment({
      store: vault(),
      signer,
      transport: first.da.transport,
      displayName: () => 'MacBook Pro',
      osVersion: () => '26.6.2'
    })

    const adopted = await again.ensure(owner, signal())
    expect(adopted.deviceServiceId).toBe(record.deviceServiceId)
    expect(signer.prompts).toHaveLength(0)
    expect(first.da.requests).toHaveLength(1)
  })

  it('reuses a legacy Secure Enclave pair before create can replace the physical-Mac identity', async () => {
    const signer = new SoftwareDeviceSigner()
    const existing = vi.spyOn(signer, 'existingKeys')
    const create = vi.spyOn(signer, 'publicKeys')
    const first = enrollment({ signer, keys: [controllerKey()] })
    const record = await first.subject.ensure(owner, signal())

    expect(existing).toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()

    // An update can lose the encrypted enrollment projection while the Secure Enclave blobs
    // remain. Reopening must adopt the same registry row, not invoke the helper's destructive
    // legacy `create` migration and enroll another Mac.
    const reopened = new DeviceEnrollment({
      store: vault(),
      signer,
      transport: first.da.transport,
      displayName: () => 'MacBook Pro',
      osVersion: () => '26.6.2'
    })

    await expect(reopened.ensure(owner, signal())).resolves.toMatchObject({
      deviceServiceId: record.deviceServiceId,
      identityKid: record.identityKid,
      enrollmentEpoch: record.enrollmentEpoch
    })
    expect(first.da.requests).toHaveLength(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('revokes a registration of this Matrix device it can no longer sign for, then enrolls afresh', async () => {
    const keys = [controllerKey()]
    const lost = enrollment({ keys })
    const old = await lost.subject.ensure(owner, signal())

    // New keys (the old blobs are gone) and a new vault, against the same registry.
    const signer = new SoftwareDeviceSigner()

    const fresh = new DeviceEnrollment({
      store: vault(),
      signer,
      transport: lost.da.transport,
      displayName: () => 'MacBook Pro',
      osVersion: () => '26.6.2'
    })

    const record = await fresh.ensure(owner, signal())
    expect(record.deviceServiceId).not.toBe(old.deviceServiceId)
    expect(record.enrollmentEpoch).toBe(1)
    expect(lost.da.rows.get(old.deviceServiceId)?.state).toBe('revoked')
  })

  it('starts over with new keys when the owner revoked this Mac elsewhere', async () => {
    const { subject, da, signer } = enrollment()
    const first = await subject.ensure(owner, signal())
    const oldIdentity = signer.identity.public.kid
    await da.transport.revoke(first.deviceServiceId, signal())

    // The next sign-in wants a re-bind; the registry answers that the service is revoked.
    const record = await subject.ensure({ ...owner, deviceId: 'MACBOOKNEW2' }, signal())

    expect(record.deviceServiceId).not.toBe(first.deviceServiceId)
    expect(record.enrollmentEpoch).toBe(1)
    expect(record.identityKid).not.toBe(oldIdentity)
  })

  it('adopts a rotation the registry applied when its answer was lost', async () => {
    const { subject, da, signer } = enrollment()
    await subject.ensure(owner, signal())
    const next = { ...owner, deviceId: 'MACBOOKNEW2' }

    da.loseNextAnswer()
    await expect(subject.ensure(next, signal())).rejects.toMatchObject({ code: 'unavailable' })

    // Retried: the registry already holds epoch 2 for this device, so it is adopted, unprompted.
    const record = await subject.ensure(next, signal())
    expect(record.enrollmentEpoch).toBe(2)
    expect(signer.prompts).toHaveLength(0)
  })

  it('does not consult the protected-action prompt while enrolling', async () => {
    for (const outcome of ['denied', 'timeout'] as const) {
      const signer = new SoftwareDeviceSigner()
      signer.outcome = outcome
      const { subject, da } = enrollment({ signer })

      await expect(subject.ensure(owner, signal())).resolves.toMatchObject({ state: 'active' })
      expect(da.requests).toHaveLength(1)
      expect(signer.prompts).toEqual([])
    }
  })

  it('reports a registry that is not open for this owner as unavailable', async () => {
    const { subject, da } = enrollment()
    da.down(true)

    const error = await subject.ensure(owner, signal()).catch(value => value)
    expect(error).toBeInstanceOf(DeviceEnrollmentError)
    expect(error.code).toBe('unavailable')
  })

  it('shares one enrollment between concurrent callers', async () => {
    const { subject, da, signer } = enrollment()

    const [a, b] = await Promise.all([subject.ensure(owner, signal()), subject.ensure(owner, signal())])

    expect(a.deviceServiceId).toBe(b.deviceServiceId)
    expect(da.requests).toHaveLength(1)
    expect(signer.prompts).toHaveLength(0)
  })
})

describe('a controller Revoke, as the contract cases write it', () => {
  const cases = ['revoke-applied', 'revoke-older-ignored', 'revoke-other-epoch-ignored', 'revoke-older-applied'].map(
    name => fixture(`${name}.case.json`)
  )

  for (const item of cases) {
    it(item.name, async () => {
      const store = vault()

      store.setItem(
        'device-enrollment-v1',
        JSON.stringify({
          v: 1,
          ownerUserId: item.device.ownerUserId,
          deviceServiceId: item.device.deviceServiceId,
          enrollmentEpoch: item.device.enrollmentEpoch,
          identityKid: 'rffnGV1sIeV_YF241ah2Rtdt62T-8NUOYu99JYRAF1Y',
          approvalKid: 'T9UfgAYiILq7nfB8dC1810vqnCVv2rzsr5U5G40TeiQ',
          matrixDeviceId: 'MACBOOKQ7ZK',
          matrixFingerprint: owner.fingerprint,
          scopes: item.device.localScopes,
          pinnedControllerKeys: item.device.pinnedControllerKeys,
          controllerKeys: item.device.controllerKeys,
          revokeSeq: item.lastRevokeSeq,
          state: 'active',
          updatedAt: 0
        })
      )

      const { subject } = enrollment({ store })
      const outcome = subject.applyRevoke(item.revoke.body)

      if (item.name === 'an older revoke applied over a newer one') {
        // The reject fixture: applying it would let a delayed revoke undo a newer one.
        expect(outcome).toEqual({ outcome: 'ignored', reason: 'older_revoke' })
      } else if (item.expect.outcome === 'applied') {
        expect(outcome).toEqual({ outcome: 'applied' })
        expect(subject.current()?.state).toBe('revoked')
        expect(subject.activeFor({ ...owner, userId: item.device.ownerUserId })).toBeNull()
      } else {
        expect(outcome).toEqual({ outcome: 'ignored', reason: item.expect.reason })
        expect(subject.current()?.state).toBe('active')
      }
    })
  }

  it('a revoked enrollment trusts no controller key', async () => {
    const { subject, da, keys } = enrollment()
    const record = await subject.ensure(owner, signal())
    expect(subject.controllerKey(keys[0]!.kid)).not.toBeNull()

    expect(subject.applyRevoke({ deviceServiceId: record.deviceServiceId, enrollmentEpoch: 1, revokeSeq: 1 })).toEqual({
      outcome: 'applied'
    })
    expect(subject.controllerKey(keys[0]!.kid)).toBeNull()
    expect(da.rows.size).toBe(1)
  })
})
