import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixAgentHomeModelOption } from '../../shared/matrix'
import { matrixModelDisplayName } from '../../shared/matrix-model-display-name'
import type { MatrixModelRoute } from '../../shared/matrix-models'
import { MATRIX_SHELF_PROVIDER } from '../../shared/matrix-shelf-models'

import { useModelPickerCopy } from './model-picker-copy'
import type { PickerFilterSource } from './model-picker-filter'
import { ModelPickerList } from './model-picker-list'
import { MODEL_PICKER_CARD, ModelPickerPanel, useModelPickerKeys } from './model-picker-panel'
import {
  matrixModelFavoriteToggle,
  type MatrixModelPickerPreferences,
  readMatrixModelPickerPreferences,
  writeMatrixModelPickerPreferences
} from './model-picker-preferences'
import { type PickerFilter, type PickerProvider, type PickerRoute, pickerSections } from './model-picker-sections'

function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** One provider row per id, in first-seen order. */
export function pickerProvidersOf(routes: readonly PickerRoute[]): PickerProvider[] {
  return routes
    .map(({ route }) => ({ id: route.provider, label: route.providerLabel }))
    .filter((provider, index, all) => all.findIndex(each => each.id === provider.id) === index)
}

/** The provider family a placement model option belongs to, as the card's rail names it. */
export function matrixHomeModelProvider(option: MatrixAgentHomeModelOption): PickerProvider {
  // Atum-funded OpenRouter models have their own rail entry, apart from Atum's line-up.
  if (option.source === 'atum' && option.shelf) {
    return { ...MATRIX_SHELF_PROVIDER }
  }

  const id =
    option.source === 'atum'
      ? 'atum'
      : option.source === 'chatgpt_plan'
        ? 'openai-codex'
        : option.source === 'opencode_go'
          ? 'opencode-go'
          : option.source.slice('own_key:'.length) || option.providerLabel.toLocaleLowerCase()

  return { id, label: option.providerLabel }
}

/** A plain model id as a card row: one provider, its readable name, chosen as this Mac's model. */
export function pickerRouteOf(input: {
  /** A caller's own stable key, when one provider/model pair can appear twice. */
  id?: string
  provider: string
  providerLabel: string
  model: string
  name?: string
  current?: boolean
  ready?: boolean
  reason?: string
}): PickerRoute {
  return {
    route: {
      id: input.id ?? `${input.provider}:${input.model}`,
      provider: input.provider,
      model: input.model,
      name: matrixModelDisplayName(input.model, input.name),
      providerLabel: input.providerLabel,
      accountLabel: input.providerLabel,
      connection: 'key',
      target: 'agent_default',
      destination: 'this_mac',
      efforts: [],
      current: input.current === true,
      ready: input.ready !== false
    },
    ...(input.ready === false ? { disabled: true } : {}),
    ...(input.reason ? { reason: input.reason } : {})
  }
}

