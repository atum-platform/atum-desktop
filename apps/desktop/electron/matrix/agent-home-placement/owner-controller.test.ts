import { describe, expect, it, vi } from 'vitest'

/** A fake platform call: any arguments in, so the calls it recorded can be read back. */
const fake = <T = never,>(implementation: (...args: unknown[]) => T = () => undefined as T) => vi.fn(implementation)

import type { PlacementConnectionAuth } from './connection-auth'
import type { PlacementConnectionPlatform } from './connection-platform'
import type { AgentHomeOwnerMovePreflightV25, AgentHomeOwnerMoveProgressV25 } from './contract-v25'
import { AgentHomeOwnerController, cloudHomeChoices, cloudHomeOptions, waitingForHomeMac } from './owner-controller'
import { readPackV25Json } from './pack-v25.fixture'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MINI = '00000000-0000-4000-8000-b454f82c5857'
const T0 = 1_800_000_000_000

interface Signed {
  message: string
  requestId: string
}

/** A signer that records what it was asked for: the request id it was told to keep, and a new command every time. */
function signer() {
  const calls: Signed[] = []
  let sequence = 11
  const auth = {
    signOwner: vi.fn(
      async (
        message: string,
        build: (meta: Record<string, unknown>) => Record<string, unknown>,
        options?: { requestId?: string }
      ) => {
        sequence += 1
        const requestId = options?.requestId ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
        calls.push({ message, requestId })

        return build({
          requestId,
          commandId: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
          signer: 'owner_client',
          signerKeyId: 'A'.repeat(43),
          sequence,
          issuedAt: T0 - 5_000,
          expiresAt: T0 + 295_000,
          nonce: 'C'.repeat(43),
          signature: 'B'.repeat(86),
          surface: 'desktop',
          authenticatedChannel: 'desktop'
        })
      }
    )
  } as unknown as PlacementConnectionAuth

  return { auth, calls }
}

const snapshot = () => readPackV25Json<{ placement: Record<string, unknown> } & Record<string, unknown>>('fixtures/owner.placement.snapshot.json')
const finishing = () => readPackV25Json<AgentHomeOwnerMoveProgressV25>('fixtures/owner.move.progress.finishing.json')
const moveId = () => finishing().moveId

const withActiveMove = () => {
  const base = snapshot()

  return {
    ...base,
    placement: {
      ...base.placement,
      activeMove: {
        moveId: moveId(),
        status: 'draining',
        source: { kind: 'cloud' },
        target: { kind: 'mac', deviceServiceId: MINI }
      }
    }
  }
}

function fixture(platform: Record<string, unknown>) {
  const clock = { now: T0 }
  const { auth, calls } = signer()
  let next = 0
  const owner = new AgentHomeOwnerController({
    platform: platform as unknown as PlacementConnectionPlatform,
    auth,
    now: () => clock.now,
    uuid: () => `66666666-6666-4666-8666-${String((next += 1)).padStart(12, '0')}`
  })

  return { owner, clock, calls }
}

const signal = () => AbortSignal.timeout(1_000)

describe('desktop owner placement requests', () => {
  it('preflights a cloud-home agent without a client inventory revision, then moves with the exact losses', async () => {
    const catalog = readPackV25Json('fixtures/mac.connection-catalog.fresh.json')
    const preflight = readPackV25Json('fixtures/owner.move.preflight.actual-losses.json')
    const platform = {
      readOwner: fake(async () => ({ ok: true, value: snapshot() })),
      readCatalog: fake(async () => ({ ok: true, value: catalog })),
      preflight: fake(async () => ({ ok: true, value: preflight })),
      requestMove: fake(async () => ({ ok: true, value: finishing() })),
      readProgress: fake(),
      readModelApplication: fake()
    }
    const { owner } = fixture(platform)
    const choice = (preflight as { common: { chosenModel: never } }).common.chosenModel

    const checked = await owner.preflight(AGENT, { kind: 'mac', deviceServiceId: MINI }, choice, 4, signal())

    expect(checked.ok).toBe(true)
    const request = platform.preflight.mock.calls[0]![1] as unknown as Record<string, unknown>
    expect(request).not.toHaveProperty('featureInventoryRevision')
    expect(request).toMatchObject({ agentPrincipal: AGENT, catalogRevision: 4, expectedHomeEpoch: 4 })

    const moved = await owner.move(AGENT, (checked as Extract<typeof checked, { ok: true }>).preflight, false, signal())
    expect(moved.ok).toBe(true)
    const body = platform.requestMove.mock.calls[0]![1] as unknown as {
      acceptedPreflight: { featureLosses: string[] }
      acceptCheckpointLoss: boolean
    }
    expect(body.acceptedPreflight.featureLosses).toEqual(['cloud_browser_session'])
    expect(body.acceptCheckpointLoss).toBe(false)
  })
})

