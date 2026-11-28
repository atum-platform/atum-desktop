import { type EventTimeline, EventType, type MatrixClient, MatrixEvent, MsgType, RelationType, type Room, SearchOrderBy } from 'matrix-js-sdk'

import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from '../../shared/matrix-company-channel-room'
import { MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT } from '../../shared/matrix-company-private-cos'
import type { MatrixRosterMessageHit, MatrixRosterMessagePage, MatrixRosterSearchScope } from '../../shared/matrix-roster-search'

import { textMatchesChatSearch } from './chat-search-matches'
import { searchSnippet } from './company-message-search'
import { historyMessageText } from './history-message-text'
import { plainRoomAnswer } from './plain-room'

const LIMIT = 30
const FOCUS_FOLLOWING_EVENTS = 5

export function rosterSearchWindowEnd(events: readonly MatrixEvent[], eventId?: string): number {
  if (!eventId) {return events.length}

  const index = events.findIndex(event => event.getId() === eventId)

  return index < 0 ? 0 : Math.min(index + 1 + FOCUS_FOLLOWING_EVENTS, events.length)
}

export function rosterSearchRoom(client: MatrixClient, id: string, personalOnly = false): Room | undefined {
  const room = client.getRoom(id)

  if (!room || room.getMyMembership() !== 'join' || room.getType() === 'm.space' ||
    room.currentState.getStateEvents(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT).length ||
    (personalOnly && [MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? ''))) {
    return undefined
  }

  return room
}

export function loadedRosterHistory(room: Room): MatrixEvent[] {
  return [...room.getLiveTimeline().getEvents(), ...room.getThreads().flatMap(thread => thread.events)]
}

export function rosterSearchMessage(
  room: Room,
  event: MatrixEvent,
  ignored: ReadonlySet<string>,
  scope: MatrixRosterSearchScope
): MatrixRosterMessageHit | undefined {
  const eventId = event.getId()
  const sender = event.getSender()
  const at = event.getTs()
  const content = event.getContent()
  const wireType = scope === 'device' ? EventType.RoomMessageEncrypted : EventType.RoomMessage

  if (event.getRoomId() !== room.roomId || !eventId?.startsWith('$') || !sender?.startsWith('@') ||
    ignored.has(sender) || !Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000 ||
    event.status != null || event.isRedacted() || event.localRedactionEvent() || event.isDecryptionFailure() ||
    event.getType() !== EventType.RoomMessage || event.getWireType() !== wireType ||
    event.isRelation(RelationType.Replace) || content.msgtype !== MsgType.Text ||
    typeof content.body !== 'string' || !content.body.trim() || content.body.length > 64 * 1024) {
    return undefined
  }

  const senderName = room.getMember(sender)?.name
  const threadRootId = event.threadRootId === eventId ? undefined : event.threadRootId

  return { roomId: room.roomId, eventId, sender, senderName, at,
    snippet: historyMessageText(content.body), ...(threadRootId ? { threadRootId } : {}) }
}

export async function rosterSearchEventTimeline(
  client: MatrixClient,
  room: Room,
  eventId: string,
  scope: MatrixRosterSearchScope,
  threadRootId?: string
): Promise<{ timeline: EventTimeline; event: MatrixEvent }> {
  const unavailable = () => new Error('matrix_roster_search_result_unavailable')
  const set = room.getUnfilteredTimelineSet()
  const live = room.getLiveTimeline()
  let timeline = live

  if (threadRootId) {
    const rootTimeline = set.getTimelineForEvent(threadRootId) ??
      (scope === 'plain' ? await client.getEventTimeline(set, threadRootId) : null)

    const root = rootTimeline?.getEvents().find(event => event.getId() === threadRootId)
    const thread = room.getThread(threadRootId) ?? (root && room.createThread(threadRootId, root, [], true))

    if (!thread) {throw unavailable()}

    timeline = thread.timelineSet.getTimelineForEvent(eventId) ??
      (scope === 'plain' ? await client.getEventTimeline(thread.timelineSet, eventId) : null) ?? thread.liveTimeline
  } else if (scope === 'plain') {
    timeline = set.getTimelineForEvent(eventId) ?? await client.getEventTimeline(set, eventId) ?? live
  }

  const event = timeline.getEvents().find(candidate => candidate.getId() === eventId)
  const hit = event && rosterSearchMessage(room, event, new Set(client.getIgnoredUsers()), scope)

  if (!event || !hit || hit.threadRootId !== threadRootId) {throw unavailable()}

  return { timeline, event }
}

