import { type KeyboardEvent, useId, useRef, useState } from 'react'

import { Check, SearchIcon, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { MatrixTeammateAvatar } from '../member-avatar'
import { PersonHandleLine } from '../person-handle-line'

import { useTeamSpaceCopy } from './copy'
import { type RosterMember, rosterName } from './views'

const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gu, 'd').toLowerCase()

/**
 * Who can be picked for a new channel, matched the way Mattermost's member picker matches: by name
 * or by @username, accents ignored ("linh" finds "Lĩnh"). Only active people, never the creator, who
 * is in the channel already. The platform's roster carries no email, so email is not searched.
 */
export function channelPeopleCandidates(roster: readonly RosterMember[], query: string): RosterMember[] {
  const needle = fold(query.trim().replace(/^@/u, ''))

  return roster.filter(person => {
    if (person.state !== 'active' || person.self) {
      return false
    }

    if (!needle) {
      return true
    }

    return fold(person.displayName ?? '').includes(needle) || fold(person.handle ?? '').includes(needle)
  })
}

export interface ChannelPeoplePickerProps {
  roster: readonly RosterMember[]
  picked: readonly string[]
  onChange(next: string[]): void
  disabled?: boolean
}

/**
 * "Add people" inside Create a channel: the picks as removable chips over one search field, then
 * the company's people with a tick (Mattermost's "Add members" and Slack's add-people step, folded
 * into the create sheet so a private channel starts with its people). Keyboard: arrows move through
 * the list, Enter picks the highlighted person, Backspace in an empty search drops the last chip.
 */
export function ChannelPeoplePicker({ disabled = false, onChange, picked, roster }: ChannelPeoplePickerProps) {
  const { company, team } = useTeamSpaceCopy()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // The highlight shows while searching or after an arrow key, and Enter picks it only then.
  const [navigating, setNavigating] = useState(false)
  const listId = useId()
  const search = useRef<HTMLInputElement>(null)

  const everyone = channelPeopleCandidates(roster, '')
  const visible = channelPeopleCandidates(roster, query)
  const chosen = picked.map(ref => roster.find(person => person.memberRef === ref)).filter(Boolean) as RosterMember[]
  const highlighted = Math.min(active, Math.max(visible.length - 1, 0))

  const toggle = (memberRef: string) => {
    onChange(picked.includes(memberRef) ? picked.filter(ref => ref !== memberRef) : [...picked, memberRef])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setNavigating(true)
      setActive(navigating || query.trim() ? (highlighted + step + visible.length) % Math.max(visible.length, 1) : 0)
    } else if (event.key === 'Enter' && (navigating || query.trim()) && visible[highlighted]) {
      // Enter picks while searching; with an empty search it submits the sheet as usual.
      event.preventDefault()
      toggle(visible[highlighted].memberRef)
      setQuery('')
    } else if (event.key === 'Backspace' && query === '' && picked.length > 0) {
      onChange(picked.slice(0, -1))
    }
  }

  if (everyone.length === 0) {
    return <p className="ak-field-help mt-0">{team.newMessageNobody}</p>
  }

  return (
    <div className="grid gap-2" data-matrix-channel-people-picker>
      <div
        className="ak-field h-auto min-h-(--ak-h-md) flex-wrap gap-1.5 py-1"
        onClick={() => search.current?.focus()}
      >
        <SearchIcon aria-hidden className="ak-icon ak-icon--sm shrink-0 text-(--ak-ink-3)" />
        {chosen.map(person => {
          const name = rosterName(person, company.someone)

          return (
            <span
              className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-(--ak-fill-quiet) py-0.5 ps-0.5 pe-1 text-(length:--atum-t-control) text-(--ak-ink)"
              data-matrix-channel-person-chip={person.memberRef}
              key={person.memberRef}
            >
              <MatrixTeammateAvatar className="size-5 text-[0.5rem] leading-none" name={name} person={person} />
              <span className="truncate">{name}</span>
              <button
                aria-label={team.removePerson(name)}
                className="grid size-4 shrink-0 place-items-center rounded-full text-(--ak-ink-3) hover:bg-(--ak-fill-hover) hover:text-(--ak-ink)"
                disabled={disabled}
                onClick={event => {
                  event.stopPropagation()
                  toggle(person.memberRef)
                }}
                type="button"
              >
                <X aria-hidden className="size-3" />
              </button>
            </span>
          )
        })}
        <input
          aria-activedescendant={(navigating || query.trim()) && visible[highlighted] ? `${listId}-${visible[highlighted].memberRef}` : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded
          aria-label={team.channelPeopleSearch}
          className="min-w-24 py-1"
          disabled={disabled}
          onChange={event => {
            setQuery(event.target.value)
            setActive(0)
            setNavigating(false)
          }}
          onKeyDown={onKeyDown}
          placeholder={chosen.length ? '' : team.channelPeopleSearch}
          ref={search}
          role="combobox"
          value={query}
        />
      </div>
      {visible.length === 0 ? (
        <p className="px-1 text-sm text-(--ak-ink-3)">{team.peopleNoMatch}</p>
      ) : (
        <ul
          aria-label={team.addPeopleTitle}
          aria-multiselectable
          className="grid max-h-44 gap-0.5 overflow-y-auto"
          id={listId}
          role="listbox"
        >
          {visible.map((person, index) => {
            const name = rosterName(person, company.someone)
            const selected = picked.includes(person.memberRef)

            return (
              <li
                aria-selected={selected}
                className={cn(
                  'flex cursor-default items-center gap-2.5 rounded-(--ak-r-sm) px-2 py-1.5 text-sm text-(--ak-ink)',
                  index === highlighted && (navigating || query.trim()) ? 'bg-(--ak-fill-hover)' : 'hover:bg-(--ak-fill-hover)',
                  disabled && 'opacity-50'
                )}
                data-matrix-channel-person={person.memberRef}
                id={`${listId}-${person.memberRef}`}
                key={person.memberRef}
                onClick={() => !disabled && toggle(person.memberRef)}
                onMouseDown={event => event.preventDefault()}
                role="option"
              >
                <MatrixTeammateAvatar className="size-6 text-[0.5625rem] leading-none" name={name} person={person} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{name}</span>
                  <PersonHandleLine handle={person.handle} name={name} />
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'grid size-[18px] shrink-0 place-items-center rounded-full',
                    selected ? 'bg-(--ak-ink) text-(--ak-on-ink)' : 'shadow-[inset_0_0_0_1.5px_var(--ak-line-2)]'
                  )}
                >
                  {selected && <Check className="size-3" />}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
