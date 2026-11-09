import { describe, expect, it, vi } from 'vitest'

import type { AgentHomeOwnerMovePreflightV25, MacConnectionCatalogV25 } from './contract-v25'
import type { AgentHomeOwnerState } from './owner-controller'
import { type AgentHomeOwnerIpcDeps, handleAgentHomeOwnerRequest, ownerHomeChoice, type RetainedPreflight } from './owner-ipc'
import { readPackV25Json } from './pack-v25.fixture'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MINI = '00000000-0000-4000-8000-b454f82c5857'
const T0 = 1_800_000_000_000

const snapshot = () => readPackV25Json<AgentHomeOwnerState['snapshot']>('fixtures/owner.placement.snapshot.json')
const catalog = () => readPackV25Json<MacConnectionCatalogV25>('fixtures/mac.connection-catalog.fresh.json')
const state = (over: Partial<AgentHomeOwnerState> = {}): AgentHomeOwnerState => ({
  snapshot: snapshot(),
  catalogs: { [MINI]: catalog() },
  ...over
})

const pick = (over: Record<string, unknown> = {}) => ({
  connectionRef: 'conn_codexplan00000001',
  model: 'gpt-5.6-luna',
  effort: 'medium',
  ...over
})

describe('what a pick in the window means', () => {
  it('is the Mac and the exact connection, model and effort its fresh catalog offers', () => {
    const resolved = ownerHomeChoice(state(), MINI, pick(), undefined, T0)

    expect(resolved).toMatchObject({
      target: { kind: 'mac', deviceServiceId: MINI },
      catalogRevision: 4,
      choice: { destination: `mac:${MINI}`, source: 'chatgpt_plan', connectionRef: 'conn_codexplan00000001', model: 'gpt-5.6-luna', effort: 'medium' }
    })
  })

  it.each([
    ['an effort that does not exist', pick({ effort: 'ultra' }), undefined],
    ['a connection that is not there', pick({ connectionRef: 'conn_gone0000000000000' }), undefined],
    ['a model that is not there', pick({ model: 'gpt-9' }), undefined],
    ['an open pick', null, undefined],
    ['a catalog that has gone stale', pick(), T0 + 61_000]
  ])('is nothing for %s', (_name, selected, now) => {
    expect(ownerHomeChoice(state(), MINI, selected, undefined, now ?? T0)).toBeNull()
  })

  it('is nothing for a Mac that is not ready or not on the list', () => {
    const away = { ...snapshot(), eligibleDevices: [{ ...snapshot().eligibleDevices[0]!, eligibility: 'unavailable' as const, reason: 'catalog_unavailable' as const }] }

    expect(ownerHomeChoice(state({ snapshot: away as never }), MINI, pick(), undefined, T0)).toBeNull()
    expect(ownerHomeChoice(state(), '00000000-0000-4000-8000-e8d95748107a', pick(), undefined, T0)).toBeNull()
  })

  it('is, for the cloud, only what the platform serves', () => {
    const offers = [
      { alias: 'nguyet-thuc', efforts: ['medium'], eligible: true },
      { alias: 'nhat-thuc', efforts: ['medium'], eligible: false }
    ]
    const cloudPick = (model: string) => ({ connectionRef: 'conn_atummanaged000001', model, effort: 'medium' })

    expect(ownerHomeChoice(state(), 'cloud', cloudPick('nguyet-thuc'), offers, T0)).toMatchObject({
      target: { kind: 'cloud' },
      catalogRevision: 0,
      choice: { source: 'atum', model: 'nguyet-thuc' }
    })
    expect(ownerHomeChoice(state(), 'cloud', cloudPick('nhat-thuc'), offers, T0)).toBeNull()
    expect(ownerHomeChoice(state(), 'cloud', cloudPick('nguyet-thuc'), undefined, T0)).not.toBeNull()
  })
})

