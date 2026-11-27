import { Codecs, persistentAtom } from '@/lib/persisted'

import type { MatrixRoom } from '../../shared/matrix'

import { directPartner } from './people'
import type { MatrixRosterProjection } from './roster-model'
import { matrixRoomHasUnread } from './roster-preview'

/**
 * The Chat roster's filter, beside its search (owner 2026-11-27: "chat should have filter too"). The
 * filters are Matrix's own, as Element X offers them: unread, people (DMs), groups, assistants and the
 * standard `m.favourite` / `m.lowpriority` tags. One at a time; `all` is no filter.
 */
export const MATRIX_ROSTER_FILTERS = ['all', 'unread', 'people', 'groups', 'assistants', 'favourites', 'lowPriority'] as const

export type MatrixRosterFilter = (typeof MATRIX_ROSTER_FILTERS)[number]

function isRosterFilter(value: unknown): value is MatrixRosterFilter {
  return typeof value === 'string' && (MATRIX_ROSTER_FILTERS as readonly string[]).includes(value)
}

/** The last filter each signed-in account chose, by Matrix user id. Survives a relaunch. */
export const $matrixRosterFilterByAccount = persistentAtom<Record<string, string>>(
  'atum.desktop.rosterFilterByAccount.v1',
  {},
  Codecs.stringRecord
)

export function rememberMatrixRosterFilter(account: string, filter: MatrixRosterFilter): void {
  const current = $matrixRosterFilterByAccount.get()

  if (current[account] !== filter) {
    $matrixRosterFilterByAccount.set({ ...current, [account]: filter })
  }
}

export function matrixRememberedRosterFilter(account: string | undefined, saved: Record<string, string>): MatrixRosterFilter {
  const value = account ? saved[account] : undefined

  return isRosterFilter(value) ? value : 'all'
}

type RoomTest = (room: MatrixRoom) => boolean

/**
 * The roster with only what `filter` keeps, section by section. Assistants stay one row each; a test
 * on a chat asks it of the assistant's conversation rooms. Coming-soon placeholders and the Founder
 * draft hold no chat, so only `all` keeps them.
 */
export function filterMatrixRosterByKind(
  projection: MatrixRosterProjection,
  filter: MatrixRosterFilter,
  ownerId: string | undefined
): MatrixRosterProjection {
  if (filter === 'all') {
    return projection
  }

  const person: RoomTest = room => Boolean(ownerId && directPartner(room, ownerId))

  const tests: Record<Exclude<MatrixRosterFilter, 'all'>, { room?: RoomTest; agents: boolean; apps: boolean }> = {
    unread: { room: matrixRoomHasUnread, agents: true, apps: true },
    people: { room: person, agents: false, apps: false },
    groups: { room: room => !room.direct && !person(room), agents: false, apps: false },
    assistants: { agents: true, apps: false },
    favourites: { room: room => Boolean(room.favourite), agents: true, apps: true },
    lowPriority: { room: room => Boolean(room.lowPriority), agents: true, apps: true }
  }

  const { agents, apps, room: test } = tests[filter]
  const keeps: RoomTest = room => (test ? test(room) : false)

  const groups = agents
    ? projection.groups.filter(group => !test || group.rooms.some(keeps))
    : []

  const keptApps = apps ? (projection.apps ?? []).filter(entry => Boolean(entry.room && !entry.room.appBot?.hidden && keeps(entry.room))) : []
  const founder = projection.founder && keeps(projection.founder) ? projection.founder : undefined

  return {
    groups,
    rest: projection.rest.filter(keeps),
    ...(projection.notesSelf ? { notesSelf: projection.notesSelf } : {}),
    ...(founder ? { founder } : {}),
    ...(keptApps.length > 0 ? { apps: keptApps } : {})
  }
}

function hasRows(projection: MatrixRosterProjection): boolean {
  return (
    projection.groups.length > 0 ||
    projection.rest.length > 0 ||
    Boolean(projection.founder) ||
    (projection.apps?.length ?? 0) > 0
  )
}

/** The filters that would show something now, in menu order. `all` is always first. */
export function availableMatrixRosterFilters(
  projection: MatrixRosterProjection,
  ownerId: string | undefined
): MatrixRosterFilter[] {
  return MATRIX_ROSTER_FILTERS.filter(
    filter => filter === 'all' || hasRows(filterMatrixRosterByKind(projection, filter, ownerId))
  )
}

/** A saved filter that has nothing to show any more reads as `all`: the roster never goes blank. */
export function effectiveMatrixRosterFilter(
  filter: MatrixRosterFilter,
  available: readonly MatrixRosterFilter[]
): MatrixRosterFilter {
  return available.includes(filter) ? filter : 'all'
}
