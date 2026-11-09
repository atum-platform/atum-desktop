import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { PetSprite } from '@/components/pet/pet-sprite'
import { PetThumb } from '@/components/pet/pet-thumb'
import { type GalleryPet, loadPetThumb } from '@/store/pet-gallery'

import { $petSheets, holdPetSheet, loadPetSheet } from './store'

/**
 * A pet on a shelf, alive.
 *
 * The still thumbnail paints first (cheap, cached), and the moment the card is
 * near the viewport the real sheet is fetched and the idle loop takes over.
 * The sprite is the same `PetSprite` the in-window pet and the overlay draw
 * with, so what you see on the shelf is exactly what you get on the desktop —
 * no promotional render that the real thing then fails to live up to.
 *
 * Alive only while near: the observer keeps watching, and a card that scrolls
 * out of view goes back to its thumbnail — the sprite (its decoded atlas and
 * its animation loop) is unmounted, not hidden. A viewport of live canvases
 * is fine; a catalog of them, kept running off-screen, is not.
 */
export function LivePetCard({
  children,
  onOpen,
  owners,
  pet,
  size = 96
}: {
  /** The pill, rendered by the shelf so the store owns its own vocabulary. */
  children?: ReactNode
  onOpen: () => void
  owners: string[]
  pet: GalleryPet
  /** Sprite width in px; the frame's aspect sets the height. */
  size?: number
}) {
  const { requestGateway } = useGatewayRequest()
  const sheet = useStore($petSheets)[pet.slug]
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    const el = boxRef.current

    if (!el) {
      return
    }

    if (typeof IntersectionObserver !== 'function') {
      setNear(true)

      return
    }

    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: '160px' })
    observer.observe(el)

    return () => observer.disconnect()
  }, [])

  // While near, this card is a holder: its sheet is never dropped from under
  // it, so a viewport wider than the cache budget grows the cache rather than
  // cycling it.
  useEffect(() => (near ? holdPetSheet(pet.slug) : undefined), [near, pet.slug])

  useEffect(() => {
    if (near && !sheet) {
      void loadPetSheet(requestGateway, pet.slug, { displayName: pet.displayName, url: pet.spritesheetUrl })
    }
  }, [near, pet.displayName, pet.slug, pet.spritesheetUrl, requestGateway, sheet])

  const frameW = sheet?.frameW ?? 192
  const frameH = sheet?.frameH ?? 208
  const height = Math.round((size * frameH) / frameW)
  // The sheet arrives at the gateway's scale 1.0; fit it to the card. Cards
  // are a catalogue, so the pet's own `size` is cancelled here (PetSprite
  // multiplies it back in) — relative size shows on the Meet stage, not here.
  const zoom = size / (frameW * (sheet?.scale ?? 1) * (sheet?.size ?? 1))
  const live = near && Boolean(sheet)

  return (
    <article
      className="atum-glass-card flex flex-col items-center gap-3 rounded-[var(--atum-r-group)] p-[1.125rem]"
      data-pet-card={pet.slug}
      data-pet-live={live ? 'true' : 'false'}
    >
      <button
        aria-label={pet.displayName}
        className="grid place-items-center"
        onClick={onOpen}
        ref={boxRef as never}
        style={{ height, width: size }}
        type="button"
      >
        {live && sheet ? (
          <PetSprite info={sheet} stateOverride="idle" zoom={zoom} />
        ) : (
          <PetThumb alt={pet.displayName} load={(slug, url) => loadPetThumb(requestGateway, slug, url)} size={size} slug={pet.slug} url={pet.spritesheetUrl} />
        )}
      </button>
      <span className="block w-full truncate text-center text-[0.9375rem] font-semibold text-(--atum-ink)">{pet.displayName}</span>
      {owners.length > 0 && (
        <span className="-mt-2 block w-full truncate text-center text-(length:--atum-t-caption) text-(--atum-ink-faint)">{owners.join(' · ')}</span>
      )}
      {children}
    </article>
  )
}
