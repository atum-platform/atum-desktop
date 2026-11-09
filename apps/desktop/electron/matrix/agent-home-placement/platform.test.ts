import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { agentHomeSignedBytes, type HomeAuthorityFence, type HomeOperation, isKeyId, isSha256, validExecutorMeta } from './contract'
import { EXECUTOR_FRAME_BACKDATE_MS, EXECUTOR_FRAME_TTL_MS, ExecutorAuthError } from './executor-auth'
import { type TestMac } from './mac.fixture'
import { pack, readPackJson } from './pack.fixture'
import { interpret, PUBLICATION_DISABLED, PUBLICATION_IN_FLIGHT, refusalReason } from './platform-client'
import { decideAuthorityAdmission, StubMatrixServer } from './stub-platform.fixture'
import { createWorld, fenceOf, leaseFenceOf, mintOperation, signal, type World } from './world.fixture'

async function reserve(w: World, mac: TestMac, fence: HomeAuthorityFence, revision = w.stub.placement(w.agent).placementRevision) {
  const body = await mac.auth.sign('CheckpointReserve', meta => ({
    operation: 'reserve' as const,
    meta,
    checkpointId: randomUUID(),
    expectedPlacementRevision: revision,
    fence
  }))

  return { body, result: await mac.platform.reserveCheckpoint(w.agent, body as never, signal()) }
}

/**
 * The sealed bytes of a generation, stored where the platform keeps them: a verified checkpoint commit needs the durable
 * receipt of this upload (0284). This file is about the checkpoint route, not the upload (that is `archive.test.ts`), so
 * the platform is left as `begin`, a complete upload and `finalize` would leave it.
 */
async function upload(w: World, generation: number, bytes: Buffer = Buffer.from(`sealed bytes of generation ${generation}`)) {
  return w.stub.storeArchive(w.agent, generation, bytes)
}

async function commit(
  w: World,
  mac: TestMac,
  fence: HomeAuthorityFence,
  reserved: { checkpointId: string; generation: number; parentGeneration: number },
  options: { verified?: boolean; manifestSha256?: string; upload?: boolean } = {}
) {
  // The upload comes first, as the Mac does it; a commit that says "verified" without one is the case under test.
  if (options.verified !== false && options.upload !== false) {
    await upload(w, reserved.generation)
  }

  const placement = w.stub.placement(w.agent)

  const body = await mac.auth.sign('CheckpointCommit', meta => ({
    operation: 'commit' as const,
    meta,
    checkpointId: reserved.checkpointId,
    generation: reserved.generation,
    parentGeneration: reserved.parentGeneration,
    expectedHomeEpoch: placement.homeEpoch,
    expectedPlacementRevision: placement.placementRevision,
    manifestSha256: options.manifestSha256 ?? 'a'.repeat(64),
    uploadVerified: options.verified ?? true,
    fence
  }))

  return { body, result: await mac.platform.commitCheckpoint(w.agent, body as never, signal()) }
}

const reservedOf = (result: Awaited<ReturnType<typeof reserve>>['result']) => {
  if (!result.ok || result.value.outcome !== 'reserved') {
    throw new Error('not reserved')
  }

  return result.value
}

const verdict = (result: { ok: boolean; kind?: string; reason?: string }) => (result.ok ? 'accepted' : (result.reason ?? result.kind))

describe('the stub platform keeps to the pack', () => {
  const cases = pack().fixtures.filter(fixture => fixture.message === 'case.authority_admission')

  it('has the authority cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
  })

  it.each(cases.map(fixture => [fixture.file.replace('fixtures/', ''), fixture] as const))('%s', (_name, fixture) => {
    const value = readPackJson<{
      presented: Parameters<typeof decideAuthorityAdmission>[0]
      trusted: Parameters<typeof decideAuthorityAdmission>[1]
      expect: unknown
    }>(fixture.file)

    expect(decideAuthorityAdmission(value.presented, value.trusted)).toEqual(value.expect)
  })
})

describe('what an answer means', () => {
  const parse = (value: unknown) => (value === 'good' ? 'parsed' : null)

  it('reads a 200 through the contract parser and refuses anything else it says', () => {
    expect(interpret(200, 'good', parse)).toEqual({ ok: true, value: 'parsed' })
    expect(interpret(200, 'odd', parse)).toEqual({ ok: false, kind: 'invalid', status: 200 })
  })

  it('names the platform refusals, wherever the platform puts the reason', () => {
    expect(interpret(403, { outcome: 'refused', reason: 'stale_home_epoch' }, parse)).toEqual({
      ok: false,
      kind: 'refused',
      reason: 'stale_home_epoch',
      status: 403
    })
    expect(interpret(401, { error: 'matrix_401', details: { reason: 'signature_expired' } }, parse)).toMatchObject({ kind: 'refused', reason: 'signature_expired' })
    expect(interpret(403, { error: 'matrix_403', details: { reason: 'wrong_signer_location' } }, parse)).toMatchObject({ kind: 'refused', reason: 'wrong_signer_location' })
    expect(interpret(400, { error: 'matrix_400', details: { reason: 'bad_signature' } }, parse)).toMatchObject({ kind: 'refused', reason: 'bad_signature' })
    // The final platform's own words, beyond the frozen enum.
    expect(interpret(403, { outcome: 'refused', reason: 'replayed' }, parse)).toMatchObject({ kind: 'refused', reason: 'replayed' })
    expect(interpret(403, { outcome: 'refused', reason: 'move_in_progress' }, parse)).toMatchObject({ kind: 'refused', reason: 'move_in_progress' })
    expect(refusalReason({ error: 'x', details: { reason: 'something_else' } })).toBeNull()
  })

  it('tells a missing route from a failing one', () => {
    for (const status of [404, 405, 501]) {
      expect(interpret(status, undefined, parse)).toMatchObject({ kind: 'unsupported' })
    }

    expect(interpret(503, { error: 'matrix_503', details: { reason: 'not_configured' } }, parse)).toMatchObject({ kind: 'unsupported' })
    expect(interpret(503, { error: 'matrix_503', details: { reason: 'internal' } }, parse)).toMatchObject({ kind: 'unavailable' })
    expect(interpret(500, undefined, parse)).toMatchObject({ kind: 'unavailable' })
    expect(interpret(409, { error: 'matrix_409' }, parse)).toMatchObject({ kind: 'conflict' })
    expect(interpret(400, { error: 'matrix_400' }, parse)).toMatchObject({ kind: 'invalid' })
    expect(interpret(401, { error: 'matrix_401' }, parse)).toMatchObject({ kind: 'unauthorized' })
    expect(interpret(403, { error: 'matrix_403' }, parse)).toMatchObject({ kind: 'forbidden' })
  })
})

