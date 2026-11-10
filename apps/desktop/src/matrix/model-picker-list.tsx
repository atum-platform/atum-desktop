import { type MouseEvent as ReactMouseEvent } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { RowButton } from '@/components/ui/row-button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Check, Star } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { matrixModelDisplayName } from '../../shared/matrix-model-display-name'
import type { MatrixModelRoute } from '../../shared/matrix-models'
import { type MatrixShelfModelView, matrixShelfProtonsLabel } from '../../shared/matrix-shelf-models'

import { useModelPickerCopy } from './model-picker-copy'
import { ProviderMark } from './model-picker-provider-mark'
import type { PickerRoute, PickerSection } from './model-picker-sections'
import { PICKER_ROW, PICKER_TRACK } from './model-picker-style'

export interface ModelPickerListProps {
  sections: readonly PickerSection[]
  favorites: readonly string[]
  isCurrent: (route: MatrixModelRoute) => boolean
  /** One concise explanation of what selecting this row changes. */
  tooltip: (route: MatrixModelRoute) => string
  /** A pick or thinking-level change is in flight. */
  busy: boolean
  onChoose: (picked: PickerRoute) => void
  onToggleFavorite: (routeId: string) => void
}

interface PickerRowProps {
  picked: PickerRoute
  current: boolean
  favorite: boolean
  shortcut?: number
  busy: boolean
  roving: boolean
  tooltip: string
  onChoose: () => void
  onStar: (event: ReactMouseEvent<HTMLButtonElement>) => void
}