export interface ModelPickerPopoverProps {
  routes: readonly PickerRoute[]
  /** The route id that answers now. */
  currentId?: string
  /** Where this picker's stars are kept (one account/device/place). */
  scope: string
  onChoose: (route: MatrixModelRoute) => void
  /** The trigger's accessible name (the field it replaces, e.g. "Main model"). */
  label: string
  /** Shown on the trigger when nothing is current. */
  placeholder: string
  disabled?: boolean
  /** A pick is being saved: rows wait. */
  busy?: boolean
  /** One line on what a pick changes, as the composer card's rows say it. */
  tooltip?: (route: MatrixModelRoute) => string
  triggerClassName?: string
  contentClassName?: string
  /** The rail's Connect, where this surface can connect a service (the composer's chooser flow). */
  onConnect?: () => void
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function ModelPickerPopover({
  routes,
  currentId,
  scope,
  onChoose,
  label,
  placeholder,
  disabled = false,
  busy = false,
  tooltip,
  triggerClassName,
  contentClassName,
  onConnect
}: ModelPickerPopoverProps) {
  const words = useModelPickerCopy()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<PickerFilter>({ favoritesOnly: false })
  const [query, setQuery] = useState('')

  const [preferences, setPreferences] = useState<MatrixModelPickerPreferences>(() =>
    readMatrixModelPickerPreferences(storage(), scope)
  )

  const content = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const keys = useModelPickerKeys(list, search)

  const isCurrent = (route: MatrixModelRoute) => route.id === currentId
  const providers = pickerProvidersOf(routes)

  // Providers are separated: the card opens on the current model's provider (else the first) and
  // lists only that provider's models, or the stars across providers.
  const opening = (): PickerFilter => {
    const source = routes.find(({ route }) => route.id === currentId)?.route.provider ?? providers[0]?.id

    return { favoritesOnly: false, ...(source ? { source } : {}) }
  }

  const shownFilter: PickerFilter =
    filter.favoritesOnly || (filter.source !== undefined && providers.some(provider => provider.id === filter.source))
      ? filter
      : opening()

  const sources: PickerFilterSource[] = providers.map(provider => ({
    ...provider,
    ready: routes.some(({ route }) => route.provider === provider.id && route.ready),
    ...(provider.id === 'atum' ? { atum: true } : {})
  }))

  const sections = pickerSections({
    atum: routes.filter(({ route }) => route.provider === 'atum'),
    connected: routes.filter(({ route }) => route.provider !== 'atum'),
    providers: providers.filter(provider => provider.id !== 'atum'),
    favorites: preferences.favorites,
    query,
    filter: shownFilter,
    isCurrent
  })

  const current = routes.find(({ route }) => route.id === currentId)?.route

  const toggleFavorite = (routeId: string) =>
    setPreferences(previous => {
      const next = matrixModelFavoriteToggle(previous, routeId)
      writeMatrixModelPickerPreferences(storage(), scope, next)

      return next
    })

  return (
    <Popover
      onOpenChange={next => {
        setOpen(next)

        if (next) {
          setQuery('')
          setFilter(opening())
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label={current ? `${label}: ${current.name}` : label}
          className={cn('w-64 max-w-full justify-between font-normal', triggerClassName)}
          data-matrix-model-popover-trigger
          disabled={disabled || routes.length === 0}
          size="sm"
          type="button"
          variant="outline"
        >
          <span className="truncate">{current?.name ?? placeholder}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className={cn(MODEL_PICKER_CARD, contentClassName)}
        onKeyDown={keys.shortcutKeyDown}
        // A card opened by a click focuses itself (DESIGN.md), never the search field or a row.
        onOpenAutoFocus={event => {
          event.preventDefault()
          content.current?.focus()
        }}
        ref={content}
        sideOffset={6}
        tabIndex={-1}
      >
        <ModelPickerPanel
          filter={shownFilter}
          keys={keys}
          listRef={list}
          onConnect={
            onConnect
              ? () => {
                  setOpen(false)
                  onConnect()
                }
              : undefined
          }
          onFilterChange={setFilter}
          onQueryChange={setQuery}
          query={query}
          searchRef={search}
          sources={sources}
        >
          <ModelPickerList
            busy={busy}
            favorites={preferences.favorites}
            isCurrent={isCurrent}
            onChoose={picked => {
              if (picked.disabled || !picked.route.ready || isCurrent(picked.route)) {
                return
              }

              setOpen(false)
              onChoose(picked.route)
            }}
            onToggleFavorite={toggleFavorite}
            sections={sections}
            tooltip={route => tooltip?.(route) ?? route.providerLabel}
          />
          {sections.length === 0 && (
            <p className="px-2 py-3 text-xs text-(--atum-ink-muted)">
              {query.trim() ? words.noMatches : filter.favoritesOnly ? words.favoritesEmpty : words.noModels}
            </p>
          )}
        </ModelPickerPanel>
      </PopoverContent>
    </Popover>
  )
}
