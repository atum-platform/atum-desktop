// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { ProtonAmount } from '@/components/brand/proton-mark'
import { type AtumPrice, type AtumPriceCopy, priceLabel } from '@/lib/atum-price'

/**
 * A price pill's content. A Protons price reads as the Proton mark and the
 * number; free and unavailable keep their words. `priceLabel` stays the one
 * rule for what a price says — this only changes how a Protons price looks,
 * and its full phrase ("4,000 Protons") is still what a screen reader hears.
 */
export function PriceTag({ className, copy, formatAmount, price }: {
  className?: string
  copy: AtumPriceCopy
  formatAmount: (amount: number) => string
  price: AtumPrice
}) {
  const label = priceLabel(price, copy, formatAmount)

  if (price.kind === 'protons' && copy.protons) {
    return <ProtonAmount amount={formatAmount(price.amount)} className={className} spoken={label} />
  }

  return <>{label}</>
}