describe('losing the work since the last checkpoint is the owner\'s own choice', () => {
  const forced = () => readPackV25Json<AgentHomeOwnerMovePreflightV25>('fixtures/owner.move.preflight.unreachable-forced.json')
  const ordinary = () => readPackV25Json<AgentHomeOwnerMovePreflightV25>('fixtures/owner.move.preflight.actual-losses.json')

  it('carries the acceptance only when the owner gave it for a review that disclosed the loss', async () => {
    const platform = { requestMove: fake(async () => ({ ok: true, value: finishing() })) }
    const { owner } = fixture(platform)

    await owner.move(AGENT, forced(), true, signal())

    expect(platform.requestMove.mock.calls[0]![1]).toMatchObject({
      acceptCheckpointLoss: true,
      acceptedPreflight: { featureLosses: expect.arrayContaining(['changes_since_last_checkpoint_lost']) }
    })
  })

  it('does not move a review that disclosed the loss until the owner accepts it, and sends nothing', async () => {
    const platform = { requestMove: fake() }
    const { owner, calls } = fixture(platform)

    await expect(owner.move(AGENT, forced(), false, signal())).resolves.toEqual({ ok: false, reason: 'checkpoint_loss_not_accepted' })
    expect(platform.requestMove).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('never sends an acceptance for a review that disclosed no such loss', async () => {
    const platform = { requestMove: fake(async () => ({ ok: true, value: finishing() })) }
    const { owner } = fixture(platform)

    await owner.move(AGENT, ordinary(), true, signal())

    expect(platform.requestMove.mock.calls[0]![1]).toMatchObject({ acceptCheckpointLoss: false })
  })
})

describe('a retry is the same operation', () => {
  const ordinary = () => readPackV25Json<AgentHomeOwnerMovePreflightV25>('fixtures/owner.move.preflight.actual-losses.json')

  it('a move whose answer never came keeps its move id, request id and idempotency key', async () => {
    let call = 0
    const platform = {
      requestMove: fake(async () => (call++ === 0 ? { ok: false, kind: 'unavailable', status: 0 } : { ok: true, value: finishing() }))
    }
    const { owner, calls } = fixture(platform)

    const first = await owner.move(AGENT, ordinary(), false, signal())
    expect(first).toEqual({ ok: false, reason: 'unavailable', retry: true })
    const second = await owner.move(AGENT, ordinary(), false, signal())
    expect(second.ok).toBe(true)

    const [a, b] = platform.requestMove.mock.calls.map(call => call[1] as unknown as Record<string, unknown> & { meta: Record<string, unknown> })
    expect(b!.moveId).toBe(a!.moveId)
    expect(b!.idempotencyKey).toBe(a!.idempotencyKey)
    expect(b!.meta.requestId).toBe(a!.meta.requestId)
    // The signature is renewed: authentication is not part of the operation's identity.
    expect(b!.meta.commandId).not.toBe(a!.meta.commandId)
    expect(b!.meta.sequence).toBeGreaterThan(a!.meta.sequence as number)
    expect(calls.map(each => each.requestId)).toEqual([a!.meta.requestId, a!.meta.requestId])
  })

  it('a move the platform answered is used up: the next one is a new operation', async () => {
    const platform = {
      requestMove: fake(async () => ({ ok: false, kind: 'conflict', status: 409, reason: 'preflight_expired' }))
    }
    const { owner } = fixture(platform)

    const first = await owner.move(AGENT, ordinary(), false, signal())
    expect(first).toEqual({ ok: false, reason: 'preflight_expired' })
    await owner.move(AGENT, ordinary(), false, signal())

    const [a, b] = platform.requestMove.mock.calls.map(call => call[1] as unknown as Record<string, unknown> & { meta: Record<string, unknown> })
    expect(b!.moveId).not.toBe(a!.moveId)
    expect(b!.idempotencyKey).not.toBe(a!.idempotencyKey)
    expect(b!.meta.requestId).not.toBe(a!.meta.requestId)
  })

  it('a cancel whose answer never came is sent again with the same ids', async () => {
    let call = 0
    const platform = {
      readOwner: fake(async () => ({ ok: true, value: withActiveMove() })),
      readProgress: fake(async () => ({ ok: true, value: finishing() })),
      readModelApplication: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 })),
      cancelMove: fake(async () => (call++ === 0 ? { ok: false, kind: 'unavailable', status: 503 } : { ok: true, value: finishing() }))
    }
    const { owner } = fixture(platform)

    expect((await owner.cancel(AGENT, signal())).ok).toBe(false)
    expect((await owner.cancel(AGENT, signal())).ok).toBe(true)

    const [a, b] = platform.cancelMove.mock.calls.map(call => call[1] as unknown as Record<string, unknown> & { meta: Record<string, unknown> })
    expect(b!.cancelId).toBe(a!.cancelId)
    expect(b!.idempotencyKey).toBe(a!.idempotencyKey)
    expect(b!.meta.requestId).toBe(a!.meta.requestId)
  })

  it('a model change whose answer never came is sent again with the same ids, and says why when refused', async () => {
    let call = 0
    const platform = {
      readOwner: fake(async () => ({ ok: true, value: snapshot() })),
      readCatalog: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 })),
      readModelApplication: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 })),
      writeModelChoice: fake(async () => {
        call += 1
        if (call === 1) {return { ok: false, kind: 'unavailable', status: 0 }}
        return { ok: false, kind: 'conflict', status: 409, reason: 'stale_choice_revision' }
      })
    }
    const { owner } = fixture(platform)
    // The snapshot says the current home is the cloud, so the write names the cloud's managed model.
    const cloudChoice = cloudHomeChoices()[0]!
    const first = await owner.chooseModel(AGENT, cloudChoice, 3, signal())
    const second = await owner.chooseModel(AGENT, cloudChoice, 3, signal())

    expect(first).toEqual({ ok: false, reason: 'unavailable' })
    expect(second).toEqual({ ok: false, reason: 'stale_choice_revision' })
    const [a, b] = platform.writeModelChoice.mock.calls.map(call => call[1] as unknown as Record<string, unknown> & { meta: Record<string, unknown> })
    expect(b!.idempotencyKey).toBe(a!.idempotencyKey)
    expect(b!.meta.requestId).toBe(a!.meta.requestId)
  })

  it('a review whose answer never came is asked for again with the same ids', async () => {
    const preflight = readPackV25Json('fixtures/owner.move.preflight.actual-losses.json')
    const choice = (preflight as { common: { chosenModel: never } }).common.chosenModel
    let call = 0
    const platform = {
      readOwner: fake(async () => ({ ok: true, value: snapshot() })),
      readCatalog: fake(async () => ({ ok: true, value: readPackV25Json('fixtures/mac.connection-catalog.fresh.json') })),
      readModelApplication: fake(),
      preflight: fake(async () => (call++ === 0 ? { ok: false, kind: 'unavailable', status: 504 } : { ok: true, value: preflight }))
    }
    const { owner } = fixture(platform)

    expect((await owner.preflight(AGENT, { kind: 'mac', deviceServiceId: MINI }, choice, 4, signal())).ok).toBe(false)
    expect((await owner.preflight(AGENT, { kind: 'mac', deviceServiceId: MINI }, choice, 4, signal())).ok).toBe(true)

    const [a, b] = platform.preflight.mock.calls.map(call => call[1] as unknown as Record<string, unknown> & { meta: Record<string, unknown> })
    expect(b!.idempotencyKey).toBe(a!.idempotencyKey)
    expect(b!.meta.requestId).toBe(a!.meta.requestId)
  })
})

