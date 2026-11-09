import { useId, useState } from 'react'

import { useI18n } from '@/i18n'
import { displayModelName, reasoningEffortLabel } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'

import { atumModelSelectionLabel, type AtumModelSliderOption } from './atum-model-slider-options'

interface AtumModelSliderProps {
  currentEffort: string
  currentModel: string
  disabled?: boolean
  thinkingOnly?: boolean
  fasterLabel: string
  onSelect: (option: AtumModelSliderOption) => Promise<boolean>
  smarterLabel: string
  options: readonly AtumModelSliderOption[]
  unavailableLabel: string
}

/**
 * The consumer model/effort control: one continuous track from quicker to
 * deeper, with a stop per option.
 *
 * The track paints its own progress — filled to the thumb, hollow past it —
 * because a bare `<input type="range">` reads as a form control dropped into
 * a product surface. `--atum-slider-fill` is the only thing that changes per
 * selection, so the paint is one custom property away from the value and
 * cannot drift from the thumb.
 */
export function AtumModelSlider({
  currentEffort,
  currentModel,
  disabled = false,
  thinkingOnly = false,
  fasterLabel,
  onSelect,
  options,
  smarterLabel,
  unavailableLabel
}: AtumModelSliderProps) {
  const { t } = useI18n()
  const thinkingLabelId = useId()

  const effortLabel = (effort: string) => {
    const labels: Record<string, string> = {
      none: t.common.off,
      minimal: t.shell.modelOptions.minimal,
      low: t.shell.modelOptions.low,
      medium: t.shell.modelOptions.medium,
      high: t.shell.modelOptions.high,
      xhigh: t.shell.modelOptions.xhigh,
      max: t.shell.modelOptions.max,
      ultra: t.shell.modelOptions.ultra
    }

    return labels[effort] ?? reasoningEffortLabel(effort)
  }

  const [pending, setPending] = useState(false)
  const [unavailableAttempt, setUnavailableAttempt] = useState(false)

  const exactIndex = options.findIndex(
    option => option.model === currentModel && (!option.effort || option.effort === currentEffort)
  )

  const selectedIndex = Math.max(
    0,
    exactIndex >= 0 ? exactIndex : options.findIndex(option => option.model === currentModel)
  )

  const selected = options[selectedIndex]

  if (!selected) {
    return null
  }

  const selectIndex = async (index: number) => {
    const option = options[index]

    if (!option || pending || disabled) {
      return
    }

    if (option.unavailable) {
      setUnavailableAttempt(true)

      return
    }

    setUnavailableAttempt(false)
    setPending(true)

    try {
      await onSelect(option)
    } finally {
      setPending(false)
    }
  }

  const currentLabel = atumModelSelectionLabel(options, currentModel, currentEffort, displayModelName, effortLabel, selected)

  // Where the thumb sits, 0–1. The stylesheet offsets this by half a thumb so
  // the fill meets the thumb's centre; a single stop pins to the start so a
  // one-option track is never painted as "fully deep".
  const fill = options.length > 1 ? selectedIndex / (options.length - 1) : 0

  return (
    <div className="px-3 pb-2.5 pt-1" data-testid="atum-model-slider">
      {thinkingOnly && (
        <div className="mb-1.5 text-[0.6875rem] font-medium tracking-[0.04em] uppercase text-(--atum-ink-faint)" id={thinkingLabelId}>
          {t.shell.modelOptions.effort}
        </div>
      )}
      <div className="atum-slider-track relative" style={{ '--atum-slider-fill': fill } as React.CSSProperties}>
        {/* Stops, painted over the track so the control reads as one object
            rather than dots on a bar behind them. The selected stop is left
            blank: the thumb IS that stop, and a dot on top of it would read as
            a second control. Behind the thumb the track is ink, so those stops
            take the reverse colour; ahead of it they sit on the hollow track. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-[calc(var(--atum-slider-thumb)/2-0.1875rem)] top-1/2 z-1 flex -translate-y-1/2 justify-between"
        >
          {options.map((option, index) => (
            <span
              className={cn(
                'size-1.5 rounded-full',
                index === selectedIndex
                  ? 'opacity-0'
                  : index < selectedIndex
                    ? 'bg-(--atum-on-accent) opacity-70'
                    : 'bg-(--atum-ink-ghost)',
                option.unavailable && index !== selectedIndex && 'bg-(--atum-ink-ghost) opacity-40'
              )}
              key={`${option.model}:${option.effort ?? 'none'}`}
            />
          ))}
        </div>
        <input
          aria-disabled={disabled || pending}
          aria-label={`${fasterLabel} — ${smarterLabel}`}
          aria-labelledby={thinkingOnly ? thinkingLabelId : undefined}
          aria-valuetext={currentLabel}
          className="atum-slider relative block w-full cursor-pointer appearance-none bg-transparent"
          disabled={options.length < 2}
          max={options.length - 1}
          min={0}
          onChange={event => void selectIndex(Number(event.target.value))}
          onKeyDown={event => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
              event.stopPropagation()

              if (disabled || pending) {
                event.preventDefault()
              }
            }
          }}
          step={1}
          type="range"
          value={selectedIndex}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[0.6875rem] text-(--atum-ink-faint)">
        <span>{fasterLabel}</span>
        <span>{smarterLabel}</span>
      </div>
      {unavailableAttempt ? (
        <p aria-live="polite" className="mt-2 text-[0.6875rem] text-(--atum-ink-muted)" role="status">
          {unavailableLabel}
        </p>
      ) : null}
    </div>
  )
}
