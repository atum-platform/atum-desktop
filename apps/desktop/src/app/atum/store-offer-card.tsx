// RETIRED legacy Store (pre-Matrix app): the platform switched its wallet spending off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import type { ReactNode } from 'react'

import { useI18n } from '@/i18n'
import { priceLabel } from '@/lib/atum-price'
import { type AtumStoreOffer, priceForOffer } from '@/lib/atum-store-items'
import { Loader2 } from '@/lib/icons'

import { PriceTag } from './price-tag'

export interface StoreOfferCardProps {
  availableProtons: null | number
  busy: boolean
  children?: ReactNode
  description?: null | string
  disabled?: boolean
  offer: AtumStoreOffer
  onBuy: () => void
  title: string
}

/**
 * A store item at its authoritative offer, as a Moon product card: the name
 * and a brief description on the left, the price over the buy button on the
 * right, and whatever the purchase needs next (a notice) opening
 * inside the same card below a hairline. The price confirmed here is the
 * price captured, or nothing is: the purchase carries the offer's version and
 * the platform refuses a stale one. The version is that mechanism's business,
 * not the customer's, so it stays in `data-atum-offer-version` and is never
 * printed — a changed price reaches the person as the "price changed" notice.
 */
export function StoreOfferCard({ availableProtons, busy, children, description, disabled = false, offer, onBuy, title }: StoreOfferCardProps) {
  const { locale, t } = useI18n()
  const copy = t.atum.discover
  const formatAmount = (amount: number) => new Intl.NumberFormat(locale).format(amount)
  const price = priceLabel(priceForOffer(offer), copy, formatAmount)

  return (
    <div
      className="relative overflow-hidden rounded-[var(--atum-r-card)] border border-(--atum-line) bg-(--atum-card) p-3"
      data-atum-offer-version={offer.version}
      data-atum-store-offer
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[1.0625rem] leading-tight font-semibold text-(--atum-ink)">{title}</div>
          {description && <p className="mt-1.5 text-(length:--atum-t-body) leading-relaxed text-(--atum-ink-muted)">{description}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 text-right">
          <div className="text-(length:--atum-t-ui) font-semibold text-(--atum-ink)"><PriceTag copy={copy} formatAmount={formatAmount} price={priceForOffer(offer)} /></div>
          <button
            aria-busy={busy || undefined}
            aria-label={copy.buyFor(price)}
            className="inline-flex min-h-9 items-center justify-center rounded-full bg-(--atum-ink) px-4 py-1.5 text-(length:--atum-t-control) font-semibold text-(--atum-on-accent) transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
            data-atum-store-buy
            disabled={busy || disabled}
            onClick={onBuy}
            type="button"
          >
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : t.atum.protons.checkout.buy}
          </button>
        </div>
      </div>
      {availableProtons !== null && (
        <p className="mt-3 text-(length:--atum-t-control) text-(--atum-ink-muted)">{copy.availableBalance(copy.protons(formatAmount(availableProtons)))}</p>
      )}
      {children && <div className="mt-3 border-t border-(--atum-line) pt-3">{children}</div>}
    </div>
  )
}