describe('the two words of the publication rollout', () => {
  const parse = () => null

  it('reads a switched-off publication worker only from the exact reason, on a 503', () => {
    const disabled = { error: 'matrix_503', details: { reason: 'publication_disabled' } }

    expect(interpret(503, disabled, parse)).toEqual({ ok: false, kind: 'publication_disabled', status: 503 })
    expect(PUBLICATION_DISABLED).toBe('publication_disabled')

    // Anything that is not exactly that is not it: another word, a longer one, a shorter one, no word, another status.
    for (const reason of ['publication_disabled_', 'publication', 'PUBLICATION_DISABLED', ' publication_disabled', 'not_configured_publication_disabled', '']) {
      expect(interpret(503, { error: 'matrix_503', details: { reason } }, parse)).not.toMatchObject({ kind: 'publication_disabled' })
    }

    expect(interpret(503, { error: 'matrix_503' }, parse)).toMatchObject({ kind: 'unavailable' })
    expect(interpret(503, { error: 'matrix_503', details: { reason: 42 } }, parse)).toMatchObject({ kind: 'unavailable' })
    expect(interpret(503, { error: 'matrix_503', details: 'publication_disabled' }, parse)).toMatchObject({ kind: 'unavailable' })
    expect(interpret(500, disabled, parse)).toMatchObject({ kind: 'unavailable' })
    expect(interpret(404, disabled, parse)).toMatchObject({ kind: 'unsupported' })
    expect(interpret(403, disabled, parse)).toMatchObject({ kind: 'forbidden' })
  })

  it('reads a publication in flight only from the exact reason, on a 409', () => {
    const inFlight = { error: 'matrix_409', details: { reason: 'agent_home_publication_in_flight' } }

    expect(interpret(409, inFlight, parse)).toEqual({ ok: false, kind: 'publication_in_flight', status: 409 })
    expect(PUBLICATION_IN_FLIGHT).toBe('agent_home_publication_in_flight')

    for (const reason of ['publication_in_flight', 'agent_home_publication_in_flight_', 'agent_home_publication', 'AGENT_HOME_PUBLICATION_IN_FLIGHT', '']) {
      expect(interpret(409, { error: 'matrix_409', details: { reason } }, parse)).toMatchObject({ kind: 'conflict' })
    }

    // A plain conflict stays a conflict: a stale epoch, a busy reservation, a move that is not the active one.
    expect(interpret(409, { error: 'matrix_409' }, parse)).toMatchObject({ kind: 'conflict' })
    expect(interpret(409, undefined, parse)).toMatchObject({ kind: 'conflict' })
    expect(interpret(503, inFlight, parse)).toMatchObject({ kind: 'unavailable' })
    expect(interpret(200, inFlight, parse)).toMatchObject({ kind: 'invalid' })
  })

  it('reaches the Mac through the real client: a switched-off worker answers the enqueue before any row exists', async () => {
    const w = await createWorld()

    w.stub.publicationsEnabled = false
    const bytes = Buffer.from(JSON.stringify({ msgtype: 'm.text', body: 'hi' }))
    const operation: HomeOperation = { kind: 'invocation', id: randomUUID() }
    w.stub.registerOperation(w.agent, operation)
    const revision = w.stub.placement(w.agent).placementRevision

    const frame = await w.a.auth.sign('MatrixPublicationEnqueue', meta => ({
      meta,
      fence: fenceOf(w, operation),
      expectedPlacementRevision: revision,
      moveSerializationRevision: revision,
      outboxId: randomUUID(),
      roomId: '!room:atum.example',
      transactionId: 'atum-1',
      payloadSha256: createHash('sha256').update(bytes).digest('hex')
    }))

    const disabled = await w.a.platform.enqueuePublication(
      w.agent,
      { publication: frame, eventType: 'm.room.message', payloadBase64: bytes.toString('base64') } as never,
      signal()
    )

    expect(disabled).toMatchObject({ ok: false, kind: 'publication_disabled', status: 503 })
    expect(w.stub.outboxRows(w.agent)).toHaveLength(0)

    // Answered before the request was looked at: it never reached the enqueue itself.
    expect(w.stub.requests.at(-1)).toMatchObject({ method: 'POST', status: 503 })
    expect(w.stub.requests.at(-1)?.path.endsWith('/home/publications')).toBe(true)
    expect(w.stub.requests.at(-1)?.action).toBeUndefined()
  })
})

