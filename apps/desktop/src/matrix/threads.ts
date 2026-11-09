import {
  type EventTimeline,
  EventType,
  type MatrixClient,
  type MatrixEvent,
  MsgType,
  NotificationCountType,
  ReceiptType,
  RelationType,
  type Room
} from 'matrix-js-sdk'

import type { MatrixCompanyThread, MatrixMessage, MatrixRoom, MatrixThread } from '../../shared/matrix'
import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from '../../shared/matrix-company-channel-room'

/** Ordinary rooms have no thread panel, so flatten every loaded SDK thread event into their
 * bounded room window. Team Space rooms keep SDK threads separate for their thread panel. */
export function matrixRoomTimelineEvents(
  room: Room,
  timeline: EventTimeline = room.getLiveTimeline(),
  events: MatrixEvent[] = timeline.getEvents()
): MatrixEvent[] {
  if (
    events.length === 0 ||
    [MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '')
  ) {
    return events
  }

  const oldest = events[0]!.getTs()
  const newest = timeline === room.getLiveTimeline() ? Infinity : (events.at(-1)?.getTs() ?? 0)
  const ids = new Set(events.flatMap(event => event.getId() ? [event.getId()!] : []))
  const threadEvents = room
    .getThreads()
    .flatMap(thread => thread.events)
    .filter(event => {
      const id = event.getId()
      const eligible =
        event.getTs() >= oldest &&
        event.getTs() <= newest &&
        (!id || !ids.has(id))

      if (eligible && id) {
        ids.add(id)
      }

      return eligible
    })
    .sort((left, right) => left.getTs() - right.getTs())

  if (threadEvents.length === 0) {return events}

  // Insert thread rows by time without sorting the SDK's main window. Its order is
  // authoritative, especially for chronological pending local echoes that can be out of time.
  const merged: MatrixEvent[] = []
  let threadIndex = 0

  for (const event of events) {
    while (threadEvents[threadIndex] && threadEvents[threadIndex]!.getTs() < event.getTs()) {
      merged.push(threadEvents[threadIndex]!)
      threadIndex++
    }

    merged.push(event)
  }

  return merged.concat(threadEvents.slice(threadIndex))
}

/** Per-user room account data. It changes attention, never channel access. */
export const MATRIX_THREAD_ATTENTION = 'io.atum.thread_attention.v1'
export const MATRIX_THREADS_MAX = 100
export const MATRIX_THREAD_REPLIES_MAX = 100
/** The renderer never retains more company threads than the inbox can page through. */
export const MATRIX_COMPANY_THREADS_MAX = 200
const MATRIX_THREAD_PREFERENCES_MAX = 1_000

const EVENT_ID = /^\$.{1,1023}$/u

interface ThreadAttention {
  followed: Set<string>
  unfollowed: Set<string>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function ids(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MATRIX_THREAD_PREFERENCES_MAX || !value.every(validThreadRootId)) {
    return undefined
  }

  const unique = [...new Set(value)]

  return unique.length === value.length ? unique : undefined
}

export function validThreadRootId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID.test(value)
}

/** Malformed preference data fails closed to defaults; it never hides a thread or grants access. */
export function matrixThreadAttention(room: Room): ThreadAttention {
  const value = record(room.getAccountData(MATRIX_THREAD_ATTENTION)?.getContent())

  if (!value || Object.keys(value).sort().join(',') !== 'followed,unfollowed,v' || value.v !== 1) {
    return { followed: new Set(), unfollowed: new Set() }
  }

  const followed = ids(value.followed)
  const unfollowed = ids(value.unfollowed)

  if (!followed || !unfollowed || followed.some(id => unfollowed.includes(id))) {
    return { followed: new Set(), unfollowed: new Set() }
  }

  return { followed: new Set(followed), unfollowed: new Set(unfollowed) }
}

