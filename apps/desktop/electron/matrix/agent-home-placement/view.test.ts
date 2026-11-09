import { describe, expect, it } from 'vitest'

import type { AgentHomeView } from './controller'
import type { AgentHomeOwnerState } from './owner-controller'
import { readPackV25Json } from './pack-v25.fixture'
import { homeViewFor, type MacNames, ownerHomeReadFallback, ownerHomeViewFor } from './view'

const ME = '00000000-0000-4000-8000-bd7662a5eeb4'
const MINI = '00000000-0000-4000-8000-b454f82c5857'
const STUDIO = '00000000-0000-4000-8000-f6222a1106ee'

const names: MacNames = {
  [ME]: { displayName: 'MacBook', thisMac: true },
  [MINI]: { displayName: 'Mac mini', thisMac: false },
  [STUDIO]: { displayName: 'Studio', thisMac: false }
}

const settled: AgentHomeView = {
  lives: { kind: 'mac', deviceServiceId: ME, thisMac: true },
  move: null,
  canMove: true,
  issue: null
}

describe('what the agent settings show', () => {
  it('shows nothing for an agent the platform has no placement for', () => {
    expect(homeViewFor(null, names, ME)).toBeUndefined()
  })

  it('names where the agent lives and lists the owner’s other Macs, never the one it is on', () => {
    expect(homeViewFor(settled, names, ME)).toEqual({
      lives: { kind: 'mac', name: 'MacBook', thisMac: true },
      move: null,
      targets: [
        { id: MINI, name: 'Mac mini' },
        { id: STUDIO, name: 'Studio' }
      ],
      issue: null
    })

    const away = homeViewFor({ ...settled, lives: { kind: 'mac', deviceServiceId: MINI, thisMac: false } }, names, ME)!
    expect(away.targets.map(target => target.id)).toEqual([ME, STUDIO])
  })

  it('offers no place to move to while a move is under way, or while the registry is unreachable', () => {
    const moving: AgentHomeView = {
      ...settled,
      canMove: false,
      move: { step: 'saving', from: { kind: 'mac', deviceServiceId: ME }, to: { kind: 'mac', deviceServiceId: MINI }, role: 'source' }
    }

    const view = homeViewFor(moving, names, ME)!
    expect(view.targets).toEqual([])
    expect(view.move).toEqual({ step: 'saving', to: { kind: 'mac', name: 'Mac mini', thisMac: false }, role: 'source' })

    expect(homeViewFor(settled, null, ME)!.targets).toEqual([])
    expect(homeViewFor(settled, null, ME)!.lives).toEqual({ kind: 'mac', name: '', thisMac: true })
  })

  it('shows the cloud as the cloud, and a Mac it does not know without a name', () => {
    const cloud = homeViewFor({ ...settled, lives: { kind: 'cloud' }, canMove: false }, names, ME)!
    expect(cloud.lives).toEqual({ kind: 'cloud' })
    expect(cloud.targets).toEqual([
      { id: MINI, name: 'Mac mini' },
      { id: ME, name: 'MacBook', thisMac: true },
      { id: STUDIO, name: 'Studio' }
    ])

    const unknown = '00000000-0000-4000-8000-f1d11edf5c5c'
    const view = homeViewFor({ ...settled, lives: { kind: 'mac', deviceServiceId: unknown, thisMac: false } }, names, ME)!
    expect(view.lives).toEqual({ kind: 'mac', name: '', thisMac: false })
  })

  it('carries the closed reason a move has not finished and nothing else about the platform', () => {
    const view = homeViewFor({ ...settled, issue: 'no_local_home' }, names, ME)!
    expect(view.issue).toBe('no_local_home')
    expect(JSON.stringify(view)).not.toMatch(/placementRevision|homeEpoch|executorTerm|leaseId/u)
  })

  it('keeps a cloud route visible when its owner snapshot conflicts, with an actionable issue', () => {
    expect(
      ownerHomeReadFallback(
        { ok: false, kind: 'conflict', status: 409, reason: 'agent_home_generation_conflict' },
        true
      )
    ).toEqual({ lives: { kind: 'cloud' }, move: null, targets: [], issue: 'placement_stale' })
    expect(ownerHomeReadFallback({ ok: false, kind: 'unavailable', status: 0 }, true)?.issue).toBe(
      'placement_unavailable'
    )
    expect(ownerHomeReadFallback({ ok: false, kind: 'conflict', status: 409 }, false)).toBeUndefined()
  })
})