function harness(over: Partial<AgentHomeOwnerIpcDeps> = {}) {
  const retained = new Map<string, RetainedPreflight>()
  const calls: string[] = []
  const owner = {
    refresh: vi.fn(async () => state()),
    preflight: vi.fn(),
    move: vi.fn(),
    cancel: vi.fn(),
    chooseModel: vi.fn()
  }
  const deps: AgentHomeOwnerIpcDeps = {
    owner: owner as never,
    kick: agent => calls.push(`kick:${agent}`),
    publish: () => calls.push('publish'),
    scope: () => 'account:1',
    refreshNames: async () => {
      calls.push('names')
    },
    view: () => undefined,
    cloudOffers: () => undefined,
    loadCloudOffers: vi.fn(async () => undefined),
    cloudChoiceRevision: async () => undefined,
    prepare: vi.fn(async () => ({ ok: true as const, connections: 1 })),
    retained,
    now: () => T0,
    ...over
  }

  return { deps, owner, retained, calls, run: (request: Record<string, unknown>) => handleAgentHomeOwnerRequest(request, AGENT, deps) }
}

const forced = () => readPackV25Json<AgentHomeOwnerMovePreflightV25>('fixtures/owner.move.preflight.unreachable-forced.json')
const ordinary = () => readPackV25Json<AgentHomeOwnerMovePreflightV25>('fixtures/owner.move.preflight.actual-losses.json')

describe('reviewing a move', () => {
  it('shows the checkpoint and asks for the owner\'s acceptance when the review disclosed the loss', async () => {
    const h = harness()
    h.owner.preflight.mockResolvedValue({ ok: true, preflight: forced() })

    const result = await h.run({ action: 'preflight', target: MINI, model: pick() })

    expect(result).toMatchObject({
      ok: true,
      target: MINI,
      checkpointLossRequired: true,
      lastCheckpointAtPlatform: 1_799_998_200_000,
      featureLosses: expect.arrayContaining(['changes_since_last_checkpoint_lost'])
    })
    expect(result).not.toHaveProperty('acceptCheckpointLoss')
    expect(h.retained.size).toBe(1)
  })

  it('asks for nothing when nothing of the kind is disclosed, and lists only the actual losses', async () => {
    const h = harness()
    h.owner.preflight.mockResolvedValue({ ok: true, preflight: ordinary() })

    const result = await h.run({ action: 'preflight', target: MINI, model: pick() })

    expect(result).toMatchObject({ ok: true, checkpointLossRequired: false, featureLosses: ['cloud_browser_session'] })
  })

  it('says why the platform refused the review, in the platform\'s closed word', async () => {
    const h = harness()
    h.owner.preflight.mockResolvedValue({ ok: false, reason: 'catalog_stale' })

    await expect(h.run({ action: 'preflight', target: MINI, model: pick() })).resolves.toEqual({ ok: false, reason: 'catalog_stale' })
    expect(h.retained.size).toBe(0)
  })

  it('refuses a pick that is not on offer, before anything is asked of the platform', async () => {
    const h = harness()

    await expect(h.run({ action: 'preflight', target: MINI, model: pick({ model: 'gpt-9' }) })).resolves.toEqual({
      ok: false,
      reason: 'connection_unavailable'
    })
    expect(h.owner.preflight).not.toHaveBeenCalled()
  })
})

describe('a Mac that is not set up for the assistant', () => {
  it('is said as such, in this client\'s word, when the platform finds no active executor there', async () => {
    const h = harness()
    h.owner.preflight.mockResolvedValue({ ok: false, reason: 'target_unavailable' })

    await expect(h.run({ action: 'preflight', target: MINI, model: pick() })).resolves.toEqual({
      ok: false,
      reason: 'target_not_prepared'
    })
  })

  it('leaves every other word, and the cloud\'s own, as the platform said it', async () => {
    const h = harness({ cloudOffers: () => [{ alias: 'nguyet-thuc', efforts: ['medium'], eligible: true }] })
    h.owner.preflight.mockResolvedValue({ ok: false, reason: 'catalog_stale' })
    await expect(h.run({ action: 'preflight', target: MINI, model: pick() })).resolves.toEqual({ ok: false, reason: 'catalog_stale' })

    h.owner.preflight.mockResolvedValue({ ok: false, reason: 'target_unavailable' })
    await expect(
      h.run({ action: 'preflight', target: 'cloud', model: { connectionRef: 'conn_atummanaged000001', model: 'nguyet-thuc', effort: 'medium' } })
    ).resolves.toEqual({ ok: false, reason: 'target_unavailable' })
  })
})

