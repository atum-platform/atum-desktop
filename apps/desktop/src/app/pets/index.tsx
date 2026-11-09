import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { AdoptPetDialog } from '@/app/atum/adopt-pet-dialog'
import { $atumAgents } from '@/app/atum/agents'
import { PriceTag } from '@/app/atum/price-tag'
import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'
import { isAcquirable } from '@/lib/atum-price'
import { Egg } from '@/lib/icons'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $atumShellEnabled } from '@/store/atum-shell'
import { refreshAtumStoreCatalog } from '@/store/atum-store-catalog'
import { $storePetRows } from '@/store/atum-store-pets'
import { $petInfoByAgent, type PetInfo, petInfoFor } from '@/store/pet'
import { $petGallery, $petGalleryStatus, loadPetGallery, rankedGalleryPets, type StorePetRow } from '@/store/pet-gallery'
import { openPetGenerate } from '@/store/pet-generate'
import { $gatewayState } from '@/store/session'

import { petSettingsHref } from '../settings/pet-settings'

import { AdoptCelebration } from './adopt-celebration'
import { LivePetCard } from './live-card'
import { MeetStage } from './meet-stage'
import { $petSheets } from './store'

/**
 * The Pet Store: a shelf of living pets — and, since Discover is the
 * storefront, this IS the Pets shelf: it renders inside the Discover panel
 * (`discover-panel.tsx`), as a docked pane beside the chat (`route-tile.tsx`,
 * identity from the path), and — with the legacy shell — as the `/pets` page.
 *
 * Three shelves, each from data the gateway sends rather than a name anyone
 * typed here — *From Atum* (`bundled`), *Popular* (petdex `curated`), and
 * *Hatch your own* (the generator). Every card animates from its real sheet;
 * tapping one opens the Meet stage, where the pet performs on command before
 * anyone commits. Adoption asks "for which assistant?" and then plays the
 * hatch. Searching collapses the shelves into one result list.
 *
 * This is where you *find* a pet. Changing the one an assistant has stays in
 * that assistant's sheet; managing what is installed stays in Settings.
 */

const SHELF_CAP = 24
/** A card: the 96px sprite plus its padding — a column is never narrower. */

