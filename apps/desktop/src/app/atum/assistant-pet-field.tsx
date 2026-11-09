import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { PetThumb } from '@/components/pet/pet-thumb'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'
import { PawPrint } from '@/lib/icons'
import { selectableCardClass } from '@/lib/selectable-card'
import { cn } from '@/lib/utils'
import { $storePetRows } from '@/store/atum-store-pets'
import { $petInfoByAgent, petInfoFor } from '@/store/pet'
import { $petGallery, $petGalleryStatus, loadPetGallery, loadPetThumb, rankedGalleryPets, refreshPetInfoFor } from '@/store/pet-gallery'
import { $gatewayState } from '@/store/session'

import { PriceTag } from './price-tag'
import { useOpenStorefront } from './use-open-storefront'

/**
 * Which pet an assistant has, inside the sheet where you change everything else
 * about it.
 *
 * A pet is agent identity here, not a global preference — the same axis as the
 * name and the photo — so it belongs beside them rather than in Settings, which
 * can only ever describe the assistant you happen to be chatting with.
 *
 * The choice is *staged*, like the photo: this field reports a slug and the
 * sheet writes it on save. A picker that adopted on click would leave the pet
 * changed after you pressed Cancel.
 *
 * It expands in place rather than opening a second dialog. Nothing else in the
 * app stacks dialogs, and a picker nested in the edit sheet would put two focus
 * traps and two Escape targets on screen at once.
 */

/** How many catalog entries to render. petdex ships thousands. */
const RENDER_CAP = 30

export interface AtumAssistantPetFieldProps {
  /** The assistant's agent key (its Hermes profile key). */
  agentId: null | string
  disabled: boolean
  /** Called with the chosen slug. */
  onChange: (slug: string) => void
  /** The staged slug, or null while the assistant's own pet is unchanged. */
  value: null | string
  /** The sheet that hosts this field. "Open the Pet Store" leaves the sheet, so
   *  the sheet must close between the shell state and the navigation (the
   *  ordering rule) — a modal left open would float over the storefront, and a
   *  collapsing roster would unmount it without its own close running. */
  onClose?: () => void
}

