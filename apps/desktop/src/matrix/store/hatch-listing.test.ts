import { describe, expect, it } from 'vitest'

import type { MatrixStoreItem, MatrixStoreOffer, MatrixStoreOwnership } from '../../../shared/matrix-store'

import {
  FIRST_HATCH_ITEM_ID,
  HATCH_ITEM_ID,
  storeListingFor,
  storeListingForOffer,
  storeListings
} from './hatch-listing'

const FIRST_OFFER = '00000000-0000-4000-8000-f96179903d54'
const REGULAR_OFFER = '00000000-0000-4000-8000-737d79e212a5'
const GIGI_OFFER = '00000000-0000-4000-8000-fb325251c8ea'
const MICRO = 1_000_000

function offer(id: string, protons: number): MatrixStoreOffer {
  return {
    id,
    version: 1,
    priceMicroProtons: protons * MICRO,
    scope: 'account',
    billingInterval: 'one_time',
    delivery: 'bundled'
  }
}

function pet(itemId: string, protons: number | null, extra: Partial<MatrixStoreItem> = {}): MatrixStoreItem {
  return {
    itemId,
    kind: 'pet',
    title: { en: itemId, vi: itemId },
    summary: { en: 'summary', vi: 'tóm tắt' },
    description: { vi: 'mô tả' },
    tryPrompt: { vi: 'thử' },
    needs: [],
    glyph: '🐾',
    accent: '#8e75d6',
    featured: false,
    sortOrder: 5,
    offer: protons === null ? null : offer(itemId === FIRST_HATCH_ITEM_ID ? FIRST_OFFER : REGULAR_OFFER, protons),
    ...extra
  }
}

const gigi = pet('pet/gigi', 90_000, { offer: offer(GIGI_OFFER, 90_000), sortOrder: 1 })
const regular = pet(HATCH_ITEM_ID, 180_000, { title: { en: 'Pet hatch', vi: 'Ấp thú cưng' }, sortOrder: 9 })
const first = pet(FIRST_HATCH_ITEM_ID, 65_000, { title: { en: 'First pet hatch', vi: 'Ấp thú cưng đầu tiên' } })

describe('storeListings', () => {
  it('folds the first-hatch row into one Hatch card that sells the first-hatch offer', () => {
    const listings = storeListings([gigi, first, regular])
    const hatches = listings.filter(listing => listing.itemId.startsWith('pet/hatch'))

    expect(hatches).toHaveLength(1)
    expect(hatches[0].itemId).toBe(HATCH_ITEM_ID)
    expect(hatches[0].title).toEqual(regular.title)
    expect(hatches[0].offer).toEqual(first.offer)
    expect(hatches[0].regularOffer).toEqual(regular.offer)
    // The card sits where the first of the two rows sat; every other row is untouched.
    expect(hatches[0].sortOrder).toBe(first.sortOrder)
    expect(listings.find(listing => listing.itemId === 'pet/gigi')).toBe(gigi)
  })

  it('sells the regular offer, with no struck price, once the catalog stops listing the first hatch', () => {
    const listings = storeListings([gigi, regular])

    expect(listings).toEqual([gigi, regular])
    expect(listings[1].regularOffer).toBeUndefined()
  })

  it('never folds a first-hatch row the catalog lists without an offer', () => {
    const listings = storeListings([regular, pet(FIRST_HATCH_ITEM_ID, null)])

    expect(listings.find(listing => listing.itemId === HATCH_ITEM_ID)).toBe(regular)
  })

  it('keeps a lone first-hatch row as its own card when there is no regular hatch to fold into', () => {
    expect(storeListings([gigi, first])).toEqual([gigi, first])
  })

  it('strikes nothing through when the regular price is not higher', () => {
    const same = pet(HATCH_ITEM_ID, 65_000)
    const [hatch] = storeListings([first, same])

    expect(hatch.offer?.id).toBe(FIRST_OFFER)
    expect(hatch.regularOffer).toBeUndefined()
  })

  it('takes ownership from the server rows: a held credit wins, otherwise the offer being sold', () => {
    const owned: MatrixStoreOwnership = { state: 'owned', source: 'purchase', assistantIds: [], until: null }
    const available: MatrixStoreOwnership = { state: 'available', source: null, assistantIds: [], until: null }

    const [held] = storeListings([
      { ...first, ownership: available },
      { ...regular, ownership: owned }
    ])
    expect(held.ownership).toEqual(owned)

    const [open] = storeListings([
      { ...first, ownership: available },
      { ...regular, ownership: available }
    ])
    expect(open.ownership).toEqual(available)
  })

  it('finds the Hatch card for a first-hatch credit or for either offer it shows', () => {
    const merged = storeListings([gigi, first, regular])
    const later = storeListings([gigi, regular])

    expect(storeListingFor(later, FIRST_HATCH_ITEM_ID)?.itemId).toBe(HATCH_ITEM_ID)
    expect(storeListingFor(later, 'pet/gigi')).toBe(gigi)
    expect(storeListingFor(later, 'pet/unknown')).toBeUndefined()
    expect(storeListingForOffer(merged, FIRST_OFFER)?.itemId).toBe(HATCH_ITEM_ID)
    expect(storeListingForOffer(merged, REGULAR_OFFER)?.itemId).toBe(HATCH_ITEM_ID)
    expect(storeListingForOffer(merged, GIGI_OFFER)).toBe(gigi)
  })
})
