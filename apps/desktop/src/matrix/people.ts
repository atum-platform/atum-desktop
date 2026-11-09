import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixAliasBridge } from '../../shared/matrix-aliases'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { isCompanyConversationRoom } from '../../shared/matrix-company-channel-room'
import type { MatrixPeopleSearchBridge, MatrixPeopleSearchPerson } from '../../shared/matrix-people-search'

import { requestMatrixHandles } from './person-handle-contacts'
import { forgetMatrixHandle, matrixHandleAccount, rememberMatrixHandle } from './person-handles'
import { normalizeMatrixRosterQuery } from './roster-model'

/**
 * People, as the roster's creation flows see them. Matrix stays the authority: a person
 * is the other member of a two-person conversation, and a new one is found by their
 * public @name through the alias directory. A raw Matrix address is never asked for;
 * one typed in full is still accepted, quietly, for people who know theirs.
 */
export interface MatrixPerson {
  userId: string
  /** What the person is called here: their conversation's name, or their @name. */
  name: string
  /** Their public handle, when found through the directory. */
  handle?: string
  /** The direct conversation with them, when one exists. */
  roomId?: string
  lastActiveAt?: number
}

/** The platform's handle shape (`matrix-alias-directory.ts`): 3–32, a letter first. */
const HANDLE = /^[a-z][a-z0-9_]{2,31}$/
// The shape a conversation's invite accepts (`parseMatrixCommand`).
const MATRIX_ID = /^@[^:\s]+:[^\s]+$/

/** Matrix allows at most this many invitations in one new conversation (`parseMatrixCommand`). */
export const MATRIX_GROUP_INVITE_LIMIT = 20

export type MatrixPersonQuery =
  | { kind: 'empty' }
  /** Could be someone's public @name; it also filters names locally. */
  | { kind: 'handle'; handle: string; text: string }
  /** A complete Matrix address, accepted without a lookup. */
  | { kind: 'matrixId'; userId: string }
  /** A name: it filters people already known, and cannot find anyone new. */
  | { kind: 'text'; text: string }

export function parsePersonQuery(raw: string): MatrixPersonQuery {
  const text = raw.trim()

  if (!text) {
    return { kind: 'empty' }
  }

  if (text.length <= 1024 && MATRIX_ID.test(text)) {
    return { kind: 'matrixId', userId: text }
  }

  const handle = text.replace(/^@/, '').toLowerCase()

  return HANDLE.test(handle) ? { kind: 'handle', handle, text } : { kind: 'text', text }
}

/** The other member of a joined two-person direct conversation, encrypted or plain (0.20) —
 * never an assistant's private room or an app's group. */
export function directPartner(room: MatrixRoom, ownerId: string): string | undefined {
  if (
    room.membership !== 'join' ||
    !room.direct ||
    room.assistant ||
    room.roomType === MATRIX_ASSISTANT_ROOM_TYPE ||
    room.appGroup ||
    // A company DM is the company's room, not a personal chat with that person.
    isCompanyConversationRoom(room)
  ) {
    return undefined
  }

  const members = (room.participants ?? []).filter(member => ['join', 'invite'].includes(member.membership))

  if (members.length !== 2 || !members.some(member => member.userId === ownerId)) {
    return undefined
  }

  return members.find(member => member.userId !== ownerId)?.userId
}

/** Matrix users that are the owner or the owner's own assistants and apps: never people. */
export function notPeople(snapshot: MatrixSnapshot): ReadonlySet<string> {
  return new Set(
    [
      snapshot.identity?.userId,
      snapshot.assistant?.userId,
      ...(snapshot.agents ?? []).map(agent => agent.userId),
      ...(snapshot.appParticipants ?? []).map(app => app.userId)
    ].filter((id): id is string => Boolean(id))
  )
}

const newest = (left: { lastActiveAt?: number }, right: { lastActiveAt?: number }) =>
  (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0)

/** The people the owner already talks to one-on-one, newest first. A person without a
 * name is left out rather than shown as an address. */
