import { type ReactNode, useEffect, useRef, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixAliasBridge } from '../../shared/matrix-aliases'

import {
  directRoomWith,
  knownPeople,
  lookupPerson,
  type MatrixPersonHolder,
  type MatrixPersonLookup,
  notPeople,
  parsePersonQuery,
  searchPeopleDirectory
} from './people'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { personHandleText } from './person-handle-line'
import { useMatrixHandles } from './person-handles'
import { useRosterCreateCopy } from './roster-create-copy'
import { matrixRosterAgentName } from './roster-model'

/** Someone the search found: a person, or one of the owner's own assistants. */
export interface FoundPerson {
  userId: string
  /** Their conversation's name when the owner already talks to them, else their @name. */
  name: string
  handle?: string
  holder: MatrixPersonHolder
  /** One of the owner's own assistants: opened as an assistant, never invited as a person. */
  ownAgent?: MatrixAgentView
  /** The direct conversation with them, when one exists. */
  roomId?: string
}

/** How strongly a row's action reads: the dialog's main act, an option, or one already taken. */
export type PersonActionTone = 'primary' | 'quiet' | 'done'

/** What a found person's row offers: one action, or a plain reason there is none. */
export type PersonOffer =
  | { label: string; onSelect(): void; disabled?: boolean; tone?: PersonActionTone }
  | { note: string }

/** An answer belongs to the query it was asked for; it is never shown against other text. */
type SearchState =
  | { state: 'idle' }
  | { state: 'searching'; query: string }
  | { state: 'nameOnly'; query: string }
  | { state: 'done'; query: string; result: MatrixPersonLookup }

export const PERSON_AVATAR = 'size-(--atum-avatar-md) shrink-0 rounded-(--atum-r-avatar) text-[0.8125rem] leading-none'

/** One person on one line: their initial, their name, a quiet caption, and what can be done. */
export function PersonRow({
  action,
  caption,
  id,
  name
}: {
  action?: ReactNode
  caption?: ReactNode
  id: string
  name: string
}) {
  return (
    <div className="flex min-h-11 items-center gap-2.5 rounded-(--atum-r-row) px-2 py-1" data-matrix-person-row={id}>
      <AtumAssistantAvatar className={PERSON_AVATAR} id={id} name={name.replace(/^@/, '')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-(length:--atum-t-control) text-(--atum-ink)">{name}</span>
        {caption && (
          <span className="block text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
            {caption}
          </span>
        )}
      </span>
      {action}
    </div>
  )
}

/** A row's one action: a compact pill, so a list of people stays light. */
export function PersonAction({
  children,
  className,
  tone = 'quiet',
  ...props
}: React.ComponentProps<'button'> & { tone?: PersonActionTone }) {
  return (
    <button
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-(length:--atum-t-caption) font-medium transition-colors disabled:pointer-events-none disabled:opacity-45',
        tone === 'primary' && 'bg-(--atum-ink) text-(--atum-on-accent) hover:bg-(--atum-ink-soft)',
        tone === 'quiet' && 'bg-(--atum-sunk) text-(--atum-ink) hover:bg-(--atum-hover)',
        tone === 'done' && 'text-(--atum-ink-muted) hover:text-(--atum-ink)',
        className
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  )
}

/** A quiet line under a field: a hint or a plain state, never an error banner. */
export function QuietLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn('text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)', className)}
      role="status"
    >
      {children}
    </p>
  )
}

/**
 * Find someone new by their exact public @name (the directory never lists people), or by a
 * complete Matrix address for those who know theirs. The query is the caller's, so it can
 * also filter the people already known; only Find spends a lookup. Every answer has its own
 * plain state, and an answer that comes back after the query changed is dropped.
 */
