/*
 * The picker's thinking column, adapted from T3 Code's model picker effort column
 * (ColumnRow, EffortRows and moveBetweenRows in apps/web/src/components/chat/ComposerModelEffort.tsx,
 * https://github.com/pingdotgg/t3code at 65accaf23cc51563e385f4d3ad84a97eecd95ca0).
 * MIT License, Copyright (c) 2026 T3 Tools Inc. The notice is kept in
 * apps/desktop/third-party/licenses/app/t3code-LICENSE.txt.
 */
import { type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { Check } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { MATRIX_DEFAULT_EFFORT, MATRIX_EFFORTS, type MatrixEffort } from '../../shared/matrix-models'

import { useModelPickerCopy } from './model-picker-copy'

/** The levels one model takes, in order from quicker to more thorough, with its default and the saved level. */
export interface PickerEffortChoice {
  levels: readonly MatrixEffort[]
  defaultLevel?: MatrixEffort
  selected?: MatrixEffort
}

/**
 * What the column shows for a model, or nothing. A model that takes one level (or none) has no
 * choice to make, so it gets no column: never a control that does nothing. The default is the
 * model's own when it advertises one, else Cân bằng when offered. Absent means the model's own
 * default, so the default level reads as selected. Only the levels a choice can be saved with
 * (low/medium/high) are offered: no backend takes Extra High, and `max` is not a conversation level.
 */
export function pickerEffortChoice(input: {
  /** What the model advertises; a level the conversation cannot save (`max`) is left out. */
  efforts: readonly string[] | undefined
  defaultEffort?: MatrixEffort
  value?: MatrixEffort
}): PickerEffortChoice | undefined {
  const levels = MATRIX_EFFORTS.filter(level => input.efforts?.includes(level))

  if (levels.length < 2) {
    return undefined
  }

  const defaultLevel =
    input.defaultEffort && levels.includes(input.defaultEffort)
      ? input.defaultEffort
      : levels.includes(MATRIX_DEFAULT_EFFORT)
        ? MATRIX_DEFAULT_EFFORT
        : undefined

  const selected = input.value && levels.includes(input.value) ? input.value : defaultLevel

  return { levels, ...(defaultLevel ? { defaultLevel } : {}), ...(selected ? { selected } : {}) }
}

const COLUMN_ROW = cn(
  'flex h-(--mp-row-h) w-full shrink-0 items-center gap-2 rounded-(--mp-row-r) px-(--mp-row-x) text-left',
  'text-(length:--mp-text) text-(--atum-ink) outline-none hover:bg-(--atum-hover) focus-visible:bg-(--atum-hover)',
  'disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent'
)

/** Up and Down move between the levels; Left goes back to the list. */
function columnKeyDown(event: ReactKeyboardEvent<HTMLElement>, onLeave?: () => void) {
  if (event.key === 'ArrowLeft' && onLeave) {
    event.preventDefault()
    event.stopPropagation()
    onLeave()

    return
  }

  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
    return
  }

  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-matrix-model-effort-level]:not(:disabled)'))
  const index = rows.findIndex(row => row === window.document.activeElement)
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]

  if (next) {
    event.preventDefault()
    event.stopPropagation()
    next.focus()
  }
}

export interface ModelPickerEffortColumnProps {
  /** The model these levels belong to: the one that answers now, or the one being chosen. */
  model: string
  choice: PickerEffortChoice
  disabled?: boolean
  onChange: (effort: MatrixEffort) => void
  /** Left arrow from a level returns focus to the list. */
  onLeave?: () => void
}

/**
 * The right column of the card: how hard the current model thinks, one row per level the model
 * takes, its default marked, a check on the saved one. Reached with the right arrow from the list.
 */
export function ModelPickerEffortColumn({ model, choice, disabled, onChange, onLeave }: ModelPickerEffortColumnProps) {
  const words = useModelPickerCopy()
  const tabStop = choice.selected ?? choice.levels[0]

  return (
    <div
      className="flex w-(--mp-effort-w) shrink-0 flex-col border-l border-(--atum-line)"
      data-matrix-model-effort-column
      onKeyDown={event => columnKeyDown(event, onLeave)}
    >
      {/* As T3's column: the level's word and the model it belongs to on the search row's line, so one
          rule runs across the card (the column may speak for the model that answers now while the
          list shows another provider). */}
      <div className="shrink-0 px-(--mp-search-x) pt-(--mp-search-top)">
        <div className="flex h-[calc(var(--mp-search-h)+0.375rem)] min-w-0 items-center gap-2 border-b-(length:--mp-search-rule) border-(--atum-line) pb-1.5 text-(length:--mp-text)">
          <span className="shrink-0 text-(--atum-ink-muted)">{words.effort}</span>
          <span className="ms-auto min-w-0 truncate text-xs text-(--atum-ink-muted)" data-matrix-model-effort-model>
            {model}
          </span>
        </div>
      </div>
      <div aria-label={`${words.effort}: ${model}`} className="flex flex-col gap-0.5 px-2 pt-1.5 pb-1.5" role="radiogroup">
        {choice.levels.map(level => {
          const selected = level === choice.selected
          const isDefault = level === choice.defaultLevel

          return (
            <Tip key={level} label={words.effortHelp[level]} side="right">
              <button
                aria-checked={selected}
                className={COLUMN_ROW}
                data-matrix-model-effort-level={level}
                disabled={disabled}
                onClick={() => {
                  if (!selected) {
                    onChange(level)
                  }
                }}
                role="radio"
                tabIndex={level === tabStop ? 0 : -1}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{words.efforts[level]}</span>
                {selected ? (
                  <>
                    {isDefault && <span className="sr-only">{words.badgeDefault}</span>}
                    <Check aria-hidden className="size-3.5 shrink-0" strokeWidth={2.4} />
                  </>
                ) : (
                  isDefault && (
                    <span className="shrink-0 text-(length:--atum-t-caption) text-(--atum-ink-faint)">
                      {words.badgeDefault}
                    </span>
                  )
                )}
              </button>
            </Tip>
          )
        })}
      </div>
    </div>
  )
}
