import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { isAssistantRoom } from '../../shared/matrix-assistant-room'
import { isTeamSpaceRoom } from '../../shared/matrix-company-channel-room'
import type { MatrixFounderView } from '../../shared/matrix-founder'
import { matrixNotesSelfKnownRoom } from '../../shared/matrix-notes-self'

import { appRoster, appRosterVisibility } from './app-roster'
import { type MatrixRosterPlaceholder, matrixRosterPlaceholder } from './coming-soon-roster'
import { founderRoom, isFounderAccount } from './founder/roster-founder'
import { primaryAgent } from './room-agent'
import { sortConversations } from './room-navigation'

/** A roster identity owns its private, two-person histories — never a room merely
 * named after it. The native projection already validates `agentPrincipal`; this
 * second shape check keeps an ordinary group out of an assistant's history. */
export interface MatrixRosterAgentGroup {
  agent: MatrixAgentView
  rooms: MatrixRoom[]
}

/** An app kept in the roster (app-roster.ts). An official bot (Moon, Andy) is one row: its chat
 * is drawn inside that row, never as a chat of its own. */
export interface MatrixRosterApp {
  app: AppDescriptor
  /** The bot's chat, when it has one: the room its row opens (`appBot.current`, chosen by the
   * SDK). A chat the person deleted stays here with `appBot.hidden`, so the row still knows it. */
  room?: MatrixRoom
}

export interface MatrixRosterProjection {
  groups: MatrixRosterAgentGroup[]
  rest: MatrixRoom[]
  /** Reserved personal notes row. The room is removed from recency so it is projected once. */
  notesSelf?: MatrixRoom
  /** This account's Founder chat (founder/roster-founder.ts), pinned first under Chats and never
   * ordered by activity. The room also stays in `rest`, which other lists (⌘K) read; the roster
   * draws it once, here. */
  founder?: MatrixRoom
  /** Preserve user-visible identity, state and recovery behavior across connection changes. */
  founderDraft?: MatrixFounderView
  /** The apps the roster lists after the chats, in catalog order; absent when there are none.
   * Their bots' chats are never in `rest`: one row per bot. */
  apps?: MatrixRosterApp[]
  /** Presentation-only catalog entries (`roster_state: "coming_soon"`) after the live apps.
   * They are inert: no room, launch route, consent or link operation exists for them. */
  placeholders?: MatrixRosterPlaceholder[]
}

function newestFirst(left: MatrixRoom, right: MatrixRoom) {
  return (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0) || left.id.localeCompare(right.id)
}

/** A bot chat belongs to this app's bot only when the room's marker and the signed catalog
 * name the same app and the same bot. */
export function isAppBotRoom(room: MatrixRoom, app: AppDescriptor): boolean {
  return Boolean(app.bot && room.appBot?.appId === app.app_id && room.appBot.botUserId === app.bot.user_id)
}

/** A Matrix id is identity, not presentation. A localpart is the bounded fallback
 * when the platform has not supplied an agent display name. */
export function matrixLocalpart(userId: string): string {
  const match = /^@([^:]+):/u.exec(userId)

  return match?.[1] || ''
}

/** The name the owner gave the assistant (the platform record). The primary assistant is
 * renameable (owner decision D1, 2026-10-05): it shows its record's name, and the product
 * name only until it has one; any other assistant falls back to its Matrix localpart. */
export function matrixRosterAgentName(agent: MatrixAgentView, defaultName: string): string {
  const name = agent.name?.trim()

  // Allocated IDs are custody, never a person's chosen name (ledger AC8).
  const local = matrixLocalpart(agent.userId).replace(/^(?:user|agent|app|service|system)-[0-9a-f]{16,}$/u, '')

  return name || (agent.isDefault ? defaultName : local || defaultName)
}

/** What the primary assistant is called now, where no chat names it (getting ready, first
 * run, repair): its record's name (D1: renameable), else the product name. */
export function matrixPrimaryAgentName(snapshot: MatrixSnapshot, defaultName: string): string {
  const primary = primaryAgent(snapshot)

  return primary ? matrixRosterAgentName(primary, defaultName) : defaultName
}

/** Search the displayed names consistently across composed/decomposed accents. */
export function normalizeMatrixRosterQuery(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/gu, 'd').trim().replace(/\s+/gu, ' ')
}

/** Filtering is presentation only: retain trusted groups and their existing order. The
 * Founder chat is also found by every name its row answers to (`founderNames`: "Founder", the
 * localized subtitle, the handle). An app is found by the name its row shows (`appName`), and a
 * bot by its chat's own name too, unless the person deleted that chat. */
