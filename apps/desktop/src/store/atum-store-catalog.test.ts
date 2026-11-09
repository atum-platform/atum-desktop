import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumStoreCatalogWire } from '@/lib/atum-store-items'

/**
 * The renderer's catalog cache: the same state machine and account fence
 * `$atumAppCatalog` has, over the store bridge main exposes.
 */

const $scope = atom<null | string>(null)

// Spread the real module and pin only the account scope: a hand-picked partial
// mock breaks each time the store chain reaches one more export.
vi.mock('./atum-messaging', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  $atumAccountScopeId: $scope
}))

const {
  $atumStoreCatalog,
  clearAtumStoreCatalog,
  refreshAtumStoreCatalog
} = await import('./atum-store-catalog')

const CATALOG: AtumStoreCatalogWire = {
  available_protons: 1200,
  entitlements: [{ assistant_id: '00000000-0000-4000-8000-7cac378a5787', assistant_identity_id: '00000000-0000-4000-8000-d3b5d0600970', granted_at: '2026-09-10T00:00:00Z', id: 'concept-diagrams', kind: 'skill', state: 'active' }],
  items: [
    {
      accent: 'var(--atum-sunk)',
      detail: { description: { vi: 'Vẽ sơ đồ' }, needs: [], try_prompt: { vi: 'Vẽ' } },
      featured: true,
      glyph: '🔷',
      hashes: [],
      id: 'concept-diagrams',
      kind: 'skill',
      offer: { id: '00000000-0000-4000-8000-11e594f48195', price_protons: 0, version: 1 },
      sort_order: 1,
      source: { identifier: 'official/creative/concept-diagrams', type: 'hermes_optional' },
      summary: { vi: 'Sơ đồ' },
      title: { vi: 'Sơ đồ giải thích' }
    }
  ]
}

const bridge = {
  catalog: vi.fn(),
  purchase: vi.fn(),
  purchaseStatus: vi.fn(),
  refresh: vi.fn()
}

function installBridge() {
  ;(globalThis as { hermesDesktop?: unknown }).hermesDesktop = { store: bridge }
}

beforeEach(() => {
  installBridge()
  bridge.catalog.mockReset().mockResolvedValue(CATALOG)
  bridge.refresh.mockReset().mockResolvedValue(CATALOG)
  $scope.set(null)
  clearAtumStoreCatalog()
})

afterEach(() => {
  delete (globalThis as { hermesDesktop?: unknown }).hermesDesktop
})