function PickerRowView({
  picked,
  current,
  favorite,
  shortcut,
  busy,
  roving,
  tooltip,
  onChoose,
  onStar
}: PickerRowProps) {
  const { locale, t } = useI18n()
  const words = useModelPickerCopy()
  const route = picked.route
  const atum = route.provider === 'atum'
  const name = matrixModelDisplayName(route.model, route.name !== route.model ? route.name : undefined)

  const tagline = picked.tagline ? words.taglines[picked.tagline] : undefined

  const facts = atum
    ? [
        picked.badges?.includes('default') || picked.note === 'default' ? t.matrixShell.modelRecommended : undefined,
        tagline,
        picked.note === 'soon' ? t.surfaces.comingSoon : undefined
      ].filter(Boolean)
    : []

  const unavailable = Boolean(picked.disabled || !route.ready)
  const starrable = !unavailable
  const shelf = picked.shelf
  const price = shelf ? shelfPrice(shelf, locale, words.shelfPrice) : undefined

  const label = [
    name,
    atum ? undefined : shelf ? `${route.providerLabel} · ${shelf.maker.label}` : route.providerLabel,
    price,
    shelf?.costly ? words.shelfCostly : undefined,
    ...facts,
    picked.reason,
    current ? words.current : undefined
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <Tip label={shortcut ? `${tooltip} · ⌘${shortcut}` : tooltip} side="left">
      <li
        className={cn(
          'group/model-row relative flex min-h-11 items-center rounded-[var(--atum-r-row)]',
          current && 'bg-(--atum-hover)'
        )}
      >
        <RowButton
          aria-current={current ? 'true' : undefined}
          aria-disabled={unavailable || undefined}
          aria-keyshortcuts={shortcut ? `Meta+${shortcut}` : undefined}
          aria-label={label}
          // Room for the star only: shortcuts live in the tooltip (STYLE.md §12).
          className={cn(PICKER_ROW, 'flex-1 pr-9')}
          data-matrix-model-route={route.id}
          disabled={busy || unavailable}
          onClick={onChoose}
          tabIndex={roving && !unavailable ? 0 : -1}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium leading-tight text-(--atum-ink)">{name}</span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-(length:--atum-t-caption) leading-tight text-(--atum-ink-muted)">
              {atum ? (
                <span className="flex min-w-0 items-center gap-x-1" data-matrix-model-atum-meta>
                  <BrandMark className="size-4 rounded-[0.25rem]" inset />
                  <span className="min-w-0 truncate">{facts.join(' · ')}</span>
                </span>
              ) : shelf ? (
                // The list is already OpenRouter's: the line names the maker and the price, and a
                // model that costs more than Nhật Thực says so (a label, never a confirmation).
                <>
                  <ProviderMark provider={shelfMakerMark(shelf)} size="xs" />
                  <span className="min-w-0 truncate" data-matrix-model-shelf-price>
                    {`${shelf.maker.label} · ${price}`}
                  </span>
                  {shelf.costly && (
                    <span
                      className="shrink-0 rounded-[0.25rem] bg-(--atum-warn)/12 px-1 font-medium text-(--atum-warn)"
                      data-matrix-model-shelf-costly
                    >
                      {words.shelfCostly}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <ProviderMark provider={{ id: route.provider, label: route.providerLabel }} size="xs" />
                  {picked.reason ? (
                    // One line beside the provider's mark: why it waits ("Not ready for cloud assistants yet").
                    <span className="min-w-0 flex-1 truncate" data-matrix-model-reason>
                      {picked.reason}
                    </span>
                  ) : (
                    (picked.subscription || route.providerLabel !== name) && (
                      <span className="truncate">{route.providerLabel}</span>
                    )
                  )}
                </>
              )}
            </span>
          </span>
          {/* The saved choice carries a check (the shade alone reads as hover or focus). */}
          {current && (
            <Check
              aria-hidden
              className="size-4 shrink-0 text-(--atum-ink)"
              data-matrix-model-check
              strokeWidth={2.4}
            />
          )}
        </RowButton>

        {starrable && (
          <Tip label={favorite ? words.unfavorite : words.favorite}>
            <Button
              aria-label={`${favorite ? words.unfavorite : words.favorite}: ${route.name}`}
              aria-pressed={favorite}
              className={cn(
                'absolute top-1/2 right-0.5 shrink-0 -translate-y-1/2 text-(--atum-ink-faint) hover:text-(--atum-ink)',
                favorite && 'text-(--atum-mark-amber) hover:text-(--atum-mark-amber)'
              )}
              data-matrix-model-favorite={favorite ? 'true' : 'false'}
              disabled={busy}
              onClick={onStar}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Star aria-hidden className={cn('size-3.5', favorite && 'fill-current')} />
            </Button>
          </Tip>
        )}
      </li>
    </Tip>
  )
}

/** "81,000 / 405,000 Protons", grouped the reader's way. */
export function shelfPrice(
  shelf: MatrixShelfModelView,
  locale: string,
  phrase: (input: string, output: string) => string
): string {
  return phrase(
    matrixShelfProtonsLabel(shelf.inputProtonsPerMtok, locale),
    matrixShelfProtonsLabel(shelf.outputProtonsPerMtok, locale)
  )
}

/** The maker's own mark (Claude, Gemini, Grok…); a maker without one gets its initial. */
function shelfMakerMark(shelf: MatrixShelfModelView) {
  const id = shelf.maker.id === 'google' ? 'gemini' : shelf.maker.id === 'x-ai' ? 'xai' : shelf.maker.id

  return { id, label: shelf.maker.label }
}

/** One flat list. The left rail owns grouping; there are no collapsible headers in this column. */
export function ModelPickerList({
  sections,
  favorites,
  isCurrent,
  tooltip,
  busy,
  onChoose,
  onToggleFavorite
}: ModelPickerListProps) {
  const rendered = sections.flatMap(section => [...section.rows])
  const rovingId = (rendered.find(each => isCurrent(each.route)) ?? rendered.find(each => !each.disabled))?.route.id
  const starIds = new Set(favorites)

  const star = (picked: PickerRoute, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onToggleFavorite(picked.route.id)
  }

  let index = 0

  return (
    <ul className={cn('grid gap-0.5', PICKER_TRACK)} role="list">
      {sections.map(section => (
        <li className="contents" key={section.id}>
          <ul className="contents" role="presentation">
            {section.heading && (
              <li
                className="px-2 pt-2 pb-1 text-[0.6875rem] font-medium tracking-wide text-(--atum-ink-faint) uppercase"
                data-matrix-model-group={section.id}
                role="presentation"
              >
                {section.heading}
              </li>
            )}
            {section.rows.map(picked => {
              const shortcut = index < 9 ? ++index : undefined

              return (
                <PickerRowView
                  busy={busy}
                  current={isCurrent(picked.route)}
                  favorite={starIds.has(picked.route.id)}
                  key={picked.route.id}
                  onChoose={() => onChoose(picked)}
                  onStar={event => star(picked, event)}
                  picked={picked}
                  roving={picked.route.id === rovingId}
                  shortcut={shortcut}
                  tooltip={picked.reason ?? tooltip(picked.route)}
                />
              )
            })}
            {section.note && (
              <li
                className="px-2 py-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)"
                data-matrix-model-note
                role="presentation"
              >
                {section.note}
              </li>
            )}
          </ul>
        </li>
      ))}
    </ul>
  )
}