describe('moving', () => {
  async function reviewed(h: ReturnType<typeof harness>, preflight: AgentHomeOwnerMovePreflightV25) {
    h.owner.preflight.mockResolvedValue({ ok: true, preflight })
    const view = (await h.run({ action: 'preflight', target: MINI, model: pick() })) as { preflightId: string }

    return view.preflightId
  }

  it('passes the owner\'s own acceptance and nothing else', async () => {
    for (const [given, expected] of [[true, true], [false, false], [undefined, false], ['yes', false], [1, false]] as const) {
      const h = harness()
      const preflightId = await reviewed(h, forced())
      h.owner.move.mockResolvedValue({ ok: true, progress: {} })

      await h.run({ action: 'move', preflightId, acceptCheckpointLoss: given })

      expect(h.owner.move.mock.calls[0]![2], String(given)).toBe(expected)
    }
  })

  it('never assumes the acceptance from the disclosure', async () => {
    const h = harness()
    const preflightId = await reviewed(h, forced())
    h.owner.move.mockResolvedValue({ ok: false, reason: 'checkpoint_loss_not_accepted' })

    await expect(h.run({ action: 'move', preflightId })).resolves.toEqual({ ok: false, reason: 'checkpoint_loss_not_accepted' })
    expect(h.owner.move.mock.calls[0]![2]).toBe(false)
  })

  it('keeps the review while the owner has not yet accepted, so the tick and Move can follow', async () => {
    const h = harness()
    const preflightId = await reviewed(h, forced())
    h.owner.move.mockResolvedValueOnce({ ok: false, reason: 'checkpoint_loss_not_accepted' })
    h.owner.move.mockResolvedValueOnce({ ok: true, progress: {} })

    await h.run({ action: 'move', preflightId, acceptCheckpointLoss: false })
    expect(h.retained.size).toBe(1)

    await expect(h.run({ action: 'move', preflightId, acceptCheckpointLoss: true })).resolves.toEqual({ ok: true })
    expect(h.retained.size).toBe(0)
  })

  it('keeps the review when the answer never came, so the same move can be sent again', async () => {
    const h = harness()
    const preflightId = await reviewed(h, ordinary())
    h.owner.move.mockResolvedValueOnce({ ok: false, reason: 'unavailable', retry: true })
    h.owner.move.mockResolvedValueOnce({ ok: true, progress: {} })

    await expect(h.run({ action: 'move', preflightId })).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(h.retained.size).toBe(1)

    await expect(h.run({ action: 'move', preflightId })).resolves.toEqual({ ok: true })
    expect(h.owner.move).toHaveBeenCalledTimes(2)
    expect(h.owner.move.mock.calls[1]![1]).toBe(h.owner.move.mock.calls[0]![1])
    expect(h.retained.size).toBe(0)
  })

  it('uses a review up when the platform answers for good', async () => {
    const h = harness()
    const preflightId = await reviewed(h, ordinary())
    h.owner.move.mockResolvedValue({ ok: false, reason: 'preflight_expired' })

    await expect(h.run({ action: 'move', preflightId })).resolves.toEqual({ ok: false, reason: 'preflight_expired' })
    expect(h.retained.size).toBe(0)

    await expect(h.run({ action: 'move', preflightId })).resolves.toEqual({ ok: false, reason: 'preflight_required' })
  })

  it('refuses a review from another account or that was never made', async () => {
    const h = harness()
    const preflightId = await reviewed(h, ordinary())
    h.deps.scope = () => 'account:2'

    await expect(h.run({ action: 'move', preflightId })).resolves.toEqual({ ok: false, reason: 'preflight_required' })
    await expect(h.run({ action: 'move', preflightId: 'nope' })).resolves.toEqual({ ok: false, reason: 'preflight_required' })
    expect(h.owner.move).not.toHaveBeenCalled()
    await expect(h.run({ action: 'move' })).rejects.toThrow('matrix_command_invalid')
  })

  it('looks at the agent again and tells the window after a move', async () => {
    const h = harness()
    const preflightId = await reviewed(h, ordinary())
    h.owner.move.mockResolvedValue({ ok: true, progress: {} })

    await h.run({ action: 'move', preflightId })

    expect(h.calls).toEqual([`kick:${AGENT}`, 'publish'])
  })
})

