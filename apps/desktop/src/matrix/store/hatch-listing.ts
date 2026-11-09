import type { MatrixStoreItem, MatrixStoreOffer } from '../../../shared/matrix-store'

/** The regular hatch credit, and the same credit at its once-per-account first-hatch price. */
export const HATCH_ITEM_ID = 'pet/hatch'
export const FIRST_HATCH_ITEM_ID = 'pet/hatch-first'

/**
 * What the Store shows: a catalog row, or the one Hatch card the two hatch rows fold into.
 * `regularOffer` is set only while the first-hatch price stands in for the regular one, so
 * the card can strike the regular price through beside the price the person pays.
 */
export interface MatrixStoreListing extends MatrixStoreItem {
  regularOffer?: MatrixStoreOffer
}

/**
 * The catalog as the Store lists it: `pet/hatch-first` and `pet/hatch` are one Hatch card.
 *
 * Eligibility is the server's, never decided here. The Marketplace lists `pet/hatch-first`
 * only to an account that has not bought it yet (atum-store `listItems`), and the Shell's pet
 * catalog funds the hatch flow the same way (`hatch-first`, else `hatch`). So the card sells
 * the first-hatch offer exactly while the catalog lists it, and the regular offer otherwise.
 * Ownership stays each row's own projection; an owned row wins, since buying either hatch
 * while a credit is held returns that credit rather than a second charge.
 */
export function storeListings(items: readonly MatrixStoreItem[]): MatrixStoreListing[] {
  const first = items.find(item => item.itemId === FIRST_HATCH_ITEM_ID)
  const regular = items.find(item => item.itemId === HATCH_ITEM_ID)

  if (!first?.offer || !regular) {
    return [...items]
  }

  const ownership = [regular, first].find(row => row.ownership?.state === 'owned')?.ownership ?? first.ownership
  const regularOffer = regular.offer

  const hatch: MatrixStoreListing = {
    ...regular,
    offer: first.offer,
    featured: regular.featured || first.featured,
    sortOrder: Math.min(regular.sortOrder, first.sortOrder),
    ...(ownership ? { ownership } : {}),
    ...(regularOffer && regularOffer.priceMicroProtons > first.offer.priceMicroProtons ? { regularOffer } : {})
  }

  return items.flatMap(item => (item === first ? [] : item === regular ? [hatch] : [item]))
}

/** The Hatch card (either hatch row, as `storeListings` folds them): it makes a pet rather than adopting one. */
export function isHatchListing(item: Pick<MatrixStoreItem, 'itemId'>) {
  return item.itemId === HATCH_ITEM_ID || item.itemId === FIRST_HATCH_ITEM_ID
}

/** The listing an entitlement belongs to: a first-hatch credit is the Hatch card's once its own row is gone. */
export function storeListingFor(listings: readonly MatrixStoreListing[], itemId: string) {
  return (
    listings.find(listing => listing.itemId === itemId) ??
    (itemId === FIRST_HATCH_ITEM_ID ? listings.find(listing => listing.itemId === HATCH_ITEM_ID) : undefined)
  )
}

/** The listing a journaled purchase was made from, by either of the offers it shows. */
export function storeListingForOffer(listings: readonly MatrixStoreListing[], offerId: string) {
  return listings.find(listing => listing.offer?.id === offerId || listing.regularOffer?.id === offerId)
}
