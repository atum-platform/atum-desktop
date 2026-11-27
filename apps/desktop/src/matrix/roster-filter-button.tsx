import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { ArrowDown, Funnel, Mail, MessageCircle, Sparkles, Star, User, Users } from '@/lib/icons'
import type { IconComponent } from '@/lib/phosphor-icon'

import { useRosterCreateCopy } from './roster-create-copy'
import type { MatrixRosterFilter } from './roster-filter'

const ICONS: Record<MatrixRosterFilter, IconComponent> = {
  all: MessageCircle,
  unread: Mail,
  people: User,
  groups: Users,
  assistants: Sparkles,
  favourites: Star,
  lowPriority: ArrowDown
}

/**
 * The roster's filter, between its search and its plus, as Work's sidebar draws it (search, filter,
 * plus): the same 28 px quiet icon button as the plus and the same menu. One filter at a time; All
 * resets it. Only filters with something to show are offered.
 */
export function MatrixRosterFilterButton({
  available,
  disabled,
  onValueChange,
  value
}: {
  available: readonly MatrixRosterFilter[]
  disabled?: boolean
  onValueChange(value: MatrixRosterFilter): void
  value: MatrixRosterFilter
}) {
  const copy = useRosterCreateCopy()

  const labels: Record<MatrixRosterFilter, string> = {
    all: copy.filterAll,
    unread: copy.filterUnread,
    people: copy.people,
    groups: copy.groups,
    assistants: copy.assistants,
    favourites: copy.filterFavourites,
    lowPriority: copy.filterLowPriority
  }

  const active = value !== 'all'
  const label = active ? `${copy.filterMenu}: ${labels[value]}` : copy.filterMenu
  const choices = available.filter(filter => filter !== 'all')

  return (
    <DropdownMenu modal={false}>
      <Tip label={label}>
        <DropdownMenuTrigger asChild disabled={disabled || choices.length === 0}>
          <button
            aria-label={label}
            className="ak-iconbtn shrink-0 disabled:opacity-45 data-[active]:text-(--atum-ink)"
            data-active={active || undefined}
            data-atum-roster-filter
            data-icon-only
            type="button"
          >
            <Funnel aria-hidden className={active ? 'ak-icon fill-current' : 'ak-icon'} />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-44" data-atum-roster-filter-content>
        <DropdownMenuRadioGroup onValueChange={next => onValueChange(next as MatrixRosterFilter)} value={value}>
          <DropdownMenuRadioItem value="all">
            <MessageCircle aria-hidden className="text-(--ui-text-tertiary)" />
            {labels.all}
          </DropdownMenuRadioItem>
          {choices.length > 0 && <DropdownMenuSeparator />}
          {choices.map(filter => {
            const Icon = ICONS[filter]

            return (
              <DropdownMenuRadioItem key={filter} value={filter}>
                <Icon aria-hidden className="text-(--ui-text-tertiary)" />
                {labels[filter]}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