export function AtumAssistantPetField({
  agentId,
  disabled,
  onChange,
  onClose,
  value
}: AtumAssistantPetFieldProps) {
  const { locale, t } = useI18n()
  const copy = t.atum.agents
  const { requestGateway } = useGatewayRequest()
  const openStorefront = useOpenStorefront()
  const gatewayState = useStore($gatewayState)
  const gallery = useStore($petGallery)
  const status = useStore($petGalleryStatus)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  // This assistant's own pet, which is usually not the active one. Read through
  // the keyed atom rather than calling `petInfoFor` bare: the refresh below
  // lands asynchronously, and a plain call would leave the field showing "no
  // pet" until something else happened to re-render the sheet.
  useStore($petInfoByAgent)
  const current = agentId ? petInfoFor(agentId) : null

  useEffect(() => {
    if (gatewayState !== 'open' || !agentId) {
      return
    }

    void refreshPetInfoFor(requestGateway, agentId)
  }, [agentId, gatewayState, requestGateway])

  // The catalog is only fetched once the picker is actually opened: the sheet is
  // usually opened to rename someone, and the petdex manifest is thousands of
  // entries over the network.
  useEffect(() => {
    if (!open || gatewayState !== 'open') {
      return
    }

    void loadPetGallery(requestGateway)
  }, [open, gatewayState, requestGateway])

  const pets = useStore($storePetRows)
  const staged = value ? pets.find(pet => pet.slug === value) : null
  const shownSlug = value ?? current?.slug ?? ''
  const shownName = staged?.displayName || (value ? value : current?.displayName) || ''
  const loading = open && status === 'loading' && pets.length === 0

  // The picker lists the storefront rows (gallery merged with the catalog), so
  // a pet the catalog prices shows its price here instead of reading as free:
  // buying lives in the store, never in this sheet. Adoptable here means free
  // by source class or already owned — anything else is labelled and disabled.
  const shown = useMemo(
    () => rankedGalleryPets(gallery ? { ...gallery, pets } : null, query).slice(0, RENDER_CAP),
    [gallery, pets, query]
  )

  const choose = (slug: string) => {
    onChange(slug)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="space-y-2" data-atum-agent-pet-field>
      <div className="flex items-center gap-3">
        {shownSlug ? (
          <PetThumb
            alt={shownName}
            load={(slug, url) => loadPetThumb(requestGateway, slug, url)}
            size={56}
            slug={shownSlug}
            url={staged?.spritesheetUrl}
          />
        ) : (
          <span className="atum-avatar grid size-14 shrink-0 place-items-center bg-(--atum-sunk) text-(--atum-ink-muted)">
            <PawPrint aria-hidden className="size-5" />
          </span>
        )}
        <div className="min-w-0 space-y-1">
          <span className="block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)">{copy.petLabel}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              data-atum-agent-pet-change
              disabled={disabled}
              onClick={() => setOpen(value_ => !value_)}
              size="sm"
              variant="secondary"
            >
              {open ? t.common.cancel : shownSlug ? copy.petChange : copy.petChoose}
            </Button>
            {shownName && !open && (
              <span className="min-w-0 truncate text-(length:--atum-t-caption) text-(--atum-ink-muted)">{shownName}</span>
            )}
          </div>
        </div>
      </div>

      {!shownSlug && !open && (
        <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.petNone}</p>
      )}

      {open && (
        <div className="space-y-2 rounded-(--atum-r-card) border border-(--atum-hairline) p-2">
          <Input
            aria-label={copy.petSearch}
            className="atum-input"
            onChange={event => setQuery(event.target.value)}
            placeholder={copy.petSearch}
            value={query}
          />
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {loading ? (
              Array.from({ length: 4 }, (_, i) => <Skeleton className="h-12 w-full rounded-md" key={i} />)
            ) : shown.length === 0 ? (
              <p className="wrap-anywhere px-1 py-2 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {pets.length === 0 ? copy.petUnreachable : copy.petNoMatch(query)}
              </p>
            ) : (
              shown.map(pet => {
                const adoptableHere = pet.owned || pet.price.kind === 'free'

                return (
                <button
                  className={cn(
                    'flex w-full items-center gap-2.5 px-2.5 py-2 text-left',
                    selectableCardClass({ active: pet.slug === shownSlug, prominent: pet.installed })
                  )}
                  disabled={!adoptableHere}
                  key={pet.slug}
                  onClick={() => choose(pet.slug)}
                  type="button"
                >
                  <PetThumb
                    alt={pet.displayName}
                    load={(slug, url) => loadPetThumb(requestGateway, slug, url)}
                    size={32}
                    slug={pet.slug}
                    url={pet.spritesheetUrl}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-(length:--atum-t-body) font-medium">{pet.displayName}</span>
                    <span className="block truncate text-(length:--atum-t-caption) text-(--atum-ink-muted)">{pet.slug}</span>
                  </span>
                  {/* A priced pet is bought in the store, not staged here; an
                      unknown price (catalog not yet answered) is unavailable.
                      Owned carries the same badge the storefront shows. */}
                  {pet.owned ? (
                    <span className="shrink-0 text-(length:--atum-t-caption) text-(--atum-ink-faint)">{t.atum.discover.owned}</span>
                  ) : pet.price.kind !== 'free' ? (
                    <span className="shrink-0 text-(length:--atum-t-caption) text-(--atum-ink-faint)"><PriceTag copy={t.atum.discover} formatAmount={amount => new Intl.NumberFormat(locale).format(amount)} price={pet.price} /></span>
                  ) : null}
                </button>
                )
              })
            )}
          </div>
          {/* The staged picker above chooses from what this profile already has
              a thumb for; the whole catalog is the storefront's job, so the
              browse affordance goes through the one opener like everywhere
              else. The sheet closes BETWEEN the shell state and the navigate
              (the opener's ordering rule): a modal left open would float over
              the storefront. */}
          <button
            className="px-1 text-(length:--atum-t-caption) text-(--atum-ink-muted) hover:text-(--atum-ink) disabled:opacity-50"
            data-atum-agent-pet-browse
            // While the sheet is saving its own close is a no-op, so leaving
            // for the storefront would strand the modal over it
            // Preserve the recovery and user-visible behavior covered by this path.
            disabled={disabled}
            onClick={() => openStorefront('pets', { beforeNavigate: onClose })}
            type="button"
          >
            {t.atum.pets.openStore}
          </button>
        </div>
      )}
    </div>
  )
}
