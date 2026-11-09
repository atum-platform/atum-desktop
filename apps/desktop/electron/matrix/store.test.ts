import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { mirrorTaggedConsole } from './main-log'
import {
  FileStoreJournal,
  matrixHireTargetLive,
  matrixScopedHireTargetLive,
  MatrixStoreController,
  MatrixStoreResponseError,
  requestMatrixStore,
  type StoreResource
} from './store'
import { storeItem, storeResult } from './store-contract'

const offerId = '00000000-0000-4000-8000-303617b97302'
const assistantId = '00000000-0000-4000-8000-00f765af1c54'
const purchaseId = '00000000-0000-4000-8000-50d86b120e98'
const entitlementId = '00000000-0000-4000-8000-0bb5de138389'
const at = '2026-10-03T04:00:00Z'

const offer = {
  id: offerId,
  version: 1,
  priceMicroProtons: 19_000_000_001,
  scope: 'agent',
  billingInterval: 'one_time',
  delivery: 'cloud'
}

const item = {
  itemId: 'skill/launch',
  kind: 'skill',
  title: { vi: 'Kỹ năng', en: 'Skill' },
  summary: { vi: 'Tóm tắt' },
  description: { vi: 'Mô tả' },
  tryPrompt: { vi: 'Thử' },
  needs: [],
  glyph: '✦',
  accent: '#204060',
  featured: true,
  sortOrder: 0,
  offer
}

const entitlement = {
  id: entitlementId,
  itemId: item.itemId,
  kind: 'skill',
  state: 'active',
  assistantId,
  delivery: 'cloud',
  grantedAt: at,
  subscription: null
}

const intent = { offerId, offerVersion: 1, assistantId }
// Every Store request declares the same understanding, Hub skills included (Store v1.1 ST-9b).
const STORE_CAPABILITIES = 'agents.schedules.1,skills.hub.1,skills.prefix.1,store.ownership.1'
const hireOfferId = '00000000-0000-4000-8000-6cc9b1298c8f'
const hirePurchaseId = '00000000-0000-4000-8000-2dab195ed4f7'
const hireEntitlementId = '00000000-0000-4000-8000-bd7662a5eeb4'

const hireOffer = {
  id: hireOfferId,
  version: 2,
  priceMicroProtons: 25_000_000,
  renewalPriceMicroProtons: 31_000_000,
  scope: 'agent',
  billingInterval: 'month',
  delivery: 'cloud'
} as const

const hireItem = { ...item, itemId: 'agent/mentor', kind: 'agent', title: { vi: 'Cố vấn' }, offer: hireOffer }
const hireIntent = { offerId: hireOfferId, offerVersion: 2, consentRenewal: true as const }

const hireResult = (key: string, createdAssistantId: string, state = 'completed') => ({
  outcome: 'purchased',
  purchase: {
    id: hirePurchaseId,
    state,
    itemId: hireItem.itemId,
    offerId: hireOfferId,
    offerVersion: 2,
    idempotencyKey: key,
    assistantId: createdAssistantId,
    amountMicroProtons: hireOffer.priceMicroProtons,
    createdAt: at
  },
  entitlement:
    state === 'delivery_pending'
      ? null
      : {
          id: hireEntitlementId,
          itemId: hireItem.itemId,
          kind: 'agent',
          state: 'active',
          assistantId: createdAssistantId,
          delivery: 'cloud',
          grantedAt: at,
          subscription: {
            state: 'active',
            renewAt: '2026-11-03T04:00:00Z',
            priceMicroProtons: hireOffer.renewalPriceMicroProtons,
            offerVersion: 2
          }
        }
})

const scope = { accountKey: 'a'.repeat(64), generation: 1 }

const result = (key: string, state = 'completed') => ({
  outcome: 'purchased',
  purchase: {
    id: purchaseId,
    state,
    itemId: item.itemId,
    offerId,
    offerVersion: 1,
    idempotencyKey: key,
    assistantId,
    amountMicroProtons: offer.priceMicroProtons,
    createdAt: at
  },
  entitlement: state === 'delivery_pending' ? null : entitlement
})

const roots: string[] = [],
  servers: Server[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }

  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

function journal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-store-test-'))
  roots.push(root)

  return { root, journal: new FileStoreJournal(root) }
}

function controller(
  j: FileStoreJournal,
  mutate: (endpoint: StoreResource, input?: unknown) => Promise<unknown>,
  options: {
    items?: unknown[]
    createAgent?: (input: { requestId: string; displayName: string }, signal: AbortSignal) => Promise<{ id: string }>
    hireReady?: (itemId: string) => Promise<boolean>
    hireTargetLive?: (assistantId: string) => boolean | undefined
    rosterStale?: () => void
  } = {}
) {
  const request = vi.fn(async (endpoint: StoreResource, _signal: AbortSignal, input?: unknown) => {
    if (endpoint === 'catalog') {
      return { items: options.items ?? [item] }
    }

    if (endpoint === 'entitlements') {
      return { entitlements: [] }
    }

    if (endpoint === 'purchases' && input === undefined) {
      return { purchases: [] }
    }

    return mutate(endpoint, input)
  })

  const changed = vi.fn(),
    walletChanged = vi.fn()

  const store = new MatrixStoreController({
    journal: j,
    request,
    changed,
    walletChanged,
    ...(options.createAgent ? { createAgent: options.createAgent } : {}),
    ...(options.hireReady ? { hireReady: options.hireReady } : {}),
    ...(options.hireTargetLive ? { hireTargetLive: options.hireTargetLive } : {}),
    ...(options.rosterStale ? { rosterStale: options.rosterStale } : {})
  })

  store.activate(scope)

  return { store, request, changed, walletChanged }
}