export function knownPeople(snapshot: MatrixSnapshot): MatrixPerson[] {
  const ownerId = snapshot.identity?.userId

  if (!ownerId) {
    return []
  }

  const excluded = notPeople(snapshot)
  const people = new Map<string, MatrixPerson>()

  for (const room of snapshot.rooms) {
    const userId = directPartner(room, ownerId)
    const name = room.name.trim()

    if (!userId || excluded.has(userId) || !name) {
      continue
    }

    const current = people.get(userId)

    if (!current || (room.lastActiveAt ?? 0) > (current.lastActiveAt ?? 0)) {
      people.set(userId, { userId, name, roomId: room.id, lastActiveAt: room.lastActiveAt })
    }
  }

  return [...people.values()].sort(newest)
}

/** Merge native-directory rows with known people. A known conversation wins its
 * display name and room, and every Matrix identity appears once. */
export function mergePeople(
  known: readonly MatrixPerson[],
  directory: readonly MatrixPeopleSearchPerson[],
  excluded: ReadonlySet<string> = new Set()
): MatrixPerson[] {
  const merged = new Map<string, MatrixPerson>()
  for (const person of known) {
    if (!excluded.has(person.userId)) {
      merged.set(person.userId, person)
    }
  }
  for (const person of directory) {
    if (!excluded.has(person.userId) && !merged.has(person.userId)) {
      merged.set(person.userId, { userId: person.userId, name: person.name })
    }
  }
  return [...merged.values()]
}

export async function searchPeopleDirectory(
  bridge: MatrixPeopleSearchBridge | undefined,
  query: string,
  limit = 20
): Promise<MatrixPeopleSearchPerson[]> {
  const text = query.trim()
  if (!bridge || [...text].length < 2) {
    return []
  }
  // The account this search was asked for: an answer that lands after a sign-out or a switch
  // (A → signed out → A included) teaches nothing and asks nothing for whoever is signed in now.
  const account = matrixHandleAccount()
  const response = await bridge.search({ query: text, limit })
  if (!response.ok) {
    throw new Error(`matrix_people_search_${response.error}`)
  }
  if (matrixHandleAccount().generation !== account.generation) {
    return response.value.results
  }
  for (const person of response.value.results) {
    if (person.handle) {
      rememberMatrixHandle(person.userId, person.handle)
    }
  }
  // People found by name whose handle the search did not carry: one pooled contacts read, so
  // every list that searches (global, company invite, pickers) shows the handle under the name.
  requestMatrixHandles(
    account.owner,
    response.value.results.filter(person => !person.handle).map(person => person.userId),
    account.generation
  )
  return response.value.results
}

/** The most recent direct conversation with someone: reusing it beats making a second. */
export function directRoomWith(snapshot: MatrixSnapshot, userId: string): MatrixRoom | undefined {
  const ownerId = snapshot.identity?.userId

  return ownerId ? snapshot.rooms.filter(room => directPartner(room, ownerId) === userId).sort(newest)[0] : undefined
}

/** Group conversations the owner is in: named, joined, and neither private nor an assistant's. */
export function groupConversations(snapshot: MatrixSnapshot): MatrixRoom[] {
  const ownerId = snapshot.identity?.userId

  if (!ownerId) {
    return []
  }

  return snapshot.rooms
    .filter(
      room =>
        room.membership === 'join' &&
        !room.direct &&
        !room.assistant &&
        room.roomType !== MATRIX_ASSISTANT_ROOM_TYPE &&
        !isCompanyConversationRoom(room) &&
        Boolean(room.name.trim()) &&
        !directPartner(room, ownerId)
    )
    .sort(newest)
}

/** Filters by what is shown: a person's name or @name, accent- and case-insensitively. */
export function matchesName(name: string, query: string, handle?: string): boolean {
  const normalized = normalizeMatrixRosterQuery(query.replace(/^@/, ''))

  return (
    !normalized ||
    normalizeMatrixRosterQuery(name).includes(normalized) ||
    Boolean(handle && handle.includes(normalized))
  )
}

