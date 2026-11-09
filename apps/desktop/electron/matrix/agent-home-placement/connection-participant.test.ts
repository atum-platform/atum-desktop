import { describe, expect, it, vi } from 'vitest'

import type { MatrixModelCatalog } from '../../../shared/matrix-models'

import type { PlacementConnectionAuth } from './connection-auth'
import { AgentHomeConnectionParticipant, catalogBinding } from './connection-participant'
import type { PlacementConnectionPlatform } from './connection-platform'
import type { HomeMove, HomePlacement } from './contract'
import type { ModelApplicationProjectionV25 } from './contract-v25'
import { AgentHomeHolds } from './holds'
import { AgentHomeJournal } from './journal'
import type { AgentHomeOwnerController } from './owner-controller'
import { readPackV25Json } from './pack-v25.fixture'
import { readPackJson } from './pack.fixture'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MINI = '00000000-0000-4000-8000-b454f82c5857'
const LAPTOP = '00000000-0000-4000-8000-f6222a1106ee'
const MOVE = '00000000-0000-4000-8000-f2da1f9533d4'
const T0 = 1_800_000_000_000

class Store {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  failureCode() { return null }
}

const catalog: MatrixModelCatalog = {
  destination: 'this_mac',
  routes: [
    {
      id: 'openai-codex:gpt-5.6-luna',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      name: 'gpt-5.6-luna',
      providerLabel: 'ChatGPT',
      accountLabel: 'ChatGPT Plan',
      connection: 'plan',
      target: 'agent_default',
      destination: 'this_mac',
      efforts: ['low', 'medium', 'high'],
      current: false,
      ready: true
    }
  ],
  accounts: [
    { id: 'openai-codex', providerLabel: 'ChatGPT', accountLabel: 'ChatGPT Plan', connection: 'plan', ready: true, models: 1 }
  ],
  unavailable: 0
}

const cloudHome = () => readPackJson<HomePlacement>('fixtures/placement.record.cloud.json')
const macHome = (deviceServiceId = MINI): HomePlacement => ({
  ...readPackJson<HomePlacement>('fixtures/placement.record.mac.json'),
  location: { kind: 'mac', deviceServiceId }
})
const moving = (placement: HomePlacement, status: HomeMove['status'], target: HomeMove['target']): HomePlacement => ({
  ...placement,
  activeMove: {
    moveId: MOVE,
    idempotencyKey: '00000000-0000-4000-8000-c8f367a876b2',
    intent: 'manual',
    status,
    source: placement.location,
    target,
    expectedHomeEpoch: placement.homeEpoch,
    expectedPlacementRevision: placement.placementRevision,
    requestedAtPlatform: T0
  }
})

interface Fixture {
  clock: { now: number }
  custody: { value: boolean }
  lease: { value: boolean }
  store: Store
  holds: AgentHomeHolds
  platform: {
    publishCatalog: ReturnType<typeof vi.fn>
    readModelApplication: ReturnType<typeof vi.fn>
    reportModelApplication: ReturnType<typeof vi.fn>
  }
  follow: ReturnType<typeof vi.fn>
  materialize: ReturnType<typeof vi.fn>
  keepExecutor: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  catalogReads: ReturnType<typeof vi.fn>
  signed: Array<{ requestId: string; sequence: number }>
  participant: AgentHomeConnectionParticipant
  /** A fresh participant over the same store and account: what the app constructs after a restart. */
  restart: () => AgentHomeConnectionParticipant
  published: () => Array<Record<string, unknown>>
  /** What the platform said to each publication: the catalog revision it holds and whether the content changed. */
  receipts: () => Array<{ catalogRevision: number; contentChanged: boolean }>
}

