import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'

import { SearchField } from '@/components/ui/search-field'

import { useModelPickerCopy } from './model-picker-copy'
import { ModelPickerFilter, type PickerFilterSource } from './model-picker-filter'
import type { PickerFilter } from './model-picker-sections'

/** The card's popover classes: one size for every model picker in Atum, T3 Code's proportions
 * (the rail, the list, and room for the thinking column beside it). */
export const MODEL_PICKER_CARD =
  'h-[22.5rem] max-h-[min(80vh,22.5rem)] w-[34rem] max-w-[calc(100vw-1rem)] overflow-hidden p-0'

/**
 * The card's keyboard: arrows/Home/End move between rows, `/` jumps to search, typing on the card
 * starts a search, `f` stars the focused row, the search's arrows reach the list, right arrow
 * reaches the thinking column (left comes back), Enter picks, and ⌘1…⌘9 pick the visible rows.
 * Every model picker uses this one set, so the behaviour is the same wherever a model is chosen.
 */
export function useModelPickerKeys(
  list: RefObject<HTMLDivElement | null>,
  search: RefObject<HTMLInputElement | null>,
  onType?: (text: string) => void
) {
  // Flat rows in the order the person sees them; the rail owns grouping.
  const stops = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[data-matrix-model-route]') ?? [])

  const moveRow = (event: ReactKeyboardEvent, direction: 'next' | 'previous') => {
    const buttons = stops()

    if (!buttons.length) {
      return
    }

    const index = buttons.indexOf(window.document.activeElement as HTMLElement)
    const next = direction === 'next' ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0)

    buttons[index < 0 ? 0 : next]?.focus()
    event.preventDefault()
  }

  // The thinking column beside the list, when the current model has levels to choose from.
  const column = () => list.current?.closest('[data-matrix-model-panel]')?.querySelector<HTMLElement>('[data-matrix-model-effort-column]')

  const toColumn = (event: ReactKeyboardEvent) => {
    const target =
      column()?.querySelector<HTMLElement>('[data-matrix-model-effort-level][tabindex="0"]:not(:disabled)') ??
      column()?.querySelector<HTMLElement>('[data-matrix-model-effort-level]:not(:disabled)')

    if (target) {
      event.preventDefault()
      target.focus()
    }
  }

  /** Back from the column: the current row, else the first that can be chosen. */
  const toList = () =>
    (
      list.current?.querySelector<HTMLElement>('[data-matrix-model-route][aria-current="true"]:not(:disabled)') ??
      list.current?.querySelector<HTMLElement>('[data-matrix-model-route]:not(:disabled)')
    )?.focus()

  const listKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowRight') {
      toColumn(event)
    } else if (event.key === 'ArrowDown') {
      moveRow(event, 'next')
    } else if (event.key === 'ArrowUp') {
      moveRow(event, 'previous')
    } else if (event.key === 'Home') {
      stops()[0]?.focus()
      event.preventDefault()
    } else if (event.key === 'End') {
      stops().at(-1)?.focus()
      event.preventDefault()
    } else if (event.key === '/') {
      event.preventDefault()
      search.current?.focus()
    } else if (event.key.toLocaleLowerCase() === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // The star beside the focused row, pressed for it; a row with no star has none to press.
      const row = window.document.activeElement as HTMLElement | null

      const star = row?.dataset?.matrixModelRoute
        ? row.parentElement?.querySelector<HTMLButtonElement>('[data-matrix-model-favorite]')
        : null

      if (star) {
        event.preventDefault()
        star.click()
      }
    }
  }

  // The search sits above the list: down reaches the first model, up the last.
  const searchKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      ;(list.current?.querySelector<HTMLElement>('[data-matrix-model-route]') ?? stops()[0])?.focus()
      event.preventDefault()
    } else if (event.key === 'ArrowUp') {
      stops().at(-1)?.focus()
      event.preventDefault()
    }
  }

  const shortcutKeyDown = (event: ReactKeyboardEvent) => {
    // Typing while the card itself has focus (as it does when a click opens it) starts a search.
    if (
      event.target === event.currentTarget &&
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault()

      if (event.key !== '/') {
        onType?.(event.key)
      }

      search.current?.focus()

      return
    }

    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !/^[1-9]$/u.test(event.key)) {
      return
    }

    const shortcut = Number(event.key) - 1
    const target = list.current?.querySelectorAll<HTMLButtonElement>('[data-matrix-model-route]')[shortcut]

    if (target && !target.disabled) {
      event.preventDefault()
      target.click()
    }
  }

  return { listKeyDown, searchKeyDown, shortcutKeyDown, toList }
}

export interface ModelPickerPanelProps {
  filter: PickerFilter
  sources: readonly PickerFilterSource[]
  onFilterChange: (filter: PickerFilter) => void
  /** The rail's last item: where subscriptions and keys are connected. */
  onConnect?: () => void
  query: string
  onQueryChange: (query: string) => void
  listRef: RefObject<HTMLDivElement | null>
  searchRef: RefObject<HTMLInputElement | null>
  keys: ReturnType<typeof useModelPickerKeys>
  /** The list column's rows (the ModelPickerList and any recovery rows under it). */
  children: ReactNode
  /** Pinned under the list: a refused pick, a notice. */
  footer?: ReactNode
  /** Beside the list, on the right: the current model's thinking column. */
  aside?: ReactNode
  /** One step the chosen row asks for (ChatGPT's one-time confirmation): it takes the list
   * column's place in the same card, so the card keeps one focus and never opens a second one. */
  takeover?: ReactNode
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function ModelPickerPanel({
  filter,
  sources,
  onFilterChange,
  onConnect,
  query,
  onQueryChange,
  listRef,
  searchRef,
  keys,
  children,
  footer,
  aside,
  takeover
}: ModelPickerPanelProps) {
  const words = useModelPickerCopy()

  return (
    <div className="flex h-full min-h-0 min-w-0" data-matrix-model-panel>
      <ModelPickerFilter filter={filter} onChange={onFilterChange} onConnect={onConnect} sources={sources} />

      {takeover ? (
        <div className="flex min-w-0 flex-1 flex-col" data-matrix-model-takeover>
          {takeover}
        </div>
      ) : (
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 px-3" data-matrix-model-search onKeyDown={keys.searchKeyDown}>
          <SearchField
            aria-label={words.searchPlaceholder}
            containerClassName="h-14 w-full border-(--atum-attention) opacity-100"
            inputClassName="w-full text-(length:--atum-t-body)"
            inputRef={searchRef}
            onChange={onQueryChange}
            onClear={() => onQueryChange('')}
            placeholder={words.searchPlaceholder}
            value={query}
          />
        </div>

        <div
          aria-label={words.modelList}
          className="dt-portal-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-1.5"
          data-matrix-model-list
          onKeyDown={keys.listKeyDown}
          ref={listRef}
          role="group"
        >
          {children}
        </div>

        {footer}
      </div>
      )}
      {!takeover && aside}
    </div>
  )
}