export function PetStoreView() {
  const { locale, t } = useI18n()
  const copy = t.atum.pets
  const navigate = useNavigate()
  const { requestGateway } = useGatewayRequest()
  const gatewayState = useStore($gatewayState)
  const gallery = useStore($petGallery)
  const rows = useStore($storePetRows)
  const status = useStore($petGalleryStatus)
  const accountId = useStore($atumAccountScopeId)
  const agents = useStore($atumAgents)
  useStore($petInfoByAgent)
  const [query, setQuery] = useState('')
  const [ownedOnly, setOwnedOnly] = useState(false)
  const [meeting, setMeeting] = useState<StorePetRow | null>(null)
  const [adopting, setAdopting] = useState<StorePetRow | null>(null)
  const [celebrating, setCelebrating] = useState<null | { agentId: string; pet: StorePetRow; sheet: null | PetInfo }>(null)

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
  const merged = useMemo(() => (gallery ? { ...gallery, pets: rows } : null), [gallery, rows])
  const rankedAll = useMemo(() => rankedGalleryPets(merged, query), [merged, query])
  // The library is a filter on the shelf, not a page: Owned means an
  // entitlement exists, and the chip narrows every shelf to exactly that.
  const ranked = useMemo(() => (ownedOnly ? rankedAll.filter(pet => pet.owned) : rankedAll), [ownedOnly, rankedAll])
  const fromAtum = useMemo(() => ranked.filter(pet => pet.bundled), [ranked])
  const popular = useMemo(() => ranked.filter(pet => !pet.bundled && pet.curated).slice(0, SHELF_CAP), [ranked])
  const searching = query.trim().length > 0

  const nameOf = (id: string) => agents.find(agent => agent.id === id)?.title || t.atum.roster.assistant

  const owners = (slug: string) =>
    agents
      .filter(agent => {
        const info = petInfoFor(agent.id)

        return Boolean(info.enabled) && info.slug === slug
      })
      .map(agent => nameOf(agent.id))

  const formatAmount = (amount: number) => new Intl.NumberFormat(locale).format(amount)

  const pill = (pet: StorePetRow) => {
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
        {adopted || pet.owned ? t.atum.discover.adopt : <PriceTag copy={t.atum.discover} formatAmount={formatAmount} price={pet.price} />}
      </button>
    )
  }

  const onAdopted = useCallback((agentId: string, pet: StorePetRow) => {
    setAdopting(null)
    setMeeting(null)
    // The celebration keeps the sheet it starts with: a picture, not a cache
    // entry, so nothing the shelf loads behind it can take it away.
    setCelebrating({ agentId, pet, sheet: $petSheets.get()[pet.slug] ?? null })
  }, [])

  const shelf = (title: string, items: StorePetRow[], testId: string) =>
    items.length === 0 ? null : (
      <section data-testid={testId}>
        <div className="mb-3.5 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">{title}</div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3.5">
          {items.map(pet => (
            <LivePetCard key={pet.slug} onOpen={() => setMeeting(pet)} owners={owners(pet.slug)} pet={pet}>
              {/* Owned is an entitlement, never an install: a bundled or
                  petdex pet somebody has carries no badge. */}
              {pet.owned && (
                <span className="-mt-2 text-(length:--atum-t-caption) text-(--atum-ink-faint)" data-atum-owned-badge>{t.atum.discover.owned}</span>
              )}
              {pill(pet)}
            </LivePetCard>
          ))}
        </div>
      </section>
    )

  return (
    <section aria-label={copy.title} className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-atum-pet-store>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-10 px-10 pb-10 pt-9">
          <header className="flex flex-col gap-2">
            <h1 className="text-[1.375rem] font-semibold text-(--atum-ink)">{copy.title}</h1>
            <p className="max-w-[40rem] text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-muted)">{copy.subtitle}</p>
            <input
              aria-label={t.atum.agents.petSearch}
              className="atum-input mt-2 w-full max-w-[24rem]"
              onChange={event => setQuery(event.target.value)}
              placeholder={t.atum.agents.petSearch}
              spellCheck={false}
              value={query}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                aria-pressed={ownedOnly}
                className={`rounded-full px-3.5 py-[7px] text-(length:--atum-t-control) font-medium transition-colors ${ownedOnly ? 'bg-(--atum-ink) text-(--atum-on-accent)' : 'bg-(--atum-hover) text-(--atum-ink) hover:bg-(--atum-pressed)'}`}
                data-atum-owned-filter
                onClick={() => setOwnedOnly(current => !current)}
                type="button"
              >
                {t.atum.discover.owned}
              </button>
            </div>
            {/* The mirror of pet-settings' link in: acquiring lives here,
                managing stays in Settings → appearance. The Settings overlay
                opens over the storefront, so a plain navigate is the way out. */}
            <button
              className="mt-1 self-start text-(length:--atum-t-control) text-(--atum-ink-muted) underline underline-offset-2 hover:text-(--atum-ink)"
              data-atum-manage-pets
              onClick={() => navigate(petSettingsHref($atumShellEnabled.get()))}
              type="button"
            >
              {t.atum.discover.manageInstalled}
            </button>
          </header>

          {loading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3.5">
              {Array.from({ length: 8 }, (_, i) => <Skeleton className="h-44 rounded-[var(--atum-r-group)]" key={i} />)}
            </div>
          ) : pets.length === 0 ? (
            <p className="text-(length:--atum-t-control) text-(--atum-ink-muted)">{t.atum.agents.petUnreachable}</p>
          ) : searching ? (
            ranked.length === 0 ? (
              <p className="wrap-anywhere text-(length:--atum-t-control) text-(--atum-ink-muted)">{t.atum.agents.petNoMatch(query)}</p>
            ) : (
              shelf(copy.results, ranked.slice(0, SHELF_CAP * 2), 'pet-store-results')
            )
          ) : (
            <>
              {ownedOnly && ranked.length === 0 && (
                <p className="text-(length:--atum-t-control) text-(--atum-ink-muted)">{t.atum.discover.ownedEmpty}</p>
              )}
              {shelf(copy.fromAtum, fromAtum, 'pet-store-atum')}
              {shelf(copy.popular, popular, 'pet-store-popular')}
              <section data-testid="pet-store-hatch">
                <div className="mb-3.5 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">{copy.hatchTitle}</div>
                <article className="atum-glass-card flex items-center gap-4 rounded-[var(--atum-r-group)] p-[1.125rem]">
                  <span aria-hidden className="atum-avatar grid size-12 shrink-0 place-items-center bg-(--atum-sunk) text-(--atum-ink)">
                    <Egg className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.9375rem] font-semibold text-(--atum-ink)">{copy.hatchLead}</span>
                    <span className="mt-[3px] block text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-muted)">{copy.hatchBody}</span>
                  </span>
                  <button
                    className="shrink-0 rounded-full bg-(--atum-ink) px-3.5 py-[7px] text-(length:--atum-t-control) font-medium text-(--atum-on-accent)"
                    data-atum-hatch
                    onClick={() => openPetGenerate()}
                    type="button"
                  >
                    {copy.hatchAction}
                  </button>
                </article>
              </section>
            </>
          )}
        </div>
      </div>

      <MeetStage onAdopt={() => setAdopting(meeting)} onOpenChange={open => { if (!open) {setMeeting(null)} }} owners={meeting ? owners(meeting.slug) : []} pet={meeting} />
      <AdoptPetDialog onAdopted={onAdopted} onOpenChange={open => { if (!open) {setAdopting(null)} }} pet={adopting} />
      {celebrating && (
        <AdoptCelebration
          assistantName={nameOf(celebrating.agentId)}
          onDone={() => setCelebrating(null)}
          petName={celebrating.pet.displayName}
          sheet={celebrating.sheet}
        />
      )}
    </section>
  )
}
