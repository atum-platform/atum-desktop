import type { AppDescriptor } from '../../shared/app-catalog'
import { appLocalizedCopy } from '../../shared/app-catalog'
import type { MatrixAgentView, MatrixMember, MatrixSnapshot } from '../../shared/matrix'
import { matrixAgentGroupOffer } from '../../shared/matrix-agent-actions'
import { MATRIX_GROUP_AGENT_LIMIT } from '../../shared/matrix-group-room'

import { appRoster } from './app-roster'
import { groupAppState, knownPeople, matchesName, MATRIX_GROUP_INVITE_LIMIT } from './people'
import { matrixRosterAgentName, normalizeMatrixRosterQuery, projectMatrixRoster } from './roster-model'

/**
 * Who a group can be made of, as one list: people, your assistants and your apps are all
 * members you pick the same way ("everything is a chat user"). Pure and table-driven; the
 * dialog only draws it. Whether a kind of member can actually join is decided here, in one
 * place per kind, so turning one on is a one-line change with its reason beside it.
 */
export type GroupCandidateKind = 'person' | 'assistant' | 'app'

/** Why a row can't be ticked. Each code has one line of copy (`group-picker-copy.ts`). */
export type GroupCandidateBlock =
  /** This assistant is still being set up, so it can't join yet (`assistantGroupAccess`). */
  | 'assistantNotReady'
  /** Five of your assistants are picked or already in the group (MATRIX_GROUP_AGENT_LIMIT). */
  | 'agentsFull'
  /** This app has no way into a group yet (`groupAppJoin`). */
  | 'appSoon'
  /** It can, once connected. */
  | 'appConnect'
  | 'appUnavailable'
  /** A single-person app group holds only you and that app. */
  | 'appAlone'
  /** People are picked, so a you-and-this-app group can't be made. */
  | 'appWithPeople'
  /** Adding to an existing group: this app only starts a new one. */
  | 'appNewGroupOnly'
  /** Already in the conversation (adding members). */
  | 'member'
  /** The 20-invitation cap is reached. */
  | 'full'

export interface GroupCandidate {
  /** Unique across kinds: `${kind}:${id}`. */
  key: string
  kind: GroupCandidateKind
  /** A Matrix user id for people and assistants, the catalog id for apps. */
  id: string
  name: string
  /** A public @name, when the search found them by it. */
  handle?: string
  lastActiveAt?: number
  /** Can't be picked, whatever else is picked; absent when it can. */
  blocked?: GroupCandidateBlock
  agent?: MatrixAgentView
  app?: AppDescriptor
}

export type GroupPickerMode = 'create' | 'add'

export type GroupPickerFilter = 'all' | GroupCandidateKind

export const GROUP_PICKER_FILTERS: readonly GroupPickerFilter[] = ['all', 'person', 'assistant', 'app']

/** At most this many recent conversations lead the list (Zalo's "recent chats"). */
export const GROUP_PICKER_RECENT_LIMIT = 5

// ---------------------------------------------------------------------------------------
// Policy seams: one function per kind of member.

/**
 * Whether one of your assistants can be added to a group (owner-only assistants in groups,
 * 2026-10-06), or `hidden` when it is not offered at all. Joining goes through the assistant's
 * own host here (`joinGroupAgents` in main refuses without one), so a cloud assistant, which has
 * none yet, is left out of the list rather than shown as blocked: no row names where it answers,
 * and none offers a join that would fail (0.19.4 Q4, `matrixAgentGroupOffer`). One still being set up
 * here is listed, not ready yet. Only your own assistants are ever listed, so only you add them.
 * In the group it answers only you, when you name it or reply to it (shared/matrix-group-room.ts).
 */
export function assistantGroupAccess(agent: MatrixAgentView): GroupCandidateBlock | 'hidden' | null {
  const offer = matrixAgentGroupOffer(agent)

  return offer === 'offered' ? null : offer === 'hidden' ? 'hidden' : 'assistantNotReady'
}

/**
 * How an app joins a group, or null when it can't yet. Today only an app approved for
 * addressed-only room context can, and only as the one app of a you-and-this-app group made
 * at creation (`createAppGroup`): its replies are not readable by other people yet (the
 * 2026-09-24 shared app conversations log). The app-bots lane adds `'bot'` here: an app with
 * its own Atum account, invited like a person (`apps.botInvite`), alongside people.
 */
export type GroupAppJoin = 'appGroup'

export function groupAppJoin(app: AppDescriptor): GroupAppJoin | null {
  // An official bot's group behaviour is a column of its own bot row (atum-app-bots v1 §6.2),
  // independent of the operator-set room context: `groupAppState` says whether it can join now.
  return app.bot || app.matrix_room_context === 'addressed_only' ? 'appGroup' : null
}

function appBlock(app: AppDescriptor, mode: GroupPickerMode): GroupCandidateBlock | undefined {
  if (!groupAppJoin(app)) {
    return 'appSoon'
  }

  if (mode === 'add') {
    return 'appNewGroupOnly'
  }

  const state = groupAppState(app)

  return state === 'connect' ? 'appConnect' : state === 'unavailable' ? 'appUnavailable' : undefined
}

