import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumStoreCatalogWire } from '@/lib/atum-store-items'

/**
 * The never-charge-twice rules (plan 2026-09-10-atum-store.md, W5.4): the
 * idempotency key is minted once per confirmation, persisted until the
 * purchase resolves, reused by every retry, and retired with its price.
 */

const $scope = atom<null | string>('account-a')

// Spread the real module and pin only the account scope: a hand-picked partial
// mock breaks each time the store chain reaches one more export.
vi.mock('./atum-messaging', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  $atumAccountScopeId: $scope
}))

const {
  $atumStorePurchaseAttempts,
  beginStorePurchase,
  recoverStorePurchase,
  runStorePurchase,
  storePurchaseAttemptFor
} = await import('./atum-store-purchase')

const { $atumStoreCatalog } = await import('./atum-store-catalog')

const ASSISTANT = '00000000-0000-4000-8000-7cac378a5787'
const IDENTITY = '00000000-0000-4000-8000-d3b5d0600970'
const OFFER = { id: '00000000-0000-4000-8000-11e594f48195', priceProtons: 5000, version: 1 }
const OFFER_V2 = { id: OFFER.id, priceProtons: 8000, version: 2 }

const CATALOG: AtumStoreCatalogWire = {
  available_protons: 7000,
  entitlements: [],
  items: []
}

const PURCHASE = {
  entitlement: {
    assistant_id: ASSISTANT,
    assistant_identity_id: IDENTITY,
    granted_at: '2026-09-10T00:00:00Z',
    id: 'concept-diagrams',
    kind: 'skill',
    state: 'active'
  },
  outcome: 'completed',
  purchase: {
    assistant_id: ASSISTANT,
    amount_protons: 5000,
    created_at: '2026-09-10T00:00:00Z',
    id: '00000000-0000-4000-8000-8cca3400b26b',
    item_id: 'concept-diagrams',
    kind: 'skill',
    offer_id: OFFER.id,
    offer_version: 1,
    refunded_at: null,
    status: 'completed'
  },
  wallet: { available_protons: 2000 }
} as const

const bridge = {
  catalog: vi.fn(),
  purchase: vi.fn(),
  purchaseStatus: vi.fn(),
  refresh: vi.fn()
}

const input = { assistantId: ASSISTANT, accountId: 'account-a', itemId: 'concept-diagrams', kind: 'skill' as const }

beforeEach(() => {
  ;(globalThis as { hermesDesktop?: unknown }).hermesDesktop = { store: bridge }
  bridge.catalog.mockReset().mockResolvedValue(CATALOG)
  bridge.refresh.mockReset().mockResolvedValue(CATALOG)
  bridge.purchase.mockReset()
  bridge.purchaseStatus.mockReset()
  $scope.set('account-a')
  $atumStorePurchaseAttempts.set({})
})

