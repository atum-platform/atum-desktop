// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
/**
 * What something you can add to Atum costs.
 *
 * One shape for every Discover section — skills, pets, whatever comes next —
 * so the price pill is one rule rather than one per surface. `protons` is the
 * Atum Store's priced kind: the amount is an integer of Protons owned by the
 * server's offer, and the client only ever *displays* it — the price the
 * person confirms is the price the platform captures, or nothing is.
 *
 * The rule that makes a server-owned catalog safe stays: any price kind this
 * build does not recognise becomes `unavailable`, never free. Every pill reads
 * through `priceLabel` instead of hardcoding "Free", so a kind added after
 * this build shipped fails closed everywhere at once.
 */
export type AtumPrice = { kind: 'free' } | { kind: 'unavailable' } | { kind: 'protons'; amount: number }

export const FREE: AtumPrice = { kind: 'free' }

/** A price this build cannot price. Never acquirable, never shown as free. */
export const UNAVAILABLE: AtumPrice = { kind: 'unavailable' }

export function isAtumPrice(value: unknown): value is AtumPrice {
  if (!value || typeof value !== 'object') {return false}

  const kind = (value as { kind?: unknown }).kind

  if (kind === 'free' || kind === 'unavailable') {return true}

  if (kind === 'protons') {
    const amount = (value as { amount?: unknown }).amount

    // Prices are integers in Protons (1 Proton = 1 VND); a fractional or
    // negative amount is not a price this build will display as one.
    return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0
  }

  return false
}

/**
 * A price from the wire.
 *
 * Two different silences, and they must not be treated alike:
 *
 *  - **Nothing sent.** An older gateway, from before rows carried a price at
 *    all. Everything it can offer is free, so free is the truth.
 *  - **Something sent that this build cannot read.** A newer gateway naming a
 *    kind added after this build shipped. That kind exists precisely because
 *    something is no longer free, so reading it as free would put a "Free"
 *    pill on a priced item and invite an install the gateway will refuse — or
 *    worse, one it won't. It reads as `unavailable`: the pill says so, and
 *    acquisition is not offered.
 *
 * Acquisition still goes through the gateway, which is the authority on price.
 * This is about never *telling the user* something costs nothing when this
 * build has no idea what it costs.
 */
export function normalizePrice(value: unknown): AtumPrice {
  if (value === undefined || value === null) {return FREE}

  return isAtumPrice(value) ? value : UNAVAILABLE
}

export interface AtumPriceCopy {
  free: string
  unavailable: string
  /** A caller without this formatter predates priced items: for it a priced
   *  kind is one it does not recognise, and the fail-closed rule applies. */
  protons?: (amount: string) => string
}

/**
 * The words on a price pill, before the thing is acquired. `formatAmount`
 * groups the integer for the viewer's locale; the default is the plain digits.
 */
export function priceLabel(
  price: AtumPrice,
  copy: AtumPriceCopy,
  // Required, not defaulted: a `String(amount)` default rendered 4000 instead of
  // 4,000 for every caller that forgot to pass the locale's formatter.
  formatAmount: (amount: number) => string
): string {
  switch (price.kind) {
    case 'free':
      return copy.free

    case 'unavailable':
      return copy.unavailable

    case 'protons':
      return copy.protons ? copy.protons(formatAmount(price.amount)) : copy.unavailable
  }
}

/** Whether this build may offer to acquire the thing at all. */
export function isAcquirable(price: AtumPrice): boolean {
  return price.kind !== 'unavailable'
}