export function PersonSearch({
  autoFocus,
  bridge = window.atumMatrix?.aliases,
  children,
  disabled,
  label,
  offer,
  onQueryChange,
  placeholder,
  query,
  seed,
  snapshot
}: {
  autoFocus?: boolean
  /** The alias bridge (defaults to the window's); without one, only addresses work. */
  bridge?: MatrixAliasBridge
  /** Rows for people already known, filtered by the same query, shown under the answer. */
  children?: ReactNode
  disabled?: boolean
  label: string
  offer(person: FoundPerson): PersonOffer
  onQueryChange(value: string): void
  placeholder: string
  query: string
  /** Changing it runs a search for the query as it is (the start menu's "Find @name"). */
  seed?: number
  snapshot: MatrixSnapshot
}) {
  const copy = useRosterCreateCopy()
  const handles = useMatrixHandles(snapshot.identity?.userId)
  const [search, setSearch] = useState<SearchState>({ state: 'idle' })
  const [directory, setDirectory] = useState<readonly FoundPerson[]>([])
  useMatrixHandleContacts(snapshot.identity?.userId,directory.map(person=>person.userId),Boolean(snapshot.domainEnabled))
  const generation = useRef(0)
  const mounted = useRef(false)
  const seeded = useRef<number | undefined>(undefined)
  const parsed = parsePersonQuery(query)
  const current: SearchState = search.state !== 'idle' && search.query === query ? search : { state: 'idle' }

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const text = query.trim()
    const bridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.people
    const mine = ++generation.current
    if (disabled || !bridge || [...text].length < 2) {
      setDirectory([])
      return
    }
    setDirectory([])
    const timer = setTimeout(() => {
      setSearch({ state: 'searching', query })
      void searchPeopleDirectory(bridge, text).then(results => {
        if (!mounted.current || generation.current !== mine) {
          return
        }
        const excluded = notPeople(snapshot)
        const known = new Set(knownPeople(snapshot).map(person => person.userId))
        setDirectory(results.filter(person => !excluded.has(person.userId) && !known.has(person.userId)).map(person => ({
          userId: person.userId,
          name: person.name,
          ...(person.handle ? { handle: person.handle } : {}),
          holder: 'person' as const
        })))
        setSearch({ state: 'idle' })
      }, () => {
        if (mounted.current && generation.current === mine) {
          setDirectory([])
          setSearch({ state: 'idle' })
        }
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [disabled, query, snapshot])

  const find = () => {
    // Only the newest search may answer; an older one still in flight is dropped.
    const mine = ++generation.current

    if (parsed.kind === 'empty') {
      setSearch({ state: 'idle' })
    } else if (parsed.kind === 'text') {
      setSearch({ state: 'nameOnly', query })
    } else if (parsed.kind === 'matrixId') {
      // Someone who typed a whole address knows who they mean: no directory round trip.
      setSearch({
        state: 'done',
        query,
        result: { state: 'found', handle: '', holder: 'person', userId: parsed.userId }
      })
    } else {
      setSearch({ state: 'searching', query })
      void lookupPerson(bridge, parsed.handle).then(result => {
        if (mounted.current && generation.current === mine) {
          setSearch({ state: 'done', query, result })
        }
      })
    }
  }

  useEffect(() => {
    if (seed !== undefined && seeded.current !== seed) {
      seeded.current = seed
      find()
    }
    // A seed runs once, for the query it arrived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  return (
    <div className="flex flex-col gap-2" data-matrix-person-search>
      <form
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault()

          if (!disabled) {
            find()
          }
        }}
      >
        <Input
          aria-label={label}
          autoFocus={autoFocus}
          className="atum-input h-9 min-w-0 flex-1"
          disabled={disabled}
          maxLength={1024}
          onChange={event => onQueryChange(event.target.value)}
          placeholder={placeholder}
          value={query}
        />
        <Button
          disabled={disabled || current.state === 'searching' || parsed.kind === 'empty'}
          type="submit"
          variant="secondary"
        >
          {copy.find}
        </Button>
      </form>
      <PersonSearchAnswer offer={offer} search={current} snapshot={snapshot} />
      {directory.length > 0 && (
        <div aria-live="polite" className="grid gap-1" data-matrix-person-directory role="status">
          {directory.map(person => {
            const offered = offer(person)
            const atName = personHandleText(person.handle ?? handles[person.userId])
            return (
              <PersonRow
                action={'label' in offered ? (
                  <PersonAction disabled={offered.disabled} onClick={offered.onSelect} tone={offered.tone}>
                    {offered.label}
                  </PersonAction>
                ) : undefined}
                // Their @handle first, then one status: why nothing can be done, else that they're on Atum.
                caption={[atName !== person.name ? atName : undefined, 'note' in offered ? offered.note : copy.onAtum]
                  .filter(Boolean)
                  .join(' · ')}
                id={person.userId}
                key={person.userId}
                name={person.name}
              />
            )
          })}
        </div>
      )}
      {children}
    </div>
  )
}

function PersonSearchAnswer({
  offer,
  search,
  snapshot
}: {
  offer(person: FoundPerson): PersonOffer
  search: SearchState
  snapshot: MatrixSnapshot
}) {
  const copy = useRosterCreateCopy()
  const { t } = useI18n()

  if (search.state === 'idle') {
    return null
  }

  if (search.state === 'searching') {
    return (
      <div
        aria-live="polite"
        className="flex items-center gap-2 py-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)"
        role="status"
      >
        <Spinner className="size-4 animate-spin" />
        {copy.searching}
      </div>
    )
  }

  if (search.state === 'nameOnly') {
    return <QuietLine>{copy.nameOnly}</QuietLine>
  }

  const { result } = search

  if (result.state === 'missing') {
    return <QuietLine>{copy.notFound(result.handle)}</QuietLine>
  }

  if (result.state === 'failed') {
    return (
      <NoticeBand role="status" tone={result.reason === 'limit' ? 'notice' : 'failure'}>
        {result.reason === 'limit'
          ? result.retryAfterSeconds
            ? copy.rateLimited(result.retryAfterSeconds)
            : copy.rateLimitedSoon
          : result.reason === 'signedOut'
            ? copy.signedOut
            : copy.searchFailed}
      </NoticeBand>
    )
  }

  const handle = result.handle || undefined
  const atName = personHandleText(handle)
  const ownAgent = result.userId ? snapshot.agents?.find(agent => agent.userId === result.userId) : undefined
  const known = result.userId ? directRoomWith(snapshot, result.userId) : undefined

  // The name the roster shows for them, when there is one; otherwise their @name.
  const name =
    (ownAgent && matrixRosterAgentName(ownAgent, t.matrixShell.assistantName)) ||
    known?.name.trim() ||
    atName ||
    result.userId ||
    ''

  // Why there is nothing to do with this @name, when there isn't.
  const reason =
    result.userId && result.userId === snapshot.identity?.userId
      ? copy.you
      : result.holder === 'app'
        ? copy.appHandle
        : result.holder === 'organization'
          ? copy.organizationHandle
          : !result.userId
            ? copy.noAddress
            : result.holder === 'assistant' && !ownAgent
              ? copy.othersAssistant
              : undefined

  const offered: PersonOffer =
    reason !== undefined || !result.userId
      ? { note: reason ?? '' }
      : offer({
          userId: result.userId,
          name,
          handle,
          holder: result.holder,
          ...(ownAgent ? { ownAgent } : {}),
          ...(known ? { roomId: known.id } : {})
        })

  // Their @name when the row shows another name, then one status: why nothing can be done,
  // else who they are to you.
  const caption = [
    name !== atName ? atName : undefined,
    'note' in offered
      ? offered.note
      : ownAgent
        ? copy.yourAssistant
        : result.holder === 'person' && handle
          ? copy.onAtum
          : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div aria-live="polite" data-matrix-person-found role="status">
      <PersonRow
        action={
          'label' in offered ? (
            <PersonAction disabled={offered.disabled} onClick={offered.onSelect} tone={offered.tone}>
              {offered.label}
            </PersonAction>
          ) : undefined
        }
        caption={caption || undefined}
        id={result.userId ?? name}
        name={name}
      />
    </div>
  )
}