describe('cancelling', () => {
  it('says why it could not, in the platform\'s closed word', async () => {
    const h = harness()
    h.owner.cancel.mockResolvedValue({ ok: false, reason: 'committed_epoch_preserved' })

    await expect(h.run({ action: 'cancel' })).resolves.toEqual({ ok: false, reason: 'committed_epoch_preserved' })
    expect(h.calls).toEqual([`kick:${AGENT}`, 'publish'])
  })

  it('is simply ok when it worked', async () => {
    const h = harness()
    h.owner.cancel.mockResolvedValue({ ok: true, progress: {} })

    await expect(h.run({ action: 'cancel' })).resolves.toEqual({ ok: true })
  })
})

describe('setting this Mac up for the assistant', () => {
  it('asks main to set this Mac up, looks at the agent again, and is simply ok when it worked', async () => {
    const h = harness()

    await expect(h.run({ action: 'prepare' })).resolves.toEqual({ ok: true })

    expect(h.deps.prepare).toHaveBeenCalledWith(AGENT, expect.any(AbortSignal))
    // Nothing is moved, reviewed or retained by it: only a fresh look.
    expect(h.calls).toEqual([`kick:${AGENT}`, 'publish'])
    expect(h.owner.preflight).not.toHaveBeenCalled()
    expect(h.owner.move).not.toHaveBeenCalled()
    expect(h.retained.size).toBe(0)
  })

  it.each(['unavailable', 'setup_busy', 'not_ready', 'another_move_in_progress', 'target_not_prepared'] as const)(
    'says why in a closed word when it could not (%s)',
    async reason => {
      const h = harness({ prepare: vi.fn(async () => ({ ok: false as const, reason })) })

      await expect(h.run({ action: 'prepare' })).resolves.toEqual({ ok: false, reason })
    }
  )
})

describe('reading and changing the model', () => {
  it('reads the cloud offer only when none is known', async () => {
    const h = harness({ view: () => ({ lives: { kind: 'cloud' }, move: null, targets: [], issue: null }) })

    await h.run({ action: 'read' })
    expect(h.deps.loadCloudOffers).toHaveBeenCalledTimes(1)
    expect(h.owner.refresh).toHaveBeenCalledWith(AGENT, expect.any(AbortSignal), true)

    const known = harness({ cloudOffers: () => [{ alias: 'nguyet-thuc', efforts: ['medium'], eligible: true }] })
    await known.run({ action: 'read' })
    expect(known.deps.loadCloudOffers).not.toHaveBeenCalled()
  })

  it('changes the current home\'s model with the exact choice, and says why when refused', async () => {
    const h = harness({
      cloudOffers: () => [{ alias: 'nhat-thuc', efforts: ['medium'], eligible: true }]
    })
    h.owner.chooseModel.mockResolvedValue({ ok: false, reason: 'stale_choice_revision' })

    const result = await h.run({
      action: 'model',
      model: { connectionRef: 'conn_atummanaged000001', model: 'nhat-thuc', effort: 'medium' }
    })

    expect(result).toEqual({ status: 'refused', reason: 'stale_choice_revision' })
    expect(h.owner.chooseModel.mock.calls[0]![1]).toMatchObject({ destination: 'cloud', source: 'atum', model: 'nhat-thuc' })
  })

  it('does not change to a cloud model the platform does not serve', async () => {
    const h = harness({ cloudOffers: () => [{ alias: 'nhat-thuc', efforts: ['medium'], eligible: false }] })

    await expect(
      h.run({ action: 'model', model: { connectionRef: 'conn_atummanaged000001', model: 'nhat-thuc', effort: 'medium' } })
    ).resolves.toEqual({ status: 'refused', reason: 'connection_unavailable' })
    expect(h.owner.chooseModel).not.toHaveBeenCalled()
  })

  it('refuses an action it does not know', async () => {
    await expect(harness().run({ action: 'format' })).rejects.toThrow('matrix_command_invalid')
  })
})