describe('the cloud models the sheet offers', () => {
  const base = homeViewFor({ ...settled, lives: { kind: 'cloud' }, canMove: true }, names, ME)!
  const state = (): AgentHomeOwnerState => ({
    snapshot: readPackV25Json<AgentHomeOwnerState['snapshot']>('fixtures/owner.placement.snapshot.json'),
    catalogs: {}
  })
  const cloudModels = (offers?: Parameters<typeof ownerHomeViewFor>[5]) =>
    ownerHomeViewFor(base, state(), names, ME, undefined, offers).placement!.destinations.find(each => each.id === 'cloud')!.models

  it('are the platform\'s served offers, an unserved alias shown but not selectable', () => {
    const models = cloudModels([
      { alias: 'nguyet-thuc', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', eligible: true },
      { alias: 'nhat-thuc', efforts: ['medium'], defaultEffort: 'medium', eligible: false }
    ])

    expect(models.map(model => [model.model, model.effort, model.efforts, model.available])).toEqual([
      ['nguyet-thuc', 'medium', ['low', 'medium', 'high'], true],
      ['nhat-thuc', 'medium', ['medium'], false]
    ])
    expect(models.every(model => model.connectionRef === 'conn_atummanaged000001' && model.source === 'atum')).toBe(true)
  })

  it('names the SAVED cloud choice as current: a plan model as itself, never the recommended Atum alias', () => {
    const current = (cloudModel: Parameters<typeof ownerHomeViewFor>[4]) =>
      ownerHomeViewFor(base, state(), names, ME, cloudModel).placement!.currentModel

    expect(
      current({
        source: 'chatgpt_plan',
        model: 'gpt-6-sol',
        modelLabel: 'GPT 6 Sol',
        providerLabel: 'ChatGPT',
        effort: 'medium'
      })
    ).toMatchObject({ source: 'chatgpt_plan', model: 'gpt-6-sol', providerLabel: 'ChatGPT', available: true })
    expect(current('nhat-thuc')).toMatchObject({ source: 'atum', model: 'nhat-thuc' })
  })

  it('are the two line-up aliases until an offer has been read', () => {
    expect(cloudModels(undefined).map(model => [model.model, model.available])).toEqual([
      ['nguyet-thuc', true],
      ['nhat-thuc', true]
    ])
  })
})

describe('this Mac as a place to move to', () => {
  const base = homeViewFor({ ...settled, lives: { kind: 'cloud' }, canMove: true }, names, ME)!
  const snapshot = () => readPackV25Json<AgentHomeOwnerState['snapshot']>('fixtures/owner.placement.snapshot.json')
  /** The platform's view: the cloud home, this Mac (ME) and the mini on the owner's list, this Mac as the platform says. */
  const owner = (me: Record<string, unknown>, extra: Partial<AgentHomeOwnerState> = {}, over: Record<string, unknown> = {}): AgentHomeOwnerState => ({
    snapshot: {
      ...snapshot(),
      eligibleDevices: [
        { deviceServiceId: MINI, displayName: 'Mac mini', eligibility: 'ready' },
        { deviceServiceId: ME, displayName: 'MacBook', ...me }
      ],
      ...over
    } as never,
    catalogs: {},
    ...extra
  })
  const here = (state: AgentHomeOwnerState) =>
    ownerHomeViewFor(base, state, names, ME).placement!.destinations.find(each => each.id === ME)!
  const notSetUp = { eligibility: 'unavailable', reason: 'catalog_unavailable' }
  const aCatalog = (connections: unknown[], freshness: 'fresh' | 'stale' = 'fresh') =>
    ({
      ...readPackV25Json<Record<string, unknown>>('fixtures/mac.connection-catalog.fresh.json'),
      deviceServiceId: ME,
      freshness,
      connections
    }) as never

  it('offers the set-up on this Mac when the assistant lives elsewhere and this Mac has no catalog', () => {
    expect(here(owner(notSetUp)).setUp).toBe('needed')
  })

  it('adds this signed-in Mac as a preparable target when the owner snapshot omits it', () => {
    const state = owner(notSetUp, {}, {
      eligibleDevices: [{ deviceServiceId: MINI, displayName: 'Mac mini', eligibility: 'ready' }]
    })

    expect(here(state)).toMatchObject({
      id: ME,
      name: 'MacBook',
      thisMac: true,
      eligibility: 'unavailable',
      reason: 'not_enrolled',
      setUp: 'needed'
    })
  })

  it('omits a superseded same-machine enrollment from placement destinations', () => {
    const stale = '00000000-0000-4000-8000-f1d11edf5c5c'
    const state = owner(notSetUp, {}, {
      eligibleDevices: [
        { deviceServiceId: stale, displayName: 'MacBook', eligibility: 'unavailable', reason: 'catalog_unavailable' },
        { deviceServiceId: ME, displayName: 'MacBook', eligibility: 'unavailable', reason: 'catalog_unavailable' },
        { deviceServiceId: MINI, displayName: 'Mac mini', eligibility: 'ready' }
      ]
    })

    const destinations = ownerHomeViewFor(base, state, names, ME, undefined, undefined, [stale]).placement!.destinations
    expect(destinations.map(each => each.id)).toEqual(['cloud', ME, MINI])
  })

  it('offers it again when the catalog it published has gone stale (its set-up lapsed)', () => {
    const connections = readPackV25Json<{ connections: unknown[] }>('fixtures/mac.connection-catalog.fresh.json').connections

    expect(here(owner(notSetUp, { catalogs: { [ME]: aCatalog(connections, 'stale') } })).setUp).toBe('needed')
  })

  it('says only that a model must be connected when this Mac is set up but offers none', () => {
    expect(here(owner(notSetUp, { catalogs: { [ME]: aCatalog([]) } })).setUp).toBe('connect')
  })

  it("shows Atum's managed model by its product name even though the wire label is ASCII", () => {
    const catalog = aCatalog([
      {
        connectionRef: 'conn_atummanaged000001',
        source: 'atum',
        providerLabel: 'Atum',
        state: 'available',
        models: [{ model: 'nguyet-thuc', modelLabel: 'Nguyet Thuc 1.3', efforts: ['medium'], defaultEffort: 'medium' }]
      }
    ])

    expect(here(owner({ eligibility: 'ready' }, { catalogs: { [ME]: catalog } })).models).toEqual([
      expect.objectContaining({
        model: 'nguyet-thuc',
        modelLabel: 'Nguyệt Thực 1.3',
        providerLabel: 'Atum',
        source: 'atum'
      })
    ])
  })

  it('offers nothing for a Mac that is ready, or that is not the one the window is on', () => {
    expect(here(owner({ eligibility: 'ready' })).setUp).toBeUndefined()

    const view = ownerHomeViewFor(base, owner(notSetUp, {}, {
      eligibleDevices: [
        { deviceServiceId: MINI, displayName: 'Mac mini', eligibility: 'unavailable', reason: 'catalog_unavailable' }
      ]
    }), names, ME)
    expect(view.placement!.destinations.find(each => each.id === MINI)!.setUp).toBeUndefined()
  })

  it('offers nothing for a reason that setting up cannot fix, or while a move is under way, or on the home itself', () => {
    expect(here(owner({ eligibility: 'unavailable', reason: 'version_unsupported' })).setUp).toBeUndefined()

    const moving = owner(notSetUp, {}, {
      placement: {
        ...snapshot().placement,
        activeMove: { moveId: '00000000-0000-4000-8000-f2da1f9533d4', status: 'draining', source: { kind: 'cloud' }, target: { kind: 'mac', deviceServiceId: MINI } }
      }
    })
    expect(here(moving).setUp).toBeUndefined()

    const home = ownerHomeViewFor(
      { ...base, lives: { kind: 'mac', name: 'MacBook', thisMac: true } },
      owner(notSetUp, {}, { placement: { ...snapshot().placement, location: { kind: 'mac', deviceServiceId: ME } } }),
      names,
      ME
    )
    expect(home.placement!.destinations.find(each => each.id === ME)!.setUp).toBeUndefined()
  })
})

describe('a home Mac that is not answering', () => {
  const base = homeViewFor(settled, names, ME)!
  const waiting = (reason: 'platform_not_ready' | 'client_update_required', where: 'mac' | 'cloud' = 'mac'): AgentHomeOwnerState => ({
    snapshot: {
      ...readPackV25Json<AgentHomeOwnerState['snapshot']>('fixtures/owner.placement.snapshot.json'),
      placement: {
        ...readPackV25Json<AgentHomeOwnerState['snapshot']>('fixtures/owner.placement.snapshot.json').placement,
        location: where === 'mac' ? { kind: 'mac', deviceServiceId: MINI } : { kind: 'cloud' }
      },
      currentHomeReachability: { state: 'offline', lastSeenAtPlatform: 1_799_999_100_000 },
      moveCapability: { state: 'unavailable', reason }
    } as never,
    catalogs: {}
  })

  it('says it waits for that Mac, and still lists the cloud and the Mac it lives on', () => {
    const placement = ownerHomeViewFor(base, waiting('platform_not_ready'), names, ME).placement!

    expect(placement.waitingForHome).toBe(true)
    expect(placement.moveAvailable).toBe(false)
    expect(placement.current).toBe(MINI)
    expect(placement.reachability).toBe('offline')
    expect(placement.destinations.map(each => each.id)).toEqual(expect.arrayContaining(['cloud', MINI]))
  })

  it('does not say it waits for a platform that is not ready for another reason, or for a cloud home', () => {
    expect(ownerHomeViewFor(base, waiting('client_update_required'), names, ME).placement!.waitingForHome).toBeUndefined()
    expect(ownerHomeViewFor(base, waiting('platform_not_ready', 'cloud'), names, ME).placement!.waitingForHome).toBeUndefined()
  })
})
