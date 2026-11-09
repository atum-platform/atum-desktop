import { useStore } from '@nanostores/react'

import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $petGenStyle, type PetGenStyle, setPetGenStyle } from '@/store/pet-generate'

/**
 * Two ways to hatch, side by side: Voxel (a model writes a spec, Atum draws
 * it — the house style, seconds, the default) and Illustrated (an image model
 * draws every frame). Always visible so the choice is never a surprise.
 */
export function StyleSwitch({ disabled }: { disabled?: boolean }) {
  const { t } = useI18n()
  const copy = t.commandCenter.generatePet
  const style = useStore($petGenStyle)
  const options: Array<[PetGenStyle, string]> = [
    ['voxel', copy.styleVoxel],
    ['illustrated', copy.styleIllustrated]
  ]

  return (
    <div aria-label={copy.styleLabel} className="flex h-6 items-center gap-0.5 rounded-full bg-(--ui-input-background) p-0.5" role="radiogroup">
      {options.map(([value, label]) => (
        <button
          aria-checked={style === value}
          className={cn(
            'rounded-full px-2 text-[0.6875rem] leading-5 transition',
            style === value ? 'bg-background text-foreground shadow-sm' : 'text-(--ui-text-tertiary) hover:text-foreground'
          )}
          data-atum-pet-style={value}
          disabled={disabled}
          key={value}
          onClick={() => setPetGenStyle(value)}
          role="radio"
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  )
}
