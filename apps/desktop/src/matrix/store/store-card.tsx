import { Fragment, useState } from 'react'

import { ProtonAmount, ProtonText } from '@/components/brand/proton-mark'
import { Check, PawPrint, Robot, Sparkles } from '@/lib/icons'
import { type IconComponent, phosphorIcon } from '@/lib/phosphor-icon'
import { cn } from '@/lib/utils'

import type { MatrixStoreItem, MatrixStoreKind, MatrixStoreOffer } from '../../../shared/matrix-store'
import { localizedStoreCopy } from '../../../shared/matrix-store-contract'
import { microProtons } from '../wallet-ui'

import { isHatchListing, type MatrixStoreListing } from './hatch-listing'
import { isHubSkill } from './hub-skill'
import { storePetPreview } from './pet-previews'
import type { MatrixStoreCopy } from './store-copy'

export const localizedStoreText = localizedStoreCopy

const STORE_KIND_ICON: Record<MatrixStoreKind, IconComponent> = {
  skill: Sparkles,
  agent: Robot,
  pet: PawPrint
}

/**
 * The catalog names each item's glyph as an emoji; the tile draws its Phosphor Light counterpart
 * (Atum Kit boards: every item has its own glyph). An emoji with no counterpart here falls back to
 * the kind's glyph, never to the emoji itself.
 */
const STORE_GLYPH_ICON: Record<string, IconComponent> = Object.fromEntries(
  (
    [
      ['🛍', 'shopping-bag'],
      ['🛒', 'shopping-cart'],
      ['🔎', 'magnifying-glass'],
      ['🔍', 'magnifying-glass'],
      ['🔷', 'diamond'],
      ['✦', 'sparkle'],
      ['✒', 'pen-nib'],
      ['✍', 'pen-nib'],
      ['📝', 'note-pencil'],
      ['🧭', 'compass'],
      ['🗓', 'calendar-blank'],
      ['📊', 'chart-bar'],
      ['📈', 'trend-up'],
      ['📄', 'file-text'],
      ['📑', 'files'],
      ['🗂', 'folders'],
      ['🏷', 'tag'],
      ['🎓', 'graduation-cap'],
      ['🧑‍🏫', 'chalkboard-teacher'],
      ['🌐', 'globe'],
      ['🧾', 'receipt'],
      ['🥗', 'bowl-food'],
      ['🍲', 'cooking-pot'],
      ['🥚', 'egg'],
      ['😂', 'smiley'],
      ['🗣', 'user-sound'],
      ['📣', 'megaphone'],
      ['🖼', 'image'],
      ['📸', 'camera'],
      ['🖥', 'desktop'],
      ['🔄', 'arrows-clockwise'],
      ['📥', 'tray-arrow-down'],
      ['🎧', 'headphones'],
      ['🎨', 'palette'],
      ['🎬', 'film-slate'],
      ['🏃', 'person-simple-run'],
      ['🏋', 'barbell'],
      ['👾', 'game-controller'],
      ['💡', 'lightbulb'],
      ['💰', 'money'],
      ['💵', 'money'],
      ['💼', 'briefcase'],
      ['📌', 'push-pin'],
      ['📍', 'map-pin'],
      ['📒', 'notebook'],
      ['📖', 'book-open'],
      ['🧩', 'puzzle-piece'],
      ['⚡', 'lightning'],
      ['🐾', 'paw-print']
    ] as const
  ).map(([emoji, name]) => [emoji, phosphorIcon(name)])
)

/** The tile's glyph for an item: its own when the catalog names one we draw, else its kind's. */
export function storeGlyphIcon(item: Pick<MatrixStoreItem, 'kind'> & { glyph?: string }): IconComponent {
  // Variation selectors and the text/emoji presentation marks never change which glyph is meant.
  const glyph = item.glyph?.trim().replace(/[\uFE0E\uFE0F]/g, '')

  return (glyph && STORE_GLYPH_ICON[glyph]) || STORE_KIND_ICON[item.kind]
}

