import { Slider as SliderPrimitive } from 'radix-ui'
import { type ReactNode, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Bolt, Rotate } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  MATRIX_PRODUCT_EFFORTS,
  type MatrixProductEffort,
  parseMatrixModelCapabilities
} from '../../shared/matrix-model-choice'

/** The level a model rests on when nothing was chosen (shown as Cân bằng), and what reset picks. */
const RESTING_EFFORT: MatrixProductEffort = 'medium'

/** Half the thumb's 24px box: Radix keeps the thumb inside the track by this much at each end. */
const THUMB_HALF = 12

const percentOf = (step: number, steps: number) => (steps > 1 ? (step / (steps - 1)) * 100 : 0)

/** A step's centre on the track, the same in-bounds offset Radix gives the thumb. */
const centreOf = (percent: number) => `calc(${percent}% + ${THUMB_HALF * (1 - percent / 50)}px)`

export interface MatrixModelEffortSliderProps {
  /** A validated model descriptor from the native offer; absence never implies support. */
  capability: unknown
  value?: MatrixProductEffort
  disabled?: boolean
  managed?: boolean
  onChange: (effort: MatrixProductEffort) => void
  /** The model's line under the level: its name, and (when there is a choice) the way to the list. */
  model?: ReactNode
}

/**
 * How hard the model thinks, as one card (owner, 0.19.1: "I wanted the visual slider, not a
 * scrappy tab"): the level's name large, the model's line under it, a reset to Cân bằng, and a
 * pill slider with a stop per advertised level. Only levels the model takes are stops; a drag
 * saves where it is let go, a key saves each step. No inference from provider or model names.
 */
export function MatrixModelEffortSlider({
  capability,
  value,
  disabled,
  managed,
  onChange,
  model
}: MatrixModelEffortSliderProps) {
  const { t } = useI18n()
  const words = t.models
  const captionId = useId()
  // The step under a dragged thumb, shown until it is let go; stale once the level changes.
  const [drag, setDrag] = useState<{ step: number; from?: MatrixProductEffort } | null>(null)
  // Whether the slider's latest interaction is a pointer (a drag previews) or a key (saves now).
  const pointer = useRef(false)

  // Canonical order, so the stops always run from quicker to more thorough.
  const efforts = [...(parseMatrixModelCapabilities(capability)?.efforts ?? [])].sort(
    (a, b) => MATRIX_PRODUCT_EFFORTS.indexOf(a) - MATRIX_PRODUCT_EFFORTS.indexOf(b)
  )

  const selected =
    value && efforts.includes(value) ? value : !value && efforts.includes(RESTING_EFFORT) ? RESTING_EFFORT : undefined

  if (!efforts.length) {
    return model ? (
      <div className="flex justify-center px-1 pt-1" data-matrix-model-effort-none>
        {model}
      </div>
    ) : null
  }

  const resting =
    selected ?? (efforts.includes(RESTING_EFFORT) ? RESTING_EFFORT : efforts[Math.floor((efforts.length - 1) / 2)])

  const preview = drag && drag.from === value ? drag.step : null
  const index = preview ?? efforts.indexOf(resting)
  const shown = preview === null ? selected : efforts[index]
  const label = shown ? words.efforts[shown] : words.effortDefaultLabel
  const resetLabel = words.effortReset(words.efforts[RESTING_EFFORT])
  const resettable = efforts.includes(RESTING_EFFORT) && selected !== RESTING_EFFORT
  const percent = percentOf(index, efforts.length)

  const commit = (step: number) => {
    setDrag(null)
    const effort = efforts[step]

    if (effort && !disabled && effort !== selected) {
      onChange(effort)
    }
  }

  return (
    <div className="px-1 pt-1" data-matrix-model-effort>
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-start gap-1">
        <Bolt aria-hidden className="mt-1.5 size-4 text-(--atum-ink-muted)" />
        <div className="min-w-0 text-center">
          <p
            aria-hidden
            className="truncate text-(length:--atum-t-section) leading-tight font-semibold text-(--atum-accent)"
            data-matrix-model-effort-label
          >
            {label}
          </p>
          {model && <div className="mt-0.5 flex justify-center">{model}</div>}
        </div>
        {resettable ? (
          <Tip label={resetLabel}>
            <Button
              aria-label={resetLabel}
              className="mt-0.5"
              data-matrix-model-effort-reset
              disabled={disabled}
              onClick={() => commit(efforts.indexOf(RESTING_EFFORT))}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Rotate aria-hidden className="size-3.5" />
            </Button>
          </Tip>
        ) : (
          <span aria-hidden />
        )}
      </div>
      {efforts.length > 1 && (
        <SliderPrimitive.Root
          className="relative mt-3 flex h-6 w-full touch-none items-center select-none data-[disabled]:opacity-50"
          data-matrix-model-effort-slider
          disabled={disabled}
          max={efforts.length - 1}
          min={0}
          onKeyDown={() => {
            pointer.current = false
          }}
          onPointerDown={() => {
            pointer.current = true
          }}
          // A key commits before it changes (Radix): its change saves. A drag changes as it moves
          // and commits once, where it is let go.
          onValueChange={([step]) => {
            if (pointer.current) {
              setDrag({ step, from: value })
            } else {
              commit(step)
            }
          }}
          onValueCommit={([step]) => {
            if (pointer.current) {
              commit(step)
            }
          }}
          step={1}
          value={[index]}
        >
          <SliderPrimitive.Track className="relative h-full w-full grow overflow-hidden rounded-full bg-(--atum-line-strong)">
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-full bg-(--atum-accent) transition-[width] duration-150 ease-out motion-reduce:transition-none"
              style={{ width: `calc(${percent}% + ${THUMB_HALF * (1 - percent / 50) + THUMB_HALF}px)` }}
            />
            {efforts.map((level, step) => (
              <span
                aria-hidden
                className={cn(
                  'absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  step <= index
                    ? 'bg-[color-mix(in_srgb,var(--atum-on-accent)_55%,transparent)]'
                    : 'bg-(--atum-ink-faint)'
                )}
                data-matrix-model-effort-stop={level}
                key={level}
                style={{ left: centreOf(percentOf(step, efforts.length)) }}
              />
            ))}
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-describedby={captionId}
            aria-label={words.effort}
            aria-valuetext={label}
            className="block size-6 cursor-grab border-2 border-transparent bg-(--atum-on-accent) bg-clip-padding outline-none [filter:drop-shadow(0_1px_1.5px_rgb(0_0_0/0.28))] transition-transform duration-150 ease-out focus-visible:scale-110 active:cursor-grabbing motion-reduce:transition-none"
            // Inline: the global `*:focus-visible { border-radius: inherit }` (unlayered) would
            // otherwise square a keyboard-focused thumb; a larger thumb is its focus mark instead.
            style={{ borderRadius: '9999px' }}
          />
        </SliderPrimitive.Root>
      )}
      <p className="mt-2 px-0.5 text-xs leading-snug text-(--atum-ink-muted)" id={captionId} role="status">
        {shown ? words.effortHelp[shown] : words.modelDefault}
        {managed && (shown === 'high' || shown === 'max') && <> {words.effortProtons}</>}
      </p>
    </div>
  )
}
