import { EventType, type MatrixClient, MatrixEvent, MsgType, type Room, SearchOrderBy } from 'matrix-js-sdk'

import type {
  MatrixCompanyMessageSearchSdkCommand,
  MatrixCompanyMessageSearchTarget,
  MatrixCompanyMessageSearchValue
} from '../../shared/matrix-company-search'
import { MATRIX_COMPANY_MESSAGE_SEARCH_SNIPPET_MAX } from '../../shared/matrix-company-search'
import {
  matrixCompanySearchDateMatches,
  type MatrixCompanySearchFileType,
  matrixCompanySearchNeedsLoadedHistory,
  matrixCompanySearchTermMatches,
  parseMatrixCompanySearchQuery
} from '../../shared/matrix-company-search-query'
import { MATRIX_NOTES_SELF_ROOM_TYPE } from '../../shared/matrix-notes-self'

import { foldSearchChar, foldSearchQuery, textMatchesChatSearch } from './chat-search-matches'
import { companyFileContext } from './company-files'
import { historyMessageText } from './history-message-text'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const ROOM_ID = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
const EVENT_ID = /^\$[!-~]{1,511}$/u
const USER_ID = /^@[!-9;-~]{1,255}:[!-~]{1,255}$/u
const MAX_DATE_MS = 8_640_000_000_000_000