describe('owner progress is monotonic', () => {
  it('ignores a lower sequence, accepts an equal one that carries a different state, and a higher one', async () => {
    const at = (state: string, sequence: number) => ({ ...finishing(), state, sequence }) as AgentHomeOwnerMoveProgressV25
    let reply = at('moving', 2)
    const platform = {
      readOwner: fake(async () => ({ ok: true, value: withActiveMove() })),
      readProgress: fake(async () => ({ ok: true, value: reply })),
      readModelApplication: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 }))
    }
    const { owner } = fixture(platform)
    const progress = async () => (await owner.refresh(AGENT, signal()))?.progress

    expect(await progress()).toMatchObject({ state: 'moving', sequence: 2 })

    reply = at('finishing_current_work', 1)
    expect(await progress()).toMatchObject({ state: 'moving', sequence: 2 })

    reply = at('waiting_for_destination', 2)
    expect(await progress()).toMatchObject({ state: 'waiting_for_destination', sequence: 2 })

    reply = at('reconciling', 3)
    expect(await progress()).toMatchObject({ state: 'reconciling', sequence: 3 })
  })

  it('reads progress for the move the platform names', async () => {
    const platform = {
      readOwner: fake(async () => ({ ok: true, value: withActiveMove() })),
      readProgress: fake(async () => ({ ok: true, value: finishing() })),
      readModelApplication: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 }))
    }
    const { owner } = fixture(platform)

    await owner.refresh(AGENT, signal())

    expect(platform.readProgress).toHaveBeenCalledWith(AGENT, moveId(), expect.any(AbortSignal))
  })
})

