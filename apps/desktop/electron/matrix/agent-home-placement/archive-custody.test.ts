/**
 * Who may ask the platform for a home's archive or key, and the signed envelope it asks with (`archive-custody.ts`).
 * The routes admit a device, not a lease: the placement's Mac, or the target of its one active move.
 */
import { createPublicKey, randomUUID, verify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { ArchiveCustody, custodyLease, mayHoldCustody } from './archive-custody'
import { agentHomeSignedBytes, type ExecutorSignedMeta, type HomeAuthorityFence, type HomePlacement, isUuid } from './contract'
import { EXECUTOR_SEQUENCE_KEY } from './executor-auth'
import type { LeaseFacts } from './fence'
import type { TestMac } from './mac.fixture'
import { createWorld, requestMove, signal } from './world.fixture'

const ME = '00000000-0000-4000-8000-b454f82c5857'
const OTHER = '00000000-0000-4000-8000-f6222a1106ee'

const placement = (overrides: Partial<HomePlacement> = {}): HomePlacement =>
  ({
    ownerUserId: '@owner:atum.example',
    agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
    homeId: '00000000-0000-4000-8000-e8d95748107a',
    location: { kind: 'mac', deviceServiceId: OTHER },
    homeEpoch: 3,
    placementRevision: 5,
    selectedGeneration: 4,
    rollbackFloorGeneration: 1,
    activeMove: null,
    policyRevision: 1,
    ...overrides
  }) as HomePlacement

const moveTo = (target: string, status: 'requested' | 'draining' | 'ready_to_commit' | 'committed' | 'aborted' | 'superseded') => ({
  moveId: randomUUID(),
  idempotencyKey: randomUUID(),
  intent: 'manual' as const,
  status,
  source: { kind: 'mac' as const, deviceServiceId: OTHER },
  target: { kind: 'mac' as const, deviceServiceId: target },
  expectedHomeEpoch: 3,
  expectedPlacementRevision: 5,
  requestedAtPlatform: 1
})

describe('who may hold custody of a home\'s archive and key', () => {
  it('is the placement\'s Mac, and the target of its one active move, and nobody else', () => {
    expect(mayHoldCustody(placement({ location: { kind: 'mac', deviceServiceId: ME } }), ME)).toBe(true)

    for (const status of ['requested', 'draining', 'ready_to_commit'] as const) {
      expect(mayHoldCustody(placement({ activeMove: moveTo(ME, status) }), ME), status).toBe(true)
    }

    // A move that is over holds nothing for its target (a committed one has made it the placement's Mac, which is the first rule).
    for (const status of ['committed', 'aborted', 'superseded'] as const) {
      expect(mayHoldCustody(placement({ activeMove: moveTo(ME, status) }), ME), status).toBe(false)
    }

    // Not the target of the move, not the placement's Mac, the cloud's home.
    expect(mayHoldCustody(placement({ activeMove: moveTo(OTHER, 'draining') }), ME)).toBe(false)
    expect(mayHoldCustody(placement(), ME)).toBe(false)
    expect(mayHoldCustody(placement({ location: { kind: 'cloud' } }), ME)).toBe(false)
    expect(mayHoldCustody(placement({ activeMove: { ...moveTo(ME, 'draining'), target: { kind: 'cloud' } } }), ME)).toBe(false)
  })

  it('presents a custody lease when it holds none: the placement\'s facts, term 1, a lease id of its own, and the end of its own frame', () => {
    const lease = custodyLease(placement(), { expiresAt: 1_800_000_300_000 }, '00000000-0000-4000-8000-f1d11edf5c5c')

    expect(lease).toEqual({
      ownerUserId: '@owner:atum.example',
      agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
      homeId: '00000000-0000-4000-8000-e8d95748107a',
      homeEpoch: 3,
      executorTerm: 1,
      leaseId: '00000000-0000-4000-8000-f1d11edf5c5c',
      leaseExpiresAtPlatform: 1_800_000_300_000
    })
  })
})

describe('the signed envelope of a custody call', () => {
  /** An agent at A, and a signer for each of the two Macs. */
  async function twoMacs() {
    const w = await createWorld({ at: 'a' })

    const custody = (mac: TestMac, facts: LeaseFacts | null = null, uuid?: () => string) =>
      new ArchiveCustody({ platform: mac.platform, auth: mac.auth, me: () => mac.deviceServiceId, leaseFacts: () => facts, ...(uuid ? { uuid } : {}) })

    const leaseOfA = (): LeaseFacts => {
      const lease = w.stub.lease(w.agent)!

      return { leaseId: lease.leaseId, leaseExpiresAtPlatform: lease.expiresAt, executorTerm: lease.term }
    }

    return { w, custody, leaseOfA, homeId: w.stub.placement(w.agent).homeId }
  }

  /** The signed body of a call that was signed (the test fails when it was not). */
  const bodyOf = (signed: Awaited<ReturnType<ArchiveCustody['sign']>>) => {
    if (signed.ok === false) {
      throw new Error(`not_signed:${signed.kind}`)
    }

    return signed.body as { meta: ExecutorSignedMeta; fence: HomeAuthorityFence } & Record<string, unknown>
  }

  const verifies = async (mac: TestMac, action: Parameters<typeof agentHomeSignedBytes>[0], body: { meta: ExecutorSignedMeta }) => {
    const keys = await mac.signer.publicKeys()
    const key = createPublicKey({ key: Buffer.from(keys.identity.spki, 'base64url'), format: 'der', type: 'spki' })

    return verify('sha256', agentHomeSignedBytes(action, body), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(body.meta.signature, 'base64url'))
  }

  it('is signed with the Mac\'s device key under the action of the call, and under no other', async () => {
    const { w, custody, leaseOfA, homeId } = await twoMacs()

    const signed = await custody(w.a, leaseOfA()).sign({ agent: w.agent, homeId, action: 'CheckpointArchiveBegin' }, { operation: 'begin', generation: 2 }, signal())

    const body = bodyOf(signed)

    expect(await verifies(w.a, 'CheckpointArchiveBegin', body)).toBe(true)
    // The action is in the signed bytes, so a begin cannot be replayed as a download or a key read.
    expect(await verifies(w.a, 'CheckpointArchiveDownload', body)).toBe(false)
    expect(await verifies(w.a, 'HomeKeyRead', body)).toBe(false)
    expect(await verifies(w.b, 'CheckpointArchiveBegin', body)).toBe(false)
    expect(body.meta).toMatchObject({ signer: 'mac_executor', deviceServiceId: w.a.deviceServiceId })
  })

  it('carries the call\'s own fields beside the meta and the fence, and nothing more', async () => {
    const { w, custody, leaseOfA, homeId } = await twoMacs()

    const key = await custody(w.a, leaseOfA()).sign({ agent: w.agent, homeId, action: 'HomeKeyRead' }, {}, signal())
    expect(key.ok && Object.keys(key.body).sort()).toEqual(['fence', 'meta'])

    const finalize = await custody(w.a, leaseOfA()).sign(
      { agent: w.agent, homeId, action: 'CheckpointArchiveFinalize' },
      { operation: 'finalize', checkpointId: randomUUID(), generation: 2, byteSize: 9, uploadToken: randomUUID(), archiveSha256: 'a'.repeat(64) },
      signal()
    )

    expect(finalize.ok && Object.keys(finalize.body).sort()).toEqual(['archiveSha256', 'byteSize', 'checkpointId', 'fence', 'generation', 'meta', 'operation', 'uploadToken'])
  })

  it('presents the lease the Mac holds, and the operation it was given', async () => {
    const { w, custody, leaseOfA, homeId } = await twoMacs()
    const operation = { kind: 'job' as const, id: randomUUID() }
    const lease = leaseOfA()

    const signed = await custody(w.a, lease).sign({ agent: w.agent, homeId, action: 'HomeKeyRead', operation }, {}, signal())

    expect(signed.ok && (signed.body.fence as HomeAuthorityFence)).toEqual({
      ownerUserId: w.stub.ownerUserId,
      agentPrincipal: w.agent,
      homeId,
      homeEpoch: 1,
      executorTerm: lease.executorTerm,
      leaseId: lease.leaseId,
      leaseExpiresAtPlatform: lease.leaseExpiresAtPlatform,
      operation
    })
  })

  it('mints a job of its own when no operation is given, and a lease-less home Mac presents a custody lease', async () => {
    const { w, custody, homeId } = await twoMacs()
    const ids = ['00000000-0000-4000-8000-fbfe405ca65f', '00000000-0000-4000-8000-a9703d75e616']
    const uuid = () => ids.shift()!

    // The home Mac, with no lease at this moment (it has just been made the home and is not yet running the agent).
    const signed = await custody(w.a, null, uuid).sign({ agent: w.agent, homeId, action: 'CheckpointArchiveDownload' }, { operation: 'download', generation: 2 }, signal())

    const body = bodyOf(signed)

    expect(body.fence).toEqual({
      ownerUserId: w.stub.ownerUserId,
      agentPrincipal: w.agent,
      homeId,
      homeEpoch: 1,
      executorTerm: 1,
      // The operation's job id is drawn first, the custody lease's id second.
      leaseId: '00000000-0000-4000-8000-a9703d75e616',
      leaseExpiresAtPlatform: body.meta.expiresAt,
      operation: { kind: 'job', id: '00000000-0000-4000-8000-fbfe405ca65f' }
    })
  })

  it('lets the target of an active move sign, with a custody lease, before it is the home', async () => {
    const { w, custody, homeId } = await twoMacs()
    await requestMove(w)

    const signed = await custody(w.b).sign({ agent: w.agent, homeId, action: 'CheckpointArchiveDownload' }, { operation: 'download', generation: 1 }, signal())

    const body = bodyOf(signed)

    expect(body.meta.deviceServiceId).toBe(w.b.deviceServiceId)
    expect(body.fence).toMatchObject({ homeId, homeEpoch: 1, executorTerm: 1, leaseExpiresAtPlatform: body.meta.expiresAt })
    expect(isUuid(body.fence.leaseId)).toBe(true)
    expect(await verifies(w.b, 'CheckpointArchiveDownload', body)).toBe(true)
  })

  it('signs nothing for a Mac that is neither the home nor the move\'s target, and says it may not', async () => {
    const { w, custody, homeId } = await twoMacs()
    const before = w.b.store.getItem(`${EXECUTOR_SEQUENCE_KEY}:${w.b.deviceServiceId}`)

    expect(await custody(w.b).sign({ agent: w.agent, homeId, action: 'HomeKeyRead' }, {}, signal())).toEqual({ ok: false, kind: 'forbidden' })
    // Not even the counter that numbers the Mac's frames moved: no frame was made.
    expect(w.b.store.getItem(`${EXECUTOR_SEQUENCE_KEY}:${w.b.deviceServiceId}`)).toBe(before)
  })

  it('signs afresh every time: a frame is never sent twice, so a retry is never a resend', async () => {
    const { w, custody, leaseOfA, homeId } = await twoMacs()
    const signer = custody(w.a, leaseOfA())
    const first = await signer.sign({ agent: w.agent, homeId, action: 'HomeKeyRead' }, {}, signal())
    const second = await signer.sign({ agent: w.agent, homeId, action: 'HomeKeyRead' }, {}, signal())

    const a = bodyOf(first).meta
    const b = bodyOf(second).meta

    expect(b.sequence).toBeGreaterThan(a.sequence)

    for (const field of ['nonce', 'commandId', 'requestId', 'signature'] as const) {
      expect(b[field], field).not.toBe(a[field])
    }
  })

  it('does not sign for a home the platform no longer names', async () => {
    const { w, custody, leaseOfA } = await twoMacs()
    const signer = custody(w.a, leaseOfA())

    expect(await signer.sign({ agent: w.agent, homeId: '00000000-0000-4000-8000-c8f367a876b2', action: 'HomeKeyRead' }, {}, signal())).toEqual({ ok: false, kind: 'conflict' })
  })

  it('says why it cannot ask the platform in the platform\'s own closed words', async () => {
    const { w, custody, leaseOfA, homeId } = await twoMacs()
    const signer = custody(w.a, leaseOfA())
    const ask = () => signer.sign({ agent: w.agent, homeId, action: 'HomeKeyRead' }, {}, signal())

    w.stub.unsupported = 'absent'
    expect(await ask()).toEqual({ ok: false, kind: 'unsupported' })
    w.stub.unsupported = null

    w.stub.failNext = { status: 401 }
    expect(await ask()).toEqual({ ok: false, kind: 'unauthorized' })

    w.stub.failNext = { status: 403 }
    expect(await ask()).toEqual({ ok: false, kind: 'forbidden' })

    w.stub.failNext = { status: 500 }
    expect(await ask()).toEqual({ ok: false, kind: 'unavailable' })
  })

  it('signs nothing when it is not enrolled, or when the key cannot sign', async () => {
    const { w, homeId, leaseOfA } = await twoMacs()
    const lease = leaseOfA()

    const notEnrolled = new ArchiveCustody({ platform: w.a.platform, auth: w.a.auth, me: () => null, leaseFacts: () => lease })
    expect(await notEnrolled.sign({ agent: w.agent, homeId, action: 'HomeKeyRead' }, {}, signal())).toEqual({ ok: false, kind: 'forbidden' })

    // The device's enrollment was revoked under it: the executor key is gone, so nothing is signed.
    w.a.enrollment.state = 'revoked'
    const revoked = new ArchiveCustody({ platform: w.a.platform, auth: w.a.auth, me: () => w.a.deviceServiceId, leaseFacts: () => lease })
    expect(await revoked.sign({ agent: w.agent, homeId, action: 'HomeKeyRead' }, {}, signal())).toEqual({ ok: false, kind: 'unavailable' })
  })
})