/** R13: pets keep their portrait; skills and assistants use neutral tiles with their own Phosphor glyph. */
export function StoreArt({
  item,
  size
}: {
  item: Pick<MatrixStoreItem, 'kind'> & { glyph?: string; itemId?: string }
  size: 'tile' | 'panel'
}) {
  const preview = item.kind === 'pet' ? storePetPreview(item.itemId) : undefined
  const [failed, setFailed] = useState<string>()
  const showPreview = Boolean(preview) && failed !== preview
  const Icon = storeGlyphIcon(item)

  return (
    <span
      aria-hidden
      className="atum-store-art"
      data-art={showPreview ? 'pet' : item.kind}
      data-size={size}
    >
      {showPreview ? (
        <img alt="" draggable={false} onError={() => setFailed(preview)} src={preview} />
      ) : (
        <Icon aria-hidden className={size === 'panel' ? 'ak-icon ak-icon--xl' : 'ak-icon ak-icon--lg'} />
      )}
    </span>
  )
}

/**
 * What an offer costs, without rounding: micro-Protons go to the final formatter so a
 * price never becomes a different offer. A monthly hire that renews at a different price
 * says both — the first month, then what every month after it costs — so the headline
 * never understates what the person keeps paying.
 */
export function storePriceParts(offer: MatrixStoreOffer, copy: MatrixStoreCopy, locale: string): string[] {
  const first = offer.priceMicroProtons

  if (offer.billingInterval === 'month') {
    const renewal = offer.renewalPriceMicroProtons

    if (renewal !== undefined && renewal !== first) {
      return [
        first === 0 ? copy.monthlyFreeFirst : copy.monthlyFirst(microProtons(first, locale)),
        copy.monthlyThen(microProtons(renewal, locale))
      ]
    }

    return [first === 0 ? copy.free : `${microProtons(first, locale)} ${copy.protons} ${copy.monthly}`]
  }

  return [first === 0 ? copy.free : `${microProtons(first, locale)} ${copy.protons}`]
}

/** The amounts an offer's price text names, as it writes them; free costs none. */
export function storePriceAmounts(offer: MatrixStoreOffer, locale: string): string[] {
  return [offer.priceMicroProtons, offer.renewalPriceMicroProtons ?? 0]
    .filter(value => value > 0)
    .map(value => microProtons(value, locale))
}

/** A price in a pill or button: each amount with the Proton mark, the words kept for screen readers. */
export function StorePriceText({
  copy,
  locale,
  offer,
  text
}: {
  copy: MatrixStoreCopy
  locale: string
  offer: MatrixStoreOffer
  /** The phrase to draw; by default the offer's own price text. */
  text?: string
}) {
  return <ProtonText amounts={storePriceAmounts(offer, locale)} text={text ?? storePriceText(offer, copy, locale)} unit={copy.protons} />
}

/** The price as one line of text: "19,000 Protons first month · then 39,000/mo". */
export function storePriceText(offer: MatrixStoreOffer, copy: MatrixStoreCopy, locale: string): string {
  return storePriceParts(offer, copy, locale).join(' · ')
}

