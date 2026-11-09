/**
 * The Atum roster — the narrow, honest adapter.
 *
 * The visible product model is Atum, the master assistant, plus any AGENTS the
 * user made, each with its own CHATS, plus hosted Atum DMs. Agents and chats
 * reach this module only as already-projected rows from `agents.ts` and
 * `assistant-chats.ts`; the roster itself never touches `$profiles`,
 * `$projects`, `$cronSessions`, pins, worktrees, or session groups. Those are
 * the Hermes ORGANISATION, and they stay out of the product — `roster.test.ts`
 * asserts that this file's import graph keeps it that way.
 *
 * The master row is the product's home and the way to start a new chat; each
 * chat row routes to its own durable session id so navigation survives a
 * stream restart and auto-compression.
 */

import { type Locale, TRANSLATIONS } from '@/i18n'
import { appDisplayName, appSubtitle, type DesktopAppCatalogEntry } from '@/lib/atum-app-catalog'
import type { AtumMessagingConversation, AtumSocialProjection } from '@/lib/atum-messaging-client'

import { type ParticipantDisplay } from '../../../shared/atum-participants'
import { dmRoute, NEW_CHAT_ROUTE } from '../routes'

import { ATUM_AGENT_ID, type AtumAgent } from './agents'
import type { AtumAssistantChat } from './assistant-chats'

export type AtumRosterKind = 'assistant' | 'chat' | 'app' | 'direct' | 'group' | 'unsupported'

/** How many of the assistant's chats the roster shows before folding the
 *  rest behind "show more". Enough to reach recent work without the thread
 *  list crowding the apps and people below it. */
export const ROSTER_CHAT_FOLD = 5

export interface AtumRosterEntry {
  /** Stable list key. `agent:<id>` for an agent row, `chat:<agent>:<id>` for its chats, the conversation id for DMs. */
  id: string
  kind: AtumRosterKind
  /**
   * Which agent this row belongs to: the agent itself, or the agent that owns
   * this chat. Empty on apps and people, which belong to the account rather
   * than to any one agent.
   */
  agentId: string
  /** An agent the product created, and may therefore repair or remove. */
  managed: boolean
  /** A named agent's symbolic avatar. Empty everywhere else. */
  emoji: string
  /** Every session id that resolves to an assistant chat row; empty elsewhere. */
  sessionIds: string[]
  /** An assistant chat whose turn finished while the user was elsewhere. */
  unread: boolean
  /** Curated app id for specialist rows; null for the assistant and people. */
  appId: string | null
  /** Hosted id once the app conversation exists; null for a first-use catalog row. */
  conversationId: string | null
  /** Authorized display projection when the row names an existing participant. */
  participant?: ParticipantDisplay
  title: string
  /** One quiet line under the title. Empty string renders nothing — never a placeholder. */
  preview: string
  /** The app role from the Atum presentation catalog or hosted row; wins over `preview`. */
  role: string
  /** Hosted avatar image when the row carries one; else an initial on a tint. */
  avatarUrl: string
  /** Curated first-party presentation, static by design and never inferred from `kind`. */
  verified: boolean
  /** Approved app accent; direct chats retain the neutral Atum tint. */
  accent: string
  /** `'online'` only when the hosted row says so; the assistant never has one. */
  presence: 'online' | null
  unreadCount: number
  /** Route this row opens. */
  route: string
  /** ISO timestamp used for ordering conversations. `null` for an agent row. */
  activityAt: null | string
}

// Unicode combining diacritical marks — stripped after NFD so a query typed
// without tone marks still matches Vietnamese titles.
const COMBINING_MARKS = /[̀-ͯ]/gu
const D_WITH_STROKE = /[đĐ]/gu

/** Fold Vietnamese diacritics so `tro chuyen` finds `Trò chuyện`. */
export function foldSearchText(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').replace(D_WITH_STROKE, 'd').toLowerCase()
}

export function rosterEntryMatches(entry: AtumRosterEntry, query: string): boolean {
  const needle = foldSearchText(query.trim())

  if (!needle) {
    return true
  }

  // The master's hint is an instruction ("start a new chat"), not content, so
  // it matches on name alone. A named agent's description IS content.
  const haystack =
    entry.kind === 'assistant' && entry.agentId === 'default'
      ? entry.title
      : `${entry.title} ${entry.role} ${entry.preview}`

  return foldSearchText(haystack).includes(needle)
}

function dmPreview(conversation: AtumMessagingConversation): string {
  const preview = conversation.payload?.preview

  return typeof preview === 'string' ? preview : ''
}

