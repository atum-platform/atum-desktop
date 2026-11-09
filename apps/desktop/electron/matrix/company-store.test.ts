import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  companyStoreFundPrefill,
  companyStoreMentionAgents,
  CompanyStorePurchaseRequestSchema
} from '../../shared/matrix-company-store'
import type { MatrixCompanyStoreIntent, MatrixCompanyStorePurchaseRequest } from '../../shared/matrix-company-store'

import { FileCompanyStoreJournal, MatrixCompanyStoreController, requestMatrixCompanyStore } from './company-store'
import { MatrixCompanyStoreBridgeController } from './company-store-bridge'
import { MatrixStoreController } from './store'

const companyId = '00000000-0000-4000-8000-bd7662a5eeb4'
const agentId = '00000000-0000-4000-8000-b454f82c5857'
const offerId = '00000000-0000-4000-8000-f6222a1106ee'
const purchaseId = '00000000-0000-4000-8000-f1d11edf5c5c'
const entitlementId = '00000000-0000-4000-8000-fbfe405ca65f'
const scope = { accountKey: 'a'.repeat(64), generation: 1 }
const at = '2026-11-07T00:00:00Z'
const intent: MatrixCompanyStoreIntent = { offerId, offerVersion: 1, target: { hire: {} }, consentRenewal: true }

const item = {
  itemId: 'agent/researcher',
  kind: 'agent',
  title: { vi: 'Researcher', en: 'Researcher' },
  summary: { vi: 'Research', en: 'Research' },
  description: { vi: 'Research', en: 'Research' },
  tryPrompt: { vi: 'Research', en: 'Research' },
  needs: [],
  glyph: 'R',
  accent: '#123456',
  featured: true,
  sortOrder: 0,
  deliverable: true,
  ownership: { state: 'available', source: null, assistantIds: [], until: null },
  offer: {
    id: offerId,
    version: 1,
    priceMicroProtons: 8_000_000_000,
    renewalPriceMicroProtons: 39_000_000_000,
    scope: 'agent',
    billingInterval: 'month',
    delivery: 'cloud'
  }
}

const entitlement = {
  id: entitlementId,
  itemId: item.itemId,
  kind: 'agent',
  state: 'active',
  assistantId: agentId,
  delivery: 'cloud',
  grantedAt: at,
  source: 'purchase',
  subscription: { state: 'active', renewAt: '2026-12-07T00:00:00Z', priceMicroProtons: 39_000_000_000, offerVersion: 1 }
}

const agent = {
  agentId,
  matrixUserId: '@researcher:example.test',
  name: 'Researcher',
  avatar: null,
  itemId: item.itemId,
  state: 'ready',
  renewAt: '2026-12-07T00:00:00Z'
}