describe('reading the placement', () => {
  it('returns the record exactly, with the wire header, the bearer and no cookie', async () => {
    const w = await createWorld()
    const result = await w.a.platform.readPlacement(w.agent, signal())

    expect(result).toMatchObject({ ok: true, value: { agentPrincipal: w.agent, homeEpoch: 1, location: { kind: 'mac', deviceServiceId: w.a.deviceServiceId } } })
    expect(w.stub.requests.at(-1)).toMatchObject({ method: 'GET', status: 200 })
    expect(w.stub.lastHeaders['atum-agent-home-wire']).toBe('2.1')
    expect(w.stub.lastHeaders.authorization).toBe(`Bearer ${w.stub.token}`)
    expect(w.stub.lastHeaders.cookie).toBeUndefined()
  })

  it('sends a body as application/json exactly, which is all the Shell accepts', async () => {
    const w = await createWorld()
    await reserve(w, w.a, fenceOf(w))

    expect(w.stub.lastHeaders['content-type']).toBe('application/json')
  })

  it('makes the placement lazily from the live executor, and never guesses without one', async () => {
    const w = await createWorld({ lazy: true, at: 'cloud' })

    expect(await w.a.platform.readPlacement(w.agent, signal())).toMatchObject({ ok: false, kind: 'unavailable', status: 503 })
    w.stub.grantLease(w.agent, w.b.deviceServiceId)
    expect(await w.a.platform.readPlacement(w.agent, signal())).toMatchObject({
      ok: true,
      value: { location: { kind: 'mac', deviceServiceId: w.b.deviceServiceId }, homeEpoch: 1, selectedGeneration: 1 }
    })
  })

  it('says unsupported when the platform has no such route yet or has it switched off', async () => {
    const w = await createWorld()
    w.stub.unsupported = 'absent'
    expect(await w.a.platform.readPlacement(w.agent, signal())).toMatchObject({ ok: false, kind: 'unsupported', status: 404 })
    w.stub.unsupported = 'not_configured'
    expect(await w.a.platform.readPlacement(w.agent, signal())).toMatchObject({ ok: false, kind: 'unsupported', status: 503 })
  })

  it('refuses an erased home and an agent that is not the owners', async () => {
    const w = await createWorld()
    w.stub.tombstone(w.agent)
    expect(await w.a.platform.readPlacement(w.agent, signal())).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await w.a.platform.readPlacement(randomUUID(), signal())).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await w.a.platform.readPlacement('not-a-uuid', signal())).toMatchObject({ ok: false, kind: 'invalid', status: 0 })
  })

  it('treats a platform that fails or answers something else as unavailable or invalid, never as a placement', async () => {
    const w = await createWorld()
    w.stub.failNext = { status: 500 }
    expect(await w.a.platform.readPlacement(w.agent, signal())).toMatchObject({ ok: false, kind: 'unavailable' })
    w.stub.failNext = { status: 200, body: { homeEpoch: 1 } }
    expect(await w.a.platform.readPlacement(w.agent, signal())).toMatchObject({ ok: false, kind: 'invalid' })
  })
})

describe('the owner moves an agent', () => {
  const request = (w: World, target: TestMac, overrides: Record<string, unknown> = {}) => {
    const placement = w.stub.placement(w.agent)

    return {
      moveId: randomUUID(),
      idempotencyKey: randomUUID(),
      target: { kind: 'mac' as const, deviceServiceId: target.deviceServiceId },
      expectedHomeEpoch: placement.homeEpoch,
      expectedPlacementRevision: placement.placementRevision,
      ...overrides
    }
  }

  it('requests a move, replays the same request, and refuses the same key for something else', async () => {
    const w = await createWorld()
    const input = request(w, w.b)
    const first = await w.a.platform.requestMove(w.agent, input, signal())

    expect(first).toMatchObject({ ok: true, value: { outcome: 'requested', move: { status: 'requested', intent: 'manual' } } })
    expect(await w.a.platform.requestMove(w.agent, input, signal())).toMatchObject({ ok: true, value: { outcome: 'replay' } })
    expect(await w.a.platform.requestMove(w.agent, { ...input, target: { kind: 'mac', deviceServiceId: w.a.deviceServiceId } }, signal())).toMatchObject({
      ok: false,
      kind: 'conflict'
    })
  })

  it('refuses a stale epoch, a move to where it already is, and a device that is not the owners', async () => {
    const w = await createWorld()
    expect(await w.a.platform.requestMove(w.agent, request(w, w.b, { expectedHomeEpoch: 9 }), signal())).toMatchObject({ ok: false, kind: 'conflict' })
    expect(await w.a.platform.requestMove(w.agent, request(w, w.a), signal())).toMatchObject({ ok: false, kind: 'invalid' })
    expect(
      await w.a.platform.requestMove(w.agent, { ...request(w, w.b), target: { kind: 'mac', deviceServiceId: randomUUID() } }, signal())
    ).toMatchObject({ ok: false, kind: 'forbidden' })
  })

  it('does not move an agent out of the cloud in this slice', async () => {
    const w = await createWorld({ at: 'cloud' })

    expect(await w.a.platform.requestMove(w.agent, request(w, w.b), signal())).toMatchObject({ ok: false, kind: 'invalid', status: 400 })
  })

  it('lets a second manual request replace the first, and cancels with a CAS', async () => {
    const w = await createWorld()
    const first = await w.a.platform.requestMove(w.agent, request(w, w.b), signal())
    const second = await w.a.platform.requestMove(w.agent, request(w, w.b), signal())

    expect(second).toMatchObject({ ok: true, value: { outcome: 'superseded_previous' } })
    expect(w.stub.moves(w.agent).map(move => move.status)).toEqual(['superseded', 'requested'])

    const active = second.ok ? second.value.move : null
    const placement = w.stub.placement(w.agent)

    const abort = await w.a.platform.abortMove(
      w.agent,
      { moveId: active!.moveId, idempotencyKey: active!.idempotencyKey, expectedHomeEpoch: placement.homeEpoch, expectedPlacementRevision: placement.placementRevision, reason: 'owner_cancelled' },
      signal()
    )

    expect(abort).toEqual({ ok: true, value: 'aborted' })
    expect(w.stub.placement(w.agent).activeMove).toBeNull()
    expect(first.ok).toBe(true)
  })
})