export function filterMatrixRoster(
  projection: MatrixRosterProjection,
  query: string,
  defaultName: string,
  founderNames: readonly string[] = [],
  appName: (app: AppDescriptor) => string = app => app.bot?.display_name ?? app.app,
  roomHandle: (room: MatrixRoom) => string | undefined = () => undefined,
  agentHandle: (agent: MatrixRosterProjection['groups'][number]['agent']) => string | undefined = () => undefined
): MatrixRosterProjection {
  const normalized = normalizeMatrixRosterQuery(query.replace(/^@/u, ''))

  if (!normalized) {
    return projection
  }

  const matches = (name: string) => normalizeMatrixRosterQuery(name.replace(/^@/u, '')).includes(normalized)

  // A chat is found by every name it shows plus a directory-verified public handle.
  const roomMatches = (room: MatrixRoom) =>
    [room.title, room.firstLine, room.name, roomHandle(room)].some(name => name && matches(name))

  const groups = projection.groups.flatMap(group => {
    const handle = agentHandle(group.agent)

    if (matches(matrixRosterAgentName(group.agent, defaultName)) || Boolean(handle && matches(handle))) {
      return [group]
    }

    const rooms = group.rooms.filter(roomMatches)

    return rooms.length > 0 ? [{ ...group, rooms }] : []
  })

  const founder =
    projection.founder && (founderNames.some(matches) || roomMatches(projection.founder))
      ? projection.founder
      : undefined

  const founderDraft =
    !founder && projection.founderDraft && founderNames.some(matches) ? projection.founderDraft : undefined

  const apps = (projection.apps ?? []).filter(
    ({ app, room }) => matches(appName(app)) || Boolean(app.bot?.handle && matches(app.bot.handle)) ||
      Boolean(room && !room.appBot?.hidden && roomMatches(room))
  )

  const placeholders = (projection.placeholders ?? []).filter(
    placeholder => Object.values(placeholder.name).some(matches) || matches(placeholder.app)
  )

  return {
    groups,
    rest: projection.rest.filter(roomMatches),
    ...(projection.notesSelf ? { notesSelf: projection.notesSelf } : {}),
    ...(founder ? { founder } : {}),
    ...(founderDraft ? { founderDraft } : {}),
    ...(apps.length > 0 ? { apps } : {}),
    ...(placeholders.length > 0 ? { placeholders } : {})
  }
}

/**
 * Catalog-driven coming-soon rows, after the live apps. The same preference/default table
 * decides them: explicit hidden wins, explicit shown draws the inert row, and an implicit
 * choice follows the effective server `roster_default` only when the preference is ready.
 * Without a catalog there is nothing to show; the old hardcoded list is gone so a stale or
 * offline window can never invent a roster the owner's server did not send.
 */
function comingSoonPlaceholders(snapshot: MatrixSnapshot): MatrixRosterPlaceholder[] {
  return (snapshot.apps?.apps ?? [])
    .filter(app => app.roster_state === 'coming_soon')
    .filter(app => appRosterVisibility(app, snapshot.appShortcuts?.[app.app_id]) === 'shown')
    .sort((a, b) => a.roster_order - b.roster_order || a.app_id.localeCompare(b.app_id))
    .map(matrixRosterPlaceholder)
}

/** A room only belongs under an agent when both the native agent projection and
 * the room's current owner+agent membership agree. */
export function isAgentHistoryRoom(room: MatrixRoom, ownerId: string | undefined, agent: MatrixAgentView): boolean {
  return room.agentPrincipal === agent.principal && isAssistantRoom(room, ownerId, agent.userId)
}

/**
 * Project every Home room exactly once. Team Space channels and conversations (company DMs and group
 * DMs) are owned by the company workspace and never appear in the personal chat roster or its search
 * consumers. The default agent is deliberately recognized
 * by the assistant-room shape even when an older snapshot has not yet annotated
 * that room with `agentPrincipal`; named agents require both the trusted native
 * principal and the same strict private-room shape.
 *
 * An official bot's chats (Moon, Andy) are drawn in the bot's own row, so they are never in
 * `rest`: the row carries the one it opens. A bot chat whose app has no row here (the person
 * took the app off the roster) stays an ordinary chat, unless the person deleted it.
 */