const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** Real engine + real transport/validators/journal, with only the Shell boundary replaced. */
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-store-'))
  roots.push(root)
  const journal = new FileCompanyStoreJournal(root)

  const state = {
    canAct: true,
    supported: true,
    header: '1',
    profile: 'atum.company-store/1',
    deliverable: true,
    failCatalog: false,
    loseNextReply: false,
    failStatus: false,
    mismatch: false,
    holdReply: false,
    postStatus: 200,
    outcome: 'purchased',
    purchaseState: 'completed',
    subscriptionState: 'active',
    submissions: [] as MatrixCompanyStorePurchaseRequest[],
    orders: new Map<string, unknown>(),
    charges: 0,
    paths: [] as string[],
    release: undefined as (() => void) | undefined
  }

  const fetcher = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(value))
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Atum-Company-Store')).toBe('1')
    expect(headers.get('Authorization')).toBe('Bearer native-token')
    expect(init?.redirect).toBe('error')
    expect(headers.get('X-Atum-Desktop-Version')).toBeTruthy()
    const prefix = `/api/matrix/v1/companies/${companyId}/`
    // Any personal Store request or createAgent/provision route fails the actual engine path.
    expect(url.pathname.startsWith(prefix)).toBe(true)
    const route = url.pathname.slice(prefix.length)
    state.paths.push(route)

    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'X-Atum-Company-Store': state.header }
      })

    if (route === 'store/catalog') {
      if (!state.supported) {
        return reply({ error: 'matrix_404' }, 404)
      }

      if (state.failCatalog) {
        return reply({ error: 'matrix_503' }, 503)
      }

      return reply({
        profile: state.profile,
        viewer: { canAct: state.canAct },
        items: [{ ...item, deliverable: state.deliverable }]
      })
    }

    if (route === 'agents') {
      return reply({ agents: [agent] })
    }

    if (route === 'store/entitlements') {
      return reply({
        entitlements: state.charges
          ? [{ ...entitlement, subscription: { ...entitlement.subscription, state: state.subscriptionState } }]
          : []
      })
    }

    if (route === `store/entitlements/${entitlementId}/cancel`) {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('{}')
      state.subscriptionState = 'cancelled'

      return reply({ ...entitlement, subscription: { ...entitlement.subscription, state: 'cancelled' } })
    }

    if (route === `store/purchases/${purchaseId}`) {
      expect(init?.method).toBe('GET')

      if (state.failStatus) {
        return reply({ error: 'matrix_404' }, 404)
      }

      const request = state.submissions.at(-1)!
      const cached = state.orders.get(request.idempotencyKey) as { purchase: object }

      return reply({ ...cached, purchase: { ...cached.purchase, state: 'completed' }, entitlement })
    }

    expect(route).toBe('store/purchases')
    expect(init?.method).toBe('POST')
    const body = CompanyStorePurchaseRequestSchema.parse(JSON.parse(String(init?.body)))
    expect(headers.get('Idempotency-Key')).toBe(body.idempotencyKey)
    expect(journal.read(scope.accountKey, companyId).some(row => row.idempotencyKey === body.idempotencyKey)).toBe(true)
    state.submissions.push(body)

    if (state.postStatus !== 200) {
      return reply({ error: `matrix_${state.postStatus}` }, state.postStatus)
    }

    let result = state.orders.get(body.idempotencyKey)

    if (!result) {
      result =
        state.outcome === 'insufficient'
          ? { outcome: 'refused', code: 'insufficient_protons', agentId, shortfallMicroProtons: 12_345_678_901 }
          : {
              outcome: 'purchased',
              agentId,
              purchase: {
                id: purchaseId,
                itemId: item.itemId,
                offerId,
                offerVersion: 1,
                idempotencyKey: body.idempotencyKey,
                assistantId: state.mismatch ? companyId : agentId,
                state: state.purchaseState,
                amountMicroProtons: item.offer.priceMicroProtons,
                createdAt: at
              },
              entitlement: state.purchaseState === 'delivery_pending' ? null : entitlement
            }
      state.orders.set(body.idempotencyKey, result)

      if (state.outcome !== 'insufficient') {
        state.charges++
      }
    }

    if (state.holdReply) {
      await new Promise<void>(resolve => {
        state.release = resolve
      })
    }

    if (state.loseNextReply) {
      state.loseNextReply = false
      throw new Error('lost_reply')
    }

    return reply(result)
  })

  vi.stubGlobal('fetch', fetcher)

  const request = (endpoint: Parameters<typeof requestMatrixCompanyStore>[3], signal: AbortSignal, input?: unknown) =>
    requestMatrixCompanyStore(
      'https://shell.example.test/api/matrix/v1',
      'native-token',
      companyId,
      endpoint,
      signal,
      input,
      '0.20.42'
    )

  function controller() {
    const engine = new MatrixCompanyStoreController(companyId, { journal, request })
    engine.activate(scope)

    return engine
  }

  return { state, journal, controller, request, fetcher }
}