function unavailable(): never {
  throw new Error('matrix_company_search_unavailable')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function searchSnippet(body: string, query: string): string {
  const characters = [...body]

  if (characters.length <= MATRIX_COMPANY_MESSAGE_SEARCH_SNIPPET_MAX) {
    return body
  }

  const foldedQuery = foldSearchQuery(query)
  const positions: number[] = []
  let foldedBody = ''

  characters.forEach((character, characterIndex) => {
    for (const unit of foldSearchChar(character)) {
      if (unit === ' ' && (foldedBody.endsWith(' ') || foldedBody === '')) {continue}
      foldedBody += unit
      positions.push(characterIndex)
    }
  })
  const found = foldedBody.indexOf(foldedQuery)
  const foundCharacter = found < 0 ? 0 : (positions[found] ?? 0)

  const start = Math.max(0, Math.min(
    foundCharacter - 160,
    characters.length - MATRIX_COMPANY_MESSAGE_SEARCH_SNIPPET_MAX
  ))

  const end = start + MATRIX_COMPANY_MESSAGE_SEARCH_SNIPPET_MAX

  return `${start > 0 ? '…' : ''}${characters.slice(start, end).join('')}${end < characters.length ? '…' : ''}`
}

function threadRoot(content: Record<string, unknown>): string | undefined | null {
  const relation = content['m.relates_to']

  if (relation === undefined) {
    return undefined
  }

  if (!record(relation) || relation.rel_type !== 'm.thread' || typeof relation.event_id !== 'string' ||
    !EVENT_ID.test(relation.event_id)) {
    return null
  }

  return relation.event_id
}

function validTarget(value: MatrixCompanyMessageSearchTarget, companyId: string): boolean {
  return UUID.test(value.channelId) && ROOM_ID.test(value.roomId) && value.channelName.trim() === value.channelName &&
    [...value.channelName].length >= 1 && [...value.channelName].length <= 80 &&
    ![...value.channelName].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    (value.targetType === undefined || ['channel', 'conversation'].includes(value.targetType)) &&
    ['active', 'archived', 'read_only'].includes(value.state) && Number.isSafeInteger(value.authorityGeneration) &&
    value.authorityGeneration > 0 && Number.isSafeInteger(value.channelGeneration) && value.channelGeneration > 0 &&
    UUID.test(companyId)
}

function boundCompanyRoom(
  client: MatrixClient,
  target: { companyId: string; channelId: string; roomId: string; targetType?: 'channel' | 'conversation' }
): Room | null {
  const room = client.getRoom(target.roomId)

  if (!room || room.getMyMembership() !== 'join') {
    return null
  }

  // Personal notes may be opened from a Team Space, but never become a company search source.
  if (room.getType() === MATRIX_NOTES_SELF_ROOM_TYPE) {
    return null
  }

  const context = companyFileContext(room)

  const targetType = target.targetType === 'conversation' ? 'conversation' : 'channel'
  const matchesTarget = targetType === 'conversation'
    ? context.target.kind === 'conversation' && context.target.conversationId === target.channelId
    : context.target.kind === 'channel' && context.target.channelId === target.channelId

  if (context.companyId !== target.companyId || !matchesTarget ||
    context.roomId !== target.roomId) {
    return unavailable()
  }

  return room
}

const DOCUMENT_MIME_TYPES = new Set([
  'application/msword',
  'application/rtf',
  'application/vnd.apple.keynote',
  'application/vnd.apple.numbers',
  'application/vnd.apple.pages',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
])

const DOCUMENT_EXTENSIONS = /\.(?:csv|doc|docx|key|md|numbers|od[psst]|pages|ppt|pptx|rtf|txt|xls|xlsx)$/iu

function fileType(name: string, mimeType: string | undefined, msgtype: string): Exclude<MatrixCompanySearchFileType, 'all'> {
  const mime = mimeType?.toLocaleLowerCase()

  if (msgtype === MsgType.Image || mime?.startsWith('image/')) {return 'images'}

  if (mime === 'application/pdf' || /\.pdf$/iu.test(name)) {return 'pdfs'}

  if (mime?.startsWith('text/') || (mime && DOCUMENT_MIME_TYPES.has(mime)) || DOCUMENT_EXTENSIONS.test(name)) {
    return 'documents'
  }

  return 'other'
}

function fileMetadata(content: Record<string, unknown>): NonNullable<MatrixCompanyMessageSearchValue['results'][number]['file']> | null {
  if (![MsgType.File, MsgType.Image, MsgType.Audio, MsgType.Video].includes(content.msgtype as MsgType)) {return null}
  const name = typeof content.filename === 'string' ? content.filename : content.body
  const info = record(content.info) ? content.info : undefined
  const mimeType = typeof info?.mimetype === 'string' && info.mimetype.length <= 255 ? info.mimetype : undefined
  const size = Number.isSafeInteger(info?.size) && Number(info?.size) >= 0 ? Number(info?.size) : undefined

  if (typeof name !== 'string' || name.length < 1 || [...name].length > 512) {return null}

  return {
    name,
    type: fileType(name, mimeType, String(content.msgtype)),
    ...(mimeType ? { mimeType } : {}),
    ...(size === undefined ? {} : { size })
  }
}

function channelTargets(
  targets: MatrixCompanyMessageSearchTarget[],
  channel: string | undefined
): MatrixCompanyMessageSearchTarget[] {
  if (!channel) {return targets}
  const wanted = foldSearchQuery(channel.slice(1))

  return targets.filter(target => foldSearchQuery(target.channelName) === wanted)
}

function senderIds(
  client: MatrixClient,
  targets: MatrixCompanyMessageSearchTarget[],
  from: string | undefined,
  resolved: string | undefined
): string[] | undefined {
  if (!from) {return undefined}

  if (from === 'me') {
    const own = client.getUserId()

    return own && USER_ID.test(own) ? [own] : []
  }

  const wanted = foldSearchQuery(from.slice(1))
  const matches = new Set<string>(resolved && USER_ID.test(resolved) ? [resolved] : [])

  for (const target of targets) {
    const room = client.getRoom(target.roomId)

    for (const member of room?.getMembers() ?? []) {
      const localpart = member.userId.startsWith('@') ? member.userId.slice(1).split(':', 1)[0]! : member.userId

      if ([localpart, member.name, member.rawDisplayName]
        .some(candidate => foldSearchQuery(candidate.replace(/^@/u, '')) === wanted)) {
        matches.add(member.userId)
      }
    }
  }

  return [...matches].filter(id => USER_ID.test(id)).sort()
}

function loadedEvents(room: Room): MatrixEvent[] {
  const seen = new Set<string>()
  const events = [...room.getLiveTimeline().getEvents(), ...room.getThreads().flatMap(thread => thread.events)]

  return events.filter(event => {
    const id = event.getId()

    if (!id || seen.has(id)) {return false}
    seen.add(id)

    return true
  })
}

function loadedSearch(
  client: MatrixClient,
  command: Extract<MatrixCompanyMessageSearchSdkCommand, { kind: 'companyMessageSearch' }>,
  admitted: MatrixCompanyMessageSearchTarget[],
  senders: string[] | undefined
): MatrixCompanyMessageSearchValue {
  const parsed = parseMatrixCompanySearchQuery(command.query)
  const tab = command.tab ?? 'messages'
  const selectedFileType = command.fileType ?? 'all'
  const allowedSenders = senders ? new Set(senders) : undefined
  const results: MatrixCompanyMessageSearchValue['results'] = []

  for (const target of admitted) {
    const room = client.getRoom(target.roomId)

    if (!room) {continue}

    for (const event of loadedEvents(room)) {
      const content = event.getContent()
      const eventId = event.getId()
      const sender = event.getSender()
      const at = event.getTs()

      if (!eventId || !EVENT_ID.test(eventId) || !sender || !USER_ID.test(sender) ||
        !Number.isSafeInteger(at) || at < 0 || at > MAX_DATE_MS || event.getType() !== EventType.RoomMessage ||
        event.getWireType() !== EventType.RoomMessage || event.isRedacted() || event.isDecryptionFailure() ||
        !record(content) || allowedSenders && !allowedSenders.has(sender) || !matrixCompanySearchDateMatches(at, parsed)) {
        continue
      }

      const threadRootId = threadRoot(content)

      if (threadRootId === null || threadRootId === eventId) {continue}

      const file = fileMetadata(content)

      if (tab === 'files') {
        if (!file || selectedFileType !== 'all' && file.type !== selectedFileType ||
          !matrixCompanySearchTermMatches(file.name, parsed)) {continue}

        results.push({ channelId: target.channelId, roomId: target.roomId, channelName: target.channelName,
          eventId, sender, snippet: file.name, at, file, ...(threadRootId ? { threadRootId } : {}) })

        continue
      }

      if (content.msgtype !== MsgType.Text || typeof content.body !== 'string' || content.body.length < 1 ||
        content.body.length > 64 * 1024) {continue}

      const visibleBody = historyMessageText(content.body)

      if (!matrixCompanySearchTermMatches(visibleBody, parsed)) {continue}
      results.push({ channelId: target.channelId, roomId: target.roomId, channelName: target.channelName,
        eventId, sender, snippet: searchSnippet(visibleBody, parsed.terms[0]?.value ?? ''), at,
        ...(threadRootId ? { threadRootId } : {}) })
    }
  }

  results.sort((left, right) => right.at - left.at || left.eventId.localeCompare(right.eventId))
  const truncated = results.length > command.limit

  return {
    schemaVersion: 1,
    companyId: command.companyId,
    query: command.query,
    coverage: { eligibleRooms: command.rooms.length, searchedRooms: admitted.length, truncated, source: 'loaded_history' },
    results: results.slice(0, command.limit)
  }
}

/** Exact server-side text search over the current joined subset of main-authorized company rooms. */
export async function searchCompanyMessages(
  client: MatrixClient,
  command: Extract<MatrixCompanyMessageSearchSdkCommand, { kind: 'companyMessageSearch' }>,
  active: () => boolean = () => true
): Promise<MatrixCompanyMessageSearchValue> {
  const tab = command.tab ?? 'messages'
  const selectedFileType = command.fileType ?? 'all'
  const parsed = parseMatrixCompanySearchQuery(command.query)

  if (!active() || !UUID.test(command.companyId) || command.query.trim() !== command.query ||
    [...command.query].length > 200 || (tab === 'messages' && [...command.query].length < 2) ||
    !['messages', 'files'].includes(tab) || !['all', 'images', 'pdfs', 'documents', 'other'].includes(selectedFileType) ||
    (command.nextBatch !== undefined && (command.nextBatch.length > 4096 || !/^[A-Za-z0-9._~-]+$/u.test(command.nextBatch))) ||
    parsed.errors.length > 0 || (command.senderUserId !== undefined && (!parsed.from || parsed.from === 'me' ||
      !USER_ID.test(command.senderUserId))) ||
    !Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 50 ||
    // The frozen company directory parser admits at most 100 channels. A
    // larger trusted command is contract drift, not partial search coverage.
    !Array.isArray(command.rooms) || command.rooms.length > 100 ||
    command.rooms.some(room => !validTarget(room, command.companyId)) ||
    new Set(command.rooms.map(room => room.channelId)).size !== command.rooms.length ||
    new Set(command.rooms.map(room => room.roomId)).size !== command.rooms.length) {
    return unavailable()
  }

  const authorizedAll = command.rooms.filter(target => boundCompanyRoom(client, { ...target, companyId: command.companyId }))
  const encrypted = (roomId: string) => typeof client.isRoomEncrypted === 'function'
    ? client.isRoomEncrypted(roomId)
    : Boolean(client.getRoom(roomId)?.hasEncryptionStateEvent?.())
  const encryptedRooms = authorizedAll.filter(target => encrypted(target.roomId)).length
  const authorized = authorizedAll.filter(target => !encrypted(target.roomId))
  const admitted = channelTargets(authorized, parsed.in)
  const senders = senderIds(client, admitted, parsed.from, command.senderUserId)

  if (admitted.length === 0) {
    return {
      schemaVersion: 1,
      companyId: command.companyId,
      query: command.query,
      coverage: { eligibleRooms: command.rooms.length, searchedRooms: 0, truncated: false, encryptedRooms,
        source: matrixCompanySearchNeedsLoadedHistory(parsed, tab) ? 'loaded_history' : 'server' },
      results: []
    }
  }

  if (senders?.length === 0) {
    return {
      schemaVersion: 1,
      companyId: command.companyId,
      query: command.query,
      coverage: { eligibleRooms: command.rooms.length, searchedRooms: admitted.length, truncated: false,
        encryptedRooms, source: 'server' },
      results: []
    }
  }

  if (matrixCompanySearchNeedsLoadedHistory(parsed, tab)) {
    return loadedSearch(client, command, admitted, senders)
  }

  const filter = {
    rooms: admitted.map(room => room.roomId),
    ...(senders ? { senders } : {}),
    types: [EventType.RoomMessage],
    ...(tab === 'files' ? { contains_url: true } : {}),
    limit: command.limit
  }
  let foundEvents: MatrixEvent[]
  let pageNext: string | undefined

  if (!command.nextBatch) {
    const response = await client.searchRoomEvents({ term: parsed.serverTerm, filter })
    foundEvents = response.results.map(found => found.context.getEvent())
    pageNext = response.next_batch
  } else {
    const response = await client.search({
      body: { search_categories: { room_events: {
      search_term: parsed.serverTerm,
      filter,
      order_by: SearchOrderBy.Recent,
      event_context: { before_limit: 0, after_limit: 0, include_profile: false }
    } } },
      next_batch: command.nextBatch
    })
    const page = response.search_categories.room_events
    foundEvents = (page.results ?? []).map(found => new MatrixEvent(found.result))
    pageNext = page.next_batch
  }

  if (!active()) {
    return unavailable()
  }

  const targets = new Map(admitted.map(target => [target.roomId, target]))
  const seen = new Set<string>()
  const results: MatrixCompanyMessageSearchValue['results'] = []

  for (const event of foundEvents) {
    if (results.length >= command.limit) {
      break
    }

    const roomId = event.getRoomId()
    const eventId = event.getId()
    const sender = event.getSender()
    const content = event.getContent()
    const target = roomId ? targets.get(roomId) : undefined
    const at = event.getTs()

    if (!target || !eventId || !EVENT_ID.test(eventId) || !sender || !USER_ID.test(sender) ||
      !Number.isSafeInteger(at) || at < 0 || at > MAX_DATE_MS ||
      !boundCompanyRoom(client, { ...target, companyId: command.companyId })) {
      return unavailable()
    }

    if (seen.has(eventId)) {continue}

    const threadRootId = threadRoot(content)

    if (threadRootId === null || threadRootId === eventId) {
      // Edits, reactions and malformed relations are not message-search results.
      continue
    }

    if (event.getType() !== EventType.RoomMessage || event.getWireType() !== EventType.RoomMessage ||
      event.isRedacted() || event.isDecryptionFailure() || !record(content) ||
      !matrixCompanySearchDateMatches(at, parsed)) {
      continue
    }

    const file = fileMetadata(content)
    if (tab === 'files') {
      if (!file || selectedFileType !== 'all' && file.type !== selectedFileType ||
        !matrixCompanySearchTermMatches(file.name, parsed)) {
        continue
      }
      seen.add(eventId)
      results.push({ channelId: target.channelId, roomId: target.roomId, channelName: target.channelName,
        eventId, sender, snippet: file.name, at, file, ...(threadRootId ? { threadRootId } : {}) })
      continue
    }

    if (content.msgtype !== MsgType.Text || typeof content.body !== 'string' || content.body.length < 1 ||
      content.body.length > 64 * 1024) {
      continue
    }
    const visibleBody = historyMessageText(content.body)
    if (!matrixCompanySearchTermMatches(visibleBody, parsed) || !textMatchesChatSearch(visibleBody, parsed.serverTerm)) {
      continue
    }
    seen.add(eventId)
    results.push({ channelId: target.channelId, roomId: target.roomId, channelName: target.channelName,
      eventId, sender, snippet: searchSnippet(visibleBody, parsed.serverTerm), at,
      ...(threadRootId ? { threadRootId } : {}) })
  }

  return {
    schemaVersion: 1,
    companyId: command.companyId,
    query: command.query,
    coverage: {
      eligibleRooms: command.rooms.length,
      searchedRooms: admitted.length,
      truncated: Boolean(pageNext), encryptedRooms, source: 'server'
    },
    results,
    ...(pageNext ? { nextBatch: pageNext } : {})
  }
}

/** Revalidate one authorized result against the current joined room and exact server event. */
export async function openCompanyMessage(
  client: MatrixClient,
  command: Extract<MatrixCompanyMessageSearchSdkCommand, { kind: 'companyMessageOpen' }>,
  active: () => boolean = () => true
): Promise<void> {
  if (!active() || !UUID.test(command.companyId) || !UUID.test(command.channelId) ||
    !ROOM_ID.test(command.roomId) || !EVENT_ID.test(command.eventId)) {
    return unavailable()
  }

  const target = { companyId: command.companyId, channelId: command.channelId, roomId: command.roomId,
    ...(command.targetType ? { targetType: command.targetType } : {}) }
  const room = boundCompanyRoom(client, target)

  if (!room) {
    return unavailable()
  }

  const raw = await client.fetchRoomEvent(command.roomId, command.eventId)

  if (!active() || !boundCompanyRoom(client, target)) {
    return unavailable()
  }

  const event = new MatrixEvent(raw)
  const content = event.getContent()
  const sender = event.getSender()
  const at = event.getTs()

  const file = record(content) ? fileMetadata(content) : null

  if (event.getId() !== command.eventId || event.getRoomId() !== command.roomId ||
    event.getType() !== EventType.RoomMessage || event.getWireType() !== EventType.RoomMessage ||
    event.isRedacted() || event.isDecryptionFailure() || !sender || !USER_ID.test(sender) ||
    !Number.isSafeInteger(at) || at < 0 || at > MAX_DATE_MS || !record(content) ||
    (content.msgtype !== MsgType.Text && !file) || typeof content.body !== 'string' ||
    content.body.length < 1 || content.body.length > 64 * 1024 ||
    threadRoot(content) !== command.threadRootId || command.threadRootId === command.eventId) {
    return unavailable()
  }
}

/** Recheck the local joined room and immutable binding immediately before selection. */
export function companyMessageRoom(
  client: MatrixClient,
  command: Extract<MatrixCompanyMessageSearchSdkCommand, { kind: 'companyMessageSelect' }>
): Room {
  if (!UUID.test(command.companyId) || !UUID.test(command.channelId) || !ROOM_ID.test(command.roomId)) {
    return unavailable()
  }

  return boundCompanyRoom(client, command) ?? unavailable()
}