afterEach(() => {
  delete (globalThis as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the idempotency key', () => {
  it('is minted once when the person confirms and persisted until resolution', async () => {
    let release!: (error: Error) => void
    bridge.purchase
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            release = reject
          })
      )
      .mockRejectedValueOnce(new Error('network still unavailable'))

    const pending = runStorePurchase({ ...input, offer: OFFER })
    await Promise.resolve()

    const attempt = storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)
    expect(attempt?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u)
    expect(attempt).toMatchObject({ offerId: OFFER.id, offerVersion: 1 })
    expect(bridge.purchase).toHaveBeenCalledWith(OFFER.id, 1, attempt!.idempotencyKey, 'account-a', ASSISTANT)

    // The reply is lost (a timeout): the key must survive for recovery.
    release(new Error('network timeout'))
    await expect(pending).resolves.toEqual({ kind: 'uncertain' })
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)?.idempotencyKey).toBe(
      attempt!.idempotencyKey
    )
    expect(bridge.purchase.mock.calls.map(call => call[2])).toEqual([attempt!.idempotencyKey, attempt!.idempotencyKey])
  })

  it('is reused by a retry, a double-click, and a second window — never re-minted mid-confirmation', async () => {
    bridge.purchase
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockRejectedValueOnce(new Error('network still unavailable'))
    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'uncertain' })
    const key = storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)!.idempotencyKey

    // Retry: same key.
    bridge.purchase.mockResolvedValueOnce(PURCHASE)
    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'completed' })

    expect(bridge.purchase).toHaveBeenNthCalledWith(3, OFFER.id, 1, key, 'account-a', ASSISTANT)
    expect(bridge.purchase.mock.calls.slice(0, 3).every(call => call[2] === key)).toBe(true)
    // Resolved: the key is gone.
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()
  })

  it('survives in the durable attempts map for another window to reuse', async () => {
    const attempt = beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, ASSISTANT)

    // A second window reads the same persisted map and begins the same
    // confirmation: it must land on the same key.
    expect(beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, ASSISTANT)).toEqual(attempt)
    expect($atumStorePurchaseAttempts.get()['account-a']![`skill/concept-diagrams/${ASSISTANT}`]).toEqual(attempt)
  })

  it('keeps separate purchase identities for training two employees in the same skill', () => {
    const otherAssistant = '00000000-0000-4000-8000-0e1a34944c4b'
    const first = beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, ASSISTANT)
    const second = beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, otherAssistant)
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toEqual(first)
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', otherAssistant)).toEqual(second)
  })

  it('is minted fresh for the new offer after offer_changed — the old key retires with the old price', async () => {
    bridge.purchase.mockResolvedValueOnce({
      offer: { id: OFFER.id, price_protons: 8000, version: 2 },
      outcome: 'offer_changed'
    })

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({
      kind: 'offer_changed',
      offer: OFFER_V2
    })

    // Nothing was charged and no attempt lingers for the dead price.
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()

    const reconfirm = beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER_V2, ASSISTANT)
    expect(reconfirm.offerVersion).toBe(2)
    expect(reconfirm.idempotencyKey).not.toBe(bridge.purchase.mock.calls[0]![2])
  })

  it('clears the attempt on insufficient_protons — a refusal, not an ambiguity', async () => {
    bridge.purchase.mockRejectedValueOnce(new Error('insufficient_protons'))

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'insufficient_protons' })
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()
  })

  it('clears the attempt when the platform reports a key conflict', async () => {
    bridge.purchase.mockRejectedValueOnce(new Error('idempotency_conflict'))

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'failed' })
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()
  })

  it('treats already_owned as resolved and proceeds without charging again', async () => {
    bridge.purchase.mockResolvedValueOnce({
      entitlement: PURCHASE.entitlement,
      outcome: 'already_owned',
      purchase: null
    })

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'already_owned' })
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()
  })

  it('keeps the persisted attempt across a renderer reload — the same key comes back', async () => {
    // The suite's other tests never reload the module, which is how the broken
    // sanitizer regex (it matched no real UUID) passed: every load dropped
    // every stored attempt. Persist one, reload, and prove it survives.
    const attempt = beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, ASSISTANT)

    vi.resetModules()
    const reloaded = await import('./atum-store-purchase')

    expect(reloaded.storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toEqual(attempt)
    // A re-confirm of the same offer after the reload is the idempotent
    // replay, not a fresh mint.
    expect(reloaded.beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, ASSISTANT).idempotencyKey).toBe(
      attempt.idempotencyKey
    )
  })

  it("shares attempts between windows: a second window reuses the key and never overwrites the first's writes", async () => {
    const first = beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, ASSISTANT)

    // A second window is a second module instance over the same localStorage.
    vi.resetModules()
    const secondWindow = await import('./atum-store-purchase')

    // It reuses the persisted key rather than minting its own…
    expect(secondWindow.beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, ASSISTANT)).toEqual(first)

    // …and a write there does not erase this window's attempt for another item.
    secondWindow.beginStorePurchase('account-a', 'pet', 'mochi', OFFER)
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toEqual(first)
    expect(storePurchaseAttemptFor('account-a', 'pet', 'mochi')).toBeTruthy()
  })

  it("adopts another window's attempts from the storage event", () => {
    // Written by the other window straight to storage; 'storage' fires in every
    // window except the writer.
    window.localStorage.setItem(
      'atum.desktop.storePurchaseAttempts.v2',
      JSON.stringify({
        'account-a': {
          [`skill/concept-diagrams/${ASSISTANT}`]: {
            assistantId: ASSISTANT,
            idempotencyKey: '00000000-0000-4000-8000-e572c98b008e',
            offerId: OFFER.id,
            offerVersion: 1,
            purchaseId: null
          }
        }
      })
    )
    window.dispatchEvent(new StorageEvent('storage', { key: 'atum.desktop.storePurchaseAttempts.v2' }))

    expect($atumStorePurchaseAttempts.get()['account-a']?.[`skill/concept-diagrams/${ASSISTANT}`]?.idempotencyKey).toBe(
      '00000000-0000-4000-8000-e572c98b008e'
    )
  })

  it("a late result from an older confirmation never clears a newer confirmation's attempt", async () => {
    let settleV1!: (value: unknown) => void
    bridge.purchase.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          settleV1 = resolve
        })
    )

    const pending = runStorePurchase({ ...input, offer: OFFER })
    await Promise.resolve()
    const olderKey = storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)!.idempotencyKey

    // The dialog was closed and reopened at v2: a NEW confirmation, a new key.
    const newer = beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER_V2, ASSISTANT)
    expect(newer.idempotencyKey).not.toBe(olderKey)

    // The older confirmation's reply finally lands; it may retire only itself.
    settleV1({ offer: { id: OFFER.id, price_protons: 8000, version: 2 }, outcome: 'offer_changed' })
    await expect(pending).resolves.toEqual({ kind: 'offer_changed', offer: OFFER_V2 })

    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)?.idempotencyKey).toBe(
      newer.idempotencyKey
    )
  })

  it.each(['forbidden', 'not_found', 'invalid_request'])(
    'clears the attempt on a no-charge refusal (%s) — a refusal is not an ambiguity',
    async code => {
      bridge.purchase.mockRejectedValueOnce(new Error(code))

      await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'failed' })
      expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()

      // Recovery cannot loop: there is nothing left to recover.
      await expect(recoverStorePurchase(input)).resolves.toEqual({ kind: 'failed' })
      expect(bridge.purchase).toHaveBeenCalledTimes(1)
    }
  )

  it('tells main which account the person confirmed for', async () => {
    // The renderer's view of the account arrives asynchronously, so its own
    // scope check cannot see a hand-off main has already committed. Main is
    // the authority; it needs to be told what the person was looking at
    // Preserve the recovery and user-visible behavior covered by this path.
    bridge.purchase.mockResolvedValueOnce(PURCHASE)

    await runStorePurchase({ ...input, offer: OFFER })

    expect(bridge.purchase).toHaveBeenCalledWith(OFFER.id, 1, expect.any(String), 'account-a', ASSISTANT)
  })

  it('reports the spending switch as a refusal, and leaves nothing that could later charge', async () => {
    // Preserve the recovery and user-visible behavior covered by this path.
    // before any write while `spending_enabled` is off — the documented
    // default. Shown as 'uncertain', its recovery button replayed the same key
    // forever; and once the switch was turned on, that "check status" click
    // committed a real charge.
    bridge.purchase.mockRejectedValueOnce(new Error('feature_unavailable'))

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'unavailable' })
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()

    // Nothing is left to replay, so turning the switch on cannot charge for a
    // status check.
    await expect(recoverStorePurchase(input)).resolves.toEqual({ kind: 'failed' })
    expect(bridge.purchase).toHaveBeenCalledTimes(1)
  })

  it('keeps an account change during the request ambiguous — the debit may have committed', async () => {
    // The fence is checked after the call returns, so 'nothing was charged' is
    // Preserve the recovery and user-visible behavior covered by this path.
    bridge.purchase.mockRejectedValueOnce(new Error('account_context_changed'))

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'uncertain' })
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeTruthy()
  })

  it('recovers a lost purchase reply with the same idempotency key and never charges twice', async () => {
    bridge.purchase.mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce(PURCHASE)

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'completed' })
    expect(bridge.purchase).toHaveBeenCalledTimes(2)
    expect(bridge.purchase.mock.calls[0]![2]).toBe(bridge.purchase.mock.calls[1]![2])
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()
  })

  it('refuses to send an attempt minted for account A while the scope has moved to B', async () => {
    $scope.set('account-b')

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'failed' })

    // Nothing was sent — replaying A's key under B would be a fresh charge for B.
    expect(bridge.purchase).not.toHaveBeenCalled()
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()
  })

  it("refuses to recover A's attempt while the scope is B, and keeps it for A's return", async () => {
    const attempt = beginStorePurchase('account-a', 'skill', 'concept-diagrams', OFFER, ASSISTANT)

    $scope.set('account-b')
    await expect(recoverStorePurchase(input)).resolves.toEqual({ kind: 'failed' })

    expect(bridge.purchase).not.toHaveBeenCalled()
    expect(bridge.purchaseStatus).not.toHaveBeenCalled()
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toEqual(attempt)
  })
})