describe('reading the owner view', () => {
  it('retains the closed read failure for an honest fallback, and Retry really reads again', async () => {
    let attempt = 0
    const platform = {
      readOwner: fake(async () => {
        attempt += 1

        return attempt === 1
          ? { ok: false, kind: 'conflict', status: 409, reason: 'agent_home_generation_conflict' }
          : { ok: true, value: snapshot() }
      }),
      readModelApplication: fake()
    }
    const { owner } = fixture(platform)

    await expect(owner.refresh(AGENT, signal())).resolves.toBeUndefined()
    expect(owner.failure(AGENT)).toMatchObject({ kind: 'conflict', reason: 'agent_home_generation_conflict' })

    await expect(owner.refresh(AGENT, signal())).resolves.toMatchObject({ snapshot: { agentPrincipal: AGENT } })
    expect(owner.failure(AGENT)).toBeUndefined()
    expect(platform.readOwner).toHaveBeenCalledTimes(2)
  })

  it('reuses what an owner action just read instead of reading again', async () => {
    const platform = {
      readOwner: fake(async () => ({ ok: true, value: snapshot() })),
      readCatalog: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 })),
      readModelApplication: fake()
    }
    const { owner, clock } = fixture(platform)

    await owner.refresh(AGENT, signal(), true)
    await owner.refresh(AGENT, signal(), true, { maxAgeMs: 10_000 })
    expect(platform.readOwner).toHaveBeenCalledTimes(1)

    clock.now += 11_000
    await owner.refresh(AGENT, signal(), true, { maxAgeMs: 10_000 })
    expect(platform.readOwner).toHaveBeenCalledTimes(2)
  })

  it('does not read the application unless asked to', async () => {
    const mac = {
      ...snapshot(),
      placement: { ...snapshot().placement, location: { kind: 'mac', deviceServiceId: MINI } }
    }
    const platform = {
      readOwner: fake(async () => ({ ok: true, value: mac })),
      readModelApplication: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 }))
    }
    const { owner } = fixture(platform)

    await owner.refresh(AGENT, signal(), false, { application: false })
    expect(platform.readModelApplication).not.toHaveBeenCalled()

    await owner.refresh(AGENT, signal())
    expect(platform.readModelApplication).toHaveBeenCalledTimes(1)
  })
})