// ---------------------------------------------------------------------------------------
// Candidates.

export interface GroupCandidateInput {
  snapshot: MatrixSnapshot
  mode: GroupPickerMode
  locale: string
  /** What the default assistant is called in this locale. */
  assistantName: string
  /** The conversation's members, when adding to one. */
  members?: readonly MatrixMember[]
}

const inRoom = (members: readonly MatrixMember[] | undefined, userId: string) =>
  Boolean(members?.some(member => member.userId === userId && ['join', 'invite'].includes(member.membership)))

/** Your apps in the order the roster shows them, then every other app available to you
 * that you haven't hidden: an app is listed even when it can't join a group yet, so its
 * row can say so rather than the app seeming to be missing. */
function pickerApps(snapshot: MatrixSnapshot): AppDescriptor[] {
  const catalog = snapshot.apps?.apps ?? []
  const shown = appRoster(catalog, snapshot.appShortcuts)
  const seen = new Set(shown.map(app => app.app_id))

  return [
    ...shown,
    ...catalog
      .filter(
        app =>
          !seen.has(app.app_id) &&
          app.availability === 'available' &&
          snapshot.appShortcuts?.[app.app_id]?.visibility !== 'hidden'
      )
      .sort((a, b) => a.roster_order - b.roster_order || a.app_id.localeCompare(b.app_id))
  ]
}

export function groupCandidates({
  assistantName,
  locale,
  members,
  mode,
  snapshot
}: GroupCandidateInput): GroupCandidate[] {
  const people: GroupCandidate[] = knownPeople(snapshot).map(person => ({
    key: `person:${person.userId}`,
    kind: 'person',
    id: person.userId,
    name: person.name,
    lastActiveAt: person.lastActiveAt,
    ...(mode === 'add' && inRoom(members, person.userId) ? { blocked: 'member' as const } : {})
  }))

  const assistants: GroupCandidate[] = projectMatrixRoster(snapshot).groups.flatMap(({ agent, rooms }) => {
    // Already in the conversation: listed as a member whatever else is true.
    const access = mode === 'add' && inRoom(members, agent.userId) ? 'member' : assistantGroupAccess(agent)

    if (access === 'hidden') {
      return []
    }

    return [
      {
        key: `assistant:${agent.userId}`,
        kind: 'assistant' as const,
        id: agent.userId,
        name: matrixRosterAgentName(agent, assistantName),
        lastActiveAt: rooms[0]?.lastActiveAt,
        agent,
        ...(access ? { blocked: access } : {})
      }
    ]
  })

  const apps: GroupCandidate[] = pickerApps(snapshot).map(app => {
    const blocked = appBlock(app, mode)

    return {
      key: `app:${app.app_id}`,
      kind: 'app',
      id: app.app_id,
      name: appLocalizedCopy(app.name, locale, app.app),
      app,
      ...(blocked ? { blocked } : {})
    }
  })

  return [...people, ...assistants, ...apps]
}

/** Someone found by their @name, as a row: a person you can add, unless they already are one. */
export function foundCandidate(
  found: { userId: string; name: string; handle?: string },
  members?: readonly MatrixMember[]
): GroupCandidate {
  return {
    key: `person:${found.userId}`,
    kind: 'person',
    id: found.userId,
    name: found.name,
    ...(found.handle ? { handle: found.handle } : {}),
    ...(inRoom(members, found.userId) ? { blocked: 'member' as const } : {})
  }
}

// ---------------------------------------------------------------------------------------
// Selection.

const isPerson = (candidate: GroupCandidate) => candidate.kind === 'person'
const isAssistant = (candidate: GroupCandidate) => candidate.kind === 'assistant'

const isAppGroupApp = (candidate: GroupCandidate) =>
  candidate.kind === 'app' && Boolean(candidate.app && groupAppJoin(candidate.app) === 'appGroup')

/** How many of your assistants a group already holds, when adding to one: the assistant rows
 * that are there already (`member`). */
export function assistantsInGroup(candidates: readonly GroupCandidate[]): number {
  return candidates.filter(candidate => isAssistant(candidate) && candidate.blocked === 'member').length
}

/**
 * Why a row can't be ticked right now: its own block, else what the current picks rule out.
 * A ticked row can always be unticked, so this is asked only of unticked rows. `inGroup`: your
 * assistants already in the group (adding to one), counted toward its five.
 */