describe('recovery after an ambiguous outcome', () => {
  it('replays the persisted key when no purchase id was ever learned', async () => {
    bridge.purchase.mockRejectedValueOnce(new Error('network timeout'))
    await runStorePurchase({ ...input, offer: OFFER })
    const key = storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)!.idempotencyKey

    // The replay is the platform's idempotent hit: same key, same offer.
    bridge.purchase.mockResolvedValueOnce(PURCHASE)
    await expect(recoverStorePurchase(input)).resolves.toEqual({ kind: 'completed' })

    expect(bridge.purchase).toHaveBeenNthCalledWith(2, OFFER.id, 1, key, 'account-a', ASSISTANT)
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()
  })

  it('goes through purchaseStatus once a purchase id is known — a GET, never a re-POST', async () => {
    $atumStorePurchaseAttempts.set({
      'account-a': {
        [`skill/concept-diagrams/${ASSISTANT}`]: {
          assistantId: ASSISTANT,
          idempotencyKey: '00000000-0000-4000-8000-87d96e07d1bf',
          offerId: OFFER.id,
          offerVersion: 1,
          purchaseId: PURCHASE.purchase.id
        }
      }
    })
    bridge.purchaseStatus.mockResolvedValueOnce({ entitlement: PURCHASE.entitlement, purchase: PURCHASE.purchase })

    await expect(recoverStorePurchase(input)).resolves.toEqual({ kind: 'completed' })

    expect(bridge.purchaseStatus).toHaveBeenCalledWith('00000000-0000-4000-8000-8cca3400b26b')
    expect(bridge.purchase).not.toHaveBeenCalled()
    expect(storePurchaseAttemptFor('account-a', 'skill', 'concept-diagrams', ASSISTANT)).toBeNull()
  })

  it('fails cleanly when nothing is persisted for the item', async () => {
    await expect(recoverStorePurchase(input)).resolves.toEqual({ kind: 'failed' })
    expect(bridge.purchase).not.toHaveBeenCalled()
    expect(bridge.purchaseStatus).not.toHaveBeenCalled()
  })
})

describe('the catalog refresh after a completed purchase', () => {
  it('refreshes the store view so the new entitlement and balance show', async () => {
    bridge.purchase.mockResolvedValueOnce(PURCHASE)

    await runStorePurchase({ ...input, offer: OFFER })

    expect(bridge.refresh).toHaveBeenCalledOnce()
    expect($atumStoreCatalog.get()).toMatchObject({ accountId: 'account-a', state: 'ready' })
  })

  it('does not mask a completed charge when the refresh fails', async () => {
    bridge.purchase.mockResolvedValueOnce(PURCHASE)
    bridge.refresh.mockRejectedValueOnce(new Error('offline'))

    await expect(runStorePurchase({ ...input, offer: OFFER })).resolves.toEqual({ kind: 'completed' })
  })
})