function collect(
  client: MatrixClient,
  rooms: readonly Room[],
  events: Iterable<MatrixEvent>,
  query: string,
  scope: MatrixRosterSearchScope
) {
  const admitted = new Map(rooms.map(room => [room.roomId, room]))
  const ignored = new Set(client.getIgnoredUsers())
  const seen = new Set<string>()
  const searched = new Set<string>()
  const results: MatrixRosterMessageHit[] = []

  for (const event of events) {
    const room = admitted.get(event.getRoomId() ?? '')

    if (!room) {continue}

    const hit = rosterSearchMessage(room, event, ignored, scope)
    const key = hit && JSON.stringify([hit.roomId, hit.eventId])

    if (!hit || !key || seen.has(key)) {continue}

    seen.add(key)
    searched.add(room.roomId)

    if (textMatchesChatSearch(hit.snippet, query)) {
      results.push({ ...hit, snippet: searchSnippet(hit.snippet, query) })
    }
  }

  return { results, loadedMessages: seen.size, searchedRooms: searched.size }
}

/** Matrix /search over confirmed plain, joined Personal rooms. Never omit the room filter. */
export async function searchPersonalMessages(
  client: MatrixClient,
  roomIds: readonly string[],
  query: string,
  active: () => boolean
): Promise<MatrixRosterMessagePage> {
  const candidates = roomIds.flatMap(id => rosterSearchRoom(client, id, true) ?? [])
  const styles = await Promise.all(candidates.map(room => plainRoomAnswer(client, room)))

  const rooms = candidates.filter((room, index) =>
    styles[index] === true && rosterSearchRoom(client, room.roomId, true) === room && !room.hasEncryptionStateEvent())

  const coverage = { eligibleRooms: candidates.length, searchedRooms: 0, truncated: false,
    source: 'server' as const, encryptedRooms: styles.filter(plain => plain === false).length }

  if (!active() || !rooms.length) {return { coverage, results: [] }}

  const filter = { rooms: rooms.map(room => room.roomId), types: [EventType.RoomMessage],
    not_senders: client.getIgnoredUsers(), limit: LIMIT }

  const first = await client.searchRoomEvents({ term: query, filter })
  let events = first.results.map(found => found.context.getEvent())
  let next = first.next_batch

  const currentRooms = () => rooms.filter(room => rosterSearchRoom(client, room.roomId, true) === room &&
    !room.hasEncryptionStateEvent())

  // Fill an empty first page once when the server cursor has more candidates.
  if (next && active() && currentRooms().length === rooms.length &&
    collect(client, rooms, events, query, 'plain').results.length === 0) {
    const response = await client.search({ body: { search_categories: { room_events: {
      search_term: query, filter, order_by: SearchOrderBy.Recent,
      event_context: { before_limit: 0, after_limit: 0, include_profile: false }
    } } }, next_batch: next })

    const page = response.search_categories.room_events
    events = (page.results ?? []).map(found => new MatrixEvent(found.result))
    next = page.next_batch
  }

  if (!active()) {throw new Error('matrix_roster_search_unavailable')}

  const current = currentRooms()

  const results = collect(client, current, events, query, 'plain').results

  return { coverage: { ...coverage, searchedRooms: current.length, truncated: Boolean(next) },
    results: results.slice(0, LIMIT), ...(next ? { nextBatch: next } : {}) }
}

/** Read only the current SDK session's already decrypted events. No backfill or durable copy. */
export function searchLoadedPrivateMessages(
  client: MatrixClient,
  roomIds: readonly string[],
  query: string
): MatrixRosterMessagePage {
  const rooms = roomIds.flatMap(id => {
    const room = rosterSearchRoom(client, id)

    return room?.hasEncryptionStateEvent() ? [room] : []
  })

  const { results, searchedRooms, loadedMessages } = collect(client, rooms, rooms.flatMap(loadedRosterHistory), query, 'device')
  results.sort((left, right) => right.at - left.at)

  return { coverage: { eligibleRooms: rooms.length, searchedRooms, loadedMessages, truncated: results.length > LIMIT,
    source: 'loaded_history' }, results: results.slice(0, LIMIT) }
}
