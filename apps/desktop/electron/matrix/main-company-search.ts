import type { MatrixCompanyErrorCode } from '../../shared/matrix-company'
import {
  type MatrixCompanyMessageSearchOpenRequest,
  type MatrixCompanyMessageSearchOpenResponse,
  type MatrixCompanyMessageSearchRequest,
  type MatrixCompanyMessageSearchResponse,
  type MatrixCompanyMessageSearchSdkCommand,
  type MatrixCompanyMessageSearchTarget,
  type MatrixCompanyMessageSearchValue,
  MATRIX_COMPANY_MESSAGE_SEARCH_SNIPPET_MAX as SEARCH_SNIPPET_MAX
} from '../../shared/matrix-company-search'
import {
  type MatrixCompanySearchFileType,
  type MatrixCompanySearchTab,
  parseMatrixCompanySearchQuery
} from '../../shared/matrix-company-search-query'
import type { CompanyConversationDirectory15Response } from '../../shared/matrix-company-team-space'

import { MatrixCompanyError } from './company'
import type { CompanyChannelDirectoryValue } from './company-directory'
import { requireMatrixCaller } from './ipc-policy'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const ROOM_ID = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
const EVENT_ID = /^\$[!-~]{1,511}$/u
const USER_ID = /^@[!-9;-~]{1,255}:[!-~]{1,255}$/u
const MAX_DATE_MS = 8_640_000_000_000_000

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function invalid(): never {
  throw new MatrixCompanyError('invalid')
}

export function parseMatrixCompanySearchRequest(value: unknown): MatrixCompanyMessageSearchRequest {
  if (!object(value)) {return invalid()}

  const keys = ['companyId', 'query', 'limit', ...(value.tab === undefined ? [] : ['tab']),
    ...(value.fileType === undefined ? [] : ['fileType']), ...(value.nextBatch === undefined ? [] : ['nextBatch'])]

  const tab = (value.tab ?? 'messages') as MatrixCompanySearchTab
  const fileType = (value.fileType ?? 'all') as MatrixCompanySearchFileType

  if (!exact(value, keys) || !UUID.test(String(value.companyId)) || typeof value.query !== 'string' ||
    value.query.trim() !== value.query || [...value.query].length > 200 || !['messages', 'files'].includes(tab) ||
    !['all', 'images', 'pdfs', 'documents', 'other'].includes(fileType) ||
    [...value.query].length < 2 || parseMatrixCompanySearchQuery(value.query).errors.length > 0 ||
    (value.nextBatch !== undefined && (typeof value.nextBatch !== 'string' || value.nextBatch.length > 4096 ||
      !/^[A-Za-z0-9._~-]+$/u.test(value.nextBatch))) ||
    !Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 50) {
    return invalid()
  }

  return {
    companyId: value.companyId as string,
    query: value.query,
    limit: Number(value.limit),
    ...(value.tab === undefined ? {} : { tab }),
    ...(value.fileType === undefined ? {} : { fileType }),
    ...(value.nextBatch === undefined ? {} : { nextBatch: value.nextBatch as string })
  }
}

export function parseMatrixCompanySearchOpenRequest(value: unknown): MatrixCompanyMessageSearchOpenRequest {
  if (!object(value)) { return invalid() }

  const keys = value.threadRootId === undefined
    ? ['companyId', 'channelId', 'roomId', 'eventId']
    : ['companyId', 'channelId', 'roomId', 'eventId', 'threadRootId']

  if (!exact(value, keys) ||
    !UUID.test(String(value.companyId)) || !UUID.test(String(value.channelId)) ||
    !ROOM_ID.test(String(value.roomId)) || !EVENT_ID.test(String(value.eventId)) ||
    (value.threadRootId !== undefined && !EVENT_ID.test(String(value.threadRootId)))) {
    return invalid()
  }

  return {
    companyId: value.companyId as string,
    channelId: value.channelId as string,
    roomId: value.roomId as string,
    eventId: value.eventId as string,
    ...(value.threadRootId === undefined ? {} : { threadRootId: value.threadRootId as string })
  }
}