export function StorePrice({
  copy,
  item,
  locale,
  owned,
  ownedLabel,
  stacked = false
}: {
  copy: MatrixStoreCopy
  item: MatrixStoreListing
  locale: string
  owned: boolean
  /** Who has it, when that is worth saying: "Owned · Atum". */
  ownedLabel?: string
  /** A narrow card: a two-part price takes two lines, each whole, and the pill fits the longer. */
  stacked?: boolean
}) {
  if (owned) {
    return (
      <span className="atum-store-price" data-owned>
        <Check aria-hidden className="size-3" strokeWidth={2.4} />
        {ownedLabel ?? copy.owned}
      </span>
    )
  }

  // The first-hatch price, beside the regular price it stands in for (struck through).
  if (item.offer && item.regularOffer) {
    return (
      <span className="atum-store-deal" data-store-first-hatch>
        <span className="atum-store-deal-label">{copy.firstHatch}</span>
        <span className="atum-store-price" data-kind="protons">
          <StorePriceText copy={copy} locale={locale} offer={item.offer} />
        </span>
        <s className="atum-store-price-was" data-store-regular-price>
          <span className="sr-only">{copy.regularPrice} </span>
          <StorePriceText copy={copy} locale={locale} offer={item.regularOffer} />
        </s>
      </span>
    )
  }

  const offer = item.offer
  const parts = offer ? storePriceParts(offer, copy, locale) : []
  // Preserve the original price element on legacy responses. A visit adds a label,
  // while the offer and acquisition action remain available. A Hub skill has no offer: it is free.
  const price = !offer ? (
    isHubSkill(item) ? (
      <span className="atum-store-price" data-kind="free">
        {copy.free}
      </span>
    ) : (
      <span className="atum-store-price" data-kind="unavailable">
        {copy.unavailable}
      </span>
    )
  ) : parts.length === 1 ? (
    <span className="atum-store-price" data-kind={parts[0] === copy.free ? 'free' : 'protons'}>
      {parts[0] === copy.free ? parts[0] : <StorePriceText copy={copy} locale={locale} offer={offer} text={parts[0]} />}
    </span>
  ) : (
    <span className="atum-store-price" data-kind="protons" data-stacked={stacked || undefined}>
      <span className={stacked ? 'grid' : undefined}>
        {parts.map((part, index) => (
          <Fragment key={part}>
            {index > 0 && (stacked ? <span className="sr-only"> · </span> : ' · ')}
            <span className="whitespace-nowrap">
              <StorePriceText copy={copy} locale={locale} offer={offer} text={part} />
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  )
  return item.ownership?.state === 'visiting' ? (
    <span className="flex flex-wrap items-center gap-2">
      <span className="atum-store-price" data-store-visiting>
        {copy.visiting}
      </span>
      {price}
    </span>
  ) : (
    price
  )
}

export function StoreCard({
  kindLabel,
  item,
  onOpen,
  owned,
  variant = 'row',
  locale,
  copy
}: {
  kindLabel?: string
  item: MatrixStoreListing
  onOpen(): void
  owned: boolean
  variant?: 'feature' | 'row'
  locale: string
  copy: MatrixStoreCopy
}) {
  const title = localizedStoreText(item.title, locale)
  const summary = localizedStoreText(item.summary, locale)
  const amount = !owned && item.offer && item.offer.priceMicroProtons > 0 ? microProtons(item.offer.priceMicroProtons, locale) : null
  // A priced row's button is the mark and the number; its name keeps the word ("8,000 Protons: Writer").
  const spoken = amount === null ? null : `${amount} ${copy.protons}`
  const action = owned ? copy.open : (spoken ?? copy.get)

  return (
    <article
      className={cn('atum-store-card group/card', variant === 'feature' && 'atum-store-card--feature')}
      data-store-item={item.itemId}
      onClick={onOpen}
    >
      <StoreArt item={item} size={variant === 'feature' ? 'panel' : 'tile'} />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 block text-[0.9375rem] leading-snug font-semibold text-(--atum-ink)">
          {title}
        </span>
        {(summary || kindLabel) && (
          <span className="mt-0.5 line-clamp-2 block text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-muted)">
            {kindLabel ? copy.discoverLine(kindLabel, summary) : summary}
          </span>
        )}
        {isHubSkill(item) && (
          <span
            className="mt-0.5 block text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-soft)"
            data-store-hub-hint
          >
            {copy.installFromHub}
          </span>
        )}
        {/* Whatever the catalog's summary says, the card says a real pet's photo works too. */}
        {isHatchListing(item) && (
          <span
            className="mt-0.5 block text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-soft)"
            data-store-hatch-hint
          >
            {copy.hatchFromPhoto}
          </span>
        )}
      </span>
      <button
        aria-label={copy.itemAction(action, title)}
        className="ak-btn ak-btn--sm"
        onClick={onOpen}
        type="button"
      >
        {amount !== null && spoken !== null ? <ProtonAmount amount={amount} spoken={spoken} /> : action}
      </button>
    </article>
  )
}
