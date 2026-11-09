import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'

import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { SearchField } from '@/components/ui/search-field'
import { useI18n } from '@/i18n'
import { Check, Search, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixMember, MatrixSnapshot } from '../../shared/matrix'

import { useGroupPickerCopy } from './group-picker-copy'
import {
  assistantsInGroup,
  filterCandidates,
  foundCandidate,
  GROUP_PICKER_FILTERS,
  groupAppJoin,
  type GroupCandidate,
  type GroupPickerFilter,
  groupPickerSections,
  selectionBlock,
  toggleCandidate
} from './group-picker-model'
import { MainAgentBadge } from './main-agent-badge'
import { directRoomWith, lookupPerson, type MatrixPersonLookup, parsePersonQuery } from './people'
import { searchPeopleDirectory } from './people'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { personHandleText } from './person-handle-line'
import { useMatrixHandles } from './person-handles'
import { PERSON_AVATAR, QuietLine } from './person-search'
import { MatrixProfileAvatar } from './profile-avatar'
import { useRosterCreateCopy } from './roster-create-copy'
import { matrixRosterAgentName } from './roster-model'

/** What a row may carry beside its name and avatar, from lanes that own it: a verification
 * mark (official / verified accounts) and an assistant's status dot. */
export interface GroupPickerAdornments {
  mark?: ReactNode
  dot?: ReactNode
}

/**
 * A picker's draft: the search, the filter, the picks and whoever was found by @name. It
 * lives with the dialog's owner, outside the dialog's content, so dismissing the dialog keeps
 * it; `reset` clears it once the group is made.
 */
export function useGroupPickerDraft() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<GroupPickerFilter>('all')
  const [selected, setSelected] = useState<readonly GroupCandidate[]>([])
  const [found, setFound] = useState<readonly GroupCandidate[]>([])

  return {
    query,
    setQuery,
    filter,
    setFilter,
    selected,
    found,
    /** `inGroup`: your assistants already in the group, toward its five (adding to one). */
    toggle: (candidate: GroupCandidate, inGroup = 0) =>
      setSelected(current => toggleCandidate(current, candidate, inGroup)),
    /** Found on purpose: listed, and ticked straight away when it can be. */
    addFound: (candidate: GroupCandidate) => {
      setFound(current => [candidate, ...current.filter(each => each.key !== candidate.key)])
      setSelected(current =>
        current.some(each => each.key === candidate.key) ? current : toggleCandidate(current, candidate)
      )
    },
    /** Drops picks that were made (an invitation that went through). */
    drop: (keys: readonly string[]) => setSelected(current => current.filter(each => !keys.includes(each.key))),
    reset: () => {
      setQuery('')
      setFilter('all')
      setSelected([])
      setFound([])
    }
  }
}

export type GroupPickerDraft = ReturnType<typeof useGroupPickerDraft>

/** An @name lookup belongs to the query it was asked for; it is never shown against other text. */
type Lookup =
  | { state: 'idle' }
  | { state: 'searching'; query: string }
  | { state: 'done'; query: string; result: MatrixPersonLookup }

export interface GroupPickerProps {
  /** Everyone who could be picked (`groupCandidates`). */
  candidates: readonly GroupCandidate[]
  /** People found by their @name, kept by the caller so a pick outlives the next search. */
  found: readonly GroupCandidate[]
  /** Someone was found on purpose: the caller lists them and ticks them when it can. */
  onFound(candidate: GroupCandidate): void
  selected: readonly GroupCandidate[]
  /** `inGroup`: your assistants already in the group, which count toward its five. */
  onToggle(candidate: GroupCandidate, inGroup: number): void
  query: string
  onQueryChange(value: string): void
  filter: GroupPickerFilter
  onFilterChange(filter: GroupPickerFilter): void
  disabled?: boolean
  snapshot: MatrixSnapshot
  /** The conversation's members, when adding to one: someone found who is already in it says so. */
  members?: readonly MatrixMember[]
  adornments?(candidate: GroupCandidate): GroupPickerAdornments | undefined
  searchRef?: RefObject<HTMLInputElement | null>
}