describe('$atumStoreCatalog', () => {
  it('stays idle with no account scope and never calls main', async () => {
    await expect(refreshAtumStoreCatalog()).resolves.toBeNull()

    expect($atumStoreCatalog.get()).toEqual({ accountId: null, catalog: null, state: 'idle' })
    expect(bridge.catalog).not.toHaveBeenCalled()
  })

  it('loads through the bridge into ready', async () => {
    $scope.set('account-a')
    // The scope arriving already asks for the catalog (see the test below);
    // this one is about what an explicit read does.
    await Promise.resolve()
    bridge.catalog.mockClear()

    await expect(refreshAtumStoreCatalog()).resolves.toEqual(CATALOG)
    expect($atumStoreCatalog.get()).toMatchObject({ accountId: 'account-a', state: 'ready' })
    expect($atumStoreCatalog.get().catalog?.items).toHaveLength(1)
    expect(bridge.catalog).toHaveBeenCalledOnce()
    expect(bridge.refresh).not.toHaveBeenCalled()
  })

  it('forces a network read when asked', async () => {
    $scope.set('account-a')
    await refreshAtumStoreCatalog(true)

    expect(bridge.refresh).toHaveBeenCalledOnce()
  })

  it('keeps the last catalog on screen as stale through a failed refresh', async () => {
    $scope.set('account-a')
    await refreshAtumStoreCatalog()

    bridge.refresh.mockRejectedValueOnce(new Error('offline'))

    await expect(refreshAtumStoreCatalog(true)).rejects.toThrow('offline')

    const view = $atumStoreCatalog.get()
    expect(view.state).toBe('stale')
    expect(view.catalog).toEqual(CATALOG)
  })

  it('a HEALTHY refresh never marks the warm catalog stale — no reconnecting flash', async () => {
    $scope.set('account-a')
    await refreshAtumStoreCatalog()

    let release!: (catalog: AtumStoreCatalogWire) => void
    bridge.refresh.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))

    const pending = refreshAtumStoreCatalog(true)
    await Promise.resolve()

    // While the refresh is in flight the shelf still shows the last good read
    // as READY: stale means a refresh failed, and this one has not.
    expect($atumStoreCatalog.get().state).toBe('ready')

    release(CATALOG)
    await expect(pending).resolves.toEqual(CATALOG)
    expect($atumStoreCatalog.get().state).toBe('ready')
  })

  it('recovers from stale to ready on the next good read', async () => {
    $scope.set('account-a')
    await refreshAtumStoreCatalog()
    bridge.refresh.mockRejectedValueOnce(new Error('offline'))
    await refreshAtumStoreCatalog(true).catch(() => null)

    await refreshAtumStoreCatalog(true)

    expect($atumStoreCatalog.get().state).toBe('ready')
  })

  it('reports a cold failure as error with nothing retained', async () => {
    $scope.set('account-a')
    bridge.catalog.mockRejectedValueOnce(new Error('store down'))

    await expect(refreshAtumStoreCatalog()).rejects.toThrow('store down')

    expect($atumStoreCatalog.get()).toMatchObject({ accountId: 'account-a', catalog: null, state: 'error' })
  })

  it('turns a warm error back into stale — a retained shelf never blanks', async () => {
    $scope.set('account-a')
    await refreshAtumStoreCatalog()
    bridge.refresh.mockRejectedValueOnce(new Error('offline'))
    await refreshAtumStoreCatalog(true).catch(() => null)
    bridge.refresh.mockRejectedValueOnce(new Error('still offline'))
    await refreshAtumStoreCatalog(true).catch(() => null)

    expect($atumStoreCatalog.get().state).toBe('stale')
    expect($atumStoreCatalog.get().catalog).toEqual(CATALOG)
  })

  it('refuses a result that arrives after an A → B account switch', async () => {
    $scope.set('account-a')

    let resolveA!: (catalog: AtumStoreCatalogWire) => void
    bridge.catalog.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve }))

    const late = refreshAtumStoreCatalog()
    await Promise.resolve()

    // A → B: the listener drops A's view synchronously and bumps the fence.
    $scope.set('account-b')
    expect($atumStoreCatalog.get()).toMatchObject({ accountId: 'account-b', catalog: null })

    const aCatalog = { ...CATALOG, available_protons: 999999 }
    resolveA(aCatalog)

    await expect(late).resolves.toBeNull()
    // B's shelf never shows A's catalog. B has a read of its own in flight
    // (the scope arriving asks for one), so the test is A's distinctive
    // balance never appearing under B, not "B has nothing".
    await vi.waitFor(() => expect($atumStoreCatalog.get().state).toBe('ready'))
    expect($atumStoreCatalog.get().catalog?.available_protons).not.toBe(999999)

    bridge.catalog.mockResolvedValueOnce(CATALOG)
    await refreshAtumStoreCatalog()
    expect($atumStoreCatalog.get()).toMatchObject({ accountId: 'account-b', state: 'ready' })
    expect($atumStoreCatalog.get().catalog?.available_protons).toBe(1200)
  })

  it('refuses even a failed late write after an account switch', async () => {
    $scope.set('account-a')
    bridge.catalog.mockRejectedValueOnce(new Error('offline'))
    const failing = refreshAtumStoreCatalog()
    await Promise.resolve()
    $scope.set('account-b')

    await expect(failing).rejects.toThrow('offline')
    // A's failure must not paint B's fresh view as an error.
    const view = $atumStoreCatalog.get()
    expect(view.accountId).toBe('account-b')
    expect(view.state).not.toBe('error')
    expect(view.state).not.toBe('stale')
  })

  it('reads the catalog as soon as an account scope arrives', async () => {
    // Every surface that prices a bundled item fails closed until the catalog
    // answers, and only Discover used to ask — so a signed-in person opening
    // "Choose a pet" from the chat rail saw every bundled pet as
    // Preserve the recovery and user-visible behavior covered by this path.
    // durable cache can answer it offline.
    $scope.set('account-a')

    await vi.waitFor(() => expect($atumStoreCatalog.get().state).toBe('ready'))
    expect(bridge.catalog).toHaveBeenCalledOnce()
    expect(bridge.refresh).not.toHaveBeenCalled()
  })

  it('does not ask for a catalog when the account goes away', async () => {
    $scope.set('account-a')
    await vi.waitFor(() => expect($atumStoreCatalog.get().state).toBe('ready'))
    bridge.catalog.mockClear()

    $scope.set(null)
    await Promise.resolve()

    expect(bridge.catalog).not.toHaveBeenCalled()
    expect($atumStoreCatalog.get()).toEqual({ accountId: null, catalog: null, state: 'idle' })
  })

  it('a failed automatic read leaves an error view, not an unhandled rejection', async () => {
    bridge.catalog.mockRejectedValueOnce(new Error('store down'))

    $scope.set('account-a')

    await vi.waitFor(() => expect($atumStoreCatalog.get().state).toBe('error'))
    expect($atumStoreCatalog.get()).toMatchObject({ accountId: 'account-a', catalog: null })
  })
})
