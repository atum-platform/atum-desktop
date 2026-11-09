import { describe, expect, it, vi } from 'vitest'

import type { AtumPetBinding } from '../../shared/atum-account-preferences'
import type { MatrixPetCatalog, MatrixPetSnapshot } from '../../shared/matrix-pet'

import { MatrixAgentDefinitionError } from './agent-definition'
import { MatrixPets, type MatrixPetScope } from './pets'

const pet: AtumPetBinding = { ref: { kind: 'bundled', slug: 'gigi' }, enabled: true, scale: 0.33 }
const target = { scope: 'account:1', agent: 'agent-a' }

const scope: MatrixPetScope = {
  key: 'account',
  generation: 1,
  owner: 'owner-a',
  agent: 'agent-a',
  assistantId: 'assistant-a',
  isDefault: true
}

const selection: MatrixPetSnapshot = {
  owner: scope.owner,
  agent: scope.agent,
  revision: 1,
  pet,
  provenance: 'default',
  access: 'owned',
  visitEndsAt: null,
  serverTime: '2026-10-03T00:00:00.000Z'
}

function setup(
  saved = new Map<string, string>(),
  roaming?: (scope: MatrixPetScope, signal: AbortSignal) => Promise<boolean>
) {
  let current: MatrixPetScope | null = { ...scope }
  const request = vi.fn(async () => structuredClone(selection))

  const sprite = vi.fn(async (_scope: MatrixPetScope, value: AtumPetBinding) => ({
    enabled: true,
    slug: value.ref?.kind === 'bundled' ? value.ref.slug : 'personal',
    scale: value.scale
  }))

  const catalog = vi.fn(async () => ({
    owner: scope.owner,
    agent: scope.agent,
    serverTime: '2026-10-03T00:00:00.000Z',
    items: [],
    personal: [],
    visit: { state: 'none' as const, startedAt: null, endsAt: null },
    hatch: { offer: null, creditEntitlementId: null, roundsLeft: 3 }
  }))

  const visit = vi.fn(async () => {})

  const cache = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value)
    }
  }

  const instance = new MatrixPets({ scope: () => current, request, sprite, catalog, visit, cache, roaming })

  return {
    instance,
    request,
    sprite,
    catalog,
    visit,
    cache,
    saved,
    change: (value: MatrixPetScope | null) => {
      current = value
    }
  }
}