describe('following a move in the background', () => {
  const platform = (readOwner: () => unknown) => ({
    readOwner: fake(async () => readOwner()),
    readProgress: fake(async () => ({ ok: true, value: finishing() })),
    readModelApplication: fake()
  })

  it('reads nothing for an agent that is not moving', async () => {
    const p = platform(() => ({ ok: true, value: snapshot() }))
    const { owner, clock } = fixture(p)

    for (let step = 0; step < 20; step += 1) {
      clock.now += 30_000
      await owner.follow(AGENT, false, signal())
    }

    expect(p.readOwner).not.toHaveBeenCalled()
  })

  it('reads quickly at first and more slowly as nothing changes', async () => {
    const p = platform(() => ({ ok: true, value: withActiveMove() }))
    const { owner, clock } = fixture(p)
    const reads: number[] = []

    for (let second = 0; second <= 1_800; second += 1) {
      clock.now = T0 + second * 1_000
      const before = p.readOwner.mock.calls.length
      await owner.follow(AGENT, true, signal())
      if (p.readOwner.mock.calls.length > before) {reads.push(second)}
    }

    // The first minute is read every few seconds, the half hour as a whole nowhere near once per five seconds.
    const firstMinute = reads.filter(second => second < 60).length
    expect(firstMinute).toBeGreaterThanOrEqual(5)
    expect(firstMinute).toBeLessThanOrEqual(14)
    expect(reads.length).toBeLessThan(40)
    const gaps = reads.slice(1).map((second, index) => second - reads[index]!)
    expect(Math.max(...gaps)).toBeGreaterThan(60)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(135)
  })

  it('backs off a failing platform, and for as long as the platform asked', async () => {
    const p = platform(() => ({ ok: false, kind: 'unavailable', status: 429, retryAfterMs: 90_000 }))
    const { owner, clock } = fixture(p)

    await owner.follow(AGENT, true, signal())
    for (const wait of [10_000, 30_000, 40_000]) {
      clock.now += wait
      await owner.follow(AGENT, true, signal())
    }
    expect(p.readOwner).toHaveBeenCalledTimes(1)

    clock.now += 20_000
    await owner.follow(AGENT, true, signal())
    expect(p.readOwner).toHaveBeenCalledTimes(2)
  })
})

