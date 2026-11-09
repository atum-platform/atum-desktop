import { useEffect, useState } from 'react'

import { PetHeartField } from '@/components/chat/vibe-hearts'
import { PetEggHatch } from '@/components/pet/pet-egg-hatch'
import { PetSprite } from '@/components/pet/pet-sprite'
import { PetStarShower } from '@/components/pet/pet-star-shower'
import { useI18n } from '@/i18n'
import type { PetInfo } from '@/store/pet'
import { useAppViewOverlayHold } from '@/store/use-app-view-overlay'

/**
 * The moment after "Adopt": an egg, a crack, and the pet stepping out to meet
 * the assistant it now belongs to. Two beats, then it gets out of the way.
 *
 * Built from the pieces the hatch flow already had — the egg, the stars, the
 * hearts — so a bundled pet and a generated one arrive the same way.
 */

const EGG_MS = 1400
const HATCHED_MS = 2600

export function AdoptCelebration({
  assistantName,
  onDone,
  petName,
  sheet
}: {
  assistantName: string
  onDone: () => void
  petName: string
  sheet: null | PetInfo
}) {
  const { t } = useI18n()
  const copy = t.atum.pets
  const [phase, setPhase] = useState<'egg' | 'hatched'>('egg')
  // A full-screen layer over the workspace: hold the app-view token so a
  // native view (a PDF, say) cannot paint over the hatch.
  useAppViewOverlayHold()

  useEffect(() => {
    const crack = setTimeout(() => setPhase('hatched'), EGG_MS)
    const done = setTimeout(onDone, EGG_MS + HATCHED_MS)

    return () => {
      clearTimeout(crack)
      clearTimeout(done)
    }
  }, [onDone])

  const frameW = sheet?.frameW ?? 192
  const frameH = sheet?.frameH ?? 208
  const width = 240
  // Fit to the celebration frame; the pet's own `size` is cancelled (PetSprite
  // multiplies it back in), like the store cards.
  const zoom = width / (frameW * (sheet?.scale ?? 1) * (sheet?.size ?? 1))
  const height = Math.round((width * frameH) / frameW)

  return (
    <div
      aria-live="polite"
      className="fixed inset-0 z-[70] grid place-items-center bg-[color-mix(in_srgb,var(--atum-card)_88%,transparent)] backdrop-blur-sm"
      data-atum-adopt-celebration={phase}
      onClick={onDone}
      role="status"
    >
      <div className="relative flex flex-col items-center gap-4">
        {phase === 'egg' ? (
          <PetEggHatch subtitle={copy.hatching} />
        ) : (
          <>
            <div className="relative" style={{ height, width }}>
              <PetStarShower />
              {sheet && <PetSprite info={sheet} stateOverride="jump" zoom={zoom} />}
              <PetHeartField petH={height} petW={width} />
            </div>
            <p className="text-center text-[1.0625rem] font-semibold text-(--atum-ink)">{copy.hatched(petName, assistantName)}</p>
          </>
        )}
      </div>
    </div>
  )
}
