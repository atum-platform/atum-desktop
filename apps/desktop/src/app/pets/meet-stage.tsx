import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { PriceTag } from '@/app/atum/price-tag'
import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { PetSprite } from '@/components/pet/pet-sprite'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { isAcquirable } from '@/lib/atum-price'
import type { PetState } from '@/store/pet'
import type { GalleryPet } from '@/store/pet-gallery'

import { $petSheets, holdPetSheet, loadPetSheet } from './store'

/**
 * Meet a pet before you adopt it.
 *
 * A big stage, the pet on it, and the things a pet can do — wave, jump, sit,
 * lounge, walk — each a button. The animation rows are the real ones the
 * desktop plays, driven through `PetSprite`'s override rather than the live
 * `$petState`, so meeting a pet never disturbs the one already on your desk.
 *
 * Adoption stays with `AdoptPetDialog`: this stage answers "what is it like?",
 * that dialog answers "for which assistant?".
 */

/** How long each commanded pose holds before the pet settles back to idle. */
const HOLD_MS: Partial<Record<PetState, number>> = { jump: 1400, lounging: 6000, run: 2200, waiting: 2600, wave: 1600 }

/** Share of the stage a size-1 pet fills; larger pets fill more, up to all of it. */
const MEET_STAGE_FILL = 0.66

export function MeetStage({
  onAdopt,
  onOpenChange,
  owners,
  pet
}: {
  onAdopt: (pet: GalleryPet) => void
  onOpenChange: (open: boolean) => void
  owners: string[]
  /** `owned` when the row came from the store merge: an entitlement exists. */
  pet: (GalleryPet & { owned?: boolean }) | null
}) {
  const { locale, t } = useI18n()
  const copy = t.atum.pets
  const { requestGateway } = useGatewayRequest()
  const sheet = useStore($petSheets)[pet?.slug ?? '']
  const [pose, setPose] = useState<PetState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The stage holds the sheet it is showing: cache pressure from the shelf
  // behind it never blanks the pet somebody is meeting.
  useEffect(() => (pet ? holdPetSheet(pet.slug) : undefined), [pet?.slug])

  useEffect(() => {
    if (pet && !sheet) {
      void loadPetSheet(requestGateway, pet.slug, { displayName: pet.displayName, url: pet.spritesheetUrl })
    }
  }, [pet, requestGateway, sheet])

  // A fresh pet, a fresh stage.
  useEffect(() => {
    setPose('idle')
    clearTimeout(timer.current)
  }, [pet?.slug])

  useEffect(() => () => clearTimeout(timer.current), [])

  const perform = (next: PetState) => {
    clearTimeout(timer.current)
    setPose(next)
    timer.current = setTimeout(() => setPose('idle'), HOLD_MS[next] ?? 1500)
  }

  const frameW = sheet?.frameW ?? 192
  const frameH = sheet?.frameH ?? 208
  const stageW = 288
  // The stage is where relative size shows: a size-1 pet fills two thirds of
  // it and a Saint Bernard nearly all of it, clamped so nothing overflows.
  // `fit` cancels the sprite's own size (PetSprite multiplies it back in).
  const size = sheet?.size ?? 1
  const fit = stageW / (frameW * (sheet?.scale ?? 1) * size)
  const zoom = fit * Math.min(1, MEET_STAGE_FILL * size)

  const actions: Array<[PetState, string]> = [
    ['wave', copy.wave],
    ['jump', copy.jump],
    ['waiting', copy.sit],
    ['lounging', copy.lounge],
    ['run', copy.walk]
  ]

  return (
    <Dialog onOpenChange={onOpenChange} open={pet !== null}>
      <DialogContent className="max-w-[30rem] border-(--atum-line) bg-(--atum-card) text-(--atum-ink)" data-atum-meet-stage>
        <DialogHeader>
          <DialogTitle className="text-(--atum-ink)">{copy.meetTitle(pet?.displayName ?? '')}</DialogTitle>
          <DialogDescription className="text-(--atum-ink-muted)">
            {owners.length > 0 ? t.atum.discover.addedFor(owners[0]!) : copy.meetBody}
          </DialogDescription>
        </DialogHeader>

        {/* The stage: a soft floor line so the pet stands on something. */}
        <div
          className="relative mx-auto grid place-items-end rounded-[var(--atum-r-group)] bg-(--atum-sunk)"
          data-atum-meet-pose={pose}
          style={{ height: Math.round((stageW * frameH) / frameW) + 24, width: stageW + 48 }}
        >
          <div className="mx-auto mb-3">
            {sheet ? <PetSprite info={sheet} stateOverride={pose} zoom={zoom} /> : <div style={{ height: Math.round((stageW * frameH) / frameW), width: stageW }} />}
          </div>
        </div>

        <div className="flex flex-wrap justify-center gap-1.5" role="group">
          {actions.map(([state, label]) => (
            <button
              aria-pressed={pose === state}
              className={`rounded-full px-3.5 py-[7px] text-(length:--atum-t-control) font-medium ${pose === state ? 'bg-(--atum-ink) text-(--atum-on-accent)' : 'bg-(--atum-hover) text-(--atum-ink) hover:bg-(--atum-pressed)'}`}
              data-atum-meet-action={state}
              disabled={!sheet}
              key={state}
              onClick={() => perform(state)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{pet ? <PriceTag copy={t.atum.discover} formatAmount={amount => new Intl.NumberFormat(locale).format(amount)} price={pet.price} /> : ''}</span>
          <button
            className="rounded-full bg-(--atum-ink) px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-on-accent) disabled:opacity-50"
            data-atum-meet-adopt
            // Owning it, or already having adopted it, is always an
            // invitation — the same rule the shelf pill uses. A listed item
            // whose offer was withdrawn prices as `unavailable` even for its
            // buyer, and this button used to lock them out of their own pet
            // Preserve the recovery and user-visible behavior covered by this path.
            disabled={!pet || !(owners.length > 0 || pet.owned === true || isAcquirable(pet.price))}
            onClick={() => pet && onAdopt(pet)}
            type="button"
          >
            {t.atum.discover.adopt}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
