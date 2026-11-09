import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FREE, isAcquirable, isAtumPrice, normalizePrice, priceLabel, UNAVAILABLE } from '@/lib/atum-price'
import type { AtumStoreCatalogWire, AtumStoreItemWire } from '@/lib/atum-store-items'

import { $petInfoByAgent, syncActivePetViews } from './pet'
import { $petGallery, $petGalleryStatus, type GatewayRequest, loadPetGallery, mergeStorePetRows, type PetGallery, resetPetGallery } from './pet-gallery'
import { $activeGatewayProfile } from './profile'

/**
 * Every gallery row has a price by the time a pill reads it.
 *
 * The gateway sends one on each row; an older gateway sends none, and a newer
 * one could send a kind this build does not know. The pill must never have to
 * ask "is there one?", so the store answers it once, at the boundary.
 */

const ROWS = [
  { displayName: 'Gigi', installed: true, slug: 'gigi' },
  { displayName: 'Boba', installed: false, price: { kind: 'free' }, slug: 'boba' },
  { displayName: 'Future', installed: false, price: { kind: 'protons', amount: 30 }, slug: 'future' }
]

function gateway(): GatewayRequest {
  return vi.fn((method: string) =>
    Promise.resolve(method === 'pet.gallery' ? { active: '', enabled: false, pets: ROWS } : {})
  ) as unknown as GatewayRequest
}

beforeEach(() => {
  resetPetGallery()
  $petInfoByAgent.set({})
  $activeGatewayProfile.set('default')
  syncActivePetViews()
})

describe('a price on every gallery row', () => {
  it('normalizes what the wire sends, on both load phases', async () => {
    await loadPetGallery(gateway())

    expect($petGalleryStatus.get()).toBe('ready')
    const prices = Object.fromEntries(($petGallery.get()?.pets ?? []).map(pet => [pet.slug, pet.price]))

    // Missing → free (an older gateway, from before rows carried a price).
    // Known → kept, Protons included. Unknown → UNAVAILABLE, because a kind
    // this build cannot read exists precisely because something stopped being
    // free; calling it free would put a "Free" pill on a priced item.
    expect(prices).toEqual({ boba: FREE, future: { amount: 30, kind: 'protons' }, gigi: FREE })
  })

  it('reads one kind through one rule, the same one the skill pill uses', () => {
    expect(isAtumPrice({ kind: 'free' })).toBe(true)
    expect(isAtumPrice({ kind: 'protons' })).toBe(false)
    expect(isAtumPrice({ kind: 'protons', amount: 30 })).toBe(true)
    expect(isAtumPrice({ kind: 'protons', amount: -5 })).toBe(false)
    expect(isAtumPrice({ kind: 'protons', amount: 1.5 })).toBe(false)
    expect(isAtumPrice(undefined)).toBe(false)
    expect(priceLabel(FREE, { free: 'Miễn phí', unavailable: 'Chưa bán' }, String)).toBe('Miễn phí')
    expect(priceLabel({ amount: 30, kind: 'protons' }, { free: 'Miễn phí', protons: amount => `${amount} Proton`, unavailable: 'Chưa bán' }, String)).toBe('30 Proton')
    // A caller that predates priced items fails closed on the kind.
    expect(priceLabel({ amount: 30, kind: 'protons' }, { free: 'Miễn phí', unavailable: 'Chưa bán' }, String)).toBe('Chưa bán')
  })

  it('tells an absent price apart from one it cannot read', () => {
    // The distinction is the whole point: silence from an old gateway is not
    // the same as a kind added after this build shipped.
    expect(normalizePrice(undefined)).toBe(FREE)
    expect(normalizePrice(null)).toBe(FREE)

    for (const unreadable of [{ kind: 'whatever' }, { kind: 'protons' }, { kind: 'protons', amount: '50' }, {}, 'free', 7]) {
      expect(normalizePrice(unreadable)).toBe(UNAVAILABLE)
    }

    expect(normalizePrice({ kind: 'protons', amount: 50 })).toEqual({ amount: 50, kind: 'protons' })
  })

  it('never offers to acquire something it cannot price', () => {
    expect(isAcquirable(FREE)).toBe(true)
    expect(isAcquirable({ amount: 50, kind: 'protons' })).toBe(true)
    expect(isAcquirable(UNAVAILABLE)).toBe(false)
    expect(priceLabel(UNAVAILABLE, { free: 'Miễn phí', unavailable: 'Chưa bán' }, String)).toBe('Chưa bán')
  })
})