describe('principal-owned pet presentation', () => {
  it('rejects malformed writes as promises before contacting the provider', async () => {
    const deps = setup()
    await expect(deps.instance.write(target, 1, { ...pet, scale: NaN })).rejects.toThrow()
    await expect(deps.instance.write(target, -1, pet)).rejects.toThrow()
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('starts the default-agent visit before each authoritative display read, but never substitutes a local timer', async () => {
    const deps = setup()
    await deps.instance.read(target)
    expect(deps.visit).toHaveBeenCalledWith(scope)
    expect(deps.visit.mock.invocationCallOrder[0]).toBeLessThan(deps.request.mock.invocationCallOrder[0])

    deps.visit.mockRejectedValueOnce(new MatrixAgentDefinitionError('unavailable'))
    await expect(deps.instance.read(target)).resolves.toMatchObject({ freshness: 'current', selection })
  })
  it('never activates a visit for a non-default agent', async () => {
    const deps = setup()
    deps.change({ ...scope, isDefault: false })
    await deps.instance.read(target)
    expect(deps.visit).not.toHaveBeenCalled()
  })
  it('serializes a read and hide so a late read cannot overwrite explicit off', async () => {
    const deps = setup()
    let finish!: (value: MatrixPetSnapshot) => void
    deps.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const read = deps.instance.read(target)
    const hidden = { ...selection, revision: 2, provenance: 'explicit' as const, pet: { ...pet, enabled: false } }
    deps.request.mockResolvedValueOnce(hidden)
    const write = deps.instance.write(target, 1, hidden.pet)
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(deps.request).toHaveBeenCalledTimes(1)
    finish(selection)
    await read
    await expect(write).resolves.toMatchObject({ selection: hidden })
    expect(JSON.parse([...deps.saved.values()][0]!)).toEqual(hidden)
    expect(deps.sprite).toHaveBeenCalledTimes(1)
  })
  it('renders a saved bundle without an executor, caches it, and restores offline after restart', async () => {
    const first = setup()
    expect(await first.instance.read(target)).toMatchObject({
      selection,
      freshness: 'current',
      sprite: { slug: 'gigi' }
    })
    const restarted = setup(first.saved)
    restarted.request.mockRejectedValue(new MatrixAgentDefinitionError('unavailable'))
    expect(await restarted.instance.read(target)).toMatchObject({
      selection,
      freshness: 'offline',
      sprite: { slug: 'gigi' }
    })
  })

  it('keeps explicit off and clear across restart; absence never seeds', async () => {
    for (const binding of [{ ...pet, enabled: false }, { ...pet, enabled: false, ref: null }, null]) {
      const deps = setup()
      deps.request.mockResolvedValue({ ...selection, pet: binding, provenance: binding === null ? null : 'explicit' })
      const read = await deps.instance.read(target)
      expect(read.selection.pet).toEqual(binding)
      expect(deps.sprite).not.toHaveBeenCalled()
      const restarted = setup(deps.saved)
      restarted.request.mockRejectedValue(new MatrixAgentDefinitionError('unavailable'))
      expect((await restarted.instance.read(target)).selection.pet).toEqual(binding)
      expect(restarted.sprite).not.toHaveBeenCalled()
    }
  })

  describe('a default agent with nothing chosen yet', () => {
    const never = { ...selection, pet: null, provenance: null, access: null }

    // The setup's catalog mock is typed from its empty default; a full shelf replaces it.
    const stock = (deps: ReturnType<typeof setup>, value: MatrixPetCatalog) =>
      deps.catalog.mockResolvedValue(value as Awaited<ReturnType<typeof deps.catalog>>)

    const shelf = (access: 'owned' | 'visiting' | 'available'): MatrixPetCatalog => ({
      owner: scope.owner,
      agent: scope.agent,
      serverTime: '2026-10-03T00:00:00.000Z',
      items: [
        { ref: { kind: 'bundled' as const, slug: 'gigi' as const }, slug: 'gigi', name: 'Gigi', access, offer: null }
      ],
      personal: [],
      visit: {
        state: access === 'visiting' ? ('visiting' as const) : ('none' as const),
        startedAt: null,
        endsAt: null
      },
      hatch: { offer: null, creditEntitlementId: null, roundsLeft: 3 }
    })

    it.each(['owned', 'visiting'] as const)(
      'shows Gigi when the account %s her, without saving a choice',
      async access => {
        const deps = setup()
        deps.request.mockResolvedValue(never)
        stock(deps, shelf(access))
        const read = await deps.instance.read(target)
        expect(read).toMatchObject({ selection: never, standIn: true, sprite: { slug: 'gigi' } })
        expect(deps.sprite).toHaveBeenCalledWith(scope, {
          ref: { kind: 'bundled', slug: 'gigi' },
          enabled: true,
          scale: 1
        })
        // Read only: the provider was asked once, with no write.
        expect(deps.request).toHaveBeenCalledExactlyOnceWith(scope, undefined)
        expect(JSON.parse([...deps.saved.values()][0]!)).toEqual(never)
      }
    )

    it('carries the visit end with a visiting stand-in, so the window can send her home on time', async () => {
      const deps = setup()
      deps.request.mockResolvedValue(never)
      const visiting = shelf('visiting')
      visiting.items[0]!.visitEndsAt = '2026-10-10T00:00:00.000Z'
      stock(deps, visiting)
      expect((await deps.instance.read(target)).visitEndsAt).toBe('2026-10-10T00:00:00.000Z')

      const owned = setup()
      owned.request.mockResolvedValue(never)
      stock(owned, shelf('owned'))
      expect((await owned.instance.read(target)).visitEndsAt).toBeUndefined()
    })

    it('asks the platform for the catalog once per read and hands it to the picker', async () => {
      const deps = setup()
      deps.request.mockResolvedValue(never)
      stock(deps, shelf('owned'))
      const read = await deps.instance.read(target)
      expect(deps.catalog).toHaveBeenCalledOnce()
      expect(read.catalog).toEqual(shelf('owned'))

      // A saved pet still brings the catalog along; a write keeps its old shape.
      const saved = setup()
      expect((await saved.instance.read(target)).catalog).toBeDefined()
      expect(saved.catalog).toHaveBeenCalledOnce()
      expect((await saved.instance.write(target, 1, pet)).catalog).toBeUndefined()
      expect(saved.catalog).toHaveBeenCalledOnce()

      // An unreachable catalog leaves it out rather than failing the read, and says it was
      // asked for, so the window does not ask again at once for what just failed.
      const down = setup()
      down.catalog.mockRejectedValue(new MatrixAgentDefinitionError('unavailable'))
      const partial = await down.instance.read(target)
      expect(partial.catalog).toBeUndefined()
      expect(partial.catalogUnavailable).toBe(true)
      expect(partial.sprite).toBeDefined()
      expect(read.catalogUnavailable).toBeUndefined()
    })

    it('shows nothing once the trial has ended and she is only for sale', async () => {
      const deps = setup()
      deps.request.mockResolvedValue(never)
      stock(deps, shelf('available'))
      const read = await deps.instance.read(target)
      expect(read.sprite).toBeUndefined()
      expect(read.standIn).toBeUndefined()
      expect(deps.sprite).not.toHaveBeenCalled()
    })

    it('never stands in for an explicit none, another agent, an offline read or an unreachable catalog', async () => {
      const none = setup()
      none.request.mockResolvedValue({
        ...selection,
        provenance: 'explicit',
        access: null,
        pet: { ...pet, ref: null, enabled: false }
      })
      stock(none, shelf('owned'))
      expect((await none.instance.read(target)).sprite).toBeUndefined()

      const other = setup()
      other.change({ ...scope, isDefault: false })
      other.request.mockResolvedValue(never)
      stock(other, shelf('owned'))
      expect((await other.instance.read(target)).sprite).toBeUndefined()
      expect(other.sprite).not.toHaveBeenCalled()

      const cached = setup()
      cached.request.mockResolvedValue(never)
      await cached.instance.read(target)
      const offline = setup(cached.saved)
      offline.request.mockRejectedValue(new MatrixAgentDefinitionError('unavailable'))
      stock(offline, shelf('owned'))
      expect(await offline.instance.read(target)).toMatchObject({ freshness: 'offline', selection: never })
      expect(offline.sprite).not.toHaveBeenCalled()

      const down = setup()
      down.request.mockResolvedValue(never)
      down.catalog.mockRejectedValue(new MatrixAgentDefinitionError('unavailable'))
      await expect(down.instance.read(target)).resolves.toMatchObject({ freshness: 'current', selection: never })
      expect(down.sprite).not.toHaveBeenCalled()
    })
  })

  it('asks for a saved pet’s catalog while the pet is still being drawn, not after', async () => {
    const deps = setup()
    let draw!: () => void
    deps.sprite.mockImplementationOnce(
      async (_scope, value) =>
        new Promise(resolve => {
          draw = () => resolve({ enabled: true, slug: 'gigi', scale: value.scale })
        })
    )
    const pending = deps.instance.read(target)
    await vi.waitFor(() => expect(draw).toBeDefined())
    expect(deps.catalog).toHaveBeenCalledOnce()
    draw()
    expect((await pending).catalog).toBeDefined()
    expect(deps.catalog).toHaveBeenCalledOnce()
  })

  it('never converts denial, missing provider or malformed/wrong-owner data into an empty/default pet', async () => {
    const deps = setup()
    await deps.instance.read(target)

    for (const code of ['denied', 'missing', 'invalid'] as const) {
      deps.request.mockRejectedValue(new MatrixAgentDefinitionError(code))
      await expect(deps.instance.read(target)).rejects.toMatchObject({ code })
    }

    deps.request.mockResolvedValue({ ...selection, owner: 'someone-else' })
    await expect(deps.instance.read(target)).rejects.toThrow('matrix_pet_invalid')
    expect(JSON.parse([...deps.saved.values()][0]!)).toEqual(selection)
  })

  it('fences a response after an account switch before it can cache or load an asset', async () => {
    const deps = setup()
    let complete!: (value: MatrixPetSnapshot) => void
    deps.request.mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const pending = deps.instance.read(target)
    await vi.waitFor(() => expect(complete).toBeDefined())
    deps.change({ ...scope, key: 'other-account', generation: 2 })
    complete(selection)
    await expect(pending).rejects.toThrow('matrix_pet_cancelled')
    expect(deps.saved.size).toBe(0)
    expect(deps.sprite).not.toHaveBeenCalled()
  })

  it('separates agents and rejects cross-principal cached assets', async () => {
    const deps = setup()
    await deps.instance.read(target)
    deps.change({ ...scope, agent: 'agent-b', assistantId: 'assistant-b' })
    deps.request.mockResolvedValue({
      ...selection,
      agent: 'agent-b',
      pet: { ...pet, ref: { kind: 'bundled', slug: 'mochi' } }
    })
    expect((await deps.instance.read({ ...target, agent: 'agent-b' })).sprite?.slug).toBe('mochi')
    expect(deps.saved.size).toBe(2)
    deps.change({ ...scope, owner: 'different-owner' })
    deps.request.mockRejectedValue(new MatrixAgentDefinitionError('unavailable'))
    await expect(deps.instance.read(target)).rejects.toThrow('matrix_pet_invalid')
  })

  it('does not resolve personal, held/catalog or unknown bundled references by their slug', async () => {
    for (const ref of [
      { kind: 'personal', pet_id: '00000000-0000-4000-8000-b9c47b970683' },
      { kind: 'catalog', item_id: 'gigi' },
      { kind: 'bundled', slug: 'unknown' }
    ] as const) {
      const deps = setup()
      deps.request.mockResolvedValue({ ...selection, pet: { ...pet, ref }, provenance: 'explicit' })
      const result = await deps.instance.read(target)
      expect(result).toMatchObject({ assetUnavailable: true, selection: { pet: { ref } } })
      expect(deps.sprite).not.toHaveBeenCalled()
    }
  })

  it('renders an owned personal library record from the real four-house catalog shape', async () => {
    const deps = setup()
    const id = '00000000-0000-4000-8000-b9c47b970683'
    const personal = { ...pet, ref: { kind: 'personal' as const, pet_id: id } }
    deps.request.mockResolvedValue({ ...selection, pet: personal, provenance: 'explicit' })
    deps.catalog.mockResolvedValue({
      owner: scope.owner,
      agent: scope.agent,
      serverTime: '2026-10-03T00:00:00.000Z',
      // The server deliberately keeps personal records out of `items`.
      items: ['gigi', 'cookie', 'mochi', 'bailey'].map(slug => ({
        ref: { kind: 'bundled' as const, slug },
        slug,
        name: slug,
        access: 'owned' as const,
        offer: null,
        visitEndsAt: null
      })),
      personal: [
        {
          pet_id: id,
          display_name: 'Little comet',
          description: 'A warm companion',
          content_sha256: 'a'.repeat(64),
          byte_size: 1234,
          updated_at: '2026-10-03T00:00:00.000Z'
        }
      ],
      visit: { state: 'none' as const, startedAt: null, endsAt: null },
      hatch: { offer: null, creditEntitlementId: null, roundsLeft: 3 }
    })

    await expect(deps.instance.read(target)).resolves.toMatchObject({
      selection: { pet: personal },
      sprite: { slug: 'personal' }
    })
    expect(deps.sprite).toHaveBeenCalledWith(scope, personal, expect.objectContaining({ personal: expect.any(Array) }))
    // The library check and the picker share one catalog request.
    expect(deps.catalog).toHaveBeenCalledOnce()
  })

  it('uses only the receipt-verified native cache for a last-verified personal pet while offline', async () => {
    const id = '00000000-0000-4000-8000-b9c47b970683'
    const personal = { ...pet, ref: { kind: 'personal' as const, pet_id: id } }
    const savedSelection = { ...selection, pet: personal, provenance: 'explicit' as const }
    const deps = setup(new Map([[`matrix-pet:${scope.key}:${scope.agent}`, JSON.stringify(savedSelection)]]))
    deps.request.mockRejectedValue(new MatrixAgentDefinitionError('unavailable'))

    await expect(deps.instance.read(target)).resolves.toMatchObject({
      freshness: 'offline',
      sprite: { slug: 'personal' }
    })
    expect(deps.catalog).not.toHaveBeenCalled()
    expect(deps.sprite).toHaveBeenCalledWith(scope, personal)
  })

  it('does not replay conflicting or ambiguous writes or use offline write fallbacks', async () => {
    const deps = setup()
    await deps.instance.read(target)
    deps.request.mockClear()

    for (const code of ['conflict', 'unavailable'] as const) {
      deps.request.mockRejectedValueOnce(new MatrixAgentDefinitionError(code))
      await expect(deps.instance.write(target, 1, { ...pet, enabled: false })).rejects.toMatchObject({ code })
    }

    expect(deps.request).toHaveBeenCalledTimes(2)
    expect(JSON.parse([...deps.saved.values()][0]!)).toEqual(selection)
  })

  it('returns only the current agent’s authoritative catalog and fences it on an account switch', async () => {
    const deps = setup()

    const payload = {
      owner: scope.owner,
      agent: scope.agent,
      serverTime: '2026-10-03T00:00:00.000Z',
      items: [
        {
          ref: { kind: 'bundled', slug: 'gigi' },
          slug: 'gigi',
          name: 'Gigi',
          access: 'visiting',
          offer: null,
          visitEndsAt: '2026-10-10T00:00:00.000Z'
        }
      ],
      personal: [],
      visit: { state: 'visiting', startedAt: '2026-10-03T00:00:00.000Z', endsAt: '2026-10-10T00:00:00.000Z' }
    } as any

    deps.catalog.mockResolvedValue(payload)
    await expect(deps.instance.catalog(target)).resolves.toMatchObject({ items: [{ access: 'visiting' }] })
    let finish!: (value: typeof payload) => void
    deps.catalog.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const pending = deps.instance.catalog(target)
    await vi.waitFor(() => expect(finish).toBeDefined())
    deps.change({ ...scope, key: 'other-account', generation: 2 })
    finish(payload)
    await expect(pending).rejects.toThrow('matrix_pet_cancelled')
  })

  it('suppresses a cached visit while offline instead of extending it from a local clock', async () => {
    const cached = { ...selection, access: 'visiting' as const, visitEndsAt: '2026-10-10T00:00:00.000Z' }
    const deps = setup(new Map([[`matrix-pet:${scope.key}:${scope.agent}`, JSON.stringify(cached)]]))
    deps.request.mockRejectedValue(new MatrixAgentDefinitionError('unavailable'))
    await expect(deps.instance.read(target)).resolves.toMatchObject({ freshness: 'offline', visitUnavailable: true })
    expect(deps.sprite).not.toHaveBeenCalled()
  })

  it('reports an accepted cloud choice even if the local cache or its asset is unavailable', async () => {
    const deps = setup()

    deps.cache.setItem = () => {
      throw new Error('disk_full')
    }

    deps.sprite.mockRejectedValue(new Error('missing_bundle'))
    const result = await deps.instance.write(target, 0, pet)
    expect(result).toMatchObject({ selection, freshness: 'current', cacheUnavailable: true, assetUnavailable: true })
  })
})

it('caches the verified roaming preference and preserves it through a read failure', async () => {
  const reader = vi.fn(async () => false)
  const deps = setup(new Map(), reader)
  const key = `matrix-pet-roaming:${JSON.stringify([scope.key, scope.owner])}`
  expect((await deps.instance.read(target)).roaming).toBe(false)
  expect(reader).toHaveBeenCalledWith(scope, expect.any(AbortSignal))
  expect(deps.saved.get(key)).toBe('false')
  reader.mockRejectedValueOnce(new Error('unavailable'))
  expect((await deps.instance.read(target)).roaming).toBe(false)
  const restarted = setup(deps.saved, vi.fn().mockRejectedValue(new Error('unavailable')))
  expect((await restarted.instance.read(target)).roaming).toBe(false)
  reader.mockResolvedValueOnce(true)
  expect((await deps.instance.read(target)).roaming).toBe(true)
  expect(deps.saved.get(key)).toBe('true')
})

it('uses the roaming default before any configured preference read succeeds', async () => {
  const reader = vi.fn().mockRejectedValue(new Error('unavailable'))

  const deps = setup(
    new Map([[`matrix-pet-roaming:${JSON.stringify([scope.key, 'other-owner'])}`, 'false']]),
    reader
  )

  expect((await deps.instance.read(target)).roaming).toBe(true)
  expect((await setup().instance.read(target)).roaming).toBe(true)
})

it('retains a verified off in memory when its encrypted cache cannot be written', async () => {
  const reader = vi.fn(async () => false)
  const deps = setup(new Map(), reader)

  deps.cache.setItem = () => {
    throw new Error('disk_full')
  }

  expect((await deps.instance.read(target)).roaming).toBe(false)
  reader.mockRejectedValueOnce(new Error('unavailable'))
  expect((await deps.instance.read(target)).roaming).toBe(false)
})

it.each(['matrix_pet_invalid', 'matrix_pet_cancelled'])('does not mask a roaming integrity error: %s', async code => {
  const deps = setup(new Map(), vi.fn().mockRejectedValue(new Error(code)))

  await expect(deps.instance.read(target)).rejects.toThrow(code)
})

it('rejects a non-boolean roaming projection instead of converting it to the default', async () => {
  const reader = vi.fn(async () => undefined) as unknown as (
    scope: MatrixPetScope,
    signal: AbortSignal
  ) => Promise<boolean>

  await expect(setup(new Map(), reader).instance.read(target)).rejects.toThrow('matrix_pet_invalid')
})

it('aborts a superseded roaming read so it cannot hold the per-agent queue', async () => {
  const signals: AbortSignal[] = []

  const reader = vi.fn((_scope: MatrixPetScope, signal: AbortSignal) => {
    signals.push(signal)

    if (signals.length > 1) {
      return Promise.resolve(false)
    }

    return new Promise<boolean>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })

  const deps = setup(new Map(), reader)
  const superseded = deps.instance.read(target)

  await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
  const latest = deps.instance.read(target)

  await expect(superseded).rejects.toThrow('matrix_pet_cancelled')
  await expect(latest).resolves.toMatchObject({ roaming: false })
  expect(signals[0]?.aborted).toBe(true)
})