function fixture(
  options: {
    me?: string
    /** The device the Secure Enclave key signs as, when it is no longer the one `me` named first. */
    signAs?: string
    custody?: boolean
    lease?: boolean
    projection?: () => ModelApplicationProjectionV25 | undefined
    /** How the platform answers when it has no projection to give: without the route, or not reachable now. */
    readKind?: 'unsupported' | 'unavailable'
    publish?: (body: Record<string, unknown>, call: number) => unknown
    materialize?: () => Promise<void>
    keepExecutor?: () => Promise<void>
  } = {}
): Fixture {
  const clock = { now: T0 }
  const custody = { value: options.custody ?? true }
  const lease = { value: options.lease ?? true }
  const store = new Store()
  const holds = new AgentHomeHolds(new AgentHomeJournal(store))
  const signed: Array<{ requestId: string; sequence: number }> = []
  let sequence = 100
  let revision = 1
  let content: string | undefined
  let calls = 0
  const bodies: Array<Record<string, unknown>> = []
  const receipts: Array<{ catalogRevision: number; contentChanged: boolean }> = []

  const auth = {
    deviceServiceId: () => options.me ?? MINI,
    signMac: vi.fn(
      async (
        _message: string,
        build: (value: Record<string, unknown>) => Record<string, unknown>,
        sign?: { requestId?: string }
      ) => {
        sequence += 1
        const requestId = sign?.requestId ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
        signed.push({ requestId, sequence })

        return build({
          requestId,
          commandId: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
          signer: 'mac_executor',
          signerKeyId: 'A'.repeat(43),
          deviceServiceId: options.signAs ?? options.me ?? MINI,
          sequence,
          issuedAt: clock.now - 5_000,
          expiresAt: clock.now + 295_000,
          nonce: String.fromCharCode(65 + (sequence % 26)).repeat(43),
          signature: 'B'.repeat(86)
        })
      }
    )
  } as unknown as PlacementConnectionAuth

  const publishCatalog = vi.fn(async (_agent: string, body: Record<string, unknown>) => {
    calls += 1
    bodies.push(body)
    const custom = options.publish?.(body, calls)
    if (custom) {return custom}
    const changed = content !== body.contentSha256
    const previous = revision
    if (changed) {revision += 1}
    content = body.contentSha256 as string
    receipts.push({ catalogRevision: revision, contentChanged: changed })

    return {
      ok: true,
      value: {
        meta: readPackV25Json<{ meta: unknown }>('fixtures/mac.connection-catalog.receipt.json').meta,
        publishId: body.publishId,
        deviceServiceId: (body.deviceServiceId as string | undefined) ?? options.me ?? MINI,
        previousCatalogRevision: previous,
        catalogRevision: revision,
        contentSha256: body.contentSha256,
        contentChanged: changed,
        receivedAtPlatform: clock.now,
        effectiveGeneratedAtPlatform: clock.now,
        effectiveFreshUntilPlatform: clock.now + 300_000,
        outcome: 'accepted',
        reason: null
      }
    }
  })
  const readModelApplication = vi.fn(async () => {
    const projection = options.projection?.()

    return projection
      ? { ok: true, value: projection }
      : options.readKind === 'unavailable'
        ? { ok: false, kind: 'unavailable', status: 503 }
        : { ok: false, kind: 'unsupported', status: 404 }
  })
  const reportModelApplication = vi.fn(
    async (_agent: string, body: { storedChoice: unknown; reportedStatus: { status: string; reason?: string } }) => ({
      ok: true,
      // What the platform answers to each kind of report: applied, or still held with the Mac's own reason.
      value:
        body.reportedStatus.status === 'applied'
          ? {
              ...options.projection!()!,
              activeMoveId: null,
              status: 'applied',
              reason: null,
              turnDisposition: 'ready',
              billingSourceChange: 'none',
              appliedAtPlatform: clock.now,
              appliedTurnSequence: 13,
              choice: body.storedChoice
            }
          : {
              ...options.projection!()!,
              activeMoveId: null,
              status: 'unavailable',
              reason: body.reportedStatus.reason,
              turnDisposition: 'held',
              billingSourceChange: 'forbidden',
              appliedAtPlatform: null,
              appliedTurnSequence: null,
              choice: body.storedChoice
            }
    })
  )
  const platform = { publishCatalog, readModelApplication, reportModelApplication }
  const follow = vi.fn(async () => undefined)
  // The participant never asks the owner controller to refresh: there is deliberately no `refresh` here.
  const owner = { follow } as unknown as AgentHomeOwnerController
  const materialize = vi.fn(async () => {
    await options.materialize?.()
    custody.value = true
  })
  const keepExecutor = vi.fn(async (_agent: string, _signal: AbortSignal, _force: boolean) => {
    await options.keepExecutor?.()
  })
  const apply = vi.fn(async (_agent: string, route: { provider: string; model: string }) => ({
    status: 'applied' as const,
    provider: route.provider,
    model: route.model
  }))
  const resume = vi.fn()
  const catalogReads = vi.fn(async () => catalog)

  const build = () => new AgentHomeConnectionParticipant({
    platform: platform as unknown as PlacementConnectionPlatform,
    auth,
    owner,
    holds,
    store,
    scope: () => 'account:1',
    me: () => options.me ?? MINI,
    catalog: catalogReads,
    custody: () => custody.value,
    materialize,
    keepExecutor,
    atRest: async () => true,
    leaseFacts: () =>
      lease.value
        ? { leaseId: '00000000-0000-4000-8000-c8f367a876b2', leaseExpiresAtPlatform: clock.now + 60_000, executorTerm: 12 }
        : null,
    apply,
    resume,
    now: () => clock.now,
    uuid: (() => {
      let next = 0
      return () => `66666666-6666-4666-8666-${String((next += 1)).padStart(12, '0')}`
    })()
  })

  const f: Fixture = {
    clock,
    custody,
    lease,
    store,
    holds,
    platform,
    follow,
    materialize,
    keepExecutor,
    apply,
    resume,
    catalogReads,
    signed,
    participant: build(),
    restart: () => (f.participant = build()),
    published: () => bodies,
    receipts: () => receipts
  }

  return f
}

const pending = (choiceRef: () => string, over: Record<string, unknown> = {}): (() => ModelApplicationProjectionV25) => () => {
  const base = readPackV25Json<ModelApplicationProjectionV25>('fixtures/model-choice.projection.pending-turn.json')

  return {
    ...base,
    activeMoveId: null,
    reason: 'turn_in_progress',
    choice: { ...base.choice, connectionRef: choiceRef() || 'conn_placeholder0000000' },
    ...over
  } as ModelApplicationProjectionV25
}

const signal = () => AbortSignal.timeout(1_000)