function targets(
  value: CompanyChannelDirectoryValue,
  conversations?: CompanyConversationDirectory15Response
): MatrixCompanyMessageSearchTarget[] {
  const channels: MatrixCompanyMessageSearchTarget[] = value.channels.flatMap(item => item.room.state === 'ready' &&
    ['active', 'archived'].includes(item.channel.state) ? [{
      channelId: item.channel.id,
      roomId: item.room.roomId,
      channelName: item.channel.displayName,
      state: item.channel.state as 'active' | 'archived',
      authorityGeneration: item.channel.authorityGeneration,
      channelGeneration: item.channel.channelGeneration
    }] : [])
  const conversationRows: MatrixCompanyMessageSearchTarget[] = (conversations?.conversations ?? []).flatMap(item =>
    item.room.state === 'ready' && ['active', 'read_only'].includes(item.state) ? [{
      targetType: 'conversation' as const,
      channelId: item.id,
      roomId: item.room.roomId,
      channelName: item.participants.map(person => person.displayName || (person.handle ? `@${person.handle}` : '')).filter(Boolean)
        .join(', ').slice(0, 80) || 'Conversation',
      state: item.state as 'active' | 'read_only',
      authorityGeneration: item.authorityGeneration,
      channelGeneration: item.conversationGeneration
    }] : [])
  return [...channels, ...conversationRows].sort((left, right) => left.channelId.localeCompare(right.channelId))
}

function fingerprint(value: readonly MatrixCompanyMessageSearchTarget[]): string {
  return JSON.stringify(value)
}

function parseSearchValue(
  value: unknown,
  request: MatrixCompanyMessageSearchRequest,
  authorized: MatrixCompanyMessageSearchTarget[]
): MatrixCompanyMessageSearchValue {
  if (!object(value) || !exact(value, ['schemaVersion', 'companyId', 'query', 'coverage', 'results',
    ...(value.nextBatch === undefined ? [] : ['nextBatch'])]) ||
    value.schemaVersion !== 1 || value.companyId !== request.companyId || value.query !== request.query ||
    !object(value.coverage) || !exact(value.coverage, ['eligibleRooms', 'searchedRooms', 'truncated',
      ...(value.coverage.source === undefined ? [] : ['source']),
      ...(value.coverage.encryptedRooms === undefined ? [] : ['encryptedRooms'])]) ||
    value.coverage.eligibleRooms !== authorized.length || !Number.isSafeInteger(value.coverage.searchedRooms) ||
    Number(value.coverage.searchedRooms) < 0 || Number(value.coverage.searchedRooms) > authorized.length ||
    typeof value.coverage.truncated !== 'boolean' ||
    (value.coverage.source !== undefined && !['server', 'loaded_history'].includes(String(value.coverage.source))) ||
    (value.coverage.encryptedRooms !== undefined && (!Number.isSafeInteger(value.coverage.encryptedRooms) ||
      Number(value.coverage.encryptedRooms) < 0 || Number(value.coverage.encryptedRooms) > authorized.length)) ||
    (value.nextBatch !== undefined && (typeof value.nextBatch !== 'string' || value.nextBatch.length > 4096 ||
      !/^[A-Za-z0-9._~-]+$/u.test(value.nextBatch))) ||
    !Array.isArray(value.results) || value.results.length > request.limit) {
    throw new Error('matrix_company_search_unavailable')
  }

  const rooms = new Map(authorized.map(room => [room.roomId, room]))
  const ids = new Set<string>()

  const results = value.results.map(raw => {
    if (!object(raw)) { throw new Error('matrix_company_search_unavailable') }

    const keys = ['channelId', 'roomId', 'channelName', 'eventId', 'sender', 'snippet', 'at',
      ...(raw.threadRootId === undefined ? [] : ['threadRootId']), ...(raw.file === undefined ? [] : ['file'])]

    const room = typeof raw.roomId === 'string' ? rooms.get(raw.roomId) : undefined

    if (!exact(raw, keys) || !room || raw.channelId !== room.channelId || raw.channelName !== room.channelName ||
      typeof raw.eventId !== 'string' || !EVENT_ID.test(raw.eventId) || ids.has(raw.eventId) ||
      typeof raw.sender !== 'string' || !USER_ID.test(raw.sender) || typeof raw.snippet !== 'string' ||
      raw.snippet.length < 1 || [...raw.snippet].length > SEARCH_SNIPPET_MAX + 2 || !Number.isSafeInteger(raw.at) ||
      Number(raw.at) < 0 || Number(raw.at) > MAX_DATE_MS ||
      (raw.threadRootId !== undefined && (typeof raw.threadRootId !== 'string' || !EVENT_ID.test(raw.threadRootId))) ||
      (raw.file !== undefined && (!object(raw.file) || !exact(raw.file, ['name', 'type',
        ...(raw.file.mimeType === undefined ? [] : ['mimeType']), ...(raw.file.size === undefined ? [] : ['size'])]) ||
        typeof raw.file.name !== 'string' || raw.file.name.length < 1 || [...raw.file.name].length > 512 ||
        !['images', 'pdfs', 'documents', 'other'].includes(String(raw.file.type)) ||
        (raw.file.mimeType !== undefined && (typeof raw.file.mimeType !== 'string' || raw.file.mimeType.length > 255)) ||
        (raw.file.size !== undefined && (!Number.isSafeInteger(raw.file.size) || Number(raw.file.size) < 0))))) {
      throw new Error('matrix_company_search_unavailable')
    }

    ids.add(raw.eventId)

    return raw as unknown as MatrixCompanyMessageSearchValue['results'][number]
  })

  return {
    schemaVersion: 1,
    companyId: request.companyId,
    query: request.query,
    coverage: value.coverage as MatrixCompanyMessageSearchValue['coverage'],
    results,
    ...(value.nextBatch === undefined ? {} : { nextBatch: value.nextBatch as string })
  }
}