function requireServerMessage(room: Room, eventId: string): MatrixEvent {
  const event = room.findEventById(eventId)

  if (
    !validThreadRootId(eventId) ||
    !event ||
    event.getId() !== eventId ||
    event.getRoomId() !== room.roomId ||
    event.status != null ||
    event.getType() !== EventType.RoomMessage ||
    event.isRelation(RelationType.Replace) ||
    event.isRedacted() ||
    event.localRedactionEvent() ||
    event.isDecryptionFailure()
  ) {
    throw new Error('matrix_message_changed')
  }

  return event
}

function requireTeamSpaceThreadRoom(room: Room, writable = false): void {
  if (![MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '') ||
    room.getMyMembership() !== 'join' || writable && !room.maySendMessage()) {
    throw new Error('matrix_thread_unavailable')
  }
}

function relation(event: MatrixEvent): Record<string, unknown> | undefined {
  return record(event.getWireContent()['m.relates_to']) ?? record(event.getOriginalContent()['m.relates_to'])
}

function requireThreadRoot(room: Room, rootId: string): MatrixEvent {
  const root = requireServerMessage(room, rootId)

  if (relation(root)?.rel_type === RelationType.Thread) {
    throw new Error('matrix_message_changed')
  }

  return root
}

/**
 * Require a server-backed flat thread target. This is deliberately shared by
 * text and protected-file sends: a reply may name its root or an existing
 * direct child of that root, never another thread's child as a new root.
 */
export function requireFlatThreadTarget(room: Room, rootId: string, replyTo = rootId): void {
  requireThreadRoot(room, rootId)
  const target = requireServerMessage(room, replyTo)

  if (replyTo === rootId) {
    return
  }

  const related = relation(target)

  if (related?.rel_type !== RelationType.Thread || related.event_id !== rootId) {
    throw new Error('matrix_message_changed')
  }
}

function responseEventId(value: { event_id?: unknown } | undefined): string {
  if (!validThreadRootId(value?.event_id)) {
    throw new Error('matrix_send_failed')
  }

  return value.event_id
}

function matrixMentions(mentions: readonly string[] | undefined, room = false) {
  const userIds = [...new Set(mentions ?? [])]

  return userIds.length || room ? { 'm.mentions': { user_ids: userIds, ...(room ? { room: true } : {}) } } : {}
}

/** Send one flat standard Matrix thread reply. Nested threads are never created. */
export async function sendMatrixThreadReply(
  client: MatrixClient,
  room: Room,
  body: string,
  rootId: string,
  replyTo = rootId,
  mentions?: readonly string[],
  roomMention = false
): Promise<string> {
  if (!body.trim()) {
    throw new Error('matrix_command_invalid')
  }

  // Archived channels and read-only company conversations close Matrix message power. Recheck
  // native state at the final write boundary so a stale thread composer cannot publish.
  requireTeamSpaceThreadRoom(room, true)

  requireFlatThreadTarget(room, rootId, replyTo)

  return responseEventId(
    await client.sendEvent(room.roomId, EventType.RoomMessage, {
      msgtype: MsgType.Text,
      body,
      'm.relates_to': {
        rel_type: RelationType.Thread,
        event_id: rootId,
        'm.in_reply_to': { event_id: replyTo }
      },
      ...matrixMentions(mentions, roomMention)
    })
  )
}

export async function setMatrixThreadFollow(
  client: MatrixClient,
  room: Room,
  rootId: string,
  followed: boolean
): Promise<void> {
  requireTeamSpaceThreadRoom(room)
  requireThreadRoot(room, rootId)
  // Matrix room account data is last-write-wins across devices. This bounded preference is
  // attention-only; sync remains authoritative and a later device can supersede an earlier
  // concurrent toggle without changing content access or receipts.
  const current = matrixThreadAttention(room)
  const yes = new Set(current.followed)
  const no = new Set(current.unfollowed)

  if (followed) {
    yes.add(rootId)
    no.delete(rootId)
  } else {
    no.add(rootId)
    yes.delete(rootId)
  }

  if (yes.size > MATRIX_THREAD_PREFERENCES_MAX || no.size > MATRIX_THREAD_PREFERENCES_MAX) {
    throw new Error('matrix_thread_limit')
  }

  await client.setRoomAccountData(
    room.roomId,
    MATRIX_THREAD_ATTENTION as never,
    {
      v: 1,
      followed: [...yes].sort(),
      unfollowed: [...no].sort()
    } as never
  )
}