/**
 * The storefront merge: a pet whose price is UNKNOWN — the catalog has not
 * answered — is unavailable, never free (review B10). Only the catalog can say
 * a bundled pet is unclaimed, so until it speaks, "free by source class" has
 * not been established.
 */
describe('mergeStorePetRows — unknown price never reads as free', () => {
  const GALLERY: PetGallery = {
    active: '',
    enabled: false,
    pets: [
      { bundled: true, displayName: 'Mochi', installed: false, price: FREE, slug: 'mochi' },
      { curated: true, displayName: 'Boba', installed: false, price: FREE, slug: 'boba' }
    ]
  }

  const catalogPet = (slug: string, priceProtons: number): AtumStoreItemWire => ({
    accent: 'var(--atum-sunk)',
    detail: { description: {}, needs: [], try_prompt: {} },
    featured: true,
    glyph: '🐾',
    hashes: [],
    id: `bundled/${slug}`,
    kind: 'pet',
    offer: { id: '00000000-0000-4000-8000-a28c50c0e7e8', price_protons: priceProtons, version: 1 },
    sort_order: 1,
    source: { slug, type: 'bundled' },
    summary: {},
    title: {}
  })

  const catalog = (items: AtumStoreItemWire[]): AtumStoreCatalogWire => ({ available_protons: 0, entitlements: [], items })

  it('marks a bundled pet unavailable while the catalog is still out (idle/loading/error)', () => {
    const [mochi, boba] = mergeStorePetRows(GALLERY, null, false)

    // The catalog may claim Mochi at a price; until it answers, no Free pill
    // and no pet.select through the adopt path.
    expect(mochi!.price).toEqual(UNAVAILABLE)
    expect(mochi!.storeItemId).toBeNull()
    // A petdex pet needs no answer: no catalog source type can claim it.
    expect(boba!.price).toEqual(FREE)
  })

  it('prices the claimed pet and frees the unclaimed once the catalog answers', () => {
    const rows = mergeStorePetRows(GALLERY, catalog([catalogPet('mochi', 20000)]), true)

    expect(rows.find(row => row.slug === 'mochi')).toMatchObject({
      price: { amount: 20000, kind: 'protons' },
      storeItemId: 'bundled/mochi'
    })
    expect(rows.find(row => row.slug === 'boba')?.price).toEqual(FREE)
  })

  it('keeps an unclaimed bundled pet free once the catalog has answered and not claimed it', () => {
    const [mochi] = mergeStorePetRows(GALLERY, catalog([]), true)

    expect(mochi!.price).toEqual(FREE)
  })

  it('never prices a DELISTED paid pet as free — the signed set covers every state', () => {
    // Preserve the recovery and user-visible behavior covered by this path.
    // while the envelope's catalog_owned carries every state. A delisted or
    // draft paid pet therefore had no catalog row, fell through to "free by
    // source class", and was offered with an enabled Adopt — which the gateway
    // then refused with purchase_required.
    const listed = catalog([])
    const withSigned: AtumStoreCatalogWire = {
      ...listed,
      catalog_owned: [{ identifier: 'mochi', kind: 'pet', delivery: 'local' }]
    }

    const rows = mergeStorePetRows(GALLERY, withSigned, true)

    expect(rows.find(row => row.slug === 'mochi')?.price).toEqual(UNAVAILABLE)
    // A pet the signed set does not name is still free by source class.
    expect(rows.find(row => row.slug === 'boba')?.price).toEqual(FREE)
  })

  it('treats a null catalog with no account in play as answered — signed-out has no store to wait for', () => {
    // The default is fail-closed (no catalog = not answered). Signed out, the
    // caller ($storePetRows) answers for it: no account means no store to wait for.
    const [mochi] = mergeStorePetRows(GALLERY, null, true)

    expect(mochi!.price).toEqual(FREE)
  })
})