export function projectMatrixRoster(snapshot: MatrixSnapshot): MatrixRosterProjection {
  const ownerId = snapshot.identity?.userId
  const reportedAgents = snapshot.agents ?? []

  const defaultAgent = primaryAgent(snapshot)

  const agents = defaultAgent
    ? [
        { ...defaultAgent, isDefault: true },
        ...reportedAgents.filter(agent => agent !== defaultAgent).map(agent => ({ ...agent, isDefault: false }))
      ]
    : !snapshot.assistant
      ? reportedAgents
      : [
          {
            principal: snapshot.assistant.userId,
            userId: snapshot.assistant.userId,
            isDefault: true,
            ready: snapshot.state === 'ready',
            hermes: snapshot.hermes ?? 'unconfigured',
            atumModel: Boolean(snapshot.atumModel)
          },
          ...reportedAgents
        ]

  // Never an assistant's history, whatever its members: the Founder chat is pinned on its own.
  const homeRooms = snapshot.rooms.filter(room => !isTeamSpaceRoom(room))
  const founder = founderRoom({ ...snapshot, rooms: homeRooms })
  // A draft only while no chat exists: main offers one from the official-accounts read, and the
  // first message (not this row) makes the room.
  const founderDraft = !founder && snapshot.founder?.offer && !isFounderAccount(snapshot) ? snapshot.founder : undefined
  const assigned = new Set<string>(founder ? [founder.id] : [])

  const groups = agents.map(agent => {
    const rooms = homeRooms
      .filter(room => {
        if (assigned.has(room.id)) {
          return false
        }

        const belongs = agent.isDefault
          ? (!defaultAgent || !room.agentPrincipal || room.agentPrincipal === agent.principal) &&
            isAssistantRoom(room, ownerId, agent.userId)
          : isAgentHistoryRoom(room, ownerId, agent)

        if (belongs) {
          assigned.add(room.id)
        }

        return belongs
      })
      .sort(newestFirst)

    return { agent, rooms }
  })

  const apps = (snapshot.apps ? appRoster(snapshot.apps.apps, snapshot.appShortcuts) : []).map(app => {
    const room = homeRooms.find(value => value.appBot?.current && isAppBotRoom(value, app))

    return room ? { app, room } : { app }
  })

  // Drawn in its bot's row, or deleted by the person: never an ordinary chat row. Since 0.20 the
  // bot's chat is plain; an encrypted one from before is never the room its row opens, so it is
  // listed as an ordinary chat (and in ⌘K): its history stays one click away.
  const inBotRow = (room: MatrixRoom) =>
    Boolean(
      room.appBot &&
      (room.appBot.hidden ||
        ((!room.encrypted || room.appBot.current) && apps.some(({ app }) => isAppBotRoom(room, app))))
    )

  const placeholders = comingSoonPlaceholders(snapshot)

  const notesSelf = snapshot.notesSelf?.state === 'ready'
    ? homeRooms.find(room => room.id === snapshot.notesSelf?.roomId)
    : undefined

  return {
    groups,
    rest: sortConversations(
      homeRooms.filter(room =>
        (!assigned.has(room.id) || room.id === founder?.id) &&
        !matrixNotesSelfKnownRoom(snapshot.notesSelf, room.id) &&
        !inBotRow(room)
      )
    ),
    ...(notesSelf ? { notesSelf } : {}),
    ...(founder ? { founder } : {}),
    ...(founderDraft ? { founderDraft } : {}),
    ...(apps.length > 0 ? { apps } : {}),
    ...(placeholders.length > 0 ? { placeholders } : {})
  }
}

/** Personal chat actions share the roster's ownership classification. */
export function personalChatActions(
  room: MatrixRoom,
  snapshot: MatrixSnapshot
): {
  end: 'delete' | 'leave' | null
  person?: string
} {
  const roster = projectMatrixRoster(snapshot)
  const self = snapshot.identity?.userId

  const founderIsSelf =
    isFounderAccount(snapshot) ||
    snapshot.officialAccounts?.some(account => account.role === 'founder' && account.userId === self)

  if (
    room.membership !== 'join' ||
    room.assistant ||
    room.agentPrincipal ||
    room.plainAgent ||
    room.appBot ||
    room.roomType ||
    !roster.rest.some(value => value.id === room.id) ||
    (founderIsSelf && room.id === snapshot.founder?.roomId)
  ) {
    return { end: null }
  }

  const person = room.direct
    ? room.participants?.find(member => member.userId !== self && ['join', 'invite'].includes(member.membership))
        ?.userId
    : undefined

  return { end: room.direct ? 'delete' : 'leave', ...(person ? { person } : {}) }
}

/**
 * A personal group's shared name and topic, and whether this account may change each (its power
 * level for `m.room.name` / `m.room.topic`). Null for every other chat: a one-to-one chat, an
 * assistant's, app's or Team Space room, the Founder chat, an invitation. Display only.
 */
export function personalGroupDetails(
  room: MatrixRoom,
  snapshot: MatrixSnapshot
): { name: boolean; topic: boolean } | null {
  if (personalChatActions(room, snapshot).end !== 'leave') {
    return null
  }

  return { name: Boolean(room.canName), topic: Boolean(room.canTopic) }
}

/**
 * Whether a chat offers Low priority (the standard `m.lowpriority` tag): an ordinary chat in the
 * roster's chat list, where the tag orders it. The Founder chat is pinned first and an
 * assistant's, app's or Team Space room is ordered by its own section, so they don't offer it.
 */
export function lowPriorityEligible(room: MatrixRoom, snapshot: MatrixSnapshot): boolean {
  if (room.membership !== 'join') {
    return false
  }

  const roster = projectMatrixRoster(snapshot)

  return room.id !== roster.founder?.id && roster.rest.some(value => value.id === room.id)
}

/**
 * Whether someone in this chat can be reported (Matrix's report APIs): a person, offered where
 * Block is — a personal chat or group you can delete or leave, never yourself, an assistant or
 * an app's bot, a Team Space room or (for the Founder) the Founder chat.
 */
export function reportablePerson(room: MatrixRoom, snapshot: MatrixSnapshot, userId: string | undefined): boolean {
  if (!userId || userId === snapshot.identity?.userId || personalChatActions(room, snapshot).end === null) {
    return false
  }

  const assistant =
    snapshot.assistant?.userId === userId || Boolean(snapshot.agents?.some(agent => agent.userId === userId))

  const bot = Boolean(snapshot.apps?.apps.some(app => app.bot?.user_id === userId))

  return !assistant && !bot
}