const HAS_UPPERCASE = /\p{Lu}/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Display title for a hosted row. Hosted specialist ids arrive lowercase
 * (`moon`, `taylor`) — those get proper title case. A title that already
 * carries its own casing (`Trò chuyện nhóm`) is left alone except for a
 * capital first letter.
 */
export function toDisplayTitle(raw: string): string {
  const title = raw.trim()

  if (!title) {
    return title
  }

  if (!HAS_UPPERCASE.test(title)) {
    return title.replace(/(^|\s)(\p{L})/gu, (_match, space: string, letter: string) => space + letter.toUpperCase())
  }

  return title.charAt(0).toUpperCase() + title.slice(1)
}

function payloadString(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

function specialistSlug(conversation: AtumMessagingConversation): string {
  return payloadString(conversation.payload, 'specialist').toLowerCase()
}

function appRole(conversation: AtumMessagingConversation, locale: Locale, catalog: readonly DesktopAppCatalogEntry[]): string {
  const supplied = payloadString(conversation.payload, 'role', 'specialist_role')

  if (supplied) {
    return supplied
  }

  const app = catalog.find(entry => entry.app === specialistSlug(conversation))

  return app ? appSubtitle(app, locale) : ''
}

function appOrder(conversation: AtumMessagingConversation, catalog: readonly DesktopAppCatalogEntry[]): number {
  const index = catalog.findIndex(entry => entry.app === specialistSlug(conversation))

  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

export interface AtumConversationPresentation {
  accent: string
  avatarUrl: string
  /** False for a direct thread whose peer could not be named. The title is
   *  then a neutral placeholder — fine for a header you navigated to, never
   *  a roster row (`buildAtumRoster` drops it). Apps are always identified. */
  identified: boolean
  kind: 'app' | 'direct' | 'group' | 'unsupported'
  presence: 'online' | null
  participant?: ParticipantDisplay
  role: string
  title: string
  verified: boolean
}

/** Who is looking, and who they know. Names a direct thread's peer. */
export interface AtumConversationIdentity {
  /** The signed-in account's hosted id; `null` when unknown. */
  accountId: string | null
  /** Social projections — the connected peer's profile wins over the wire row. */
  people: readonly AtumSocialProjection[]
}

const NO_IDENTITY: AtumConversationIdentity = { accountId: null, people: [] }

/**
 * The peer's display name for a direct thread, or `''` when it cannot be
 * named. The social relationship is authoritative (it is what governs whether
 * you can message them); the hosted participant projection is the fallback so
 * a thread whose relationship has not synced yet still carries its name.
 * Never a raw participant id.
 */
function directPeer(
  conversation: AtumMessagingConversation,
  identity: AtumConversationIdentity
): { avatarUrl: string; name: string; participant?: ParticipantDisplay } {
  const relationship = identity.people.find(
    row => row.availability === 'available' && row.directThreadId === conversation.id
  )

  const avatarUrl = relationship?.availability === 'available' ? (relationship.profile.avatar ?? '') : ''

  if (relationship?.availability === 'available') {
    const name = relationship.profile.displayName.trim()

    if (name) {
      return {
        avatarUrl,
        name,
        participant: {
          kind: 'user',
          id: relationship.profile.profileId,
          displayName: name,
          ...(avatarUrl ? { avatarUrl } : {})
        }
      }
    }
  }

  if (!identity.accountId) {
    return { avatarUrl, name: '' }
  }

  const participants = conversation.payload?.participants

  if (!Array.isArray(participants)) {
    return { avatarUrl, name: '' }
  }

  const peer = participants.find(
    (participant): participant is Record<string, unknown> =>
      typeof participant === 'object' &&
      participant !== null &&
      (participant as Record<string, unknown>).type === 'user' &&
      (participant as Record<string, unknown>).id !== identity.accountId
  )

  const name = typeof peer?.display_name === 'string' ? peer.display_name.trim() : ''

  return { avatarUrl, name: UUID.test(name) ? '' : name }
}

/** One presentation adapter shared by the roster, transcript empty state and
 * workspace details. Raw participant ids never need to become UI copy. */
export function presentAtumConversation(
  conversation: AtumMessagingConversation,
  locale: Locale,
  identity: AtumConversationIdentity = NO_IDENTITY,
  catalog: readonly DesktopAppCatalogEntry[] = []
): AtumConversationPresentation {
  const specialist = specialistSlug(conversation)
  // An old specialist row that only has a title is still an openable history
  // row, but its title never becomes an app selection.
  const isApp = conversation.kind === 'specialist' && Boolean(specialist)

  const kind =
    isApp
      ? 'app'
      : conversation.kind === 'group'
        ? 'group'
        : conversation.kind === 'unsupported'
          ? 'unsupported'
          : 'direct'

  const presentation = kind === 'app' ? catalog.find(app => app.app === specialist) : undefined

  const suppliedTitle = (conversation.kind === 'group' ? conversation.group?.title : conversation.title)?.trim() ?? ''
  const peer = conversation.kind === 'direct' ? directPeer(conversation, identity) : { avatarUrl: '', name: '' }

  const title =
    kind === 'app'
      ? specialist
      : peer.name || (suppliedTitle && !UUID.test(suppliedTitle) ? suppliedTitle : '')

  return {
    accent: '',
    avatarUrl:
      presentation?.icon?.url ?? (peer.avatarUrl || payloadString(conversation.payload, 'avatar_url', 'avatarUrl')),
    identified: conversation.kind === 'specialist' || kind === 'group' || kind === 'unsupported' || Boolean(title),
    kind,
    presence:
      kind === 'group' || kind === 'unsupported' ? null : conversation.payload?.presence === 'online' ? 'online' : null,
    role: kind === 'app' ? appRole(conversation, locale, catalog) : '',
    ...(peer.participant ? { participant: peer.participant } : {}),
    title:
      kind === 'unsupported'
        ? TRANSLATIONS[locale].dm.group.unavailable
        : (presentation ? appDisplayName(presentation, locale) : toDisplayTitle(title || (locale === 'vi' ? 'Cuộc trò chuyện' : 'Conversation'))),
    verified: presentation?.verified ?? false
  }
}

function activityTime(conversation: AtumMessagingConversation): string {
  return conversation.lastMessageAt ?? conversation.updatedAt
}

export interface BuildRosterInput {
  /** Agents, already projected free of Hermes nouns. The master is first. */
  agents: readonly AtumAgent[]
  /** Assistant chats, already projected free of Hermes nouns. */
  chats: readonly AtumAssistantChat[]
  /** Copy for the pinned assistant row. */
  assistantHint: string
  assistantTitle: string
  /** Title for a chat the server has not titled or previewed yet. */
  untitledChat: string
  /** Current renderer locale, used only for the curated app-role presentation. */
  locale: Locale
  /** Hosted Atum app and direct conversations. */
  conversations: readonly AtumMessagingConversation[]
  /** Hosted conversations only exist once the account is usable. */
  dmsAvailable: boolean
  /** The signed-in account id, so a direct thread's peer can be told from self. */
  accountId: string | null
  /** Social projections used to name direct threads. */
  people: readonly AtumSocialProjection[]
  /** Current account's main-projected server registration. */
  catalog?: readonly DesktopAppCatalogEntry[]
}

/**
 * Build the visible roster. The pinned assistant is always first and always
 * present — it is the product's home surface and starts a new chat, so "no
 * chats" is never a state the user can reach by having no sessions. Assistant
 * chats follow, newest first, then apps, then people. A direct thread whose
 * peer cannot be named is not a row: a "Conversation" placeholder reads as a
 * chat with nobody, so the list ends with the discover affordance instead.
 */
export function buildAtumRoster({
  agents,
  chats,
  assistantHint,
  assistantTitle,
  untitledChat,
  locale,
  conversations,
  dmsAvailable,
  accountId,
  people,
  catalog = []
}: BuildRosterInput): AtumRosterEntry[] {
  const chatRow = (chat: AtumAssistantChat): AtumRosterEntry => ({
    id: `chat:${chat.agentId}:${chat.id}`,
    kind: 'chat',
    agentId: chat.agentId,
    managed: false,
    emoji: '',
    sessionIds: chat.sessionIds,
    unread: chat.unread,
    appId: null,
    conversationId: null,
    participant: undefined,
    title: chat.title || chat.preview || untitledChat,
    preview: chat.title ? chat.preview : '',
    role: '',
    avatarUrl: '',
    accent: '',
    verified: false,
    presence: null,
    unreadCount: 0,
    route: chat.route,
    activityAt: chat.activityAt
  })

  // Each agent, then the chats it owns. The master assistant is always first
  // and always present, so "no agents yet" is never a state a user reaches.
  const assistantRows = agents.flatMap<AtumRosterEntry>(agent => [
    {
      id: `agent:${agent.id}`,
      kind: 'assistant',
      agentId: agent.id,
      managed: agent.isManaged,
      // Legacy symbols remain readable metadata but no longer drive the
      // profile surface. A new identity is a hosted photo or its initial.
      emoji: '',
      sessionIds: [],
      unread: false,
      appId: null,
      conversationId: null,
      participant: agent.participant,
      title: agent.isDefault ? agent.title || assistantTitle : agent.title,
      // Only the master advertises the new-chat affordance. A named agent
      // shows what it is for, and nothing when it has no description — its
      // description is CONTENT and is searched, so it must not carry copy
      // that would make every wordless agent match the same query.
      preview: agent.isDefault ? assistantHint : agent.description,
      role: '',
      avatarUrl: agent.avatarUrl ?? '',
      accent: '',
      verified: false,
      presence: null,
      unreadCount: 0,
      // Every agent's row leads to the same place — the composer — because
      // WHICH agent it talks to is what the click decides, not where it goes.
      // A named agent with no route was simply inert.
      route: NEW_CHAT_ROUTE,
      activityAt: null
    },
    ...chats.filter(chat => chat.agentId === agent.id).map(chatRow)
  ])

  // A chat whose agent has not loaded yet still belongs to someone. Every cold
  // boot passes through that window ($sessions arrives before $profiles), and
  // an orphan keeping its own agent id would group under an agent row that
  // does not exist — a nameless indented block. It is re-homed to the master,
  // which is always present, so the roster never shows ownerless chats.
  const knownAgents = new Set(agents.map(agent => agent.id))

  const orphanChats = chats
    .filter(chat => !knownAgents.has(chat.agentId))
    .map(chat => ({ ...chatRow(chat), agentId: ATUM_AGENT_ID }))

  if (!dmsAvailable) {
    return [...assistantRows, ...orphanChats]
  }

  const identity: AtumConversationIdentity = { accountId, people }

  const entries = conversations.flatMap<AtumRosterEntry>(conversation => {
    const presentation = presentAtumConversation(conversation, locale, identity, catalog)

    if (!presentation.identified) {
      return []
    }

    const specialist = presentation.kind === 'app' ? specialistSlug(conversation) || null : null

    return {
      id: conversation.id,
      kind: presentation.kind,
      agentId: '',
      managed: false,
      emoji: '',
      sessionIds: [],
      unread: false,
      appId: specialist,
      conversationId: conversation.id,
      participant: presentation.participant,
      title: presentation.title,
      preview: dmPreview(conversation),
      role: presentation.role,
      avatarUrl: presentation.avatarUrl,
      accent: presentation.accent,
      verified: presentation.verified,
      presence: presentation.presence,
      unreadCount: conversation.unreadCount,
      route: dmRoute(conversation.id),
      activityAt: activityTime(conversation)
    }
  })

  const apps = entries
    .filter(entry => entry.kind === 'app')
    .sort((left, right) => {
      const leftConversation = conversations.find(conversation => conversation.id === left.id)!
      const rightConversation = conversations.find(conversation => conversation.id === right.id)!

      return appOrder(leftConversation, catalog) - appOrder(rightConversation, catalog) || left.title.localeCompare(right.title)
    })

  for (const presentation of catalog) {
    const catalogId = presentation.app

    if (presentation.availability !== 'available' || !presentation.supported_modes.includes('direct')) {continue}

    if (apps.some(entry => entry.appId === catalogId)) {
      continue
    }

    apps.push({
      id: `app:${catalogId}`,
      kind: 'app',
      agentId: '',
      managed: false,
      emoji: '',
      sessionIds: [],
      unread: false,
      appId: catalogId,
      conversationId: null,
      participant: undefined,
      title: appDisplayName(presentation, locale),
      preview: '',
      role: appSubtitle(presentation, locale),
      avatarUrl: presentation.icon?.url ?? '',
      accent: '',
      verified: presentation.verified,
      presence: null,
      unreadCount: 0,
      route: '',
      activityAt: null
    })
  }

  apps.sort((left, right) => {
    const index = (appId: string | null) => {
      const found = catalog.findIndex(app => app.app === appId)

      return found < 0 ? Number.MAX_SAFE_INTEGER : found
    }

    return index(left.appId) - index(right.appId)
  })

  const direct = entries
    .filter(entry => entry.kind === 'direct' || entry.kind === 'group' || entry.kind === 'unsupported')
    .sort((left, right) => (right.activityAt ?? '').localeCompare(left.activityAt ?? ''))

  return [...assistantRows, ...orphanChats, ...apps, ...direct]
}

export function filterRoster(entries: readonly AtumRosterEntry[], query: string): AtumRosterEntry[] {
  return query.trim() ? entries.filter(entry => rosterEntryMatches(entry, query)) : [...entries]
}
