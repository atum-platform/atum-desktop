// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { PetThumb } from '@/components/pet/pet-thumb'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'
import { isAcquirable } from '@/lib/atum-price'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { refreshAtumStoreCatalog } from '@/store/atum-store-catalog'
import { $storePetRows } from '@/store/atum-store-pets'
import { $petInfoByAgent, petInfoFor } from '@/store/pet'
import { $petGallery, $petGalleryStatus, loadPetGallery, loadPetThumb, rankedGalleryPets, type StorePetRow } from '@/store/pet-gallery'
import { $gatewayState } from '@/store/session'

import { AdoptPetDialog } from './adopt-pet-dialog'
import { $atumAgents } from './agents'
import { PriceTag } from './price-tag'
import { useOpenStorefront } from './use-open-storefront'

/**
 * Pets in Discover — the shop window on the Featured shelf.
 *
 * Discover is "everything you can add to Atum", and a pet is exactly that kind
 * of thing, so pets get a strip here: the three that ship with the app, each
 * adoptable on the spot, and a teaser button that opens the Pets shelf of the
 * SAME storefront — the rail stays on Discover, the panel just switches
 * shelves. Settings manages the pets an assistant already has; the assistant
 * editor changes one assistant's pet.
 *
 * The one question a skill never had to ask — *for which assistant?* — is
 * answered by `AdoptPetDialog`, because a pet is one assistant's face.
 *
 * Prices and ownership come from the store catalog (`$storePetRows` merges it
 * into the gateway gallery): the catalog's offer wins for its own rows, every
 * other pet is free by source class, and Owned means an entitlement exists.
 * The gallery describes the *active* profile's installed set, which is fine
 * here: the catalog is the same for everyone. Who currently has a pet comes
 * from the keyed pet info instead.
 */

/** Cards in the featured strip. What ships with the app first. */
const FEATURED = 3

export interface DiscoverPetsSectionProps {
  /** The panel that owns shelf state passes the shelf switch. The opener's
   *  nonce already re-adopts a re-seeded shelf (see `$discoverShelfNonce`);
   *  this direct switch keeps the teaser instantaneous either way. */
  onOpenStore?: () => void
}

export function DiscoverPetsSection({ onOpenStore }: DiscoverPetsSectionProps) {
  const { locale, t } = useI18n()
  const copy = t.atum.discover
  const { requestGateway } = useGatewayRequest()
  const openStorefront = useOpenStorefront()
  const gatewayState = useStore($gatewayState)
  const gallery = useStore($petGallery)
  const rows = useStore($storePetRows)
  const status = useStore($petGalleryStatus)
  const accountId = useStore($atumAccountScopeId)
  const agents = useStore($atumAgents)
  // Owners are read through the keyed atom so an adoption repaints the rows.
  useStore($petInfoByAgent)
  const [adopting, setAdopting] = useState<StorePetRow | null>(null)

  useEffect(() => {
    if (gatewayState === 'open') {
      void loadPetGallery(requestGateway)
    }
  }, [gatewayState, requestGateway])

  useEffect(() => {
    if (accountId) {
      void refreshAtumStoreCatalog().catch(() => null)
    }
  }, [accountId])

  const pets = gallery?.pets ?? []
  const loading = status === 'loading' && pets.length === 0

  // What ships with the app leads the strip — the gallery says which entries
  // are ours, so nothing here knows a pet by name — and petdex's curated picks
  // fill the rest.
  const featured = useMemo(() => {
    const all = rankedGalleryPets(gallery ? { ...gallery, pets: rows } : null, '')

    return [...all.filter(pet => pet.bundled), ...all.filter(pet => !pet.bundled && pet.curated)].slice(0, FEATURED)
  }, [gallery, rows])

  /** Names of the assistants whose pet this is right now. */
  const owners = (slug: string) =>
    agents
      .filter(agent => {
        const info = petInfoFor(agent.id)

        return Boolean(info.enabled) && info.slug === slug
      })
      .map(agent => agent.title || t.atum.roster.assistant)

  const thumb = (pet: StorePetRow, size: number) => (
    <PetThumb alt={pet.displayName} load={(slug, url) => loadPetThumb(requestGateway, slug, url)} size={size} slug={pet.slug} url={pet.spritesheetUrl} />
  )

  const formatAmount = (amount: number) => new Intl.NumberFormat(locale).format(amount)

  // Pills exactly like a skill's: the price until somebody has it, then the
  // verb — and the same button either way, because acquiring is the action.
  const adoptPill = (pet: StorePetRow) => {
    const adopted = owners(pet.slug).length > 0
    // A price this build cannot read is not an invitation. Label it and stop.
    // Owned is always an invitation: the entitlement is the acquisition.
    const offerable = adopted || pet.owned || isAcquirable(pet.price)

    return (
      <button
        className={`shrink-0 rounded-full px-3.5 py-[7px] text-(length:--atum-t-control) font-medium ${adopted ? 'bg-(--atum-hover) text-(--atum-ink) hover:bg-(--atum-pressed)' : 'bg-(--atum-ink) text-(--atum-on-accent)'} ${offerable ? '' : 'opacity-50'}`}
        data-atum-adopt={pet.slug}
        disabled={!offerable}
        onClick={event => {
          event.stopPropagation()
          setAdopting(pet)
        }}
        type="button"
      >
        {adopted || pet.owned ? copy.adopt : <PriceTag copy={copy} formatAmount={formatAmount} price={pet.price} />}
      </button>
    )
  }

  return (
    <div data-testid="discover-pets">
      <div className="mb-1 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">{copy.petsSection}</div>
      <p className="mb-3.5 text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-muted)">{copy.petsIntro}</p>

      {loading ? (
        <div className="mb-3.5 grid grid-cols-3 gap-3.5">
          {Array.from({ length: 3 }, (_, i) => <Skeleton className="h-40 rounded-[var(--atum-r-group)]" key={i} />)}
        </div>
      ) : pets.length === 0 ? (
        <p className="mb-3.5 text-(length:--atum-t-control) text-(--atum-ink-muted)">{t.atum.agents.petUnreachable}</p>
      ) : null}

      {featured.length > 0 && (
        <div className="mb-3.5 grid grid-cols-3 gap-3.5" data-testid="discover-pets-featured">
          {featured.map(pet => (
            <article className="atum-glass-card flex flex-col items-center gap-3 rounded-[var(--atum-r-group)] p-[1.125rem]" data-featured-pet={pet.slug} key={pet.slug}>
              {thumb(pet, 96)}
              <span className="block w-full truncate text-center text-[0.9375rem] font-semibold text-(--atum-ink)">{pet.displayName}</span>
              {/* Owned is an entitlement, never an install: a bundled or petdex
                  pet somebody has carries no badge. */}
              {pet.owned && <span className="-mt-2 text-(length:--atum-t-caption) text-(--atum-ink-faint)" data-atum-owned-badge>{copy.owned}</span>}
              {adoptPill(pet)}
            </article>
          ))}
        </div>
      )}

      <button
        className="rounded-full bg-(--atum-ink) px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-on-accent)"
        data-atum-open-pet-store
        onClick={() => {
          // The store is Discover's Pets shelf now — seed the intent through
          // the one opener; the rail is already here, so nothing navigates.
          // Then switch the mounted panel's shelf directly (the opener's nonce
          // re-adopts the seed too; this keeps the teaser instantaneous).
          openStorefront('pets')
          onOpenStore?.()
        }}
        type="button"
      >
        {t.atum.pets.openStore}
      </button>

      <AdoptPetDialog onOpenChange={open => { if (!open) {setAdopting(null)} }} pet={adopting} />
    </div>
  )
}