describe('the Mac executor signs what it says', () => {
  it('carries a header bound to this device, the pinned key and a bounded window that never starts in the future', async () => {
    const w = await createWorld()
    const { body } = await reserve(w, w.a, fenceOf(w))
    const keys = await w.a.signer.publicKeys()

    expect(validExecutorMeta(body.meta)).toBe(true)
    expect(body.meta).toMatchObject({ signer: 'mac_executor', deviceServiceId: w.a.deviceServiceId, signerKeyId: keys.identity.kid })
    expect(isKeyId(body.meta.nonce)).toBe(true)
    expect(EXECUTOR_FRAME_BACKDATE_MS).toBe(5_000)
    expect(body.meta.issuedAt).toBe(w.clock.now() - EXECUTOR_FRAME_BACKDATE_MS)
    expect(body.meta.issuedAt).toBeLessThanOrEqual(w.clock.now())
    expect(body.meta.expiresAt - body.meta.issuedAt).toBe(EXECUTOR_FRAME_TTL_MS)
    expect(body.meta.expiresAt - body.meta.issuedAt).toBeLessThanOrEqual(2 * 60 * 60_000)
  })

  it('never repeats a nonce, a command id or a sequence, even if its counter is lost', async () => {
    const w = await createWorld()
    const seen = { nonce: new Set<string>(), command: new Set<string>(), sequence: new Set<number>() }

    for (let i = 0; i < 5; i += 1) {
      const { body } = await reserve(w, w.a, fenceOf(w))
      seen.nonce.add(body.meta.nonce)
      seen.command.add(body.meta.commandId)
      seen.sequence.add(body.meta.sequence)
    }

    expect([seen.nonce.size, seen.command.size, seen.sequence.size]).toEqual([5, 5, 5])
    const last = Math.max(...seen.sequence)

    // A store that was wiped starts again from nothing, but the sequence never goes below the clock.
    w.a.store.setItem(`agent-home-executor-sequence-v1:${w.a.deviceServiceId}`, '0')
    w.clock.advance(1_000)
    const next = (await reserve(w, w.a, fenceOf(w))).body.meta.sequence

    expect(next).toBeGreaterThan(last)
  })

  it('numbers its frames strictly upward, durably, and stops if it cannot store the number', async () => {
    const w = await createWorld()
    const first = (await reserve(w, w.a, fenceOf(w))).body.meta.sequence
    const second = (await reserve(w, w.a, fenceOf(w))).body.meta.sequence

    expect(second).toBe(first + 1)
    w.a.store.failing = 'disk'
    await expect(reserve(w, w.a, fenceOf(w))).rejects.toMatchObject({ code: 'store_unavailable' })
  })

  it('refuses to sign without an active enrollment, or when the enrollment names another key', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)

    w.a.enrollment.identityKid = 'A'.repeat(43)
    await expect(reserve(w, w.a, fence)).rejects.toMatchObject({ code: 'key_mismatch' })
    w.a.enrollment.identityKid = (await w.a.signer.publicKeys()).identity.kid
    w.a.enrollment.state = 'revoked'
    await expect(reserve(w, w.a, fence)).rejects.toBeInstanceOf(ExecutorAuthError)
    await expect(reserve(w, w.a, fence)).rejects.toMatchObject({ code: 'device_not_enrolled' })
  })

  it('does not sign if the enrollment moves on while the key is signing', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)
    const real = w.a.signer.signIdentity.bind(w.a.signer)

    w.a.signer.signIdentity = async bytes => {
      w.a.enrollment.enrollmentEpoch += 1

      return real(bytes)
    }

    await expect(reserve(w, w.a, fence)).rejects.toMatchObject({ code: 'key_mismatch' })
  })

  it('has a signature that covers the action, the device and every field', async () => {
    const w = await createWorld()
    const { body } = await reserve(w, w.a, fenceOf(w))
    const keys = await w.a.signer.publicKeys()
    const key = createPublicKey({ key: Buffer.from(keys.identity.spki, 'base64url'), format: 'der', type: 'spki' })

    const check = (action: Parameters<typeof agentHomeSignedBytes>[0], value: unknown) =>
      verify('sha256', agentHomeSignedBytes(action, value as never), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(body.meta.signature, 'base64url'))

    expect(check('CheckpointReserve', body)).toBe(true)
    expect(check('CheckpointCommit', body)).toBe(false)
    expect(check('DrainAck', body)).toBe(false)
    expect(check('CheckpointReserve', { ...body, meta: { ...body.meta, deviceServiceId: w.b.deviceServiceId } })).toBe(false)
    expect(check('CheckpointReserve', { ...body, expectedPlacementRevision: body.expectedPlacementRevision + 1 })).toBe(false)
    expect(check('CheckpointReserve', { ...body, meta: { ...body.meta, expiresAt: body.meta.expiresAt + 1 } })).toBe(false)
    expect(check('CheckpointReserve', { ...body, meta: { ...body.meta, nonce: 'B'.repeat(43) } })).toBe(false)
    expect(check('CheckpointReserve', { ...body, fence: { ...body.fence, homeEpoch: body.fence.homeEpoch + 1 } })).toBe(false)
  })
})