export interface MatrixCompanySearchContext {
  event: Parameters<typeof requireMatrixCaller>[0]
  ui: Parameters<typeof requireMatrixCaller>[1]
  uiUrl: string
  enabled: boolean
  closing: boolean
  available: () => boolean
  channels: (companyId: string) => Promise<CompanyChannelDirectoryValue>
  conversations?: (companyId: string) => Promise<CompanyConversationDirectory15Response>
  resolveHandle?: (handle: string) => Promise<string | null>
  sdk: (command: MatrixCompanyMessageSearchSdkCommand) => Promise<unknown>
}

type Refusal = { ok: false; error: MatrixCompanyErrorCode }

function gate(context: MatrixCompanySearchContext): Refusal | null {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)

  if (!context.enabled || context.closing) { return { ok: false, error: 'unavailable' } }

  if (!context.available()) { return { ok: false, error: 'authentication' } }

  return null
}

function errorResult(error: unknown): Refusal {
  if (error instanceof Error && error.message === 'matrix_domain_signed_out') {
    return { ok: false, error: 'authentication' }
  }

  return error instanceof MatrixCompanyError
    ? { ok: false, error: error.code }
    : { ok: false, error: 'unavailable' }
}

export async function handleMatrixCompanySearch(
  input: unknown,
  context: MatrixCompanySearchContext
): Promise<MatrixCompanyMessageSearchResponse> {
  const refused = gate(context)

  if (refused) { return refused }

  try {
    const request = parseMatrixCompanySearchRequest(input)
    const parsed = parseMatrixCompanySearchQuery(request.query)
    const before = targets(await context.channels(request.companyId), await context.conversations?.(request.companyId))

    const senderUserId = parsed.from && /^@[a-z][a-z0-9_]{2,31}$/u.test(parsed.from) && context.resolveHandle
      ? await context.resolveHandle(parsed.from.slice(1))
      : null

    const raw = await context.sdk({ kind: 'companyMessageSearch', ...request,
      ...(senderUserId ? { senderUserId } : {}), rooms: before })

    const after = targets(await context.channels(request.companyId), await context.conversations?.(request.companyId))

    if (fingerprint(before) !== fingerprint(after)) {
      return { ok: false, error: 'cancelled' }
    }

    return { ok: true, value: parseSearchValue(raw, request, after) }
  } catch (error) {
    return errorResult(error)
  }
}

export async function handleMatrixCompanySearchOpen(
  input: unknown,
  context: MatrixCompanySearchContext
): Promise<MatrixCompanyMessageSearchOpenResponse> {
  const refused = gate(context)

  if (refused) { return refused }

  try {
    const request = parseMatrixCompanySearchOpenRequest(input)

    const read = async () => targets(await context.channels(request.companyId), await context.conversations?.(request.companyId))
      .find(room => room.channelId === request.channelId && room.roomId === request.roomId)

    const before = await read()

    if (!before) { return { ok: false, error: 'denied' } }
    // Validate the exact event without selecting it, then put the current platform
    // authority read on the far side of that network operation. Selection is a
    // second trusted SDK command and repeats the local joined/binding check.
    await context.sdk({ kind: 'companyMessageOpen', ...request,
      ...(before.targetType ? { targetType: before.targetType } : {}) })
    const after = await read()

    if (!after) { return { ok: false, error: 'denied' } }

    if (fingerprint([before]) !== fingerprint([after])) {
      return { ok: false, error: 'cancelled' }
    }

    await context.sdk({
      kind: 'companyMessageSelect',
      companyId: request.companyId,
      channelId: request.channelId,
      roomId: request.roomId,
      ...(after.targetType ? { targetType: after.targetType } : {})
    })

    return { ok: true }
  } catch (error) {
    return errorResult(error)
  }
}
