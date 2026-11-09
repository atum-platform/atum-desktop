/**
 * The whole of "Set this Mac up for <assistant>" against a small model of the platform's rule (S1 0302): a Mac is listed as a
 * place the agent can move to, and its catalog is taken, only while the agent has an ACTIVE local executor on that Mac, and
 * an executor lasts an hour unless something renews it. The real participant and the real sheet view run against it, with
 * a clock, so what is proven is the sequence the owner sees: not set up, set up, still set up hours later, and let go.
 */
import { describe, expect, it, vi } from 'vitest'

import type { MatrixModelCatalog } from '../../../shared/matrix-models'

import type { PlacementConnectionAuth } from './connection-auth'
import { AgentHomeConnectionParticipant } from './connection-participant'
import type { PlacementConnectionPlatform } from './connection-platform'
import type { HomePlacement } from './contract'
import { AgentHomeHolds } from './holds'
import { AgentHomeJournal } from './journal'
import type { AgentHomeOwnerController, AgentHomeOwnerState } from './owner-controller'
import { readPackV25Json } from './pack-v25.fixture'
import { readPackJson } from './pack.fixture'
import { homeViewFor, type MacNames, ownerHomeViewFor } from './view'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MINI = '00000000-0000-4000-8000-b454f82c5857'
const LAPTOP = '00000000-0000-4000-8000-f6222a1106ee'
const T0 = 1_800_000_000_000
const HOUR = 3_600_000
const BEAT = 30_000

const names: MacNames = {
  [MINI]: { displayName: 'Mac mini', thisMac: false },
  [LAPTOP]: { displayName: 'MacBook', thisMac: true }
}

class Store {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  failureCode() { return null }
}

const chatgpt: MatrixModelCatalog = {
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
  accounts: [{ id: 'openai-codex', providerLabel: 'ChatGPT', accountLabel: 'ChatGPT Plan', connection: 'plan', ready: true, models: 1 }],
  unavailable: 0
}

/** The platform's side: this laptop's executor for the agent (it lasts an hour) and the catalog it last accepted. */
class PlatformModel {
  now = T0
  executorUntil: number | undefined
  catalog: { connections: unknown[]; freshUntil: number } | undefined
  enrolled = 0
  rotated = 0
  refused = 0

  enroll() {
    this.enrolled += 1
    this.executorUntil = this.now + HOUR
  }

  /** A lapsed executor cannot be rotated: the platform denies it, and the Mac enrolls again. */
  rotate() {
    if (this.executorUntil === undefined || this.executorUntil <= this.now) {throw new Error('matrix_agent_unavailable')}
    this.rotated += 1
    this.executorUntil = this.now + HOUR
  }

  get active() {
    return this.executorUntil !== undefined && this.executorUntil > this.now
  }

  async publishCatalog(_agent: string, body: Record<string, unknown>) {
    if (!this.active) {
      this.refused += 1

      return { ok: false, kind: 'conflict', status: 409, reason: 'stale_home' }
    }

    this.catalog = { connections: body.connections as unknown[], freshUntil: this.now + 300_000 }

    return {
      ok: true,
      value: {
        meta: readPackV25Json<{ meta: unknown }>('fixtures/mac.connection-catalog.receipt.json').meta,
        publishId: body.publishId,
        deviceServiceId: LAPTOP,
        previousCatalogRevision: 1,
        catalogRevision: 2,
        contentSha256: body.contentSha256,
        contentChanged: true,
        receivedAtPlatform: this.now,
        effectiveGeneratedAtPlatform: this.now,
        effectiveFreshUntilPlatform: this.now + 300_000,
        outcome: 'accepted',
        reason: null
      }
    }
  }