describe('the platform admits only the current home', () => {
  it('reserves exactly the next generation and commits only verified bytes', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)
    const { result } = await reserve(w, w.a, fence)

    expect(result).toMatchObject({ ok: true, value: { outcome: 'reserved', generation: 2, parentGeneration: 1, homeEpoch: 1, replayed: false } })

    const committed = await commit(w, w.a, fence, reservedOf(result))

    expect(committed.result).toMatchObject({
      ok: true,
      value: { outcome: 'committed', generation: 2, selectedGeneration: 2, placementRevision: 2, manifestSha256: 'a'.repeat(64) }
    })
    expect(isSha256('a'.repeat(64))).toBe(true)
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 2, placementRevision: 2, homeEpoch: 1 })
  })

  it('admits a checkpoint from any well-formed operation: it needs the lease and the epoch, not a live invocation', async () => {
    const w = await createWorld()

    expect(verdict((await reserve(w, w.a, fenceOf(w, { kind: 'invocation', id: randomUUID() }))).result)).toBe('accepted')
  })

  it('keeps the previous generation selected when the upload could not be verified', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)
    const reserved = reservedOf((await reserve(w, w.a, fence)).result)
    const failed = await commit(w, w.a, fence, reserved, { verified: false, manifestSha256: 'b'.repeat(64) })

    expect(failed.result).toMatchObject({ ok: true, value: { outcome: 'verification_failed', selectedGeneration: 1, placementRevision: 1 } })
    expect(w.stub.placement(w.agent)).toMatchObject({ selectedGeneration: 1, placementRevision: 1 })
  })

  it('refuses a stale home epoch, a stale term, a wrong owner and a wrong home', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)

    expect(verdict((await reserve(w, w.a, { ...fence, homeEpoch: 2 })).result)).toBe('stale_home_epoch')
    expect(verdict((await reserve(w, w.a, { ...fence, executorTerm: fence.executorTerm + 1 })).result)).toBe('stale_executor_term')
    expect(verdict((await reserve(w, w.a, { ...fence, ownerUserId: '@someone:atum.example' })).result)).toBe('wrong_owner')
    expect(verdict((await reserve(w, w.a, { ...fence, homeId: randomUUID() })).result)).toBe('wrong_home')
  })

  it('refuses a renewed-away lease and an expired one', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)

    // The presented expiry must match the platform's exactly: a renewal moves it.
    w.clock.advance(1_000)
    w.stub.renewLease(w.agent)
    expect(verdict((await reserve(w, w.a, fence)).result)).toBe('wrong_lease')

    // A replaced holder is a new lease id and a new term.
    const stale = fenceOf(w)
    w.stub.grantLease(w.agent, w.a.deviceServiceId)
    expect(verdict((await reserve(w, w.a, stale)).result)).toBe('stale_executor_term')

    const current = fenceOf(w)
    w.clock.advance(120_000)
    expect(verdict((await reserve(w, w.a, current)).result)).toBe('lease_expired')
  })

  it('refuses a Mac that is not the placement, a key the platform did not pin, and a window that has ended', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)

    expect(verdict((await reserve(w, w.b, fence)).result)).toBe('wrong_signer_location')
    w.stub.retireDevice(w.a.deviceServiceId)
    expect(verdict((await reserve(w, w.a, fence)).result)).toBe('unpinned_signer_key')
  })

  it('refuses a frame whose window has ended, and one dated in the future, before the authority check', async () => {
    const w = await createWorld()
    const { body } = await reserve(w, w.a, fenceOf(w))
    w.clock.advance(EXECUTOR_FRAME_TTL_MS)
    w.stub.renewLease(w.agent, 600_000)

    expect(await w.a.platform.reserveCheckpoint(w.agent, body as never, signal())).toMatchObject({ ok: false, kind: 'refused', reason: 'signature_expired', status: 401 })

    // The platform allows no future skew: a Mac whose clock runs 30 s fast backdates only five seconds,
    // so its frame is dated after the platform's now and is refused.
    const fence = fenceOf(w)
    w.clock.advance(30_000)

    const future = await w.a.auth.sign('CheckpointReserve', meta => ({
      operation: 'reserve' as const,
      meta,
      checkpointId: randomUUID(),
      expectedPlacementRevision: 1,
      fence
    }))

    w.clock.time -= 30_000
    expect(await w.a.platform.reserveCheckpoint(w.agent, future as never, signal())).toMatchObject({ ok: false, kind: 'refused', reason: 'signature_expired', status: 401 })
  })

  it('refuses a body that was changed after it was signed', async () => {
    const w = await createWorld()
    const { body } = await reserve(w, w.a, fenceOf(w), 1)
    const tampered = { ...body, expectedPlacementRevision: 2 }

    expect(await w.a.platform.reserveCheckpoint(w.agent, tampered as never, signal())).toMatchObject({ ok: false, kind: 'refused', reason: 'bad_signature', status: 400 })
  })

  it('refuses a frame sent twice, and a nonce, command id or sequence used again, until the frame can no longer be live', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)
    const first = await reserve(w, w.a, fence)

    expect(first.result.ok).toBe(true)
    // The same signed body again, as a lost response would tempt a retry to do.
    expect(await w.a.platform.reserveCheckpoint(w.agent, first.body as never, signal())).toMatchObject({ ok: false, kind: 'refused', reason: 'replayed' })

    // Spent even when the operation itself was refused.
    const stale = await reserve(w, w.a, { ...fence, homeEpoch: 9 })
    expect(verdict(stale.result)).toBe('stale_home_epoch')
    expect(await w.a.platform.reserveCheckpoint(w.agent, stale.body as never, signal())).toMatchObject({ ok: false, reason: 'stale_home_epoch' })

    // A fresh frame for the same logical operation is the retry: reserving is idempotent by checkpoint id.
    const again = await w.a.auth.sign('CheckpointReserve', meta => ({
      operation: 'reserve' as const,
      meta,
      checkpointId: first.body.checkpointId,
      expectedPlacementRevision: 1,
      fence
    }))

    expect(await w.a.platform.reserveCheckpoint(w.agent, again as never, signal())).toMatchObject({ ok: true, value: { outcome: 'reserved', replayed: true } })
  })

  it('answers a stale placement revision with the revision to use', async () => {
    const w = await createWorld()

    expect((await reserve(w, w.a, fenceOf(w), 5)).result).toEqual({ ok: true, value: { outcome: 'stale_revision', placementRevision: 1 } })
  })

  it('lets one reservation live fifteen minutes of platform time, then fails it and frees the generation', async () => {
    const w = await createWorld()
    const fence = fenceOf(w)
    const reserved = reservedOf((await reserve(w, w.a, fence)).result)

    // Another reservation is refused while one is live.
    expect((await reserve(w, w.a, fence)).result).toMatchObject({ ok: false, kind: 'conflict' })

    w.clock.advance(15 * 60_000)
    w.stub.renewLease(w.agent, 600_000)
    const late = await commit(w, w.a, fenceOf(w), reserved)

    expect(late.result).toMatchObject({ ok: true, value: { outcome: 'reservation_expired', selectedGeneration: 1 } })
    expect(verdict((await reserve(w, w.a, fenceOf(w))).result)).toBe('accepted')
  })

  it('records an authenticated readiness report and nothing the Mac cannot prove', async () => {
    const w = await createWorld()
    const lease = leaseFenceOf(w)

    const report = await w.a.auth.sign('ReadinessReport', meta => ({
      meta,
      fence: lease,
      reportedAtLocal: w.clock.now(),
      powerState: 'awake' as const,
      checks: { homeAccessible: true, runtimeUsable: true, matrixIntakeWorking: true }
    }))

    expect(await w.a.platform.reportReadiness(w.agent, report as never, signal())).toMatchObject({
      ok: true,
      value: { reachable: true, powerState: 'awake', homeEpoch: 1, agentPrincipal: w.agent }
    })
    expect(w.stub.readiness(w.agent)).toMatchObject({ reachable: true, lastReadyAt: w.clock.now() })

    const failing = await w.a.auth.sign('ReadinessReport', meta => ({
      meta,
      fence: lease,
      reportedAtLocal: w.clock.now(),
      powerState: 'awake' as const,
      checks: { homeAccessible: true, runtimeUsable: false, matrixIntakeWorking: true }
    }))

    expect(await w.a.platform.reportReadiness(w.agent, failing as never, signal())).toMatchObject({ ok: true, value: { reachable: false, lastReadyAtPlatform: null } })

    const stale = await w.a.auth.sign('ReadinessReport', meta => ({
      meta,
      fence: { ...lease, homeEpoch: 3 },
      reportedAtLocal: w.clock.now(),
      powerState: 'awake' as const,
      checks: { homeAccessible: true, runtimeUsable: true, matrixIntakeWorking: true }
    }))

    expect(await w.a.platform.reportReadiness(w.agent, stale as never, signal())).toMatchObject({ ok: false, kind: 'refused', reason: 'stale_authority' })
  })
})