export async function readMatrixThread(client: MatrixClient, room: Room, rootId: string): Promise<void> {
  requireTeamSpaceThreadRoom(room)
  requireThreadRoot(room, rootId)
  const thread = room.getThread(rootId)

  if (!thread) {
    return
  }

  const latest = [...thread.events]
    .reverse()
    .find(event => event.getId() !== rootId && event.status == null && event.getId()?.startsWith('$'))

  if (!latest) {
    return
  }

  // Match the room transcript: clear server unread state across this person's devices
  // without publishing when they read the thread to other members.
  await client.sendReadReceipt(latest, ReceiptType.ReadPrivate)

  thread.setUnread(NotificationCountType.Total, 0)
  thread.setUnread(NotificationCountType.Highlight, 0)
}

function mentioned(event: MatrixEvent, userId: string): boolean {
  const content = event.getOriginalContent()
  const mentions = record(content['m.mentions'])

  return Array.isArray(mentions?.user_ids) && mentions.user_ids.includes(userId)
}

type MatrixSdkThread = ReturnType<Room['getThreads']>[number]

interface CompanyThreadStamp {
  eventCount: number
  highlights: number
  participated: boolean
  lastEventId?: string
  length: number
  replyEventId?: string
  rootEvent?: MatrixEvent
  thread: MatrixSdkThread
  unread: number
}

interface CompanyThreadRoomCache {
  attention: string
  cacheKey: string
  stamps: CompanyThreadStamp[]
  threads: MatrixThread[]
  userId: string
}

const companyThreadRoomCache = new WeakMap<Room, CompanyThreadRoomCache>()

function threadAttentionKey(attention: ThreadAttention): string {
  return `${[...attention.followed].sort().join('\0')}\u0001${[...attention.unfollowed].sort().join('\0')}`
}

function companyThreadStamps(room: Room, threads: readonly MatrixSdkThread[]): CompanyThreadStamp[] {
  return threads.map(thread => ({
    thread,
    rootEvent: thread.rootEvent,
    eventCount: thread.events.length,
    length: thread.length,
    participated: thread.hasCurrentUserParticipated,
    ...(thread.events.at(-1)?.getId() ? { lastEventId: thread.events.at(-1)!.getId()! } : {}),
    ...(thread.replyToEvent?.getId() ? { replyEventId: thread.replyToEvent.getId()! } : {}),
    unread: room.getThreadUnreadNotificationCount(thread.id, NotificationCountType.Total),
    highlights: room.getThreadUnreadNotificationCount(thread.id, NotificationCountType.Highlight)
  }))
}

function sameCompanyThreadStamps(
  left: readonly CompanyThreadStamp[],
  right: readonly CompanyThreadStamp[]
): boolean {
  return left.length === right.length && left.every((stamp, index) => {
    const other = right[index]

    return other?.thread === stamp.thread && other.rootEvent === stamp.rootEvent &&
      other.eventCount === stamp.eventCount && other.length === stamp.length &&
      other.participated === stamp.participated && other.lastEventId === stamp.lastEventId &&
      other.replyEventId === stamp.replyEventId && other.unread === stamp.unread &&
      other.highlights === stamp.highlights
  })
}