  /** What the owner's snapshot says of this laptop: ready only with an active executor and a fresh catalog that offers a model. */
  state(): AgentHomeOwnerState {
    const ready = this.active && this.catalog !== undefined && this.catalog.freshUntil > this.now && this.catalog.connections.length > 0
    const base = readPackV25Json<AgentHomeOwnerState['snapshot']>('fixtures/owner.placement.snapshot.json')
    const fresh = readPackV25Json<Record<string, unknown>>('fixtures/mac.connection-catalog.fresh.json')

    return {
      snapshot: {
        ...base,
        eligibleDevices: [
          { deviceServiceId: MINI, displayName: 'Mac mini', eligibility: 'unavailable', reason: 'catalog_unavailable' },
          ready
            ? { deviceServiceId: LAPTOP, displayName: 'MacBook', eligibility: 'ready' }
            : { deviceServiceId: LAPTOP, displayName: 'MacBook', eligibility: 'unavailable', reason: 'catalog_unavailable' }
        ]
      } as never,
      catalogs: this.catalog
        ? {
            [LAPTOP]: {
              ...fresh,
              deviceServiceId: LAPTOP,
              freshness: this.catalog.freshUntil > this.now ? 'fresh' : 'stale',
              connections: this.catalog.connections
            } as never
          }
        : {}
    }
  }
}

function world(options: { keep?: boolean } = {}) {
  const platform = new PlatformModel()
  const store = new Store()
  let custody = false
  let sequence = 100
  const placement: HomePlacement = readPackJson<HomePlacement>('fixtures/placement.record.cloud.json')

  const make = (kept = options.keep ?? true) =>
    new AgentHomeConnectionParticipant({
      platform: platform as unknown as PlacementConnectionPlatform,
      auth: {
        deviceServiceId: () => LAPTOP,
        signMac: async (_message: string, build: (meta: Record<string, unknown>) => Record<string, unknown>, sign?: { requestId?: string }) => {
          sequence += 1

          return build({
            requestId: sign?.requestId ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
            commandId: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
            signer: 'mac_executor',
            signerKeyId: 'A'.repeat(43),
            deviceServiceId: LAPTOP,
            sequence,
            issuedAt: platform.now - 5_000,
            expiresAt: platform.now + 295_000,
            nonce: String.fromCharCode(65 + (sequence % 26)).repeat(43),
            signature: 'B'.repeat(86)
          })
        }
      } as unknown as PlacementConnectionAuth,
      owner: { follow: vi.fn(async () => undefined) } as unknown as AgentHomeOwnerController,
      holds: new AgentHomeHolds(new AgentHomeJournal(store)),
      store,
      scope: () => 'account:1',
      me: () => LAPTOP,
      catalog: async () => chatgpt,
      custody: () => custody,
      materialize: async () => {
        // What main does: enroll only when there is no usable enrollment; the home directory is made too.
        if (!platform.active) {platform.enroll()}
        custody = true
      },
      keepExecutor: kept
        ? async (_agent, _signal, force) => {
            if (!platform.active) {
              platform.enroll()

              return
            }

            if (force || platform.executorUntil! - platform.now <= HOUR / 2) {platform.rotate()}
          }
        : undefined,
      atRest: async () => true,
      leaseFacts: () => null,
      apply: vi.fn(),
      now: () => platform.now,
      uuid: (() => {
        let next = 0

        return () => `66666666-6666-4666-8666-${String((next += 1)).padStart(12, '0')}`
      })()
    })

  /** The owner's sheet, as the window would get it now. */
  const sheet = () => {
    const base = homeViewFor({ lives: { kind: 'cloud' }, move: null, canMove: true, issue: null } as never, names, LAPTOP)!
    const placementView = ownerHomeViewFor(base, platform.state(), names, LAPTOP).placement!

    return placementView.destinations.find(each => each.id === LAPTOP)!
  }

  /** Time passes, the app's beat reconciling the agent as it does. */
  const pass = async (participant: AgentHomeConnectionParticipant, ms: number) => {
    const end = platform.now + ms

    while (platform.now < end) {
      platform.now += BEAT
      await participant.reconcile(AGENT, placement, AbortSignal.timeout(5_000))
    }
  }

  return { platform, placement, make, sheet, pass }
}