describe('company Store bridge through a fake Shell', () => {
  it.each(['owner', 'admin'])(
    '%s hires through company routes, with no personal purchase or provisioning',
    async () => {
      const personal = vi.spyOn(MatrixStoreController.prototype, 'purchase')

      const h = harness(),
        engine = h.controller()

      expect(await engine.refresh()).toMatchObject({
        capability: 'supported',
        marketplaceAvailable: true,
        viewer: { canAct: true },
        agents: [agent]
      })
      const result = await engine.purchase(intent)
      expect(result).toMatchObject({ outcome: 'purchased', agentId, purchase: { assistantId: agentId } })
      expect(h.state.submissions[0]).toMatchObject(intent)
      expect(engine.snapshot().pending).toEqual([])
      expect(h.journal.read(scope.accountKey, companyId)).toEqual([])
      expect(h.state.charges).toBe(1)
      expect(personal).not.toHaveBeenCalled()
      expect(companyStoreMentionAgents(engine.snapshot().agents)).toEqual([agent])
      expect(companyStoreMentionAgents([{ ...agent, matrixUserId: null, state: 'preparing' }])).toEqual([])
    }
  )

  it('lets members browse prices/roster but refuses writes locally with denied, without balances', async () => {
    const h = harness()
    h.state.canAct = false

    const engine = h.controller(),
      snapshot = await engine.refresh()

    expect(snapshot.items[0]?.offer?.priceMicroProtons).toBe(item.offer.priceMicroProtons)
    expect(snapshot.agents).toEqual([agent])
    expect(snapshot).not.toHaveProperty('wallet')
    expect(snapshot.viewer).toEqual({ canAct: false })
    expect(await engine.purchase(intent)).toEqual({ outcome: 'refused', code: 'denied' })
    await expect(engine.cancel(entitlementId)).rejects.toThrow('company_store_denied')
    expect(h.state.submissions).toEqual([])
  })

  it('returns exact insufficient funding prefill and no charge', async () => {
    const h = harness()
    h.state.outcome = 'insufficient'
    const engine = h.controller()
    await engine.refresh()
    const result = await engine.purchase(intent)
    expect(companyStoreFundPrefill(companyId, result)).toEqual({ companyId, shortfallMicroProtons: 12_345_678_901 })
    expect(companyStoreFundPrefill(companyId, { outcome: 'uncertain' })).toBeNull()
    expect(engine.snapshot().pending).toEqual([])
    expect(h.state.charges).toBe(0)
  })

  it('restarts after a lost reply and replays the durable key, charging only once', async () => {
    const h = harness()
    h.state.loseNextReply = true
    const first = h.controller()
    await first.refresh()
    expect(await first.purchase(intent)).toEqual({ outcome: 'uncertain' })
    const key = first.snapshot().pending[0]!.idempotencyKey
    first.activate(null)
    const restarted = h.controller()
    await restarted.refresh()
    expect(await restarted.purchase(intent)).toMatchObject({ outcome: 'purchased' })
    expect(h.state.submissions.map(row => row.idempotencyKey)).toEqual([key, key])
    expect(h.state.charges).toBe(1)
    expect(restarted.snapshot().pending).toEqual([])
  })

  it('coalesces simultaneous clicks/resumes into one dispatch', async () => {
    const h = harness()
    h.state.holdReply = true
    const engine = h.controller()
    await engine.refresh()

    const first = engine.purchase(intent),
      second = engine.purchase(intent)

    await vi.waitFor(() => expect(h.state.release).toBeTypeOf('function'))
    const key = engine.snapshot().pending[0]!.idempotencyKey
    const resumed = engine.resume(key)
    h.state.release!()
    const results = await Promise.all([first, second, resumed])
    expect(results.every(result => result.outcome === 'purchased')).toBe(true)
    expect(h.state.submissions).toHaveLength(1)
    expect(h.state.charges).toBe(1)
  })

  it('recovers a known purchase by ID and retains it across a failed status read', async () => {
    const h = harness()
    h.state.purchaseState = 'delivery_pending'
    const engine = h.controller()
    await engine.refresh()
    expect(await engine.purchase(intent)).toMatchObject({ outcome: 'purchased', entitlement: null })
    const pending = engine.snapshot().pending[0]!
    expect(pending.purchaseId).toBe(purchaseId)
    h.state.failStatus = true
    expect(await engine.resume(pending.idempotencyKey)).toEqual({ outcome: 'uncertain' })
    expect(engine.snapshot().pending).toEqual([pending])
    h.state.failStatus = false
    expect(await engine.resume(pending.idempotencyKey)).toMatchObject({ outcome: 'purchased' })
    expect(h.state.submissions).toHaveLength(1)
    expect(h.state.charges).toBe(1)
    expect(engine.snapshot().pending).toEqual([])
  })

  it('keeps an uncertain key when authority changes, so a later retry cannot double-charge', async () => {
    const h = harness()
    h.state.loseNextReply = true
    const engine = h.controller()
    await engine.refresh()
    await engine.purchase(intent)
    const key = engine.snapshot().pending[0]!.idempotencyKey
    h.state.postStatus = 403
    expect(await engine.resume(key)).toEqual({ outcome: 'refused', code: 'denied' })
    expect(engine.snapshot().pending[0]?.idempotencyKey).toBe(key)
    h.state.postStatus = 200
    expect(await engine.resume(key)).toMatchObject({ outcome: 'purchased' })
    expect(h.state.charges).toBe(1)
  })

  it('cancels a subscription and renews a lapsed hire targeting the same agent with a fresh key', async () => {
    const h = harness(),
      engine = h.controller()

    await engine.refresh()
    await engine.purchase(intent)
    await engine.cancel(entitlementId)
    expect(engine.snapshot().entitlements[0]?.subscription?.state).toBe('cancelled')
    h.state.subscriptionState = 'lapsed'
    await engine.refresh()
    expect(engine.snapshot().entitlements[0]?.subscription?.state).toBe('lapsed')
    expect(await engine.purchase({ ...intent, target: { agentId } })).toMatchObject({ outcome: 'purchased', agentId })
    expect(h.state.submissions[1]?.target).toEqual({ agentId })
    expect(h.state.submissions[1]?.idempotencyKey).not.toBe(h.state.submissions[0]?.idempotencyKey)
  })

  it('filters undeliverable items and never dispatches their purchase', async () => {
    const h = harness()
    h.state.deliverable = false
    const engine = h.controller()
    expect(await engine.refresh()).toMatchObject({ capability: 'supported', items: [], marketplaceAvailable: false })
    expect(await engine.purchase(intent)).toEqual({ outcome: 'refused', code: 'offer_unavailable' })
    expect(h.state.submissions).toEqual([])
  })

  it('negotiates capability absence as no tab, and distinguishes transient failure', async () => {
    const h = harness()
    h.state.supported = false
    const engine = h.controller()
    expect(await engine.refresh()).toMatchObject({ capability: 'absent', marketplaceAvailable: false, state: 'ready' })
    expect(h.state.paths).toEqual(['store/catalog'])
    h.state.supported = true
    h.state.failCatalog = true
    expect(await engine.refresh()).toMatchObject({ capability: 'absent', marketplaceAvailable: false, state: 'stale' })
    h.state.failCatalog = false
    expect(await engine.refresh()).toMatchObject({ capability: 'supported', marketplaceAvailable: true })
  })

  it.each(['header', 'profile'])('rejects a malformed capability %s', async field => {
    const h = harness()
    h.state[field as 'header' | 'profile'] = 'wrong'
    expect(await h.controller().refresh()).toMatchObject({
      capability: 'unknown',
      marketplaceAvailable: false,
      state: 'unavailable'
    })
  })

  it('rejects mismatched paid receipts without dropping the recovery key', async () => {
    const h = harness()
    h.state.mismatch = true
    const engine = h.controller()
    await engine.refresh()
    expect(await engine.purchase(intent)).toEqual({ outcome: 'uncertain' })
    expect(engine.snapshot().pending).toHaveLength(1)
  })

  it('fences late results after account switch and preserves the outgoing journal', async () => {
    const h = harness()
    h.state.holdReply = true
    const engine = h.controller()
    await engine.refresh()
    const work = engine.purchase(intent)
    // Attach the rejection handler before releasing the old-account response.
    const rejected = expect(work).rejects.toThrow('company_store_cancelled')
    await vi.waitFor(() => expect(h.state.release).toBeTypeOf('function'))
    engine.activate({ accountKey: 'b'.repeat(64), generation: 2 })
    h.state.release!()
    await rejected
    expect(engine.snapshot().pending).toEqual([])
    expect(engine.snapshot().agents).toEqual([])
    expect(h.journal.read(scope.accountKey, companyId)).toHaveLength(1)
  })

  it('exposes only closed bridge commands and isolates company/account journals', async () => {
    const h = harness()

    const bridge = new MatrixCompanyStoreBridgeController({
      journal: h.journal,
      request: (company, endpoint, signal, body) => {
        expect(company).toBe(companyId)

        return h.request(endpoint, signal, body)
      }
    })

    bridge.activate(scope)
    await expect(
      bridge.request({ action: 'purchase', companyId, input: { ...intent, principal: companyId } })
    ).rejects.toThrow()
    await expect(bridge.request({ action: 'refresh', companyId, url: 'https://other.test' })).rejects.toThrow()
    await bridge.request({ action: 'refresh', companyId })
    expect(await bridge.request({ action: 'purchase', companyId, input: intent })).toMatchObject({
      outcome: 'purchased'
    })
    bridge.activate(null)
    await expect(bridge.request({ action: 'refresh', companyId })).rejects.toThrow('company_store_unavailable')
    expect(h.journal.read(scope.accountKey, agentId)).toEqual([])
    expect(h.journal.read('b'.repeat(64), companyId)).toEqual([])
  })

  it('fails closed on a corrupt recovery journal before any request', async () => {
    const h = harness()
    h.journal.write(scope.accountKey, companyId, [])
    const dir = roots.at(-1)!
    fs.writeFileSync(path.join(dir, scope.accountKey, `${companyId}.json`), '[{"payer":"personal"}]')
    const engine = h.controller()
    expect(await engine.refresh()).toMatchObject({ state: 'unavailable' })
    expect(await engine.purchase(intent)).toEqual({ outcome: 'uncertain' })
    expect(h.fetcher).not.toHaveBeenCalled()
  })
})