describe('the epoch and move a catalog is bound to', () => {
  it('is N with no move outside a move, whoever the home is', () => {
    expect(catalogBinding(cloudHome(), MINI)).toMatchObject({ homeEpoch: 4, activeMoveId: null })
    expect(catalogBinding(macHome(LAPTOP), MINI)).toMatchObject({ homeEpoch: 5, activeMoveId: null })
    expect(catalogBinding(macHome(MINI), MINI)).toMatchObject({ homeEpoch: 5, activeMoveId: null })
  })

  it.each(['requested', 'draining', 'ready_to_commit'] as const)('is N+1 with the move only for its target, while it is %s', status => {
    const placement = moving(cloudHome(), status, { kind: 'mac', deviceServiceId: MINI })

    expect(catalogBinding(placement, MINI)).toMatchObject({ homeEpoch: 5, activeMoveId: MOVE })
    // The source, and every other Mac, stay at N with no move.
    expect(catalogBinding(placement, LAPTOP)).toMatchObject({ homeEpoch: 4, activeMoveId: null })
  })

  it('is N with no move for the target of a move that has ended', () => {
    for (const status of ['committed', 'aborted', 'superseded'] as const) {
      expect(catalogBinding(moving(cloudHome(), status, { kind: 'mac', deviceServiceId: MINI }), MINI)).toMatchObject({
        homeEpoch: 4,
        activeMoveId: null
      })
    }
  })

  it('is N for a move whose target is the cloud', () => {
    expect(catalogBinding(moving(macHome(MINI), 'draining', { kind: 'cloud' }), MINI)).toMatchObject({ homeEpoch: 5, activeMoveId: null })
  })
})

describe('publishing the Mac catalog', () => {
  it('publishes the first catalog for an agent this Mac holds, without creating anything for it', async () => {
    const f = fixture({ custody: true })
    const placement = cloudHome()

    await f.participant.reconcile(AGENT, placement, signal())

    expect(f.materialize).not.toHaveBeenCalled()
    const [body] = f.published()
    expect(body).toMatchObject({ agentPrincipal: AGENT, deviceServiceId: MINI, homeEpoch: 4, activeMoveId: null })
    expect(body).not.toHaveProperty('accountId')
    expect(JSON.stringify(body)).not.toMatch(/token|secret|credential/iu)
    const connection = (body!.connections as Array<Record<string, unknown>>)[0]!
    expect(connection).toMatchObject({ source: 'chatgpt_plan', providerLabel: 'ChatGPT' })
    expect(connection.connectionRef).toMatch(/^conn_[A-Za-z0-9_-]{16,64}$/u)
    expect((connection.models as Array<Record<string, unknown>>)[0]).toMatchObject({
      model: 'gpt-5.6-luna',
      modelLabel: 'GPT-5.6 Luna'
    })
  })

  it('signs the catalog for the device the frame names, not an earlier read of it', async () => {
    // The Mac re-enrolled between the pass's first device read and the signature: the body must carry the
    // device the key signs for, or MacConnectionCatalogIngestV25Schema refuses it as catalog_device_mismatch.
    const f = fixture({ custody: true, me: MINI, signAs: LAPTOP })

    await f.participant.reconcile(AGENT, cloudHome(), signal())

    const [body] = f.published()
    expect(body!.deviceServiceId).toBe(LAPTOP)
    expect((body!.meta as Record<string, unknown>).deviceServiceId).toBe(LAPTOP)
  })

  // A background pass never sets a Mac up (that would enroll every agent on every Mac): only the owner's action does,
  // see 'setting this Mac up for an assistant'.
  it('does nothing at all for an agent this Mac holds nothing of and has no part in', async () => {
    const f = fixture({ custody: false })

    await f.participant.reconcile(AGENT, cloudHome(), signal())
    await f.participant.reconcile(AGENT, macHome(LAPTOP), signal())

    expect(f.materialize).not.toHaveBeenCalled()
    expect(f.platform.publishCatalog).not.toHaveBeenCalled()
    expect(f.platform.readModelApplication).not.toHaveBeenCalled()
    expect(f.catalogReads).not.toHaveBeenCalled()
  })

  it('creates custody once for the target of a move, then publishes the next epoch with the move', async () => {
    const f = fixture({ custody: false })
    const placement = moving(cloudHome(), 'requested', { kind: 'mac', deviceServiceId: MINI })

    await f.participant.reconcile(AGENT, placement, signal())
    f.clock.now += 1_000
    await f.participant.reconcile(AGENT, placement, signal())

    expect(f.materialize).toHaveBeenCalledTimes(1)
    expect(f.published()).toHaveLength(1)
    expect(f.published()[0]).toMatchObject({ homeEpoch: 5, activeMoveId: MOVE })
  })

  it('creates custody for the home it is the home of, only when it has none', async () => {
    const f = fixture({ custody: false, projection: () => undefined })

    await f.participant.reconcile(AGENT, macHome(MINI), signal())
    f.clock.now += 6_000
    await f.participant.reconcile(AGENT, macHome(MINI), signal())

    expect(f.materialize).toHaveBeenCalledTimes(1)
  })

  it('keeps every other Mac at N with no move while a move is under way', async () => {
    const f = fixture({ me: LAPTOP, custody: true })

    await f.participant.reconcile(AGENT, moving(cloudHome(), 'draining', { kind: 'mac', deviceServiceId: MINI }), signal())

    expect(f.published()[0]).toMatchObject({ deviceServiceId: LAPTOP, homeEpoch: 4, activeMoveId: null })
  })

  it('republishes at once when the binding changes, without a new catalog revision for unchanged content', async () => {
    const f = fixture({ custody: true })
    const idle = cloudHome()

    await f.participant.reconcile(AGENT, idle, signal())
    f.clock.now += 5_000
    await f.participant.reconcile(AGENT, moving(idle, 'requested', { kind: 'mac', deviceServiceId: MINI }), signal())
    f.clock.now += 5_000
    await f.participant.reconcile(AGENT, { ...macHome(MINI), homeEpoch: 5 }, signal())

    expect(f.published().map(body => [body.homeEpoch, body.activeMoveId])).toEqual([
      [4, null],
      [5, MOVE],
      [5, null]
    ])
    // Identical connection content: the platform's revision moves once (the first publication), never for a binding.
    expect(f.receipts().map(receipt => receipt.catalogRevision)).toEqual([2, 2, 2])
    expect(f.receipts().map(receipt => receipt.contentChanged)).toEqual([true, false, false])
  })

  it('does not send again while the last catalog is fresh and nothing changed, then refreshes before it goes stale', async () => {
    const f = fixture({ custody: true })
    const placement = cloudHome()

    await f.participant.reconcile(AGENT, placement, signal())
    f.catalogReads.mockClear()

    for (let second = 4; second <= 200; second += 4) {
      f.clock.now = T0 + second * 1_000
      await f.participant.reconcile(AGENT, placement, signal())
    }

    expect(f.published()).toHaveLength(1)
    // A fresh catalog is not even read: the connections are only looked at when a publication is due.
    expect(f.catalogReads).not.toHaveBeenCalled()

    f.clock.now = T0 + 245_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.published()).toHaveLength(2)
    // Freshness asked for is the platform's own maximum (five minutes), and the refresh comes before it ends.
    const second = f.published()[1]!
    expect((second.freshUntilPlatform as number) - (second.generatedAtPlatformEstimate as number)).toBe(300_000)
  })

  it('spreads the catalogs of a Mac with several agents out', async () => {
    const f = fixture({ custody: true })
    const other = '00000000-0000-4000-8000-2ead943db39c'

    await f.participant.reconcile(AGENT, cloudHome(), signal())
    await f.participant.reconcile(other, { ...cloudHome(), agentPrincipal: other }, signal())

    expect(f.published()).toHaveLength(1)
    f.clock.now += 2_000
    await f.participant.reconcile(other, { ...cloudHome(), agentPrincipal: other }, signal())
    expect(f.published()).toHaveLength(2)
  })

  it('never asks the owner controller for a snapshot; it only lets it follow a move', async () => {
    const f = fixture({ custody: true })

    await f.participant.reconcile(AGENT, cloudHome(), signal())
    await f.participant.reconcile(AGENT, moving(cloudHome(), 'requested', { kind: 'mac', deviceServiceId: MINI }), signal())

    expect(f.follow.mock.calls.map(call => call[1])).toEqual([false, true])
  })
})