/** Who holds a public @name. The owner's own assistants are told apart by the caller. */
export type MatrixPersonHolder = 'person' | 'assistant' | 'app' | 'organization'

/** What a search for someone new found. */
export type MatrixPersonLookup =
  | { state: 'found'; handle: string; holder: MatrixPersonHolder; userId: string | null }
  | { state: 'missing'; handle: string }
  | { state: 'failed'; reason: 'limit' | 'signedOut' | 'unavailable'; retryAfterSeconds?: number }

const HOLDERS = { human: 'person', agent: 'assistant', app: 'app', organization: 'organization' } as const

/** Finds who holds a public @name. The directory never lists people, so this is an exact
 * lookup, made only on request; its refusals come back as plain states. */
export async function lookupPerson(bridge: MatrixAliasBridge | undefined, handle: string): Promise<MatrixPersonLookup> {
  if (!bridge) {
    return { state: 'failed', reason: 'unavailable' }
  }

  try {
    const result = await bridge.request({ action: 'lookup', handle })

    if (!result.ok) {
      if (result.error === 'limit') {
        return { state: 'failed', reason: 'limit', retryAfterSeconds: result.retryAfterSeconds }
      }

      if (result.error === 'invalid') {
        return { state: 'missing', handle }
      }

      return { state: 'failed', reason: result.error === 'authentication' ? 'signedOut' : 'unavailable' }
    }

    const found = result.value

    if (found.kind !== 'lookup') {
      return { state: 'failed', reason: 'unavailable' }
    }

    if (found.state === 'assigned') {
      // The directory vouches for this pairing: the person shows by this handle from now on.
      if (found.matrixUser) {
        rememberMatrixHandle(found.matrixUser, found.handle)
      } else {
        forgetMatrixHandle({ handle: found.handle })
      }

      return { state: 'found', handle: found.handle, holder: HOLDERS[found.principalKind], userId: found.matrixUser }
    }

    if (found.handle) {
      forgetMatrixHandle({ handle: found.handle })
    }

    return { state: 'missing', handle: found.handle ?? handle }
  } catch {
    return { state: 'failed', reason: 'unavailable' }
  }
}

/** Why an app that can join a group (`groupAppJoin` in `group-picker-model.ts`) can or
 * can't be picked: only once it is available and connected. */
export type MatrixGroupAppState = 'ready' | 'connect' | 'unavailable'

export function groupAppState(app: AppDescriptor): MatrixGroupAppState {
  if (app.bot) {
    if (app.bot.state !== 'active' || !app.bot.device || !app.bot.groups) {
      return 'unavailable'
    }

    return app.bot.consent === 'accepted' && app.link.state === 'linked' ? 'ready' : 'connect'
  }

  if (app.availability !== 'available') {
    return 'unavailable'
  }

  return app.link.state === 'linked' ? 'ready' : 'connect'
}

/** The apps a group can be started with, in catalog order. Apps that can never join a
 * group are left out rather than listed as broken. */
export function groupApps(apps: readonly AppDescriptor[]): AppDescriptor[] {
  return [...apps]
    // Keep an official app visible when groups are disabled so the person gets
    // the catalog's honest unavailable note (rather than mistaking absence for
    // a missing app).  `groupAppState` remains the single enablement gate.
    // An official bot joins on its own bot row's terms, whatever the operator-set room context.
    .filter(app => Boolean(app.bot) || app.matrix_room_context === 'addressed_only')
    .sort((a, b) => a.roster_order - b.roster_order || a.app_id.localeCompare(b.app_id))
}

/** One persona from the new-assistant questions, in the shape the old app wrote it: a
 * heading, who they are, what they do. Nothing answered means no persona at all, so the
 * assistant keeps Atum's default. */
export function assistantPersona(name: string, who: string, job: string): string {
  const sections = [
    who.trim() && `## Who you are\n\n${who.trim()}`,
    job.trim() && `## What you do\n\n${job.trim()}`
  ].filter(Boolean)

  return sections.length ? [`# ${name.trim()}`, ...sections].join('\n\n') : ''
}
