import { type MatrixEvent, type Room } from 'matrix-js-sdk'

import type { MatrixMessage, MatrixRoom } from '../../shared/matrix'
import type { MatrixCompanyActivityItem } from '../../shared/matrix-company-activity'

import { matrixEventMentionsViewer, matrixEventThreadRoot } from './attention'
import { companyAIAnswerProjection } from './company-ai-answer-projection'
import { canMentionMatrixRoom } from './conversations'
import { shownContent } from './message'
import { matrixPersonName } from './person-name'

/** The renderer never retains more activity than a person can page through in this view. */
export const MATRIX_COMPANY_ACTIVITY_MAX = 200
/** Only the already-synced recent tail of each room is inspected. No inbox read causes backfill. */
export const MATRIX_COMPANY_ACTIVITY_ROOM_EVENT_WINDOW = 200

export interface MatrixCompanyActivitySourceMessage {
  message: MatrixMessage
  /** False when m.mentions.room came from a sender below the room-mention power threshold. */
  roomMentionAuthorized?: boolean
  senderName?: string
  unread: boolean
  threadParticipated: boolean
}

export interface MatrixCompanyActivitySourceRoom {
  companyId?: string
  membership: string
  roomId: string
  messages: readonly MatrixCompanyActivitySourceMessage[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function eventRoomMentionAuthorized(event: MatrixEvent, room: Room): boolean {
  const mentions = record(shownContent(event).content['m.mentions'])
  const sender = event.getSender()

  return mentions?.room !== true || Boolean(sender && canMentionMatrixRoom(room, sender))
}

interface ActivityThreadStamp {
  count: number
  lastEventId?: string
  thread: ReturnType<Room['getThreads']>[number]
}

interface ActivityRoomCache {
  cacheKey: string
  events: MatrixEvent[]
  liveCount: number
  liveLastEventId?: string
  projected: Map<string, MatrixMessage | null>
  projector: (event: MatrixEvent, room: Room) => MatrixMessage | null
  threadStamps: ActivityThreadStamp[]
  timeline: ReturnType<Room['getLiveTimeline']>
}

const activityRoomCache = new WeakMap<Room, ActivityRoomCache>()

function sameThreadStamps(left: readonly ActivityThreadStamp[], right: readonly ActivityThreadStamp[]): boolean {
  return left.length === right.length && left.every((stamp, index) => {
    const other = right[index]

    return other?.thread === stamp.thread && other.count === stamp.count && other.lastEventId === stamp.lastEventId
  })
}

/**
 * Remember the immutable event window per room. A publish with no timeline/thread change reuses it,
 * while receipts remain live below. `cacheKey` lets the SDK invalidate display projection changes
 * (decryption, redaction, ignored senders) that do not add an event.
 */
function knownActivityEvents(
  room: Room,
  project: (event: MatrixEvent, room: Room) => MatrixMessage | null,
  cacheKey: string
): ActivityRoomCache {
  const timeline = room.getLiveTimeline()
  const liveEvents = timeline.getEvents()
  const threads = room.getThreads()
  const threadStamps = threads.map(thread => ({
    thread,
    count: thread.events.length,
    ...(thread.events.at(-1)?.getId() ? { lastEventId: thread.events.at(-1)!.getId()! } : {})
  }))
  const previous = activityRoomCache.get(room)
  const liveLastEventId = liveEvents.at(-1)?.getId()

  if (
    previous?.timeline === timeline &&
    previous.liveCount === liveEvents.length &&
    previous.liveLastEventId === liveLastEventId &&
    sameThreadStamps(previous.threadStamps, threadStamps)
  ) {
    if (previous.projector !== project || previous.cacheKey !== cacheKey) {
      previous.projector = project
      previous.cacheKey = cacheKey
      previous.projected.clear()
    }

    return previous
  }

  const byId = new Map<string, MatrixEvent>()

  const remember = (event: MatrixEvent) => {
    const id = event.getId()

    if (id) {byId.set(id, event)}
  }

  liveEvents.forEach(remember)
  // With server-side threads, replies can live only in the SDK's thread timeline. Reading the
  // timelines already in memory is still client-only: it performs no pagination or request.
  threads.forEach(thread => thread.events.forEach(remember))

  const value: ActivityRoomCache = {
    cacheKey,
    events: [...byId.values()]
    .sort((left, right) => left.getTs() - right.getTs() ||
      (left.getId() ?? '').localeCompare(right.getId() ?? ''))
      .slice(-MATRIX_COMPANY_ACTIVITY_ROOM_EVENT_WINDOW),
    liveCount: liveEvents.length,
    ...(liveLastEventId ? { liveLastEventId } : {}),
    projected: new Map(),
    projector: project,
    threadStamps,
    timeline
  }

  activityRoomCache.set(room, value)

  return value
}

function activityKind(
  source: MatrixCompanyActivitySourceMessage,
  userId: string
): MatrixCompanyActivityItem['kind'] | undefined {
  const { message } = source
  const mentioned = Boolean(
    message.mentions?.userIds.includes(userId) ||
    message.mentions?.room && source.roomMentionAuthorized !== false
  )

  if (mentioned) {
    return 'mention'
  }

  return message.thread && source.threadParticipated ? 'thread_reply' : undefined
}

/**
 * Merge authorized room tails into one stable, newest-first view. The room membership and
 * company binding travel with every input so a caller cannot accidentally aggregate an invite,
 * a left room, or an ordinary personal chat.
 */
export function aggregateMatrixCompanyActivity(
  rooms: readonly MatrixCompanyActivitySourceRoom[],
  userId: string,
  limit = MATRIX_COMPANY_ACTIVITY_MAX
): MatrixCompanyActivityItem[] {
  const capped = Math.max(0, Math.min(Math.floor(limit), MATRIX_COMPANY_ACTIVITY_MAX))
  const items = new Map<string, MatrixCompanyActivityItem>()

  for (const room of rooms) {
    if (room.membership !== 'join' || !room.companyId) {
      continue
    }

    for (const source of room.messages) {
      const { message } = source
      const kind = activityKind(source, userId)

      if (!kind || message.own || message.pending || message.failed || message.redacted ||
        message.decryptionFailed || !message.id || !message.body.trim()) {
        continue
      }

      const key = `${room.roomId}\0${message.id}`
      items.set(key, {
        companyId: room.companyId,
        roomId: room.roomId,
        eventId: message.id,
        kind,
        body: message.body,
        senderId: message.sender,
        ...(source.senderName ? { senderName: source.senderName } : {}),
        sentAt: message.timestamp,
        unread: source.unread,
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
        ...(companyAIAnswerProjection(message) ? { companyAIAnswer: true as const } : {})
      })
    }
  }

  return [...items.values()]
    .sort((left, right) => right.sentAt - left.sentAt || left.eventId.localeCompare(right.eventId) ||
      left.roomId.localeCompare(right.roomId))
    .slice(0, capped)
}

/**
 * Project Activity from the Matrix SDK's already-authorized, already-synced room tails. This
 * performs no request and trusts only the same joined Team Space room projection the sidebar uses.
 */
export function matrixCompanyActivity(
  rooms: readonly MatrixRoom[],
  nativeRoom: (roomId: string) => Room | null,
  userId: string,
  project: (event: MatrixEvent, room: Room) => MatrixMessage | null,
  cacheKey = ''
): MatrixCompanyActivityItem[] {
  const sources: MatrixCompanyActivitySourceRoom[] = []

  for (const projectedRoom of rooms) {
    const binding = projectedRoom.companyChannel ?? projectedRoom.companyConversation

    if (projectedRoom.membership !== 'join' || !binding) {
      continue
    }

    const room = nativeRoom(projectedRoom.id)

    if (!room || room.getMyMembership() !== 'join') {
      continue
    }

    const cached = knownActivityEvents(room, project, cacheKey)
    const { events } = cached
    const eventsById = new Map(events.map(event => [event.getId(), event]))
    const participatedRoots = new Set<string>()
    const threadsByRoot = new Map<string, ReturnType<Room['getThread']>>()

    for (const event of events) {
      const rootId = matrixEventThreadRoot(event)

      if (!rootId) {
        continue
      }

      const thread = threadsByRoot.has(rootId) ? threadsByRoot.get(rootId)! : room.getThread(rootId)
      threadsByRoot.set(rootId, thread)
      // The bounded tail may omit a much older root. The SDK's in-memory event index is cheap and
      // does not paginate, so use it before accepting the recent-only fallback for unknown roots.
      const root = eventsById.get(rootId) ?? room.findEventById(rootId)

      if (event.getSender() === userId || root?.getSender() === userId || thread?.hasCurrentUserParticipated) {
        participatedRoots.add(rootId)
      }
    }

    // Most room events can never appear in Activity. Inspect their immutable relation and current
    // mention metadata first, then pay the full message-projection cost only for candidates.
    const projected = events
      .filter(event => {
        const rootId = matrixEventThreadRoot(event)

        return matrixEventMentionsViewer(event, room, userId) || Boolean(rootId && participatedRoots.has(rootId))
      })
      .map(event => {
        const id = event.getId() ?? ''

        if (!cached.projected.has(id)) {
          cached.projected.set(id, project(event, room))
        }

        return { event, message: cached.projected.get(id) ?? null }
      })
      .filter((value): value is { event: MatrixEvent; message: MatrixMessage } => value.message !== null)

    sources.push({
      companyId: binding.companyId,
      membership: projectedRoom.membership,
      roomId: projectedRoom.id,
      messages: projected.map(({ event, message }) => {
        const thread = message.threadRootId
          ? threadsByRoot.get(message.threadRootId) ?? room.getThread(message.threadRootId)
          : null

        const read = thread
          ? thread.hasUserReadEvent(userId, message.id)
          // A thread receipt is a separate read horizon. If the SDK has not materialized the
          // thread yet, a room receipt cannot prove that this reply was read.
          : message.threadRootId
            ? false
            : room.hasUserReadEvent(userId, message.id)

        const senderName = matrixPersonName(room.getMember(message.sender)?.name, message.sender)

        return {
          message,
          roomMentionAuthorized: eventRoomMentionAuthorized(event, room),
          ...(senderName ? { senderName } : {}),
          unread: !read,
          threadParticipated: Boolean(message.threadRootId && participatedRoots.has(message.threadRootId))
        }
      })
    })
  }

  return aggregateMatrixCompanyActivity(sources, userId)
}