describe('backing off', () => {
  it('waits before asking again after a failure, and longer after each one', async () => {
    let fail = true
    const f = fixture({
      custody: true,
      publish: () => (fail ? { ok: false, kind: 'unavailable', status: 503 } : undefined)
    })
    const placement = cloudHome()

    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(1)

    f.clock.now += 5_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(1)

    f.clock.now += 20_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(2)

    // The second wait is longer than the first.
    f.clock.now += 20_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(2)

    fail = false
    f.clock.now += 40_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(3)
  })

  it('waits at least as long as the platform asked', async () => {
    const f = fixture({ custody: true, publish: () => ({ ok: false, kind: 'unavailable', status: 429, retryAfterMs: 120_000 }) })
    const placement = cloudHome()

    await f.participant.reconcile(AGENT, placement, signal())
    f.clock.now += 100_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(1)

    f.clock.now += 40_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(2)
  })

  it('does not throw, and backs off, when the connections cannot be read', async () => {
    const f = fixture({ custody: true })
    f.catalogReads.mockRejectedValueOnce(new Error('matrix_agent_busy'))

    await expect(f.participant.reconcile(AGENT, cloudHome(), signal())).resolves.toBeUndefined()
    expect(f.platform.publishCatalog).not.toHaveBeenCalled()

    f.clock.now += 5_000
    await f.participant.reconcile(AGENT, cloudHome(), signal())
    expect(f.platform.publishCatalog).not.toHaveBeenCalled()

    f.clock.now += 20_000
    await f.participant.reconcile(AGENT, cloudHome(), signal())
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(1)
  })
})

describe('a retry is the same operation', () => {
  it('sends the same ids and the same signed bytes again while they are valid', async () => {
    let call = 0
    const f = fixture({
      custody: true,
      publish: () => (call++ === 0 ? { ok: false, kind: 'unavailable', status: 0 } : undefined)
    })
    const placement = cloudHome()

    await f.participant.reconcile(AGENT, placement, signal())
    f.clock.now += 20_000
    await f.participant.reconcile(AGENT, placement, signal())

    const [first, retry] = f.published()
    expect(f.published()).toHaveLength(2)
    expect(retry).toEqual(first)
    expect(retry!.publishId).toBe(first!.publishId)
    expect(retry!.idempotencyKey).toBe(first!.idempotencyKey)
    expect((retry!.meta as { requestId: string }).requestId).toBe((first!.meta as { requestId: string }).requestId)
    // It was signed once: the second attempt is the first one's bytes.
    expect(f.signed).toHaveLength(1)
  })

  it('keeps the request id and the idempotency key when the bytes have to be signed again', async () => {
    let call = 0
    const f = fixture({
      custody: true,
      publish: () => (call++ === 0 ? { ok: false, kind: 'unavailable', status: 503 } : undefined)
    })
    const placement = cloudHome()

    await f.participant.reconcile(AGENT, placement, signal())
    // Past the signature's life the first bytes are no longer sent, but the operation is the same one.
    f.clock.now += 290_000
    await f.participant.reconcile(AGENT, placement, signal())

    const [first, retry] = f.published()
    expect(retry!.publishId).toBe(first!.publishId)
    expect(retry!.idempotencyKey).toBe(first!.idempotencyKey)
    expect((retry!.meta as { requestId: string }).requestId).toBe((first!.meta as { requestId: string }).requestId)
    expect((retry!.meta as { sequence: number }).sequence).toBeGreaterThan((first!.meta as { sequence: number }).sequence)
    expect(f.signed).toHaveLength(2)
  })

  it('starts a new operation after the platform has answered', async () => {
    const f = fixture({ custody: true })
    const placement = cloudHome()

    await f.participant.reconcile(AGENT, placement, signal())
    f.clock.now += 245_000
    await f.participant.reconcile(AGENT, placement, signal())

    const [first, second] = f.published()
    expect(second!.publishId).not.toBe(first!.publishId)
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey)
    expect((second!.clientCatalogRevision as number)).toBeGreaterThan(first!.clientCatalogRevision as number)
  })
})