describe('durable native Store purchase', () => {
  it('persists one key before dispatch and coalesces a double click', async () => {
    const { journal: j } = journal()
    let finish!: (value: unknown) => void

    const mutate = vi.fn(async (_endpoint, input: any) => {
      expect(j.read(scope.accountKey)).toEqual([{ ...intent, idempotencyKey: input.idempotencyKey, purchaseId: null }])

      return new Promise(resolve => {
        finish = resolve
      })
    })

    const { store } = controller(j, mutate)
    await store.refresh()

    const first = store.purchase(intent),
      second = store.purchase(intent)

    expect(mutate).toHaveBeenCalledTimes(1)
    finish(result(j.read(scope.accountKey)[0]!.idempotencyKey))
    expect(await first).toEqual(await second)
    expect(j.read(scope.accountKey)).toEqual([])
    store.activate(null)
  })
  it('recovers a lost reply after process restart with the exact same request key', async () => {
    const { journal: j } = journal()
    const seen: any[] = []

    const first = controller(j, async (_endpoint, input) => {
      seen.push(input)
      throw new Error('reply lost')
    })

    await first.store.refresh()
    expect(await first.store.purchase(intent)).toEqual({ outcome: 'uncertain' })
    const saved = j.read(scope.accountKey)[0]!
    first.store.activate(null)

    const restarted = controller(j, async (_endpoint, input: any) => {
      seen.push(input)

      return result(input.idempotencyKey)
    })

    await restarted.store.refresh()
    expect(restarted.store.snapshot()?.pending).toEqual([saved])
    await restarted.store.resume(saved.idempotencyKey)
    expect(seen).toEqual([seen[0], seen[0]])
    expect(j.read(scope.accountKey)).toEqual([])
    restarted.store.activate(null)
  })
  it('recovers known settled but undelivered purchase by GET without another POST', async () => {
    const { journal: j } = journal()
    const endpoints: string[] = []

    const { store } = controller(j, async (endpoint, input: any) => {
      endpoints.push(endpoint)

      return result(
        input?.idempotencyKey ?? j.read(scope.accountKey)[0]!.idempotencyKey,
        endpoint === 'purchases' ? 'granted' : 'completed'
      )
    })

    await store.refresh()
    await store.purchase(intent)
    expect(j.read(scope.accountKey)[0]?.purchaseId).toBe(purchaseId)
    await store.resume(j.read(scope.accountKey)[0]!.idempotencyKey)
    expect(endpoints).toEqual(['purchases', `purchases/${purchaseId}`])
    expect(j.read(scope.accountKey)).toEqual([])
    store.activate(null)
  })
  it('persists a hatch caller key before it can dispatch the purchase', async () => {
    const { journal: j } = journal()
    const mutate = vi.fn(async (_endpoint, input: any) => result(input.idempotencyKey))
    const { store } = controller(j, mutate)

    await store.refresh()
    const key = store.preparePurchase(intent)
    expect(j.read(scope.accountKey)).toEqual([expect.objectContaining({ idempotencyKey: key, purchaseId: null })])
    expect(mutate).not.toHaveBeenCalled()
    await store.resume(key)
    expect(mutate).toHaveBeenCalledTimes(1)
    store.activate(null)
  })
  it('replays an SDK-compacted terminal key with the exact immutable terms', async () => {
    const { journal: j } = journal()
    const keys: string[] = []
    const { store } = controller(j, async (_endpoint, input: any) => {
      keys.push(input.idempotencyKey)
      return result(input.idempotencyKey)
    })
    await store.refresh()
    const key = store.preparePurchase(intent)
    await store.resume(key)
    expect(j.read(scope.accountKey)).toEqual([])
    await store.resumePrepared(key, intent)
    expect(keys).toEqual([key, key])
    store.activate(null)
  })
  it('a terminal refusal leaves no retryable request; a later purchase is a fresh explicit action', async () => {
    const { journal: j } = journal()
    const keys: string[] = []

    const { store } = controller(j, async (_endpoint, input: any) => {
      keys.push(input.idempotencyKey)

      return { outcome: 'refused', code: 'insufficient_protons' }
    })

    await store.refresh()
    await store.purchase(intent)
    expect(j.read(scope.accountKey)).toEqual([])
    await store.purchase(intent)
    expect(keys[0]).not.toBe(keys[1])
    store.activate(null)
  })
  it.each([
    [400, 'invalid_request'],
    [403, 'forbidden'],
    [404, 'offer_unavailable'],
    [409, 'feature_unavailable'],
    [410, 'offer_unavailable'],
    [413, 'invalid_request'],
    [422, 'invalid_request'],
    [429, 'rate_limited']
  ] as const)('clears a request on a definite Store %i response', async (status, code) => {
    const { journal: j } = journal()

    const { store } = controller(j, async () => {
      throw new MatrixStoreResponseError(status)
    })

    await store.refresh()
    await expect(store.purchase(intent)).resolves.toEqual({ outcome: 'refused', code })
    expect(j.read(scope.accountKey)).toEqual([])
    store.activate(null)
  })
  it('refuses on a 401 the renewed sign-in got again, and keeps nothing to retry', async () => {
    const { journal: j } = journal()

    const { store } = controller(j, async () => {
      throw new Error('matrix_store_authentication')
    })

    await store.refresh()
    await expect(store.purchase(intent)).resolves.toEqual({ outcome: 'refused', code: 'unauthenticated' })
    expect(j.read(scope.accountKey)).toEqual([])
    store.activate(null)
  })
  it.each([
    ['a 5xx or non-JSON reply', new Error('matrix_store_unavailable')],
    ['a timeout', new DOMException('timed out', 'TimeoutError')],
    ['a dropped connection', new TypeError('fetch failed')],
    ['an unreadable 200 reply', new Error('matrix_store_invalid')]
  ])('keeps the key after %s: the purchase may have reached the Store', async (_label, error) => {
    const { journal: j } = journal()

    const { store } = controller(j, async () => {
      throw error
    })

    await store.refresh()
    await expect(store.purchase(intent)).resolves.toEqual({ outcome: 'uncertain' })
    expect(j.read(scope.accountKey)).toHaveLength(1)
    store.activate(null)
  })
  it('never calls a refused status read of a created purchase a refusal: it may already be charged', async () => {
    const { journal: j } = journal()
    let read = 0

    const { store } = controller(j, async (endpoint, input: any) => {
      if (endpoint === 'purchases') {
        return result(input.idempotencyKey, 'granted')
      }

      read += 1
      throw new MatrixStoreResponseError(read === 1 ? 400 : 404)
    })

    await store.refresh()
    await store.purchase(intent)
    const key = j.read(scope.accountKey)[0]!.idempotencyKey
    // A 400 to the status read: uncertain, and the purchase is kept to check again.
    await expect(store.resume(key)).resolves.toEqual({ outcome: 'uncertain' })
    expect(j.read(scope.accountKey)).toHaveLength(1)
    // A 404 drops the row as it always has, still without claiming nothing was charged.
    await expect(store.resume(key)).resolves.toEqual({ outcome: 'uncertain' })
    expect(j.read(scope.accountKey)).toEqual([])
    store.activate(null)
  })
  it('keeps ambiguous attempts when responses change the target or request key', async () => {
    const { journal: j } = journal()

    const { store } = controller(j, async (_endpoint, input: any) => ({
      ...result(input.idempotencyKey),
      purchase: { ...result(input.idempotencyKey).purchase, assistantId: purchaseId }
    }))

    await store.refresh()
    expect(await store.purchase(intent)).toEqual({ outcome: 'uncertain' })
    expect(j.read(scope.accountKey)).toHaveLength(1)
    await expect(store.purchase({ ...intent, offerVersion: 2 })).rejects.toThrow('matrix_store_pending')
    store.activate(null)
  })
  it('journals a monthly hire before creating its agent and requires explicit renewal consent', async () => {
    const { journal: j } = journal()
    const createAgent = vi.fn(async input => ({ id: assistantId }))
    const mutate = vi.fn(async (_endpoint, input: any) => hireResult(input.idempotencyKey, assistantId))
    const { store } = controller(j, mutate, { items: [hireItem], createAgent })
    await store.refresh()
    await expect(store.purchase({ offerId: hireOfferId, offerVersion: 2 })).rejects.toThrow('matrix_store_invalid')
    const purchasing = store.purchase(hireIntent)
    const saved = j.read(scope.accountKey)[0]!
    expect(saved).toMatchObject({
      ...hireIntent,
      idempotencyKey: saved.idempotencyKey,
      purchaseId: null,
      provision: { requestId: saved.idempotencyKey, name: 'Cố vấn' }
    })
    expect(await purchasing).toMatchObject({ outcome: 'purchased' })
    expect(createAgent).toHaveBeenCalledWith(
      { requestId: saved.idempotencyKey, displayName: 'Cố vấn' },
      expect.any(AbortSignal)
    )
    expect(mutate).toHaveBeenCalledWith('purchases', expect.objectContaining({ ...hireIntent, assistantId }))
    store.activate(null)
  })
  it('refuses a hire whose skills this Mac cannot install before anything is created or charged', async () => {
    const { journal: j } = journal()
    const coach = { ...hireItem, itemId: 'agent/english-coach' }
    const createAgent = vi.fn(async () => ({ id: assistantId }))
    const mutate = vi.fn(async (_endpoint, input: any) => hireResult(input.idempotencyKey, assistantId))

    for (const hireReady of [vi.fn(async () => false), vi.fn(async () => Promise.reject(new Error('backend gone')))]) {
      const { store } = controller(j, mutate, { items: [coach], createAgent, hireReady })
      await store.refresh()

      expect(await store.purchase(hireIntent)).toEqual({ outcome: 'refused', code: 'feature_unavailable' })
      expect(hireReady).toHaveBeenCalledWith('agent/english-coach')
      store.activate(null)
    }

    expect(createAgent).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
    expect(j.read(scope.accountKey)).toEqual([])

    // Where they can be installed, the hire goes ahead as before.
    const hireReady = vi.fn(async () => true)
    const { store } = controller(j, mutate, { items: [coach], createAgent, hireReady })
    await store.refresh()
    expect(await store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
    expect(mutate).toHaveBeenCalledWith('purchases', expect.objectContaining({ ...hireIntent, assistantId }))
    store.activate(null)
  })
  it('coalesces a double click on a hire whose skills check is still running: one agent, one charge', async () => {
    const { journal: j } = journal()
    const coach = { ...hireItem, itemId: 'agent/english-coach' }
    const createAgent = vi.fn(async () => ({ id: assistantId }))
    const mutate = vi.fn(async (_endpoint, input: any) => hireResult(input.idempotencyKey, assistantId))
    const checks: Array<(ready: boolean) => void> = []

    const hireReady = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          checks.push(resolve)
        })
    )

    const { store } = controller(j, mutate, { items: [coach], createAgent, hireReady })
    await store.refresh()

    // Both clicks pass the check before either is journaled (the check awaits the backend).
    const first = store.purchase(hireIntent),
      second = store.purchase(hireIntent)

    expect(hireReady).toHaveBeenCalledTimes(2)
    expect(j.read(scope.accountKey)).toEqual([])
    checks.forEach(ready => ready(true))

    expect(await first).toMatchObject({ outcome: 'purchased' })
    expect(await second).toEqual(await first)
    expect(createAgent).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(j.read(scope.accountKey)).toEqual([])
    store.activate(null)
  })
  it('asks nothing for a hire that needs no skills, or resuming one already journaled', async () => {
    const { journal: j } = journal()
    const hireReady = vi.fn(async () => false)
    const createAgent = vi.fn(async () => ({ id: assistantId }))
    const mutate = vi.fn(async (_endpoint, input: any) => hireResult(input.idempotencyKey, assistantId))
    const plain = controller(j, mutate, { items: [hireItem], createAgent, hireReady })
    await plain.store.refresh()
    expect(await plain.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
    plain.store.activate(null)

    // A hire journaled before (its outcome unknown: it may be charged) is always resumed.
    const coach = { ...hireItem, itemId: 'agent/english-coach' }
    const key = '00000000-0000-4000-8000-b454f82c5857'
    j.write(scope.accountKey, [
      { ...hireIntent, idempotencyKey: key, purchaseId: null, provision: { requestId: key, name: 'Cố vấn' } }
    ])
    const journaled = controller(j, mutate, { items: [coach], createAgent, hireReady })
    await journaled.store.refresh()
    expect(await journaled.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
    expect(mutate).toHaveBeenLastCalledWith('purchases', expect.objectContaining({ idempotencyKey: key }))
    expect(hireReady).not.toHaveBeenCalled()
    journaled.store.activate(null)
  })
  it('retries a lost create response with its original provisioning request after restart', async () => {
    const { journal: j } = journal()

    const firstCreate = vi.fn(async () => {
      throw new Error('lost create')
    })

    const first = controller(
      j,
      async () => {
        throw new Error('must not buy')
      },
      { items: [hireItem], createAgent: firstCreate }
    )

    await first.store.refresh()
    expect(await first.store.purchase(hireIntent)).toEqual({ outcome: 'uncertain' })
    const saved = j.read(scope.accountKey)[0]!
    expect(saved.assistantId).toBeUndefined()
    expect(saved).toMatchObject({
      provision: { requestId: saved.idempotencyKey, name: 'Cố vấn' }
    })
    first.store.activate(null)
    const created = '00000000-0000-4000-8000-b454f82c5857'
    const createAgent = vi.fn(async () => ({ id: created }))

    const restarted = controller(j, async (_endpoint, input: any) => hireResult(input.idempotencyKey, created), {
      items: [hireItem],
      createAgent
    })

    await restarted.store.refresh()
    expect(await restarted.store.resume(saved.idempotencyKey)).toMatchObject({ outcome: 'purchased' })
    expect(createAgent).toHaveBeenCalledWith(
      { requestId: saved.idempotencyKey, displayName: 'Cố vấn' },
      expect.any(AbortSignal)
    )
    expect(j.read(scope.accountKey)).toEqual([])
    restarted.store.activate(null)
  })
  it('persists the created agent before recovering a lost purchase response without provisioning twice', async () => {
    const { journal: j } = journal()
    const created = '00000000-0000-4000-8000-f6222a1106ee'
    const createAgent = vi.fn(async () => ({ id: created }))

    const first = controller(
      j,
      async () => {
        throw new Error('lost purchase')
      },
      { items: [hireItem], createAgent }
    )

    await first.store.refresh()
    expect(await first.store.purchase(hireIntent)).toEqual({ outcome: 'uncertain' })
    const saved = j.read(scope.accountKey)[0]!
    expect(saved.assistantId).toBe(created)
    first.store.activate(null)
    const restartedCreate = vi.fn(async () => ({ id: '00000000-0000-4000-8000-f1d11edf5c5c' }))

    const restarted = controller(j, async (_endpoint, input: any) => hireResult(input.idempotencyKey, created), {
      items: [hireItem],
      createAgent: restartedCreate
    })

    await restarted.store.refresh()
    await restarted.store.resume(saved.idempotencyKey)
    expect(restartedCreate).not.toHaveBeenCalled()
    expect(j.read(scope.accountKey)).toEqual([])
    restarted.store.activate(null)
  })
  it('reuses a provisioned hire after a definite refusal with a fresh payment key, including after restart', async () => {
    const { journal: j } = journal()
    const created = '00000000-0000-4000-8000-fbfe405ca65f'
    let firstKey = ''

    const firstCreate = vi.fn(async (input: { requestId: string; displayName: string }) => {
      firstKey = input.requestId

      return { id: created }
    })

    const first = controller(j, async () => ({ outcome: 'refused', code: 'insufficient_protons' }), {
      items: [hireItem],
      createAgent: firstCreate
    })

    await first.store.refresh()
    expect(await first.store.purchase(hireIntent)).toEqual({ outcome: 'refused', code: 'insufficient_protons' })
    const [reusable] = j.readReusableHires(scope.accountKey)
    expect(j.read(scope.accountKey)).toEqual([])
    expect(reusable).toEqual({ offerId: hireOfferId, offerVersion: 2, assistantId: created })
    first.store.activate(null)

    const secondCreate = vi.fn(async () => ({ id: '00000000-0000-4000-8000-a9703d75e616' }))
    let secondKey = ''

    const restarted = controller(
      j,
      async (_endpoint, input: any) => {
        secondKey = input.idempotencyKey

        return hireResult(input.idempotencyKey, created)
      },
      { items: [hireItem], createAgent: secondCreate }
    )

    await restarted.store.refresh()
    expect(await restarted.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
    expect(secondCreate).not.toHaveBeenCalled()
    expect(secondKey).not.toBe(firstKey)
    expect(j.readReusableHires(scope.accountKey)).toEqual([])
    restarted.store.activate(null)
  })
  it('keeps one provisioned hire through repeated refusals and a changed quote', async () => {
    const { journal: j } = journal()
    const created = '00000000-0000-4000-8000-fbfe405ca65f'
    const createAgent = vi.fn(async () => ({ id: created }))

    for (let attempt = 0; attempt < 2; attempt++) {
      const f = controller(j, async () => ({ outcome: 'refused', code: 'insufficient_protons' }), {
        items: [hireItem],
        createAgent
      })
      await f.store.refresh()
      expect(await f.store.purchase(hireIntent)).toMatchObject({ outcome: 'refused' })
      expect(j.readReusableHires(scope.accountKey)[0]?.assistantId).toBe(created)
      f.store.activate(null)
    }

    const updated = { ...hireItem, offer: { ...hireItem.offer!, version: 3 } }

    const f = controller(
      j,
      async (_endpoint, input: any) => {
        const result = hireResult(input.idempotencyKey, created)
        result.purchase.offerVersion = 3

        return result
      },
      { items: [updated], createAgent }
    )

    await f.store.refresh()
    expect(await f.store.purchase({ ...hireIntent, offerVersion: 3 })).toMatchObject({ outcome: 'purchased' })
    expect(createAgent).toHaveBeenCalledOnce()
    f.store.activate(null)
  })
  it('coalesces a double-click monthly hire before the agent exists', async () => {
    const { journal: j } = journal()
    let finish!: (value: { id: string }) => void

    const createAgent = vi.fn(
      async () =>
        new Promise<{ id: string }>(resolve => {
          finish = resolve
        })
    )

    const { store } = controller(j, async (_endpoint, input: any) => hireResult(input.idempotencyKey, assistantId), {
      items: [hireItem],
      createAgent
    })

    await store.refresh()

    const first = store.purchase(hireIntent),
      second = store.purchase(hireIntent)

    expect(createAgent).toHaveBeenCalledTimes(1)
    finish({ id: assistantId })
    expect(await first).toEqual(await second)
    expect(j.read(scope.accountKey)).toEqual([])
    store.activate(null)
  })
  it('does not save a late provision from a previous account generation', async () => {
    const { journal: j } = journal()
    let finish!: (value: { id: string }) => void

    const createAgent = vi.fn(
      async () =>
        new Promise<{ id: string }>(resolve => {
          finish = resolve
        })
    )

    const { store } = controller(
      j,
      async () => {
        throw new Error('must not buy')
      },
      { items: [hireItem], createAgent }
    )

    await store.refresh()
    const pending = store.purchase(hireIntent)
    const key = j.read(scope.accountKey)[0]!.idempotencyKey
    store.activate({ accountKey: 'b'.repeat(64), generation: 2 })
    await store.refresh()
    finish({ id: assistantId })
    await expect(pending).rejects.toThrow('matrix_store_cancelled')
    expect(j.read(scope.accountKey)[0]?.idempotencyKey).toBe(key)
    expect(j.read(scope.accountKey)[0]?.assistantId).toBeUndefined()
    expect(store.snapshot()?.pending).toEqual([])
    store.activate(null)
  })
  it('late replies from an old account cannot clear its journal or populate the new account', async () => {
    const { journal: j } = journal()
    let finish!: (value: unknown) => void

    const { store } = controller(
      j,
      async () =>
        new Promise(resolve => {
          finish = resolve
        })
    )

    await store.refresh()
    const write = store.purchase(intent)
    const key = j.read(scope.accountKey)[0]!.idempotencyKey
    store.activate({ accountKey: 'b'.repeat(64), generation: 2 })
    await store.refresh()
    finish(result(key))
    await expect(write).rejects.toThrow('matrix_store_cancelled')
    expect(j.read(scope.accountKey)).toHaveLength(1)
    expect(store.snapshot()?.pending).toEqual([])
    store.activate(null)
  })
  it('a corrupt journal blocks mutations and retains the file for recovery', async () => {
    const { root, journal: j } = journal()
    j.write(scope.accountKey, [])
    const file = path.join(root, scope.accountKey, 'store-intents.json')
    fs.writeFileSync(file, '{broken')

    const { store, request } = controller(j, async () => {
      throw new Error('must not dispatch')
    })

    await store.refresh()
    await expect(store.purchase(intent)).rejects.toThrow('matrix_store_unavailable')
    expect(request).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
    store.activate(null)
  })
  it('journal writes are private and reject duplicate or foreign shapes', () => {
    const { root, journal: j } = journal()
    const pending = { ...intent, idempotencyKey: purchaseId, purchaseId: null }
    j.write(scope.accountKey, [pending])
    const file = path.join(root, scope.accountKey, 'store-intents.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(j.read(scope.accountKey)).toEqual([pending])
    j.write(scope.accountKey, [pending, pending])
    expect(() => j.read(scope.accountKey)).toThrow('matrix_store_journal_invalid')
    expect(() => j.write('../other', [])).toThrow('matrix_store_invalid')
  })
  it('rejects a malformed provision record instead of replaying a different agent request', () => {
    const { root, journal: j } = journal()
    const file = path.join(root, scope.accountKey, 'store-intents.json')
    j.write(scope.accountKey, [
      {
        ...hireIntent,
        idempotencyKey: purchaseId,
        purchaseId: null,
        provision: { requestId: purchaseId, name: 'Cố vấn' }
      }
    ])
    expect(j.read(scope.accountKey)[0]?.provision).toEqual({ requestId: purchaseId, name: 'Cố vấn' })
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        intents: [
          {
            ...hireIntent,
            idempotencyKey: purchaseId,
            purchaseId: null,
            provision: { requestId: assistantId, name: 'Cố vấn' }
          }
        ]
      })
    )
    expect(() => j.read(scope.accountKey)).toThrow('matrix_store_journal_invalid')
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        intents: [{ ...hireIntent, idempotencyKey: purchaseId, purchaseId: null, unexpected: true }]
      })
    )
    expect(() => j.read(scope.accountKey)).toThrow('matrix_store_journal_invalid')
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        intents: [{ ...hireIntent, consentRenewal: false, idempotencyKey: purchaseId, purchaseId: null }]
      })
    )
    expect(() => j.read(scope.accountKey)).toThrow('matrix_store_journal_invalid')
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        intents: [],
        reusableHires: [{ offerId: hireOfferId, offerVersion: 2, assistantId, unexpected: true }]
      })
    )
    expect(() => j.readReusableHires(scope.accountKey)).toThrow('matrix_store_journal_invalid')
  })
})
describe('reusable hire targets and retired assistants', () => {
  const kept = '00000000-0000-4000-8000-fbfe405ca65f'
  const fresh = '00000000-0000-4000-8000-a9703d75e616'

  /** A first hire refused for funds: its created agent is kept as the offer's reusable target. */
  async function keepHire(j: FileStoreJournal) {
    const f = controller(j, async () => ({ outcome: 'refused', code: 'insufficient_protons' }), {
      items: [hireItem],
      createAgent: async () => ({ id: kept })
    })

    await f.store.refresh()
    expect(await f.store.purchase(hireIntent)).toEqual({ outcome: 'refused', code: 'insufficient_protons' })
    f.store.activate(null)
    expect(j.readReusableHires(scope.accountKey)).toEqual([
      { offerId: hireOfferId, offerVersion: 2, assistantId: kept }
    ])
  }

  /** A later hire whose purchases are answered by `answer`, with the agent list's view of agents.
   * `charged` names the assistant of each purchase request (a status read sends none). */
  function hireAgain(
    j: FileStoreJournal,
    live: (assistantId: string) => boolean | undefined,
    answer: (input: any, endpoint: StoreResource) => unknown = input =>
      hireResult(input.idempotencyKey, input.assistantId)
  ) {
    const charged: (string | undefined)[] = []
    const createAgent = vi.fn(async () => ({ id: fresh }))
    const rosterStale = vi.fn()

    const f = controller(
      j,
      async (endpoint, input: any) => {
        if (input) {
          charged.push(input.assistantId)
        }

        return answer(input, endpoint)
      },
      { items: [hireItem], createAgent, hireTargetLive: live, rosterStale }
    )

    return { ...f, charged, createAgent, rosterStale }
  }

  it('provisions a fresh agent instead of charging a retired one kept from an earlier refusal', async () => {
    const { journal: j } = journal()
    await keepHire(j)

    const f = hireAgain(j, id => (id === kept ? false : undefined))
    await f.store.refresh()

    expect(await f.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
    expect(f.createAgent).toHaveBeenCalledOnce()
    expect(f.charged).toEqual([fresh])
    expect(j.readReusableHires(scope.accountKey)).toEqual([])
    f.store.activate(null)
  })
  it.each([true, undefined])('still reuses a half-created agent the agent list calls %s', async live => {
    const { journal: j } = journal()
    await keepHire(j)

    const f = hireAgain(j, () => live)
    await f.store.refresh()

    expect(await f.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
    expect(f.createAgent).not.toHaveBeenCalled()
    expect(f.charged).toEqual([kept])
    f.store.activate(null)
  })
  it('drops a target on a roster sync only once the agent list says its assistant is retired', async () => {
    const { journal: j } = journal()
    await keepHire(j)
    let live: boolean | undefined

    const f = hireAgain(j, () => live)
    await f.store.refresh()

    // Not synced yet: nothing is pruned on a guess.
    f.store.pruneHireTargets()
    expect(j.readReusableHires(scope.accountKey)).toHaveLength(1)

    live = false
    f.store.pruneHireTargets()
    expect(j.readReusableHires(scope.accountKey)).toEqual([])
    f.store.activate(null)
  })
  it('a journal write failure while pruning fails neither caller, and the next write carries it', async () => {
    const { journal: j } = journal()
    await keepHire(j)

    const f = hireAgain(j, () => false)
    await f.store.refresh()
    vi.spyOn(j, 'write').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => f.store.forgetHireTarget(kept)).not.toThrow()
    expect(j.readReusableHires(scope.accountKey)).toHaveLength(1)

    expect(await f.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
    expect(f.charged).toEqual([fresh])
    expect(j.readReusableHires(scope.accountKey)).toEqual([])
    f.store.activate(null)
  })
  it('never charges an agent retired on this Mac, even before the agent list shows it', async () => {
    const { journal: j } = journal()
    await keepHire(j)

    const f = hireAgain(j, () => true)
    await f.store.refresh()
    f.store.forgetHireTarget(kept)
    expect(j.readReusableHires(scope.accountKey)).toEqual([])

    expect(await f.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
    expect(f.charged).toEqual([fresh])
    f.store.activate(null)
  })
  it.each([404, 410])(
    'lets go of a reused target the Store cannot find (%i), so the next hire makes a fresh agent',
    async status => {
      const { journal: j } = journal()
      await keepHire(j)

      const gone = hireAgain(
        j,
        () => undefined,
        () => {
          throw new MatrixStoreResponseError(status)
        }
      )

      await gone.store.refresh()
      expect(await gone.store.purchase(hireIntent)).toMatchObject({ outcome: 'refused' })
      expect(gone.charged).toEqual([kept])
      expect(gone.rosterStale).toHaveBeenCalledOnce()
      expect(j.read(scope.accountKey)).toEqual([])
      expect(j.readReusableHires(scope.accountKey)).toEqual([])
      gone.store.activate(null)

      const next = hireAgain(j, () => undefined)
      await next.store.refresh()
      expect(await next.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
      expect(next.createAgent).toHaveBeenCalledOnce()
      expect(next.charged).toEqual([fresh])
      next.store.activate(null)
    }
  )
  it('keeps an unconfirmed target refused 403 (an account that may not spend gets it too) and reads the list again', async () => {
    const { journal: j } = journal()
    await keepHire(j)
    let live: boolean | undefined

    const f = hireAgain(
      j,
      () => live,
      () => {
        throw new MatrixStoreResponseError(403)
      }
    )

    await f.store.refresh()
    expect(await f.store.purchase(hireIntent)).toEqual({ outcome: 'refused', code: 'forbidden' })
    expect(f.createAgent).not.toHaveBeenCalled()
    expect(f.rosterStale).toHaveBeenCalledOnce()
    expect(j.read(scope.accountKey)).toEqual([])
    expect(j.readReusableHires(scope.accountKey)).toEqual([
      { offerId: hireOfferId, offerVersion: 2, assistantId: kept }
    ])

    // The fresh list shows the agent retired (on another Mac): its sync prunes the target.
    live = false
    f.store.pruneHireTargets()
    expect(j.readReusableHires(scope.accountKey)).toEqual([])
    f.store.activate(null)
  })
  it.each([403, 404])(
    'keeps a target the agent list says is alive when the Store refuses it with %i, and reads the list again',
    async status => {
      const { journal: j } = journal()
      await keepHire(j)

      const f = hireAgain(
        j,
        () => true,
        () => {
          throw new MatrixStoreResponseError(status)
        }
      )

      await f.store.refresh()
      expect(await f.store.purchase(hireIntent)).toMatchObject({ outcome: 'refused' })
      expect(f.rosterStale).toHaveBeenCalledOnce()
      expect(j.readReusableHires(scope.accountKey)).toEqual([
        { offerId: hireOfferId, offerVersion: 2, assistantId: kept }
      ])
      f.store.activate(null)
    }
  )
  it.each([403, 404])(
    'keeps the agent a hire just made when its purchase is refused %i before the list names it',
    async status => {
      const { journal: j } = journal()

      const first = hireAgain(
        j,
        () => undefined,
        () => {
          throw new MatrixStoreResponseError(status)
        }
      )

      await first.store.refresh()
      expect(await first.store.purchase(hireIntent)).toMatchObject({ outcome: 'refused' })
      expect(first.createAgent).toHaveBeenCalledOnce()
      expect(first.charged).toEqual([fresh])
      expect(j.readReusableHires(scope.accountKey)).toEqual([
        { offerId: hireOfferId, offerVersion: 2, assistantId: fresh }
      ])
      first.store.activate(null)

      // The next hire charges that agent: refusals never make a stream of new agents.
      const next = hireAgain(j, () => undefined)
      await next.store.refresh()
      expect(await next.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
      expect(next.createAgent).not.toHaveBeenCalled()
      expect(next.charged).toEqual([fresh])
      next.store.activate(null)
    }
  )
  it('does not keep the agent a hire just made once the list shows it retired', async () => {
    const { journal: j } = journal()

    const f = hireAgain(
      j,
      id => (id === fresh ? false : undefined),
      () => ({ outcome: 'refused', code: 'insufficient_protons' })
    )

    await f.store.refresh()
    expect(await f.store.purchase(hireIntent)).toEqual({ outcome: 'refused', code: 'insufficient_protons' })
    expect(f.charged).toEqual([fresh])
    expect(j.read(scope.accountKey)).toEqual([])
    expect(j.readReusableHires(scope.accountKey)).toEqual([])
    f.store.activate(null)
  })
  it.each([403, 404])(
    'keeps a reused target when the status read of its existing purchase is refused %i',
    async status => {
      const { journal: j } = journal()
      await keepHire(j)

      // The purchase is accepted but not yet settled, so the next attempt reads its status.
      const f = hireAgain(
        j,
        () => undefined,
        (input, endpoint) => {
          if (endpoint === 'purchases') {
            return hireResult(input.idempotencyKey, input.assistantId, 'delivery_pending')
          }

          throw new MatrixStoreResponseError(status)
        }
      )

      await f.store.refresh()
      expect(await f.store.purchase(hireIntent)).toMatchObject({ outcome: 'purchased' })
      expect(j.read(scope.accountKey)).toMatchObject([{ assistantId: kept, purchaseId: hirePurchaseId }])

      expect(await f.store.purchase(hireIntent)).toEqual({ outcome: 'uncertain' })
      expect(f.charged).toEqual([kept])
      expect(f.rosterStale).not.toHaveBeenCalled()
      expect(j.read(scope.accountKey)).toEqual([])
      expect(j.readReusableHires(scope.accountKey)).toEqual([
        { offerId: hireOfferId, offerVersion: 2, assistantId: kept }
      ])
      f.store.activate(null)
    }
  )
  it('resolves a pending purchase of a retired target before provisioning anew', async () => {
    const { journal: j } = journal()
    await keepHire(j)
    let live: boolean | undefined

    let reply: () => unknown = () => {
      throw new Error('fetch failed')
    }

    const f = hireAgain(
      j,
      () => live,
      () => reply()
    )

    await f.store.refresh()
    // The reply is lost: the purchase naming the kept agent may have been charged.
    expect(await f.store.purchase(hireIntent)).toEqual({ outcome: 'uncertain' })
    expect(j.read(scope.accountKey)).toHaveLength(1)

    live = false
    f.store.pruneHireTargets()
    expect(j.readReusableHires(scope.accountKey)).toHaveLength(1)

    // The next hire checks that purchase first; the Store refuses it, and the target goes.
    reply = () => {
      throw new MatrixStoreResponseError(403)
    }

    expect(await f.store.purchase(hireIntent)).toEqual({ outcome: 'refused', code: 'forbidden' })
    expect(f.charged).toEqual([kept, kept])
    expect(f.createAgent).not.toHaveBeenCalled()
    expect(j.readReusableHires(scope.accountKey)).toEqual([])

    reply = () => ({ outcome: 'refused', code: 'insufficient_protons' })
    await f.store.purchase(hireIntent)
    expect(f.createAgent).toHaveBeenCalledOnce()
    expect(f.charged.at(-1)).toBe(fresh)
    f.store.activate(null)
  })
})
describe('matrixScopedHireTargetLive', () => {
  const read = { scope, roster: [{ id: assistantId, status: 'retired' as const }] }

  it('answers from the roster read for the signed-in account and generation, and unknown otherwise', () => {
    expect(matrixScopedHireTargetLive(read, scope, assistantId)).toBe(false)
    expect(matrixScopedHireTargetLive(read, { ...scope, generation: 2 }, assistantId)).toBeUndefined()
    expect(matrixScopedHireTargetLive(read, { ...scope, accountKey: 'b'.repeat(64) }, assistantId)).toBeUndefined()
    expect(matrixScopedHireTargetLive(read, null, assistantId)).toBeUndefined()
    expect(matrixScopedHireTargetLive(undefined, scope, assistantId)).toBeUndefined()
  })
})
describe('matrixHireTargetLive', () => {
  const roster = [
    { id: assistantId, status: 'active' as const },
    { id: offerId, status: 'retired' as const }
  ]

  it('is alive while listed active, gone once tombstoned, and unknown otherwise', () => {
    expect(matrixHireTargetLive(roster, assistantId)).toBe(true)
    expect(matrixHireTargetLive(roster, offerId)).toBe(false)
    expect(matrixHireTargetLive(roster, purchaseId)).toBeUndefined()
    expect(matrixHireTargetLive(undefined, assistantId)).toBeUndefined()
  })
})
describe('free official Hub skills in the native Store', () => {
  const listings = (
    JSON.parse(fs.readFileSync(new URL('./__fixtures__/store-hub-listings.json', import.meta.url), 'utf8')) as {
      items: { itemId: string; install: { id: string } }[]
    }
  ).items

  it('lists every published Hub skill beside paid items and leaves out a row it cannot install', async () => {
    const { journal: j } = journal()

    const unusable = {
      ...listings[0],
      itemId: 'skill/official/x/y',
      install: { source: 'clawhub', id: 'official/x/y' }
    }

    const { store, request } = controller(j, vi.fn(), { items: [item, ...listings, unusable] })
    await store.refresh()

    const snapshot = store.snapshot()!
    expect(snapshot.state).toBe('ready')
    expect(snapshot.items.map(value => value.itemId)).toEqual([item.itemId, ...listings.map(value => value.itemId)])
    expect(snapshot.items.slice(1).every(value => value.offer === null && value.install)).toBe(true)
    // A Hub skill is free and has no offer: nothing can be bought, journaled or sent for it.
    expect(() => store.preparePurchase({ offerId: assistantId, offerVersion: 1, assistantId })).toThrow(
      'matrix_store_invalid'
    )
    expect(j.read(scope.accountKey)).toEqual([])
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual(['catalog', 'entitlements', 'purchases'])
  })
})

describe('Store public wire boundary', () => {
  it('retains exact fractional Protons and projects away protected/provider fields', () => {
    expect(
      storeItem({ ...item, privateInstructions: 'PRIVATE_CANARY', metadata: { secret: 'PRIVATE_CANARY' } })
    ).toEqual(item)
    expect(storeResult(result(purchaseId))).toEqual(result(purchaseId))
    expect(() => storeItem({ ...item, offer: { ...offer, priceMicroProtons: 2 ** 54 } })).toThrow()
    expect(() => storeItem({ ...item, offer: undefined })).toThrow()
    expect(() => storeResult({ ...result(purchaseId), entitlement: { ...entitlement, assistantId: null } })).toThrow()
  })
  it('calls only fixed Store paths with native bearer and persistent key on real HTTP', async () => {
    const seen: any[] = []

    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => {
        body += chunk
      })
      request.on('end', () => {
        seen.push({
          path: request.url,
          method: request.method,
          bearer: request.headers.authorization,
          key: request.headers['idempotency-key'],
          origin: request.headers.origin,
          version: request.headers['x-atum-desktop-version'],
          capabilities: request.headers['atum-store-capabilities'],
          body
        })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(result(purchaseId)))
      })
    })

    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/matrix/v1`
    const body = { ...intent, idempotencyKey: purchaseId }
    await requestMatrixStore(origin, 'test-native-token', 'purchases', AbortSignal.timeout(5000), body, '0.18.3')
    await requestMatrixStore(
      origin,
      'test-native-token',
      `topups/${purchaseId}`,
      AbortSignal.timeout(5000),
      undefined,
      '0.18.3'
    )
    // No usable version: the header is left out (the Shell answers as for an older desktop).
    await requestMatrixStore(origin, 'test-native-token', 'catalog', AbortSignal.timeout(5000), undefined, 'dev\r\n')
    expect(seen).toEqual([
      {
        path: '/api/matrix/v1/store/purchases',
        method: 'POST',
        bearer: 'Bearer test-native-token',
        key: purchaseId,
        origin: undefined,
        version: '0.18.3',
        capabilities: STORE_CAPABILITIES,
        body: JSON.stringify(body)
      },
      {
        path: `/api/matrix/v1/store/topups/${purchaseId}`,
        method: 'GET',
        bearer: 'Bearer test-native-token',
        key: undefined,
        origin: undefined,
        version: '0.18.3',
        capabilities: STORE_CAPABILITIES,
        body: ''
      },
      {
        path: '/api/matrix/v1/store/catalog',
        method: 'GET',
        bearer: 'Bearer test-native-token',
        key: undefined,
        origin: undefined,
        version: undefined,
        capabilities: STORE_CAPABILITIES,
        body: ''
      }
    ])
    await expect(
      requestMatrixStore(origin, 'token', '../wallet' as StoreResource, AbortSignal.timeout(5000))
    ).rejects.toThrow()
    await expect(
      requestMatrixStore(origin, 'token', 'topups/not-a-uuid' as StoreResource, AbortSignal.timeout(5000))
    ).rejects.toThrow()
    expect(seen).toHaveLength(3)
    // Every fixed read and mutation endpoint receives the same negotiated capability.
    const resources: StoreResource[] = [
      'entitlements',
      'purchases',
      'tasks',
      'topups',
      `purchases/${purchaseId}`,
      `entitlements/${entitlementId}/cancel`
    ]
    for (const endpoint of resources) {
      const cancel = endpoint.endsWith('/cancel')
      await requestMatrixStore(
        origin,
        'test-native-token',
        endpoint,
        AbortSignal.timeout(5000),
        cancel ? {} : undefined,
        '0.18.3'
      )
      expect(seen.at(-1)).toMatchObject({
        path: `/api/matrix/v1/store/${endpoint}`,
        method: cancel ? 'POST' : 'GET',
        bearer: 'Bearer test-native-token',
        capabilities: STORE_CAPABILITIES,
        version: '0.18.3'
      })
    }
  })
  it.each([400, 403, 404, 409, 410, 422, 429] as const)(
    'preserves a definite Store HTTP %i status for the controller',
    async status => {
      const server = createServer((_request, response) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: `matrix_${status}` }))
      })

      servers.push(server)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/matrix/v1`
      await expect(
        requestMatrixStore(origin, 'test-native-token', 'purchases', AbortSignal.timeout(5000), {
          ...intent,
          idempotencyKey: purchaseId
        })
      ).rejects.toMatchObject({ status })
    }
  )
})

describe('Store HTTP statuses that prove nothing', () => {
  it.each([
    [401, 'matrix_store_authentication'],
    [408, 'matrix_store_unavailable'],
    [500, 'matrix_store_unavailable'],
    [502, 'matrix_store_unavailable'],
    [503, 'matrix_store_unavailable']
  ] as const)('reads HTTP %i as %s, never as a definite refusal', async (status, message) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: `matrix_${status}` }))
    })

    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/matrix/v1`

    const error = await requestMatrixStore(origin, 'test-native-token', 'purchases', AbortSignal.timeout(5000), {
      ...intent,
      idempotencyKey: purchaseId
    }).catch((value: unknown) => value)

    expect(error).not.toBeInstanceOf(MatrixStoreResponseError)
    expect((error as Error).message).toBe(message)
  })
})

describe('Store purchase diagnostics', () => {
  function logged(
    mutate: (endpoint: StoreResource, input?: unknown) => Promise<unknown>,
    options: { items?: unknown[]; hireReady?: (itemId: string) => Promise<boolean>; log?: (line: string) => void } = {}
  ) {
    const { journal: j } = journal()
    const log = vi.fn<(line: string) => void>(options.log)

    const store = new MatrixStoreController({
      journal: j,
      request: async (endpoint, _signal, input) =>
        endpoint === 'catalog'
          ? { items: options.items ?? [item] }
          : endpoint === 'entitlements'
            ? { entitlements: [] }
            : endpoint === 'purchases' && input === undefined
              ? { purchases: [] }
              : mutate(endpoint, input),
      changed: vi.fn(),
      walletChanged: vi.fn(),
      log,
      ...(options.hireReady ? { hireReady: options.hireReady } : {})
    })

    store.activate(scope)

    return { store, log, journal: j }
  }

  const purchaseLines = (log: ReturnType<typeof vi.fn>) =>
    log.mock.calls.map(([line]) => line as string).filter(line => line.startsWith('[Matrix] store purchase'))

  it.each([
    [
      'a completed purchase',
      async (_e: StoreResource, input: any) => result(input.idempotencyKey),
      'ok code=completed'
    ],
    [
      'a purchase still being delivered',
      async (_e: StoreResource, input: any) => result(input.idempotencyKey, 'delivery_pending'),
      'ok code=delivery_pending'
    ],
    [
      'a Store refusal',
      async () => ({ outcome: 'refused', code: 'insufficient_protons' }),
      'refused code=insufficient_protons'
    ],
    [
      'an HTTP 400',
      async () => {
        throw new MatrixStoreResponseError(400)
      },
      'refused code=invalid_request'
    ],
    [
      'a 5xx',
      async () => {
        throw new Error('matrix_store_unavailable')
      },
      'uncertain code=unavailable'
    ],
    [
      'a timeout',
      async () => {
        throw new DOMException('timed out', 'TimeoutError')
      },
      'uncertain code=timeout'
    ],
    [
      'a dropped connection',
      async () => {
        throw new TypeError('fetch failed')
      },
      'uncertain code=network'
    ]
  ])('writes one closed line for %s', async (_label, mutate, words) => {
    const { store, log } = logged(mutate)
    await store.refresh()
    await store.purchase(intent)

    expect(purchaseLines(log)).toEqual([`[Matrix] store purchase kind=skill outcome=${words}`])
    store.activate(null)
  })

  it('writes every attempt, even one identical to the last, and nothing that names the purchase', async () => {
    const { store, log } = logged(async () => {
      throw new MatrixStoreResponseError(400)
    })

    await store.refresh()
    await store.purchase(intent)
    await store.purchase(intent)

    expect(purchaseLines(log)).toEqual([
      '[Matrix] store purchase kind=skill outcome=refused code=invalid_request',
      '[Matrix] store purchase kind=skill outcome=refused code=invalid_request'
    ])
    // No title, price, offer, purchase, assistant or request identifier.
    expect(log.mock.calls.flat().join(' ')).not.toMatch(
      /Kỹ năng|Skill\b|19000|aaaaaaaa|bbbbbbbb|cccccccc|[0-9a-f]{8}-/u
    )
    store.activate(null)
  })

  it('names a hire this Mac cannot deliver as a refused agent', async () => {
    const coach = { ...hireItem, itemId: 'agent/english-coach' }
    const { store, log } = logged(async () => ({}), { items: [coach], hireReady: async () => false })
    await store.refresh()

    await expect(store.purchase(hireIntent)).resolves.toEqual({ outcome: 'refused', code: 'feature_unavailable' })
    expect(purchaseLines(log)).toEqual(['[Matrix] store purchase kind=agent outcome=refused code=feature_unavailable'])
    store.activate(null)
  })

  it('says unknown for a journaled purchase checked before its catalog loaded', async () => {
    const { journal: j } = journal()
    const key = '00000000-0000-4000-8000-7d338194c358'
    j.write(scope.accountKey, [{ ...intent, idempotencyKey: key, purchaseId: null }])
    const log = vi.fn<(line: string) => void>()

    const store = new MatrixStoreController({
      journal: j,
      request: async (endpoint, _signal, input) => {
        if (input === undefined) {
          throw new Error('matrix_store_unavailable')
        }

        return result(key)
      },
      changed: vi.fn(),
      walletChanged: vi.fn(),
      log
    })

    store.activate(scope)
    await store.refresh()
    await store.resume(key)

    expect(purchaseLines(log)).toEqual(['[Matrix] store purchase kind=unknown outcome=ok code=completed'])
    store.activate(null)
  })

  it('lands in main.log through the tagged console mirror', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-store-log-'))
    roots.push(directory)
    const target = { warn: vi.fn(), error: vi.fn() }
    mirrorTaggedConsole(directory, target, () => new Date('2026-10-10T05:00:00Z'))

    const { store } = logged(
      async () => {
        throw new MatrixStoreResponseError(400)
      },
      { log: line => target.warn(line) }
    )

    await store.refresh()
    await store.purchase(intent)

    expect(fs.readFileSync(path.join(directory, 'main.log'), 'utf8')).toContain(
      '2026-10-10T05:00:00.000Z warn [Matrix] store purchase kind=skill outcome=refused code=invalid_request\n'
    )
    store.activate(null)
  })
})

describe('Store read diagnostics', () => {
  // The four launch assistants as the Shell serves them (docs/shelf/agents, prices from
  // prepare-store-publication.py): what decides the Assistants shelf on the installed app.
  const agentListings = JSON.parse(
    fs.readFileSync(new URL('./__fixtures__/store-agent-listings.json', import.meta.url), 'utf8')
  ) as { items: unknown[] }

  function logged(read: (endpoint: StoreResource) => Promise<unknown>) {
    const { journal: j } = journal()
    const log = vi.fn<(line: string) => void>()

    const store = new MatrixStoreController({
      journal: j,
      request: async endpoint => read(endpoint),
      changed: vi.fn(),
      walletChanged: vi.fn(),
      log
    })

    return { store, log }
  }

  const ok = (items: unknown[]) => async (endpoint: StoreResource) =>
    endpoint === 'catalog' ? { items } : endpoint === 'entitlements' ? { entitlements: [] } : { purchases: [] }

  it('logs what the catalog holds per kind, counts only, and only when the outcome changes', async () => {
    const { store, log } = logged(ok([item, ...agentListings.items]))
    store.activate(scope)
    await store.refresh()
    await store.refresh()

    expect(log.mock.calls).toEqual([
      ['[Matrix] store read outcome=ready agents=4 agents_offered=4 skills=1 skills_offered=1 pets=0 pets_offered=0']
    ])
    // No title, price or offer identifier reaches the log.
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/Researcher|Nhà nghiên cứu|39000|00000000-/u)
    store.activate(null)
  })

  it('names an empty Assistants shelf as zero agents rather than hiding it', async () => {
    const { store, log } = logged(ok([item]))
    store.activate(scope)
    await store.refresh()

    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('agents=0 agents_offered=0'))
    store.activate(null)
  })

  it.each([
    [new Error('matrix_store_authentication'), 'auth'],
    [new MatrixStoreResponseError(403), 'forbidden'],
    [new MatrixStoreResponseError(404), 'not_found'],
    [new MatrixStoreResponseError(409), 'conflict'],
    [new MatrixStoreResponseError(400), 'rejected'],
    [new Error('matrix_store_invalid'), 'invalid'],
    [new DOMException('timed out', 'TimeoutError'), 'timeout'],
    [new Error('matrix_store_unavailable'), 'unavailable'],
    [new Error('socket hang up at https://shell.example/store/catalog'), 'other']
  ])('logs a failed first read as unavailable with a closed reason (%s)', async (error, reason) => {
    const { store, log } = logged(async () => {
      throw error
    })

    store.activate(scope)
    await store.refresh()

    expect(store.snapshot()?.state).toBe('unavailable')
    expect(log).toHaveBeenLastCalledWith(`[Matrix] store read outcome=failed state=unavailable reason=${reason}`)
    store.activate(null)
  })

  it('logs a failed refresh after a good read as stale', async () => {
    let fail = false

    const { store, log } = logged(async endpoint => {
      if (fail) {
        throw new Error('matrix_store_unavailable')
      }

      return ok([item])(endpoint)
    })

    store.activate(scope)
    await store.refresh()
    fail = true
    await store.refresh()

    expect(log).toHaveBeenLastCalledWith('[Matrix] store read outcome=failed state=stale reason=unavailable')
    store.activate(null)
  })
})


it('owns a 15-minute safety refresh and bypasses it for explicit invalidation', async () => {
  vi.useFakeTimers()
  try {
    const { store, request } = controller(journal().journal, async () => ({}))
    await store.refresh()
    expect(request).toHaveBeenCalledTimes(3)
    for (let minute = 0; minute < 14; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      await store.refresh(true)
    }
    expect(request).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    await store.refresh(true)
    expect(request).toHaveBeenCalledTimes(6)
    await store.refresh() // focus/purchase/manual invalidation
    expect(request).toHaveBeenCalledTimes(9)
    store.activate({ ...scope, generation: scope.generation + 1 })
    await store.refresh(true)
    expect(request).toHaveBeenCalledTimes(12)
  } finally { vi.useRealTimers() }
})