async function requested(w: World) {
  const placement = w.stub.placement(w.agent)

  const move = await w.b.platform.requestMove(
    w.agent,
    {
      moveId: randomUUID(),
      idempotencyKey: randomUUID(),
      target: { kind: 'mac', deviceServiceId: w.b.deviceServiceId },
      expectedHomeEpoch: placement.homeEpoch,
      expectedPlacementRevision: placement.placementRevision
    },
    signal()
  )

  if (!move.ok) {
    throw new Error('move not requested')
  }

  return move.value.move
}

const drain = async (w: World, moveId: string, fence: HomeAuthorityFence, result: 'quiesced' | 'timed_out' | 'unreachable' = 'quiesced') => {
  const ack = await w.a.auth.sign('DrainAck', meta => ({ meta, moveId, fence, result }))

  return w.a.platform.ackDrain(w.agent, ack as never, signal())
}

describe('a move, as the platform runs it', () => {
  it('moves requested to draining on the ack, and a checkpoint reserved after it readies the move', async () => {
    const w = await createWorld()
    const move = await requested(w)
    const operation = mintOperation()
    const fence = fenceOf(w, operation)

    expect(await drain(w, move.moveId, fence)).toMatchObject({ ok: true, value: { outcome: 'draining', move: { status: 'draining' } } })
    w.clock.advance(1_000)

    const reserved = reservedOf((await reserve(w, w.a, fenceOf(w, operation))).result)
    const committed = await commit(w, w.a, fenceOf(w, operation), reserved)

    expect(committed.result).toMatchObject({ ok: true, value: { outcome: 'committed', generation: 2 } })
    expect(w.stub.moves(w.agent)[0]).toMatchObject({ status: 'ready_to_commit', checkpointGeneration: 2 })
  })

  it('accepts a retried drain ack for the same operation as a replay, and refuses another operation', async () => {
    const w = await createWorld()
    const move = await requested(w)
    const operation = mintOperation()

    await drain(w, move.moveId, fenceOf(w, operation))
    expect(await drain(w, move.moveId, fenceOf(w, operation))).toMatchObject({ ok: true, value: { outcome: 'replay' } })
    expect(verdict(await drain(w, move.moveId, fenceOf(w, mintOperation())))).toBe('wrong_operation')
  })

  it('takes a checkpoint during the drain only from the operation the drain recorded', async () => {
    const w = await createWorld()
    const move = await requested(w)
    const operation = mintOperation()

    await drain(w, move.moveId, fenceOf(w, operation))
    w.clock.advance(1_000)

    expect(verdict((await reserve(w, w.a, fenceOf(w, mintOperation()))).result)).toBe('wrong_operation')
    expect(verdict((await reserve(w, w.a, fenceOf(w, operation))).result)).toBe('accepted')
  })

  it('does not let a checkpoint reserved before the drain ack make the move ready', async () => {
    const w = await createWorld()
    const early = reservedOf((await reserve(w, w.a, fenceOf(w))).result)
    const move = await requested(w)
    const operation = mintOperation()

    await drain(w, move.moveId, fenceOf(w, operation))
    // The drain failed the reservation that was open: the move starts a new generation's story.
    expect(w.stub.checkpoints(w.agent).find(checkpoint => checkpoint.checkpointId === early.checkpointId)).toMatchObject({ state: 'failed', failure: 'move_started' })
    // It has no archive receipt either (nothing could be put against a reservation the drain failed), so the platform
    // says what 0284 says of any verified commit without one.
    expect((await commit(w, w.a, fenceOf(w, operation), early)).result).toMatchObject({ ok: true, value: { outcome: 'verification_failed' } })
    expect(w.stub.moves(w.agent)[0]!.status).toBe('draining')
  })

  it('aborts the move when the source could not quiesce', async () => {
    const w = await createWorld()
    const move = await requested(w)

    expect(await drain(w, move.moveId, fenceOf(w), 'timed_out')).toMatchObject({ ok: true, value: { outcome: 'aborted', move: { status: 'aborted' } } })
    expect(w.stub.placement(w.agent).activeMove).toBeNull()
  })

  it('commits the move only once a checkpoint is ready, as one CAS that advances the epoch', async () => {
    const w = await createWorld()
    const move = await requested(w)
    const cas = { moveId: move.moveId, idempotencyKey: move.idempotencyKey, expectedHomeEpoch: 1, expectedPlacementRevision: 1 }

    expect(await w.b.platform.commitMove(w.agent, cas, signal())).toMatchObject({ ok: false, kind: 'conflict' })

    const operation = mintOperation()
    await drain(w, move.moveId, fenceOf(w, operation))
    w.clock.advance(1_000)
    const reserved = reservedOf((await reserve(w, w.a, fenceOf(w, operation))).result)
    await commit(w, w.a, fenceOf(w, operation), reserved)

    const placement = w.stub.placement(w.agent)
    const done = await w.b.platform.commitMove(w.agent, { ...cas, expectedHomeEpoch: placement.homeEpoch, expectedPlacementRevision: placement.placementRevision }, signal())

    expect(done).toMatchObject({ ok: true, value: { outcome: 'committed', homeEpoch: 2, placementRevision: 3, selectedGeneration: 2 } })
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { kind: 'mac', deviceServiceId: w.b.deviceServiceId }, activeMove: null })
    // A repeat is not a second move.
    expect(await w.b.platform.commitMove(w.agent, cas, signal())).toMatchObject({ ok: true, value: { outcome: 'already_committed', homeEpoch: 2 } })
  })

  it('fails a reservation that a cancelled move leaves behind', async () => {
    const w = await createWorld()
    const move = await requested(w)
    const operation = mintOperation()

    await drain(w, move.moveId, fenceOf(w, operation))
    w.clock.advance(1_000)
    const reserved = reservedOf((await reserve(w, w.a, fenceOf(w, operation))).result)
    const placement = w.stub.placement(w.agent)

    await w.a.platform.abortMove(
      w.agent,
      { moveId: move.moveId, idempotencyKey: move.idempotencyKey, expectedHomeEpoch: placement.homeEpoch, expectedPlacementRevision: placement.placementRevision, reason: 'owner_cancelled' },
      signal()
    )

    expect(w.stub.checkpoints(w.agent).find(checkpoint => checkpoint.checkpointId === reserved.checkpointId)).toMatchObject({ state: 'failed', failure: 'move_aborted' })
  })
})