describe('the saved home default', () => {
  const homeAt = (f: Fixture) => {
    void f
    return macHome(MINI)
  }

  it('is applied between turns, read back, reported, and only then let go', async () => {
    let ref = ''
    const f = fixture({ custody: true, projection: pending(() => ref) })
    const placement = homeAt(f)

    // The first publication allocates the local opaque reference the platform's stored choice names.
    await f.participant.publish(AGENT, placement, signal())
    ref = (f.published()[0]!.connections as Array<Record<string, unknown>>)[0]!.connectionRef as string
    await f.participant.reconcile(AGENT, placement, signal())

    expect(f.apply).toHaveBeenCalledWith(
      AGENT,
      expect.objectContaining({ provider: 'openai-codex', model: 'gpt-5.6-luna' }),
      'medium',
      expect.any(AbortSignal)
    )
    expect(f.platform.reportModelApplication).toHaveBeenCalledTimes(1)
    expect(f.holds.reasons(AGENT)).not.toContain('model')
    expect(f.resume).toHaveBeenCalledWith(AGENT)
  })

  it('holds persistently while the choice is pending, without applying it twice', async () => {
    let ref = ''
    const f = fixture({ custody: true, lease: false, projection: pending(() => ref) })
    const placement = homeAt(f)

    await f.participant.publish(AGENT, placement, signal())
    ref = (f.published()[0]!.connections as Array<Record<string, unknown>>)[0]!.connectionRef as string

    await f.participant.reconcile(AGENT, placement, signal())
    // Applied on this Mac's own profile and read back: the agent may answer. Without a lease nothing can be reported yet.
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(f.platform.reportModelApplication).not.toHaveBeenCalled()
    expect(f.holds.reasons(AGENT)).not.toContain('model')

    // The lease arrives: the next look reports what was applied; it is not applied a second time.
    f.lease.value = true
    f.clock.now += 6_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(f.platform.reportModelApplication).toHaveBeenCalledTimes(1)
  })

  it('stays held, and reports it, when the connection is not there', async () => {
    const f = fixture({ custody: true, projection: pending(() => 'conn_notonthismac00000') })
    const placement = homeAt(f)

    await f.participant.reconcile(AGENT, placement, signal())

    expect(f.apply).not.toHaveBeenCalled()
    expect(f.holds.reasons(AGENT)).toContain('model')
    expect(f.platform.reportModelApplication).toHaveBeenCalledWith(
      AGENT,
      expect.objectContaining({ reportedStatus: { status: 'unavailable', reason: 'connection_unavailable' } }),
      expect.any(AbortSignal)
    )
    // Persisted: a restart still finds the agent held.
    expect(new AgentHomeJournal(f.store).read(AGENT).modelHold).toBe(true)
    expect(f.resume).not.toHaveBeenCalled()
  })

  it('reads the saved choice slowly when it is applied and quickly while turns wait for it', async () => {
    let ref = ''
    const f = fixture({
      custody: true,
      projection: () => {
        const base = pending(() => ref)()
        return ref === 'applied'
          ? ({ ...readPackV25Json<ModelApplicationProjectionV25>('fixtures/model-choice.projection.applied.json') } as ModelApplicationProjectionV25)
          : base
      }
    })
    const placement = homeAt(f)

    ref = 'applied'
    await f.participant.reconcile(AGENT, placement, signal())
    for (let second = 4; second <= 48; second += 4) {
      f.clock.now = T0 + second * 1_000
      await f.participant.reconcile(AGENT, placement, signal())
    }
    expect(f.platform.readModelApplication).toHaveBeenCalledTimes(1)

    f.clock.now = T0 + 70_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.platform.readModelApplication).toHaveBeenCalledTimes(2)
  })

  it('needs nothing applied, and holds nothing, for the platform managed model', async () => {
    const f = fixture({
      custody: true,
      projection: () => {
        const base = readPackV25Json<ModelApplicationProjectionV25>('fixtures/model-choice.projection.pending-turn.json')
        return { ...base, activeMoveId: null, choice: { ...base.choice, source: 'atum' } } as ModelApplicationProjectionV25
      }
    })

    await f.participant.reconcile(AGENT, macHome(MINI), signal())

    expect(f.apply).not.toHaveBeenCalled()
    expect(f.holds.reasons(AGENT)).not.toContain('model')
  })

  it.each([false, true])('clears a hold it set when the Mac is no longer the agent home or its target (custody: %s)', async custody => {
    const f = fixture({ custody })
    f.holds.add(AGENT, 'model')

    await f.participant.reconcile(AGENT, macHome(LAPTOP), signal())

    expect(f.holds.reasons(AGENT)).not.toContain('model')
    expect(new AgentHomeJournal(f.store).read(AGENT).modelHold).toBeUndefined()
  })

  it('keeps a hold for the target of a move that is about to make this Mac the home', async () => {
    const f = fixture({ custody: true, projection: () => undefined })
    f.holds.add(AGENT, 'model')

    await f.participant.reconcile(AGENT, moving(cloudHome(), 'ready_to_commit', { kind: 'mac', deviceServiceId: MINI }), signal())

    expect(f.holds.reasons(AGENT)).toContain('model')
  })
})