describe('setting this Mac up, as the owner sees it', () => {
  it('goes from "not set up" to a place to move to, and stays one for hours', async () => {
    const w = world()
    const participant = w.make()

    // Before: nothing holds the assistant here, so a background pass does nothing, and the sheet offers the set-up.
    await w.pass(participant, 5 * 60_000)
    expect(w.platform.enrolled).toBe(0)
    expect(w.sheet()).toMatchObject({ eligibility: 'unavailable', setUp: 'needed' })

    // The owner presses the button: enrolled, catalog published, and the platform lists this Mac as ready.
    await expect(participant.prepare(AGENT, w.placement, AbortSignal.timeout(5_000))).resolves.toEqual({ ok: true, connections: 1 })
    expect(w.platform.enrolled).toBe(1)
    expect(w.sheet()).toMatchObject({ eligibility: 'ready', models: [{ model: 'gpt-5.6-luna', available: true }] })
    expect(w.sheet().setUp).toBeUndefined()

    // Three hours later (an executor lasts one) it is still ready: the keepalive renewed it, and the catalog stayed fresh.
    await w.pass(participant, 3 * HOUR)
    expect(w.sheet().eligibility).toBe('ready')
    expect(w.platform.rotated).toBeGreaterThanOrEqual(5)
    expect(w.platform.rotated).toBeLessThanOrEqual(8)
    expect(w.platform.refused).toBe(0)
  })

  it('without the keepalive the same set-up lapses after the hour: the deadlock the keepalive is there to prevent', async () => {
    const w = world({ keep: false })
    const participant = w.make()

    await participant.prepare(AGENT, w.placement, AbortSignal.timeout(5_000))
    expect(w.sheet().eligibility).toBe('ready')

    await w.pass(participant, 90 * 60_000)
    expect(w.sheet()).toMatchObject({ eligibility: 'unavailable', setUp: 'needed' })
  })

  it('lets go after the bound, and offers the set-up again', async () => {
    const w = world()
    const participant = w.make()
    await participant.prepare(AGENT, w.placement, AbortSignal.timeout(5_000))

    await w.pass(participant, 25 * HOUR)

    expect(w.sheet()).toMatchObject({ eligibility: 'unavailable', setUp: 'needed' })
    // And the owner can set it up again.
    await expect(participant.prepare(AGENT, w.placement, AbortSignal.timeout(5_000))).resolves.toMatchObject({ ok: true })
    expect(w.sheet().eligibility).toBe('ready')
  })

  it('survives an app restart, and the first press after its day lapses enrolls again', async () => {
    const w = world()
    const before = w.make()
    await before.prepare(AGENT, w.placement, AbortSignal.timeout(5_000))
    const enrolled = w.platform.enrolled

    // The app restarts: the set-up time is kept beside the catalog journal, so the new participant carries the day on.
    const after = w.make()
    await w.pass(after, 2 * HOUR)
    expect(w.sheet().eligibility).toBe('ready')

    // Past the day the executor lapses and the owner is offered the set-up again; the first press enrolls again.
    await w.pass(after, 23 * HOUR)
    expect(w.sheet()).toMatchObject({ eligibility: 'unavailable', setUp: 'needed' })

    await expect(after.prepare(AGENT, w.placement, AbortSignal.timeout(5_000))).resolves.toMatchObject({ ok: true })
    expect(w.platform.enrolled).toBe(enrolled + 1)
    expect(w.sheet().eligibility).toBe('ready')
  })

  it('leaves the Mac alone for an assistant it was never set up for', async () => {
    const w = world()
    const participant = w.make()

    await w.pass(participant, 2 * HOUR)

    expect(w.platform.enrolled).toBe(0)
    expect(w.platform.rotated).toBe(0)
    expect(w.sheet().setUp).toBe('needed')
  })
})
