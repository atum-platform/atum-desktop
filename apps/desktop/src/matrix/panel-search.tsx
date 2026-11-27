import type { ComponentProps, ReactNode, Ref } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { SearchIcon, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

export interface MatrixPanelSearchProps extends Omit<ComponentProps<'input'>, 'className' | 'onChange' | 'ref' | 'value'> {
  /** Names the field for assistive tech, and is its placeholder unless one is given. */
  label: string
  value: string
  onValueChange(value: string): void
  inputRef?: Ref<HTMLInputElement>
  /** On the field's box: width and placement only. Its look is the one search every screen wears. */
  className?: string
}

/**
 * The left panel's search (zone D), one field for every screen (owner 2026-11-27: "the search bars seem
 * slightly different on every screen in color, style etc."): the Kit's `ak-field--search`, 32 px, 8 px
 * radius, the quiet fill, 14 px text and a 16 px magnifier. Escape or × clears it. Screens own what it
 * finds; this owns only how it looks and behaves as a field.
 */
export function MatrixPanelSearch({
  className,
  inputRef,
  label,
  onKeyDown,
  onValueChange,
  placeholder,
  type = 'text',
  value,
  ...input
}: MatrixPanelSearchProps) {
  const { t } = useI18n()

  return (
    <label className={cn('ak-field ak-field--search h-8 min-w-0 flex-1', className)} data-atum-panel-search="">
      <SearchIcon aria-hidden className="ak-icon ak-icon--sm shrink-0" />
      <input
        aria-label={label}
        onChange={event => onValueChange(event.currentTarget.value)}
        onKeyDown={event => {
          onKeyDown?.(event)

          if (!event.defaultPrevented && event.key === 'Escape' && value) {
            event.preventDefault()
            onValueChange('')
          }
        }}
        placeholder={placeholder ?? label}
        ref={inputRef}
        type={type}
        value={value}
        {...input}
      />
      {value && (
        <Tip label={t.ui.search.clear}>
          <button
            aria-label={t.ui.search.clear}
            className="atum-icon-btn -me-1 size-5 shrink-0"
            onClick={() => onValueChange('')}
            type="button"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </Tip>
      )}
    </label>
  )
}

/** Zone D's row: the search, then the screen's quick buttons (its plus), on the panel's 8 px gutter. */
export function MatrixPanelSearchRow({ children, className, ...props }: ComponentProps<'div'> & { children: ReactNode }) {
  return (
    <div className={cn('flex shrink-0 items-center gap-1.5 px-2 pt-1 pb-2', className)} data-atum-panel-search-row="" {...props}>
      {children}
    </div>
  )
}
