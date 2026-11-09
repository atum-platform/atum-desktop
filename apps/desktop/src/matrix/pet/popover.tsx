import { useEffect, useRef } from 'react'

import { ProtonAmount } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'

import { MATRIX_PET_DEFAULT_SCALE } from '../../../shared/matrix-pet'
import type { MatrixPetDisplayBridge } from '../../../shared/matrix-pet-display'
import { focusMatrixComposer } from '../composer-focus'
import { petCopy } from '../pet-copy'
import { microProtons } from '../wallet-ui'

import { petChoices } from './catalog'
import type { PetHatch } from './hatch'
import { PetHatchPanel } from './hatch-panel'
import { type PetAction, PetActions } from './menu'
import { PetOverlayPreferences } from './overlay-preferences'
import { PetThumb } from './pet-thumb'
import type { PetSelection } from './selection'

interface PetPopoverProps {
  selection: PetSelection
  hatch: PetHatch
  open: boolean
  onOpenChange(open: boolean): void
  actions?: readonly PetAction[]
  focusSize?: number
  /** Changes when a hatch is asked for from elsewhere (the Store): the picker opens on the
   * hatch panel's description and photo instead of its first action. 0 for an ordinary open. */
  focusHatch?: number
  display?: MatrixPetDisplayBridge
}

export function PetPopover({
  selection,
  hatch,
  open,
  onOpenChange,
  actions = [],
  focusSize = 0,
  focusHatch = 0,
  display
}: PetPopoverProps) {
  const { locale } = useI18n()
  const copy = petCopy[locale]
  const content = useRef<HTMLDivElement>(null)
  // Radix calls close autofocus after this content and its ref are detached.
  // Track ownership while mounted, including action/native controlled closes.
  const ownedFocus = useRef(false)
  const { view, catalog, error, pending, scale, setScale, canEdit, read, write, acquire } = selection
  const pet = view?.selection.pet
  const { choices, available } = petChoices(catalog)
  const sizeText = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(scale)

  useEffect(() => {
    if (open && focusSize) {
      content.current?.querySelector<HTMLElement>('[role="slider"]')?.focus()
    }
  }, [open, focusSize])

  // A read that could not bring the catalog leaves the picker to ask for it when it opens.
  const { loadCatalog } = selection
  const shown = Boolean(view)

  useEffect(() => {
    if (open && shown && !catalog) {
      void loadCatalog()
    }
  }, [open, shown, catalog, loadCatalog])

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverAnchor asChild>
        <span aria-hidden className="block size-px" />
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="max-h-[min(calc(100dvh-2rem),var(--radix-popover-content-available-height))] space-y-4 overflow-y-auto"
        data-pet-own
        onBlurCapture={event => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
            ownedFocus.current = false
          }
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const restore = ownedFocus.current
          ownedFocus.current = false
          // An action may already have focused a newly opened sheet. Never
          // steal that focus, or focus moved intentionally outside the picker.
          const active = window.document.activeElement

          if (restore && (!active || active === window.document.body)) {
            focusMatrixComposer()
          }
        }}
        onFocusCapture={() => { ownedFocus.current = true }}
        onInteractOutside={() => { ownedFocus.current = false }}
        onOpenAutoFocus={event => {
          ownedFocus.current = false

          // The hatch panel focuses its description itself, once the catalog it needs is here.
          if (focusHatch) {
            event.preventDefault()

            return
          }

          if (focusSize) {
            const slider = content.current?.querySelector<HTMLElement>('[role="slider"]')

            if (slider) {
              event.preventDefault()
              slider.focus()
            }
          }
        }}
        ref={content}
        side="top"
      >
        <section aria-label={copy.actions}>
          <p className="text-sm font-medium">{copy.actions}</p>
          <PetActions actions={actions} />
        </section>
        <p className="text-sm font-medium">{copy.choose}</p>
        <div className="grid grid-cols-2 gap-1">
          {choices.map(item => (
            <PetThumb
              disabled={!canEdit}
              item={item}
              key={JSON.stringify(item.ref)}
              onClick={() =>
                void write({ ref: item.ref, enabled: true, scale: pet?.scale ?? MATRIX_PET_DEFAULT_SCALE })
              }
              selected={JSON.stringify(pet?.ref) === JSON.stringify(item.ref)}
            />
          ))}
        </div>
        {catalog && choices.length === 0 && <p className="text-xs text-muted-foreground">{copy.empty}</p>}
        {available.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">{copy.store}</p>
            {available.map(item => (
              <PetThumb
                aria-label={`${copy.acquire} ${item.name}`}
                disabled={!canEdit || !item.offer}
                item={item}
                key={JSON.stringify(item.ref)}
                onClick={() => void acquire(item)}
              >
                {item.offer ? (
                  <ProtonAmount
                    amount={microProtons(item.offer.priceMicroProtons, locale)}
                    spoken={`${microProtons(item.offer.priceMicroProtons, locale)} ${copy.protons}`}
                  />
                ) : (
                  ''
                )}
              </PetThumb>
            ))}
          </div>
        )}
        <PetHatchPanel focusKey={focusHatch} hatch={hatch} selection={selection} />
        {display && <PetOverlayPreferences bridge={display} />}
        <Button
          disabled={!canEdit}
          onClick={() => void write({ ref: null, enabled: false, scale: pet?.scale ?? MATRIX_PET_DEFAULT_SCALE })}
          size="sm"
          variant="text"
        >
          {copy.none}
        </Button>
        {pet?.ref && (
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>{copy.visible}</span>
            <Checkbox
              aria-label={copy.visible}
              checked={pet.enabled}
              disabled={!canEdit}
              onCheckedChange={checked => void write({ ...pet, enabled: checked === true })}
            />
          </label>
        )}
        {pet?.ref && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <span>{copy.size}</span>
              <Slider
                aria-label={copy.size}
                aria-valuetext={sizeText}
                disabled={!canEdit}
                max={3}
                min={0.1}
                onValueChange={values => setScale(values[0])}
                step={0.01}
                value={[scale]}
              />
              <output className="text-xs tabular-nums">{sizeText}</output>
            </label>
            <Button
              disabled={!canEdit || scale === pet.scale}
              onClick={() => void write({ ...pet, scale })}
              size="sm"
              variant="text"
            >
              {copy.save}
            </Button>
          </div>
        )}
        <div aria-live="polite" className="text-xs text-muted-foreground">
          {pending ? (
            <Spinner className="size-4 animate-spin" label={copy.loading} />
          ) : error ? (
            copy[error]
          ) : view?.assetUnavailable ? (
            copy.asset
          ) : view?.visitUnavailable ? (
            copy.visit
          ) : view?.freshness === 'offline' ? (
            copy.offline
          ) : view?.cacheUnavailable ? (
            copy.cache
          ) : view ? (
            error === 'priceChanged' ? (
              copy.priceChanged
            ) : error === 'refused' ? (
              copy.refused
            ) : error === 'uncertain' ? (
              copy.uncertain
            ) : (
              copy.saved
            )
          ) : (
            ''
          )}
        </div>
        <Button disabled={pending} onClick={() => void read()} size="sm" variant="text">
          {copy.retry}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