describe('publications, as the platform takes them', () => {
  const OUTBOX = '00000000-0000-4000-8000-a9703d75e616'
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

  /** A signed enqueue of exact bytes, sent as the Mac sends it; `tamper` changes the envelope after signing. */
  async function enqueue(
    w: World,
    mac: TestMac,
    options: {
      operation?: HomeOperation
      outboxId?: string
      payload?: object
      transactionId?: string
      part?: { index: number; count: number }
      tamper?: (envelope: Record<string, unknown>) => Record<string, unknown>
    } = {}
  ) {
    const operation = options.operation ?? mintOperation()
    const bytes = Buffer.from(JSON.stringify(options.payload ?? { msgtype: 'm.text', body: 'hi' }))
    const revision = w.stub.placement(w.agent).placementRevision

    const frame = await mac.auth.sign('MatrixPublicationEnqueue', meta => ({
      meta,
      fence: fenceOf(w, operation),
      expectedPlacementRevision: revision,
      moveSerializationRevision: revision,
      outboxId: options.outboxId ?? OUTBOX,
      roomId: '!room:atum.example',
      transactionId: options.transactionId ?? 'atum-1',
      payloadSha256: sha(bytes)
    }))

    const envelope = {
      publication: frame,
      eventType: 'm.room.message',
      payloadBase64: bytes.toString('base64'),
      ...(options.part ? { part: options.part } : {})
    }

    return { operation, frame, bytes, result: await mac.platform.enqueuePublication(w.agent, (options.tamper ? options.tamper(envelope) : envelope) as never, signal()) }
  }

  const known = (w: World): HomeOperation => {
    const operation: HomeOperation = { kind: 'invocation', id: randomUUID() }
    w.stub.registerOperation(w.agent, operation)

    return operation
  }

  it('queues the exact bytes under an operation of the ledger, and answers where the row stands', async () => {
    const w = await createWorld()
    const { result, bytes, frame } = await enqueue(w, w.a, { operation: known(w) })

    expect(result).toMatchObject({ ok: true, value: { outboxId: OUTBOX, state: 'queued', eventId: null, reason: null } })
    expect(w.stub.outboxRows(w.agent)).toHaveLength(1)
    expect(w.stub.outboxRows(w.agent)[0]!.payload.equals(bytes)).toBe(true)
    expect(w.stub.lastHeaders['atum-agent-home-wire']).toBe('2.1')
    expect(frame.meta.signer).toBe('mac_executor')
  })

  it('is idempotent by outbox id: the same transaction, bytes and part come back as the row, anything else is a conflict', async () => {
    const w = await createWorld()
    const operation = known(w)

    expect(await enqueue(w, w.a, { operation })).toMatchObject({ result: { ok: true } })
    // Looked at again with a fresh frame: the same row.
    expect(await enqueue(w, w.a, { operation })).toMatchObject({ result: { ok: true, value: { state: 'queued' } } })
    expect(w.stub.outboxRows(w.agent)).toHaveLength(1)

    for (const changed of [
      { payload: { msgtype: 'm.text', body: 'other bytes' } },
      { transactionId: 'atum-other' },
      { part: { index: 0, count: 2 } }
    ]) {
      expect((await enqueue(w, w.a, { operation, ...changed })).result).toMatchObject({ ok: false, kind: 'publication_changed_replay', status: 409 })
    }

    expect(w.stub.outboxRows(w.agent)).toHaveLength(1)
  })

  it('says a saturated queue by name, with the minute the platform asks for', async () => {
    const w = await createWorld()
    w.stub.publicationQueueFull = true

    expect((await enqueue(w, w.a, { operation: known(w) })).result).toMatchObject({ ok: false, kind: 'publication_queue_full', status: 429, retryAfterSeconds: 60 })
    expect(w.stub.outboxRows(w.agent)).toHaveLength(0)

    // A row that already exists is looked at all the same: the queue is full of other rows, not of this one.
    w.stub.publicationQueueFull = false
    const operation = known(w)
    expect((await enqueue(w, w.a, { operation })).result.ok).toBe(true)
    w.stub.publicationQueueFull = true
    expect((await enqueue(w, w.a, { operation })).result).toMatchObject({ ok: true, value: { state: 'queued' } })
  })

  it('publishes an accepted row before it answers, when the Shell has a homeserver to publish to', async () => {
    const w = await createWorld()
    const matrix = new StubMatrixServer()
    w.stub.inlineMatrix = matrix
    const operation = known(w)

    const sent = await enqueue(w, w.a, { operation })

    expect(sent.result).toMatchObject({ ok: true, value: { state: 'published', eventId: expect.stringMatching(/^\$/u) } })
    expect(matrix.events).toHaveLength(1)
    expect(w.stub.ledgerPublished(w.agent, operation)).toBe(matrix.events[0]!.eventId)
  })

  it('refuses, in the SQL’s own words and without a row, an operation it does not know', async () => {
    const w = await createWorld()

    // An operation the ledger does not know is some other operation: the base function collapses every authority
    // refusal to one word, and the route answers it as `{outcome: "refused", reason}` in a 403, not as a receipt.
    expect((await enqueue(w, w.a, { operation: mintOperation() })).result).toEqual({
      ok: false,
      kind: 'refused',
      reason: 'stale_authority',
      status: 403
    })

    expect(w.stub.outboxRows(w.agent)).toHaveLength(0)
  })

  it('refuses a frame that signed a placement revision a checkpoint has moved past, and takes it signed again', async () => {
    const w = await createWorld()
    const operation = known(w)
    w.stub.advanceRevisionBeforeNextPublication = true

    expect((await enqueue(w, w.a, { operation })).result).toMatchObject({ ok: false, kind: 'refused', reason: 'stale_authority' })
    expect(w.stub.outboxRows(w.agent)).toHaveLength(0)

    // Read again, signed again: the revision is the platform's now.
    expect((await enqueue(w, w.a, { operation })).result).toMatchObject({ ok: true, value: { state: 'queued' } })
  })

  it('takes a result while the move is only requested, and refuses everything new once the drain is acknowledged', async () => {
    const w = await createWorld()
    const matrix = new StubMatrixServer()
    const before = known(w)
    const after = known(w)
    const move = await requested(w)

    // The turn in flight finishes and says its piece: the row is tagged with the move and belongs to the source epoch.
    const taken = await enqueue(w, w.a, { operation: before, outboxId: randomUUID() })
    expect(taken.result).toMatchObject({ ok: true, value: { state: 'queued' } })
    expect(w.stub.outboxRows(w.agent)[0]).toMatchObject({ sourceMoveId: move.moveId, state: 'queued' })

    // The drain is acknowledged: nothing new enters.
    await drain(w, move.moveId, fenceOf(w, mintOperation()))
    expect((await enqueue(w, w.a, { operation: after, outboxId: randomUUID() })).result).toEqual({
      ok: false,
      kind: 'refused',
      reason: 'move_in_progress',
      status: 403
    })
    expect(w.stub.outboxRows(w.agent)).toHaveLength(1)

    // The row taken before it still goes out, under the source epoch, while the move waits.
    w.clock.advance(1_000)
    expect(w.stub.sweepPublications(matrix)).toMatchObject({ published: 1 })
    expect(w.stub.ledgerPublished(w.agent, before)).toBe(matrix.events[0]!.eventId)
  })

  it('does not commit a move while a publication of the source is queued, sending, or unpublished and tagged to it', async () => {
    const w = await createWorld()
    const matrix = new StubMatrixServer()
    const move = await requested(w)
    await enqueue(w, w.a, { operation: known(w), outboxId: randomUUID() })

    const operation = mintOperation()
    await drain(w, move.moveId, fenceOf(w, operation))
    w.clock.advance(1_000)
    const reserved = reservedOf((await reserve(w, w.a, fenceOf(w, operation))).result)
    await commit(w, w.a, fenceOf(w, operation), reserved)

    const placement = w.stub.placement(w.agent)
    const cas = { moveId: move.moveId, idempotencyKey: move.idempotencyKey, expectedHomeEpoch: placement.homeEpoch, expectedPlacementRevision: placement.placementRevision }

    // The row has not been sent: the commit waits, by name, and changes nothing.
    expect(await w.b.platform.commitMove(w.agent, cas, signal())).toMatchObject({ ok: false, kind: 'publication_in_flight', status: 409 })
    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 1 })

    // Once it is out the move may commit.
    w.stub.sweepPublications(matrix)
    expect(await w.b.platform.commitMove(w.agent, cas, signal())).toMatchObject({ ok: true, value: { outcome: 'committed', homeEpoch: 2 } })
  })

  it('refuses a frame that was changed after it was signed, one sent twice, and a Mac that is not the home', async () => {
    const w = await createWorld()
    const operation = known(w)

    // Another room than the one the frame signed.
    const altered = await enqueue(w, w.a, {
      operation,
      tamper: envelope => ({ ...envelope, publication: { ...(envelope.publication as object), roomId: '!elsewhere:atum.example' } })
    })

    expect(altered.result).toMatchObject({ ok: false, kind: 'refused', reason: 'bad_signature' })

    // The very same frame twice.
    const first = await enqueue(w, w.a, { operation })
    expect(first.result.ok).toBe(true)

    const again = await w.a.platform.enqueuePublication(
      w.agent,
      { publication: first.frame, eventType: 'm.room.message', payloadBase64: first.bytes.toString('base64') } as never,
      signal()
    )

    expect(again).toMatchObject({ ok: false, kind: 'refused', reason: 'replayed' })

    // The Mac mini is not where the placement says the home is.
    expect((await enqueue(w, w.b, { operation, outboxId: randomUUID() })).result).toMatchObject({ ok: false, kind: 'refused', reason: 'wrong_signer_location' })
  })

  it('does not send what the platform would refuse as malformed: the bytes must be the signed hash', async () => {
    const w = await createWorld()
    const before = w.stub.requests.length

    const wrongBytes = await enqueue(w, w.a, {
      operation: known(w),
      tamper: envelope => ({ ...envelope, payloadBase64: Buffer.from(JSON.stringify({ body: 'not what was signed' })).toString('base64') })
    })

    const wrongAgent = await enqueue(w, w.a, {
      operation: known(w),
      tamper: envelope => ({ ...envelope, publication: { ...(envelope.publication as object), fence: { ...fenceOf(w), agentPrincipal: randomUUID() } } })
    })

    expect(wrongBytes.result).toMatchObject({ ok: false, kind: 'invalid' })
    expect(wrongAgent.result).toMatchObject({ ok: false, kind: 'invalid' })
    // Neither left the Mac.
    expect(w.stub.requests.length).toBe(before)
  })

  it('says unsupported when the platform has no publications route yet', async () => {
    const w = await createWorld()
    w.stub.publicationsRoute = false

    expect((await enqueue(w, w.a, { operation: known(w) })).result).toMatchObject({ ok: false, kind: 'unsupported' })
  })
})
