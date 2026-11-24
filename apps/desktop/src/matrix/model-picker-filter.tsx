import { BrandMark } from '@/components/brand-mark'
import { RowButton } from '@/components/ui/row-button'
import { Tip } from '@/components/ui/tooltip'
import { Plug, Star } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { useModelPickerCopy } from './model-picker-copy'
import { ProviderMark } from './model-picker-provider-mark'
import { type PickerFilter, type PickerProvider } from './model-picker-sections'

/** A connection the rail can narrow the list to. */
export interface PickerFilterSource extends PickerProvider {
  /** Signed in and usable. Signed-out connections stay visible and lead to their recovery state. */
  ready: boolean
  /** Atum's own line-up, drawn with Atum's mark. */
  atum?: boolean
}

export interface ModelPickerFilterProps {
  filter: PickerFilter
  sources: readonly PickerFilterSource[]
  onChange: (filter: PickerFilter) => void
  onConnect?: () => void
}

const RAIL_BUTTON = cn(
  'relative grid size-(--mp-rail-item) shrink-0 place-items-center rounded-(--mp-rail-radius) text-(--atum-ink-muted)',
  'hover:bg-(--atum-hover) hover:text-(--atum-ink) focus-visible:bg-(--atum-hover) focus-visible:text-(--atum-ink)'
)

function ActiveBar() {
  return (
    <span
      aria-hidden
      // T3's indicator: a short ink bar at the rail's inner edge, beside the chosen connection.
      className="absolute top-1/2 right-[calc(var(--mp-ind-inset)-(var(--mp-rail-w)-var(--mp-rail-item))/2)] h-(--mp-ind-h) w-(--mp-ind-w) -translate-y-1/2 rounded-full bg-(--atum-ink)"
      data-matrix-model-rail-active
    />
  )
}

/** The reference picker's narrow icon rail: Favorites, one model family per source, then Connect. */
export function ModelPickerFilter({ filter, sources, onChange, onConnect }: ModelPickerFilterProps) {
  const words = useModelPickerCopy()
  const favorites = filter.favoritesOnly

  return (
    <nav
      aria-label={words.modelSources}
      className="flex h-full w-(--mp-rail-w) shrink-0 flex-col items-center gap-1 border-r border-(--atum-line) py-1"
      data-matrix-model-rail
    >
      <Tip label={words.favorites} side="right">
        <RowButton
          aria-label={words.favorites}
          aria-pressed={favorites}
          className={cn(RAIL_BUTTON, favorites && 'text-(--atum-ink)')}
          data-matrix-model-rail-item="favorites"
          onClick={() => onChange({ favoritesOnly: true })}
        >
          <Star aria-hidden className="size-(--mp-rail-icon) fill-current" />
          {favorites && <ActiveBar />}
        </RowButton>
      </Tip>

      <div className="dt-portal-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {sources.map(source => {
          const active = !favorites && filter.source === source.id

          return (
            <Tip
              key={source.id}
              label={source.ready ? source.label : `${source.label} · ${words.signInAgain}`}
              side="right"
            >
              <RowButton
                aria-label={source.label}
                aria-pressed={active}
                // A signed-out connection keeps its full mark, as in T3: it is still chosen to reach its
                // sign-in state, and a dimmed mark under the pointer or the active bar read as missing.
                className={cn(RAIL_BUTTON, active && 'text-(--atum-ink)')}
                data-matrix-model-rail-item={source.id}
                data-matrix-model-rail-signed-out={source.ready ? undefined : 'true'}
                onClick={() => onChange({ favoritesOnly: false, source: source.id })}
              >
                {source.atum ? (
                  <BrandMark className="size-(--mp-rail-icon) rounded-[0.3rem]" inset />
                ) : (
                  <ProviderMark className="size-(--mp-rail-icon)" provider={source} size="sm" />
                )}
                {active && <ActiveBar />}
              </RowButton>
            </Tip>
          )
        })}
      </div>

      {onConnect && (
        <Tip label={words.connections} side="right">
          <RowButton
            aria-label={words.connections}
            className={RAIL_BUTTON}
            data-matrix-model-connect
            onClick={onConnect}
          >
            <Plug aria-hidden className="size-(--mp-rail-icon)" />
          </RowButton>
        </Tip>
      )}
    </nav>
  )
}