export function selectionBlock(
  candidate: GroupCandidate,
  selected: readonly GroupCandidate[],
  inGroup = 0
): GroupCandidateBlock | undefined {
  if (candidate.blocked) {
    return candidate.blocked
  }

  if (selected.some(each => each.key === candidate.key)) {
    return undefined
  }

  // One group's invitations go out together, at most MATRIX_GROUP_INVITE_LIMIT of them:
  // people and your assistants alike.
  const invited = selected.filter(each => isPerson(each) || isAssistant(each)).length

  if (isPerson(candidate)) {
    if (selected.some(isAppGroupApp)) {
      return 'appAlone'
    }

    return invited >= MATRIX_GROUP_INVITE_LIMIT ? 'full' : undefined
  }

  if (isAssistant(candidate)) {
    if (selected.some(isAppGroupApp)) {
      return 'appAlone'
    }

    if (selected.filter(isAssistant).length + inGroup >= MATRIX_GROUP_AGENT_LIMIT) {
      return 'agentsFull'
    }

    return invited >= MATRIX_GROUP_INVITE_LIMIT ? 'full' : undefined
  }

  if (isAppGroupApp(candidate)) {
    if (selected.some(each => isPerson(each) || isAssistant(each))) {
      return 'appWithPeople'
    }

    return selected.some(isAppGroupApp) ? 'appAlone' : undefined
  }

  return undefined
}

/** Ticks or unticks a row, refusing what `selectionBlock` refuses. */
export function toggleCandidate(
  selected: readonly GroupCandidate[],
  candidate: GroupCandidate,
  inGroup = 0
): GroupCandidate[] {
  if (selected.some(each => each.key === candidate.key)) {
    return selected.filter(each => each.key !== candidate.key)
  }

  return selectionBlock(candidate, selected, inGroup) ? [...selected] : [...selected, candidate]
}

// ---------------------------------------------------------------------------------------
// Presentation: filtering, recent, A–Z.

export function filterCandidates(
  candidates: readonly GroupCandidate[],
  filter: GroupPickerFilter,
  query: string
): GroupCandidate[] {
  return candidates.filter(
    candidate => (filter === 'all' || candidate.kind === filter) && matchesName(candidate.name, query, candidate.handle)
  )
}

export interface GroupPickerSection {
  /** `recent`, or the letter (accents removed; `#` for anything that isn't a letter). */
  key: string
  candidates: GroupCandidate[]
}

/** The letter a name is filed under: its first character without accents (Đ under D). */
export function sectionLetter(name: string): string {
  const first = normalizeMatrixRosterQuery(name.replace(/^@/, '')).charAt(0)

  return /\p{L}/u.test(first) ? first.toLocaleUpperCase() : '#'
}

/**
 * Recent conversations first (only rows that can be ticked, newest first, while not
 * searching), then everyone else under their letter, sorted the way the reader's language
 * sorts names. Everyone appears once.
 */
export function groupPickerSections(
  candidates: readonly GroupCandidate[],
  options: { locale: string; query: string }
): GroupPickerSection[] {
  const recent = options.query.trim()
    ? []
    : candidates
        .filter(candidate => !candidate.blocked && (candidate.lastActiveAt ?? 0) > 0)
        .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
        .slice(0, GROUP_PICKER_RECENT_LIMIT)

  const shown = new Set(recent.map(candidate => candidate.key))
  const collator = new Intl.Collator(options.locale, { sensitivity: 'base', numeric: true })
  const letters = new Map<string, GroupCandidate[]>()

  for (const candidate of [...candidates]
    .filter(each => !shown.has(each.key))
    .sort((a, b) => collator.compare(a.name, b.name) || a.key.localeCompare(b.key))) {
    const letter = sectionLetter(candidate.name)
    letters.set(letter, [...(letters.get(letter) ?? []), candidate])
  }

  const ordered = [...letters.entries()].sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : collator.compare(a, b)))

  return [
    ...(recent.length > 0 ? [{ key: 'recent', candidates: recent }] : []),
    ...ordered.map(([key, list]) => ({ key, candidates: list }))
  ]
}

// ---------------------------------------------------------------------------------------
// Creation.

/** The group's name: what was typed, else its members' names (Zalo's default). */
export function groupNameFor(typed: string, selected: readonly GroupCandidate[]): string {
  const name = typed.trim()

  if (name) {
    return name.slice(0, 200)
  }

  const joined = selected.map(each => each.name.replace(/^@/, '')).join(', ')

  return joined.length > 200 ? `${joined.slice(0, 199)}…` : joined
}

export type GroupCreationPlan =
  | { kind: 'room'; name: string; invite: string[] }
  | { kind: 'appGroup'; name: string; appId: string }

/**
 * What creating the group does, or null while there is nothing to create: a name or one member.
 * A room invites the people and your assistants picked, people first; main tells them apart
 * (its own enrolled assistants) and has each assistant join (assistant-policy.ts).
 */
export function groupCreationPlan(typed: string, selected: readonly GroupCandidate[]): GroupCreationPlan | null {
  const name = groupNameFor(typed, selected)

  if (!name) {
    return null
  }

  const app = selected.find(isAppGroupApp)

  if (app) {
    return { kind: 'appGroup', name, appId: app.id }
  }

  return {
    kind: 'room',
    name,
    invite: [...selected.filter(isPerson), ...selected.filter(isAssistant)].map(each => each.id)
  }
}