describe('the cloud models the owner may pick', () => {
  it('are the platform\'s served offers when it has said, with an unserved alias shown unavailable', () => {
    const options = cloudHomeOptions([
      { alias: 'nguyet-thuc', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', eligible: true },
      { alias: 'nhat-thuc', efforts: ['medium'], defaultEffort: 'medium', eligible: false }
    ])

    expect(options.map(option => [option.choice.model, option.choice.effort, option.available])).toEqual([
      ['nguyet-thuc', 'high', true],
      ['nhat-thuc', 'medium', false]
    ])
    expect(cloudHomeChoices([{ alias: 'nguyet-thuc', efforts: ['low', 'medium'], eligible: true }, { alias: 'nhat-thuc', efforts: ['medium'], eligible: false }]).map(choice => choice.model)).toEqual(['nguyet-thuc'])
    expect(options.every(option => option.choice.connectionRef === 'conn_atummanaged000001' && option.choice.source === 'atum')).toBe(true)
  })

  it('never carry an effort the managed models do not allow', () => {
    const options = cloudHomeOptions([{ alias: 'nguyet-thuc', efforts: ['max'], eligible: true }])

    expect(options).toEqual([])
  })

  it('fall back to the two line-up aliases at their usual effort until an offer has been read', () => {
    for (const offers of [undefined, []]) {
      expect(cloudHomeChoices(offers).map(choice => [choice.model, choice.effort])).toEqual([
        ['nguyet-thuc', 'medium'],
        ['nhat-thuc', 'medium']
      ])
    }
  })
})

describe('a home Mac that is not answering', () => {
  const LAPTOP = '00000000-0000-4000-8000-f6222a1106ee'
  const waiting = (reason: 'platform_not_ready' | 'client_update_required' = 'platform_not_ready', home: 'mac' | 'cloud' = 'mac') => {
    const base = snapshot()

    return {
      ...base,
      placement: { ...base.placement, location: home === 'mac' ? { kind: 'mac', deviceServiceId: MINI } : { kind: 'cloud' } },
      currentHomeReachability: { state: 'offline', lastSeenAtPlatform: T0 - 900_000 },
      moveCapability: { state: 'unavailable', reason }
    }
  }
  const forced = () => readPackV25Json('fixtures/owner.move.preflight.unreachable-forced.json')
  const platformFor = (view: unknown) => ({
    readOwner: fake(async () => ({ ok: true, value: view })),
    readCatalog: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 })),
    readModelApplication: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 })),
    readProgress: fake(async () => ({ ok: false, kind: 'unsupported', status: 404 })),
    preflight: fake(async () => ({ ok: true, value: forced() })),
    cancelMove: fake(async () => ({ ok: true, value: finishing() }))
  })

  it('is recognised only for a Mac home the platform is not ready for', () => {
    expect(waitingForHomeMac(waiting() as never)).toBe(true)
    expect(waitingForHomeMac(waiting('client_update_required') as never)).toBe(false)
    expect(waitingForHomeMac(waiting('platform_not_ready', 'cloud') as never)).toBe(false)
    expect(waitingForHomeMac(snapshot() as never)).toBe(false)
  })

  it('still reviews the disclosed move to the cloud: the platform decides it, and says what is lost', async () => {
    const platform = platformFor(waiting())
    const { owner } = fixture(platform)

    const checked = await owner.preflight(AGENT, { kind: 'cloud' }, cloudHomeChoices()[0]!, 0, signal())

    expect(checked.ok).toBe(true)
    expect(platform.preflight).toHaveBeenCalledTimes(1)
    expect(platform.preflight.mock.calls[0]![1]).toMatchObject({ agentPrincipal: AGENT, target: { kind: 'cloud' }, catalogRevision: 0 })
    expect((checked as Extract<typeof checked, { ok: true }>).preflight.common.checkpointLoss.state).toBe('disclosed')
  })

  it('waits for the Mac for any other move, and says so without asking the platform', async () => {
    const platform = platformFor(waiting())
    const { owner } = fixture(platform)
    const choice = (readPackV25Json('fixtures/owner.move.preflight.actual-losses.json') as { common: { chosenModel: never } }).common.chosenModel

    await expect(owner.preflight(AGENT, { kind: 'mac', deviceServiceId: LAPTOP }, choice, 4, signal())).resolves.toEqual({
      ok: false,
      reason: 'current_home_unreachable'
    })
    expect(platform.preflight).not.toHaveBeenCalled()
  })

  it('says it already lives there before it says anything about waiting', async () => {
    const platform = platformFor(waiting())
    const { owner } = fixture(platform)
    const choice = (readPackV25Json('fixtures/owner.move.preflight.actual-losses.json') as { common: { chosenModel: never } }).common.chosenModel

    await expect(owner.preflight(AGENT, { kind: 'mac', deviceServiceId: MINI }, choice, 4, signal())).resolves.toEqual({
      ok: false,
      reason: 'already_there'
    })
  })

  it('keeps saying a move is not available for a platform that is not ready for another reason', async () => {
    const { owner: needsUpdate } = fixture(platformFor(waiting('client_update_required')))
    await expect(needsUpdate.preflight(AGENT, { kind: 'cloud' }, cloudHomeChoices()[0]!, 0, signal())).resolves.toEqual({
      ok: false,
      reason: 'unsupported'
    })

    const { owner: cloudHome } = fixture(platformFor(waiting('platform_not_ready', 'cloud')))
    await expect(cloudHome.preflight(AGENT, { kind: 'mac', deviceServiceId: MINI }, cloudHomeChoices()[0]!, 4, signal())).resolves.toEqual({
      ok: false,
      reason: 'unsupported'
    })
  })

  it('keeps Cancel reachable for a move under way', async () => {
    const platform = platformFor({ ...waiting(), placement: { ...waiting().placement, activeMove: { ...withActiveMove().placement.activeMove, source: { kind: 'mac', deviceServiceId: MINI }, target: { kind: 'cloud' } } } })
    const { owner } = fixture(platform)

    await expect(owner.cancel(AGENT, signal())).resolves.toMatchObject({ ok: true })
    expect(platform.cancelMove).toHaveBeenCalledTimes(1)
  })
})