function projectMatrixThreads(
  room: Room,
  userId: string,
  project: (event: MatrixEvent) => MatrixMessage | null,
  sdkThreads: readonly MatrixSdkThread[],
  attention: ThreadAttention
): MatrixThread[] {
  return sdkThreads
    .flatMap(thread => {
      const rootEvent = thread.rootEvent ?? room.findEventById(thread.id)
      const root = rootEvent ? project(rootEvent) : null

      if (!root || !validThreadRootId(root.id)) {
        return []
      }

      const events = thread.events
        .filter(event => event.getId() !== root.id)
        .sort((left, right) => left.getTs() - right.getTs())
      const replies = events
        .slice(-MATRIX_THREAD_REPLIES_MAX)
        .map(event => {
          const message = project(event)

          // Homeservers may redact the relation itself. The SDK thread that supplied this
          // non-root event is still authoritative for its display placement, so keep the
          // tombstone in the thread rather than making the reply count lie.
          return message?.redacted && !message.thread
            ? { ...message, thread: true as const, threadRootId: root.id }
            : message
        })
        .filter((message): message is MatrixMessage => message?.thread === true)
      const highlights = room.getThreadUnreadNotificationCount(root.id, NotificationCountType.Highlight)
      const unread = room.getThreadUnreadNotificationCount(root.id, NotificationCountType.Total) > 0
      const automatic =
        thread.hasCurrentUserParticipated ||
        Boolean(rootEvent && mentioned(rootEvent, userId)) ||
        events.some(event => mentioned(event, userId))
      const followed = attention.unfollowed.has(root.id) ? false : attention.followed.has(root.id) || automatic
      const lastActivityAt = thread.replyToEvent?.getTs() ?? replies.at(-1)?.timestamp ?? root.timestamp
      const participantIds = [...new Set([root.sender, ...replies.map(reply => reply.sender)])].slice(0, 100)

      return [
        { root, replies, participantIds, replyCount: thread.length, lastActivityAt, unread, highlights, followed }
      ]
    })
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.root.id.localeCompare(right.root.id))
    .slice(0, MATRIX_THREADS_MAX)
}

/** Bounded display projection of the room's known server threads. */
export function matrixThreads(
  room: Room,
  userId: string,
  project: (event: MatrixEvent) => MatrixMessage | null
): MatrixThread[] {
  const attention = matrixThreadAttention(room)

  return projectMatrixThreads(room, userId, project, room.getThreads(), attention)
}

function cachedCompanyRoomThreads(
  room: Room,
  userId: string,
  project: (event: MatrixEvent) => MatrixMessage | null,
  cacheKey: string
): MatrixThread[] {
  const sdkThreads = room.getThreads()
  const attention = matrixThreadAttention(room)
  const stamps = companyThreadStamps(room, sdkThreads)
  const attentionKey = threadAttentionKey(attention)
  const previous = companyThreadRoomCache.get(room)

  if (previous?.cacheKey === cacheKey && previous.userId === userId &&
      previous.attention === attentionKey && sameCompanyThreadStamps(previous.stamps, stamps)) {
    return previous.threads
  }

  const threads = projectMatrixThreads(room, userId, project, sdkThreads, attention)
  companyThreadRoomCache.set(room, { attention: attentionKey, cacheKey, stamps, threads, userId })

  return threads
}

/**
 * Project one stable company-wide thread list from rooms already present in the SDK. Both the
 * public room projection and the native room must still say `join`; this deliberately performs
 * no pagination or history request and never includes an ordinary personal room.
 */
export function matrixCompanyThreads(
  rooms: readonly MatrixRoom[],
  nativeRoom: (roomId: string) => Room | null,
  userId: string,
  project: (event: MatrixEvent, room: Room) => MatrixMessage | null,
  limit = MATRIX_COMPANY_THREADS_MAX,
  cacheKey = ''
): MatrixCompanyThread[] {
  const capped = Math.max(0, Math.min(Math.floor(limit), MATRIX_COMPANY_THREADS_MAX))
  const threads: MatrixCompanyThread[] = []

  for (const projected of rooms) {
    const binding = projected.companyChannel ?? projected.companyConversation

    if (projected.membership !== 'join' || !binding) {
      continue
    }

    const room = nativeRoom(projected.id)

    if (!room || room.getMyMembership() !== 'join' ||
      ![MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '')) {
      continue
    }

    threads.push(...cachedCompanyRoomThreads(room, userId, event => project(event, room), cacheKey).map(thread => ({
      ...thread,
      companyId: binding.companyId,
      roomId: projected.id
    })))
  }

  return threads
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt ||
      left.root.id.localeCompare(right.root.id) || left.roomId.localeCompare(right.roomId))
    .slice(0, capped)
}