describe('before the target Mac answers', () => {
  it('may start only once the saved choice is this Mac\'s own', async () => {
    let ref = ''
    const f = fixture({ custody: true, projection: pending(() => ref) })

    await f.participant.publish(AGENT, macHome(MINI), signal())
    ref = (f.published()[0]!.connections as Array<Record<string, unknown>>)[0]!.connectionRef as string

    await expect(f.participant.prepareActivation(AGENT, signal())).resolves.toBe(true)
    expect(f.apply).toHaveBeenCalledTimes(1)

    // The follow-up pass does not apply it a second time.
    await f.participant.reconcile(AGENT, macHome(MINI), signal())
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it.each(['pending', 'applied'])('holds an unavailable %s choice and exposes its reason without a lease or paid fallback', async status => {
    const f = fixture({ lease: false, projection: pending(() => 'conn_removed00000000', { status }) })
    f.catalogReads.mockResolvedValue({ ...catalog, routes: [], managed: ['nguyet-thuc'] })
    f.holds.add(AGENT, 'model')
    await expect(f.participant.prepareActivation(AGENT, signal())).resolves.toBe(false)
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.holds.reasons(AGENT)).toContain('model')
    expect(f.participant.projection(AGENT)).toMatchObject({
      status: 'unavailable', reason: 'connection_unavailable', turnDisposition: 'held', billingSourceChange: 'forbidden'
    })
    expect(f.platform.reportModelApplication).not.toHaveBeenCalled()
    await f.participant.reconcile(AGENT, macHome(), signal())
    expect(f.holds.reasons(AGENT)).toContain('model')
    expect(f.participant.projection(AGENT)).toMatchObject({ status: 'unavailable', reason: 'connection_unavailable' })
    expect(f.resume).not.toHaveBeenCalled()
  })

  it('stays held when the choice cannot be read now', async () => {
    const f = fixture({ custody: true, projection: () => undefined, readKind: 'unavailable' })

    await expect(f.participant.prepareActivation(AGENT, signal())).resolves.toBe(false)
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('has nothing to wait for on a platform that has no saved home default at all', async () => {
    const f = fixture({ custody: true, projection: () => undefined, readKind: 'unsupported' })

    await expect(f.participant.prepareActivation(AGENT, signal())).resolves.toBe(true)
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('stays held when the choice cannot be applied here', async () => {
    const f = fixture({ custody: true, projection: pending(() => 'conn_notonthismac00000') })

    await expect(f.participant.prepareActivation(AGENT, signal())).resolves.toBe(false)
  })

  it('stays held when the choice belongs to another Mac', async () => {
    const f = fixture({ custody: true, me: LAPTOP, projection: pending(() => '') })

    await expect(f.participant.prepareActivation(AGENT, signal())).resolves.toBe(false)
  })

  it('does not need to hold for the platform managed model', async () => {
    const f = fixture({
      custody: true,
      projection: () => {
        const base = readPackV25Json<ModelApplicationProjectionV25>('fixtures/model-choice.projection.pending-turn.json')
        return { ...base, activeMoveId: null, choice: { ...base.choice, source: 'atum' } } as ModelApplicationProjectionV25
      }
    })

    f.catalogReads.mockResolvedValue({ ...catalog, managed: ['nguyet-thuc'] })
    await expect(f.participant.prepareActivation(AGENT, signal())).resolves.toBe(true)
    expect(f.apply).not.toHaveBeenCalled()
  })
})

const STALE_HOME = { ok: false, kind: 'conflict', status: 409, reason: 'stale_home' }

describe('setting this Mac up for an assistant', () => {
  it('enrolls this Mac for it and publishes its catalog at once, admitting no turn', async () => {
    const f = fixture({ custody: false })

    const result = await f.participant.prepare(AGENT, cloudHome(), signal())

    expect(result).toEqual({ ok: true, connections: 1 })
    expect(f.materialize).toHaveBeenCalledTimes(1)
    expect(f.published()).toHaveLength(1)
    // Epoch N with no move, as every Mac outside a move: this Mac is listed as a place the agent can move to.
    expect(f.published()[0]).toMatchObject({ agentPrincipal: AGENT, deviceServiceId: MINI, homeEpoch: 4, activeMoveId: null })
    expect((f.published()[0]!.connections as unknown[]).length).toBe(1)
    // Custody only: no model applied, nothing held, nothing started, no lease asked for.
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.holds.has(AGENT)).toBe(false)
    expect(f.platform.readModelApplication).not.toHaveBeenCalled()
  })

  it('publishes Atum\'s managed models, so a Mac with only Atum connected is still a place to move to', async () => {
    const f = fixture({ custody: false })
    f.catalogReads.mockResolvedValueOnce({
      ...catalog,
      routes: [],
      accounts: [],
      managed: ['nguyet-thuc']
    })

    await expect(f.participant.prepare(AGENT, cloudHome(), signal())).resolves.toEqual({ ok: true, connections: 1 })

    expect((f.published()[0]!.connections as unknown[])[0]).toMatchObject({
      connectionRef: 'conn_atummanaged000001',
      source: 'atum',
      providerLabel: 'Atum',
      state: 'available',
      models: [{ model: 'nguyet-thuc', modelLabel: 'Nguyet Thuc 1.3', efforts: ['medium'], defaultEffort: 'medium' }]
    })
  })

  it('does not call an empty catalog a successful set-up: it says a model must be connected', async () => {
    const f = fixture({ custody: false })
    f.catalogReads.mockResolvedValueOnce({ ...catalog, routes: [], accounts: [] })

    await expect(f.participant.prepare(AGENT, cloudHome(), signal())).resolves.toEqual({
      ok: false,
      reason: 'connect_model'
    })
  })

  it('works again for a Mac that holds the assistant but whose set-up lapsed (materialize enrolls only when it must)', async () => {
    const f = fixture({ custody: true })

    await expect(f.participant.prepare(AGENT, cloudHome(), signal())).resolves.toMatchObject({ ok: true })
    expect(f.materialize).toHaveBeenCalledTimes(1)
  })

  it('joins a second press while the first is still running', async () => {
    let release!: () => void
    const f = fixture({ custody: false, materialize: () => new Promise<void>(resolve => (release = resolve)) })

    const first = f.participant.prepare(AGENT, cloudHome(), signal())
    const second = f.participant.prepare(AGENT, cloudHome(), signal())
    await vi.waitFor(() => expect(f.materialize).toHaveBeenCalledTimes(1))
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true, connections: 1 }, { ok: true, connections: 1 }])
    expect(f.materialize).toHaveBeenCalledTimes(1)
    expect(f.published()).toHaveLength(1)
  })

  it('does nothing while a move goes elsewhere', async () => {
    const f = fixture({ custody: false })
    const placement = moving(cloudHome(), 'draining', { kind: 'mac', deviceServiceId: LAPTOP })

    await expect(f.participant.prepare(AGENT, placement, signal())).resolves.toEqual({
      ok: false,
      reason: 'another_move_in_progress'
    })
    expect(f.materialize).not.toHaveBeenCalled()
    expect(f.published()).toHaveLength(0)
  })

  it.each([
    ['matrix_agent_busy', 'setup_busy'],
    ['matrix_agent_unavailable', 'not_ready'],
    ['matrix_enrollment_failed', 'unavailable']
  ])('says why when this Mac could not be enrolled (%s)', async (code, reason) => {
    const f = fixture({
      custody: false,
      materialize: async () => {
        throw new Error(code)
      }
    })

    await expect(f.participant.prepare(AGENT, cloudHome(), signal())).resolves.toEqual({ ok: false, reason })
    expect(f.published()).toHaveLength(0)
  })

  it('says unavailable, and sends nothing, when the connections of this Mac cannot be read', async () => {
    const f = fixture({ custody: false })
    f.catalogReads.mockRejectedValueOnce(new Error('matrix_agent_busy'))

    await expect(f.participant.prepare(AGENT, cloudHome(), signal())).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(f.platform.publishCatalog).not.toHaveBeenCalled()
  })

  it('rotates the executor once and says it again when the platform still sees no active one', async () => {
    let call = 0
    const f = fixture({ custody: false, publish: () => (call++ === 0 ? STALE_HOME : undefined) })

    await expect(f.participant.prepare(AGENT, cloudHome(), signal())).resolves.toEqual({ ok: true, connections: 1 })

    expect(f.keepExecutor).toHaveBeenCalledTimes(1)
    expect(f.keepExecutor).toHaveBeenCalledWith(AGENT, expect.any(AbortSignal), true)
    expect(f.platform.publishCatalog).toHaveBeenCalledTimes(2)
  })

  it('maps a refusal that survives its own enrollment to target_not_prepared, in this client\'s words', async () => {
    const f = fixture({ custody: false, publish: () => STALE_HOME })

    await expect(f.participant.prepare(AGENT, cloudHome(), signal())).resolves.toEqual({
      ok: false,
      reason: 'target_not_prepared'
    })
    expect(f.keepExecutor).toHaveBeenCalledTimes(1)
  })

  it('says unavailable, not target_not_prepared, when the platform could not be reached', async () => {
    const f = fixture({ custody: false, publish: () => ({ ok: false, kind: 'unavailable', status: 503 }) })

    await expect(f.participant.prepare(AGENT, cloudHome(), signal())).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(f.keepExecutor).not.toHaveBeenCalled()
  })
})

describe('keeping a Mac that holds an assistant without running it answerable', () => {
  const HOUR = 3_600_000

  it('keeps the executor of a Mac the owner set up looked after, a minute apart, and publishes its catalog on the usual beat', async () => {
    const f = fixture({ custody: false })
    const placement = cloudHome()
    await f.participant.prepare(AGENT, placement, signal())
    f.keepExecutor.mockClear()

    for (let second = 4; second <= 400; second += 4) {
      f.clock.now = T0 + second * 1_000
      await f.participant.reconcile(AGENT, placement, signal())
    }

    // About once a minute for the 400 s, never forced, and the catalog stayed fresh the whole time.
    expect(f.keepExecutor.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(f.keepExecutor.mock.calls.length).toBeLessThanOrEqual(8)
    expect(f.keepExecutor.mock.calls.every(call => call[2] === false)).toBe(true)
    expect(f.published().length).toBeGreaterThanOrEqual(2)
  })

  it('lets go after the bound, and the owner can set the Mac up again', async () => {
    const f = fixture({ custody: false })
    const placement = cloudHome()
    await f.participant.prepare(AGENT, placement, signal())
    f.keepExecutor.mockClear()

    f.clock.now = T0 + 23 * HOUR
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(1)

    f.clock.now = T0 + 24 * HOUR + 1_000
    await f.participant.reconcile(AGENT, placement, signal())
    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(1)

    f.materialize.mockClear()
    await expect(f.participant.prepare(AGENT, placement, signal())).resolves.toMatchObject({ ok: true })
    expect(f.materialize).toHaveBeenCalledTimes(1)
    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(2)
  })

  it('stays quiet while a move goes elsewhere, and takes its day up again when that move is cancelled', async () => {
    const f = fixture({ custody: false })
    await f.participant.prepare(AGENT, cloudHome(), signal())
    f.keepExecutor.mockClear()

    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, moving(cloudHome(), 'draining', { kind: 'mac', deviceServiceId: LAPTOP }), signal())
    expect(f.keepExecutor).not.toHaveBeenCalled()

    // Cancelled: the placement did not move, and the set-up day it spent waiting is the same day.
    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, cloudHome(), signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(1)
  })

  it('lets go when a move to another place commits', async () => {
    const f = fixture({ custody: false })
    await f.participant.prepare(AGENT, cloudHome(), signal())
    f.keepExecutor.mockClear()

    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, moving(cloudHome(), 'draining', { kind: 'mac', deviceServiceId: LAPTOP }), signal())
    // Committed: it now lives on the other Mac.
    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, macHome(LAPTOP), signal())
    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, macHome(LAPTOP), signal())

    expect(f.keepExecutor).not.toHaveBeenCalled()
  })

  it('keeps its day across an app restart: a new participant over the same store carries it on', async () => {
    const f = fixture({ custody: false })
    const placement = cloudHome()
    await f.participant.prepare(AGENT, placement, signal())
    f.keepExecutor.mockClear()

    f.clock.now = T0 + 2 * HOUR
    await f.restart().reconcile(AGENT, placement, signal())

    expect(f.keepExecutor).toHaveBeenCalledTimes(1)
  })

  it('drops a set-up whose day is over instead of restoring it', async () => {
    const f = fixture({ custody: false })
    const placement = cloudHome()
    await f.participant.prepare(AGENT, placement, signal())
    f.keepExecutor.mockClear()

    f.clock.now = T0 + 24 * HOUR + 1_000
    await f.restart().reconcile(AGENT, placement, signal())

    expect(f.keepExecutor).not.toHaveBeenCalled()
  })

  it('lets go when this Mac becomes the home: a running host renews its own executor', async () => {
    const f = fixture({ custody: false, projection: () => undefined })
    await f.participant.prepare(AGENT, cloudHome(), signal())
    f.keepExecutor.mockClear()

    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, macHome(MINI), signal())
    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, cloudHome(), signal())

    expect(f.keepExecutor).not.toHaveBeenCalled()
  })

  it('keeps the target of a move answerable for as long as the move lives, and no longer', async () => {
    const f = fixture({ custody: true })
    const placement = moving(cloudHome(), 'requested', { kind: 'mac', deviceServiceId: MINI })

    for (let minute = 1; minute <= 5; minute += 1) {
      f.clock.now = T0 + minute * 70_000
      await f.participant.reconcile(AGENT, placement, signal())
    }
    expect(f.keepExecutor).toHaveBeenCalledTimes(5)

    // Cancelled: nothing prepared this Mac, so nothing keeps it.
    f.clock.now += 2 * 60_000
    await f.participant.reconcile(AGENT, cloudHome(), signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(5)
  })

  it('does not hammer when keeping it fails: the next look waits longer each time', async () => {
    const f = fixture({
      custody: true,
      keepExecutor: async () => {
        throw new Error('matrix_enrollment_pending')
      }
    })
    const placement = moving(cloudHome(), 'requested', { kind: 'mac', deviceServiceId: MINI })

    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(1)
    f.clock.now += 5_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(1)
    f.clock.now += 20_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(2)
    f.clock.now += 20_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor).toHaveBeenCalledTimes(2)
  })

  it('rotates the executor now when the platform refuses the same catalog twice, and not again at every pass', async () => {
    const f = fixture({ custody: true, publish: () => STALE_HOME })
    const placement = moving(cloudHome(), 'requested', { kind: 'mac', deviceServiceId: MINI })

    // The first refusal is not yet the executor: the home may simply have moved.
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor.mock.calls.map(call => call[2])).toEqual([false])

    // The same binding refused again: the executor is not active there, so it is rotated at once.
    f.clock.now += 70_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor.mock.calls.map(call => call[2])).toEqual([false, true])

    // Refused yet again: the next forced rotation waits for its five minutes.
    f.clock.now += 70_000
    await f.participant.reconcile(AGENT, placement, signal())
    f.clock.now += 70_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor.mock.calls.filter(call => call[2] === true)).toHaveLength(1)

    f.clock.now += 5 * 60_000
    await f.participant.reconcile(AGENT, placement, signal())
    expect(f.keepExecutor.mock.calls.filter(call => call[2] === true)).toHaveLength(2)
  })

  it('does not rotate by force for a refusal about a binding that has since changed', async () => {
    const f = fixture({ custody: true, publish: () => STALE_HOME })
    const first = moving(cloudHome(), 'requested', { kind: 'mac', deviceServiceId: MINI })

    await f.participant.reconcile(AGENT, first, signal())
    // The placement moved on (another epoch): the refusal was about the old one.
    f.clock.now += 70_000
    await f.participant.reconcile(AGENT, { ...first, homeEpoch: first.homeEpoch + 1 }, signal())

    expect(f.keepExecutor.mock.calls.map(call => call[2])).toEqual([false, false])
  })

  it('never keeps an executor for an assistant it holds a copy of and was not set up for', async () => {
    const f = fixture({ custody: true })

    for (let minute = 1; minute <= 3; minute += 1) {
      f.clock.now = T0 + minute * 70_000
      await f.participant.reconcile(AGENT, cloudHome(), signal())
    }

    expect(f.keepExecutor).not.toHaveBeenCalled()
  })
})