/**
 * Picking a group's members the way Zalo does: one search box (a name, or anyone by their
 * @name), a row of filters, the picks as removable chips, then recent chats and everyone
 * else A–Z, each with a round tick. People, assistants and apps are rows alike; a row that
 * can't be ticked says why in its caption, never by disappearing.
 */
export function GroupPicker({
  adornments,
  candidates,
  disabled,
  filter,
  found,
  members,
  onFilterChange,
  onFound,
  onQueryChange,
  onToggle,
  query,
  searchRef,
  selected,
  snapshot
}: GroupPickerProps) {
  const copy = useGroupPickerCopy()
  const roster = useRosterCreateCopy()
  const { locale, t } = useI18n()
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const [directory, setDirectory] = useState<readonly GroupCandidate[]>([])
  const generation = useRef(0)
  const mounted = useRef(false)
  const parsed = parsePersonQuery(query)
  const current: Lookup = lookup.state !== 'idle' && lookup.query === query ? lookup : { state: 'idle' }
  const scopeKey = `${snapshot.petScope ?? ''}/${snapshot.identity?.userId}/${snapshot.identity?.deviceId}`
  const bridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.aliases
  const peopleBridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.people
  const handles = useMatrixHandles(snapshot.identity?.userId)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const text = query.trim()
    const mine = ++generation.current
    if (disabled || [...text].length < 2 || !peopleBridge) {
      setDirectory([])
      return
    }
    setDirectory([])
    setLookup({ state: 'searching', query })
    const timer = setTimeout(() => {
      void searchPeopleDirectory(peopleBridge, text).then(results => {
        if (!mounted.current || generation.current !== mine) {
          return
        }
        const excluded = new Set([
          snapshot.identity?.userId,
          ...(snapshot.agents ?? []).map(agent => agent.userId)
        ].filter((id): id is string => Boolean(id)))
        setDirectory(results.filter(person => !excluded.has(person.userId)).map(person =>
          foundCandidate({ userId: person.userId, name: person.name, ...(person.handle ? { handle: person.handle } : {}) }, members)))
        setLookup({ state: 'idle' })
      }, () => {
        if (mounted.current && generation.current === mine) {
          setDirectory([])
          setLookup({ state: 'idle' })
        }
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [disabled, members, peopleBridge, query, snapshot.agents, snapshot.identity?.userId])

  // A person's @handle, once the directory vouched for it, shows under their name and finds them.
  const withHandle = (candidate: GroupCandidate): GroupCandidate =>
    candidate.kind === 'person' && !candidate.handle && handles[candidate.id]
      ? { ...candidate, handle: handles[candidate.id] }
      : candidate

  const all = [
    ...found,
    ...directory.filter(each => !found.some(other => other.key === each.key)),
    ...candidates.filter(each => !found.some(other => other.key === each.key) && !directory.some(other => other.key === each.key))
  ].map(withHandle)
  // Everyone the picker offers, asked once together, so each shows their @handle under the name.
  useMatrixHandleContacts(
    snapshot.identity?.userId,
    all.filter(candidate => candidate.kind === 'person' && !candidate.handle).map(candidate => candidate.id),
    Boolean(snapshot.domainEnabled)
  )
  const inGroup = assistantsInGroup(candidates)
  const toggle = (candidate: GroupCandidate) => onToggle(candidate, inGroup)
  const shown = filterCandidates(all, filter, query)
  const sections = groupPickerSections(shown, { locale, query })
  const isSelected = (candidate: GroupCandidate) => selected.some(each => each.key === candidate.key)

  // A query that could be someone's @name offers to look them up, unless they're already listed.
  const findable = parsed.kind === 'handle' ? parsed.handle : parsed.kind === 'matrixId' ? parsed.userId.slice(1) : null

  const alreadyListed =
    (parsed.kind === 'handle' && all.some(each => each.handle === parsed.handle)) ||
    (parsed.kind === 'matrixId' && all.some(each => each.id === parsed.userId))

  const offerFind = findable !== null && !alreadyListed && (parsed.kind === 'matrixId' || Boolean(bridge))

  const remember = (result: MatrixPersonLookup) => {
    if (result.state !== 'found' || !result.userId || result.holder !== 'person') {
      return
    }

    if (result.userId === snapshot.identity?.userId || snapshot.agents?.some(each => each.userId === result.userId)) {
      return
    }

    const known = directRoomWith(snapshot, result.userId)
    const handle = result.handle || undefined

    const candidate = foundCandidate(
      { userId: result.userId, name: known?.name.trim() || (handle ? `@${handle}` : result.userId), handle },
      members
    )

    onFound(candidate)
  }

  const find = () => {
    if (disabled || !offerFind) {
      return
    }

    const mine = ++generation.current

    if (parsed.kind === 'matrixId') {
      // Someone who typed a whole address knows who they mean: no directory round trip.
      const result: MatrixPersonLookup = { state: 'found', handle: '', holder: 'person', userId: parsed.userId }
      setLookup({ state: 'done', query, result })
      remember(result)

      return
    }

    if (parsed.kind !== 'handle') {
      return
    }

    setLookup({ state: 'searching', query })
    void lookupPerson(bridge, parsed.handle).then(result => {
      if (mounted.current && generation.current === mine) {
        setLookup({ state: 'done', query, result })
        remember(result)
      }
    })
  }

  const avatarFor = (candidate: GroupCandidate, className: string) =>
    candidate.kind === 'assistant' && candidate.agent ? (
      <MatrixProfileAvatar
        avatarUrl={candidate.agent.avatarUrl}
        brand={candidate.agent.isDefault}
        className={className}
        id={candidate.agent.principal}
        mark={candidate.agent.mark}
        name={candidate.name}
        profile={candidate.agent.profile}
        scopeKey={scopeKey}
        target={{ kind: 'agent', principal: candidate.agent.principal }}
      />
    ) : candidate.kind === 'app' && candidate.app ? (
      <AppCatalogAvatar app={candidate.app} className={className} locale={locale} tile />
    ) : (
      <AtumAssistantAvatar className={className} id={candidate.id} name={candidate.name.replace(/^@/, '')} />
    )

  const chosenApp = selected.find(each => each.kind === 'app' && each.app && groupAppJoin(each.app) === 'appGroup')
  // Picking one of your assistants: what that means for the group, said once.
  const assistantsNote = selected.some(each => each.kind === 'assistant')

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5" data-group-picker>
      <form
        onSubmit={event => {
          event.preventDefault()
          find()
        }}
      >
        <SearchField
          aria-label={copy.search}
          containerClassName="h-9 w-full min-w-0 rounded-full border-none bg-(--atum-sunk) px-3 text-[0.8125rem] !opacity-100 transition-colors focus-within:bg-(--atum-hover)"
          inputClassName="min-w-0 flex-1 text-(--atum-ink) placeholder:text-(--atum-ink-faint)"
          inputRef={searchRef}
          onChange={onQueryChange}
          placeholder={copy.search}
          value={query}
        />
      </form>
      <div aria-label={copy.filters} className="flex flex-wrap gap-1.5" data-group-picker-filters role="group">
        {GROUP_PICKER_FILTERS.map(value => (
          <button
            aria-pressed={filter === value}
            className={cn(
              'h-7 rounded-full px-3 text-(length:--atum-t-caption) font-medium transition-colors',
              filter === value
                ? 'bg-(--atum-ink) text-(--atum-on-accent)'
                : 'bg-(--atum-sunk) text-(--atum-ink-muted) hover:bg-(--atum-hover) hover:text-(--atum-ink)'
            )}
            data-group-picker-filter={value}
            key={value}
            onClick={() => onFilterChange(value)}
            type="button"
          >
            {copy.filter[value]}
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <ul aria-label={copy.selected(selected.length)} className="flex flex-wrap gap-1.5" data-group-picker-selected>
          {selected.map(candidate => (
            <li
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-(--atum-sunk) ps-1 pe-0.5 text-(length:--atum-t-caption) text-(--atum-ink)"
              key={candidate.key}
            >
              {avatarFor(candidate, 'size-5 shrink-0 rounded-full text-[0.625rem] leading-none')}
              <span className="max-w-[10rem] truncate">{candidate.name}</span>
              {candidate.agent?.isDefault && <MainAgentBadge />}
              <button
                aria-label={copy.remove(candidate.name)}
                className="atum-icon-btn size-6 rounded-full"
                disabled={disabled}
                onClick={() => toggle(candidate)}
                type="button"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2" data-group-picker-list>
        <span aria-atomic aria-live="polite" className="sr-only">
          {query.trim() ? t.atum.roster.results(shown.length) : ''}
        </span>
        {offerFind && current.state !== 'done' && (
          <button
            className="atum-row flex min-h-12 w-full items-center gap-3 rounded-(--atum-r-row) px-2 text-left disabled:opacity-45"
            data-group-picker-find
            disabled={disabled || current.state === 'searching'}
            onClick={find}
            type="button"
          >
            <span className="grid size-5 shrink-0 place-items-center" />
            <span className="grid size-(--atum-avatar-md) shrink-0 place-items-center rounded-(--atum-r-avatar) bg-(--atum-sunk) text-(--atum-ink-muted)">
              {current.state === 'searching' ? (
                <Loader aria-hidden className="size-4" role="presentation" size="sm" />
              ) : (
                <Search aria-hidden className="size-4" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-(length:--atum-t-control) text-(--atum-ink)">
              {current.state === 'searching' ? roster.searching : roster.findOnAtum(findable!)}
            </span>
          </button>
        )}
        {current.state === 'done' && <LookupAnswer result={current.result} snapshot={snapshot} />}
        {assistantsNote && (
          <QuietLine className="px-2 pb-1">
            <span data-group-picker-assistants-note>{copy.assistantsNote}</span>
          </QuietLine>
        )}
        {chosenApp && <QuietLine className="px-2 pb-1">{copy.appGroupNote}</QuietLine>}
        {sections.map(section => (
          <section
            aria-label={section.key === 'recent' ? copy.recent : section.key}
            data-group-picker-section={section.key}
            key={section.key}
          >
            <h3 className="px-2 pt-2.5 pb-1 text-(length:--atum-t-label) leading-(--atum-lh-label) font-semibold tracking-wide text-(--atum-ink-muted)">
              {section.key === 'recent' ? copy.recent : section.key}
            </h3>
            <ul className="flex flex-col">
              {section.candidates.map(candidate => {
                const checked = isSelected(candidate)
                const block = checked ? undefined : selectionBlock(candidate, selected, inGroup)
                const extra = adornments?.(candidate)

                return (
                  <PickerRow
                    avatar={
                      <span className="relative shrink-0">
                        {avatarFor(candidate, PERSON_AVATAR)}
                        {extra?.dot}
                      </span>
                    }
                    caption={[
                      `@${candidate.handle}` !== candidate.name ? personHandleText(candidate.handle) : undefined,
                      block ? copy.block[block] : undefined
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    // An existing member is shown ticked: they're in, and can't be taken out here.
                    checked={checked || candidate.blocked === 'member'}
                    disabled={disabled || Boolean(block)}
                    key={candidate.key}
                    mark={candidate.agent?.isDefault ? <>{extra?.mark}<MainAgentBadge /></> : extra?.mark}
                    muted={Boolean(block)}
                    name={candidate.name}
                    onChange={() => toggle(candidate)}
                    rowKey={candidate.key}
                  />
                )
              })}
            </ul>
          </section>
        ))}
        {sections.length === 0 && !offerFind && current.state === 'idle' && (
          <p className="px-2 py-8 text-center text-(length:--atum-t-control) text-(--atum-ink-muted)" role="status">
            {query.trim() ? copy.noMatches : copy.nothingYet}
          </p>
        )}
      </div>
    </div>
  )
}

function PickerRow({
  avatar,
  caption,
  checked,
  disabled,
  mark,
  muted,
  name,
  onChange,
  rowKey
}: {
  avatar: ReactNode
  caption?: string
  checked: boolean
  disabled: boolean
  mark?: ReactNode
  muted: boolean
  name: string
  onChange(): void
  rowKey: string
}) {
  const id = useId()

  return (
    <li>
      <label
        className={cn(
          'atum-row flex min-h-12 items-center gap-3 rounded-(--atum-r-row) px-2 py-1.5',
          disabled ? 'cursor-default' : 'cursor-pointer'
        )}
        data-group-picker-row={rowKey}
      >
        <input
          aria-describedby={caption ? `${id}-caption` : undefined}
          aria-labelledby={`${id}-name`}
          checked={checked}
          className="peer sr-only"
          disabled={disabled}
          onChange={onChange}
          type="checkbox"
        />
        <span
          aria-hidden
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] transition-colors',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-(--atum-focus)',
            checked
              ? 'border-(--atum-ink) bg-(--atum-ink) text-(--atum-on-accent)'
              : 'border-(--atum-ink-faint) bg-transparent',
            disabled && 'opacity-45'
          )}
        >
          {checked && <Check className="size-3.5" strokeWidth={2.4} />}
        </span>
        <span className={cn('flex shrink-0', muted && 'opacity-50')}>{avatar}</span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'flex min-w-0 items-center gap-1 text-(length:--atum-t-control)',
              muted ? 'text-(--atum-ink-muted)' : 'text-(--atum-ink)'
            )}
          >
            <span className="truncate" id={`${id}-name`}>
              {name}
            </span>
            {mark}
          </span>
          {caption && (
            <span
              className="block truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)"
              id={`${id}-caption`}
            >
              {caption}
            </span>
          )}
        </span>
      </label>
    </li>
  )
}

/** What an @name lookup found, when it isn't simply a person now in the list. */
function LookupAnswer({ result, snapshot }: { result: MatrixPersonLookup; snapshot: MatrixSnapshot }) {
  const roster = useRosterCreateCopy()
  const { t } = useI18n()

  if (result.state === 'missing') {
    return <QuietLine className="px-2 py-1">{roster.notFound(result.handle)}</QuietLine>
  }

  if (result.state === 'failed') {
    return (
      <NoticeBand role="status" tone={result.reason === 'limit' ? 'notice' : 'failure'}>
        {result.reason === 'limit'
          ? result.retryAfterSeconds
            ? roster.rateLimited(result.retryAfterSeconds)
            : roster.rateLimitedSoon
          : result.reason === 'signedOut'
            ? roster.signedOut
            : roster.searchFailed}
      </NoticeBand>
    )
  }

  const ownAgent = result.userId ? snapshot.agents?.find(agent => agent.userId === result.userId) : undefined

  const reason =
    result.userId && result.userId === snapshot.identity?.userId
      ? roster.you
      : ownAgent
        ? `${matrixRosterAgentName(ownAgent, t.matrixShell.assistantName)}: ${roster.yourAssistant}`
        : result.holder === 'app'
          ? roster.appHandle
          : result.holder === 'organization'
            ? roster.organizationHandle
            : !result.userId
              ? roster.noAddress
              : result.holder === 'assistant'
                ? roster.othersAssistant
                : null

  // A person: they are a row in the list now (and ticked), so nothing more to say.
  return reason ? (
    <QuietLine className="px-2 py-1">
      <span data-group-picker-lookup>{reason}</span>
    </QuietLine>
  ) : null
}
