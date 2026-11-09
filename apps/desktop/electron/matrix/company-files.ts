import type { MatrixCompanyFileRefV1 as MatrixCompanyFileRef } from '../../shared/matrix-company-files'

import type { NativeGrant } from './authorization'
import { readDomainJson } from './domain'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const ROOM_ID = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
const EVENT_ID = /^\$[!-~]{1,511}$/u
const TRANSACTION_ID = /^atum-cf-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,63}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const TOKEN = /^[A-Za-z0-9_-]{43}$/u

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join(',') === [...names].sort().join(',')
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const fileName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && [...value].length <= 255 &&
  [...value].every(character => character.codePointAt(0)! > 31 && character.codePointAt(0) !== 127)
const contentType = (value: unknown): value is string => typeof value === 'string' && CONTENT_TYPE.test(value)
const byteSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 20 * 1024 * 1024
const sha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value)

export type MatrixCompanyFileErrorCode =
  | 'invalid'
  | 'authentication'
  | 'denied'
  | 'missing'
  | 'conflict'
  | 'limit'
  | 'unavailable'
  | 'unsupported'
  | 'cancelled'

export type MatrixCompanyFileFailureReason =
  | 'invalid'
  | 'denied'
  | 'revoked'
  | 'not_found'
  | 'space_preparing'
  | 'upload_incomplete'
  | 'upload_unknown'
  | 'version_conflict'
  | 'limit'
  | 'provider_unavailable'

/** Closed error vocabulary for the native-only company Drive adapter. */
export class MatrixCompanyFileError extends Error {
  constructor(
    readonly code: MatrixCompanyFileErrorCode,
    readonly retryAfterSeconds?: number,
    readonly reason?: MatrixCompanyFileFailureReason
  ) {
    super(reason === 'space_preparing'
      ? 'matrix_company_file_preparing'
      : reason === 'revoked' || reason === 'denied'
        ? 'matrix_company_file_denied'
        : reason === 'not_found'
          ? 'matrix_company_file_missing'
          : reason === 'version_conflict'
            ? 'matrix_company_file_version_conflict'
            : code === 'unsupported'
              ? 'matrix_company_file_unsupported'
            : `matrix_company_file_${code}`)
  }
}

export interface MatrixCompanyFileReserveRequest {
  action: 'reserve'
  companyId: string
  channelId: string
  requestId: string
  name: string
  contentType: string
  size: number
  sha256: string
}

export interface MatrixCompanyFileStatusRequest {
  action: 'status'
  companyId: string
  channelId: string
  requestId: string
}

export interface MatrixCompanyFilePublishRequest {
  action: 'publish'
  companyId: string
  channelId: string
  requestId: string
  fileId: string
  revision: 1
  roomId: string
  eventId: string
  matrixTransactionId: string
}

export interface MatrixCompanyFileDownloadRequest {
  action: 'download'
  companyId: string
  channelId: string
  fileId: string
  revision: 1
}

export type MatrixCompanyFileRequest =
  | MatrixCompanyFileReserveRequest
  | MatrixCompanyFileStatusRequest
  | MatrixCompanyFilePublishRequest
  | MatrixCompanyFileDownloadRequest

export interface MatrixCompanyFileGrant {
  token: string
  expiresAtMs: number
}

export interface MatrixCompanyFileNativeGrant {
  /** Native-only raw grant. It never crosses the renderer boundary or enters a journal. */
  nativeGrant: string
  expiresAtMs: number
}

export interface MatrixCompanyFileReserved {
  schemaVersion: 1
  state: 'reserved'
  requestId: string
  file: MatrixCompanyFileRef
  serverUrl: string
  uploadGrant: MatrixCompanyFileNativeGrant
}

export interface MatrixCompanyFileStatusReady {
  schemaVersion: 1
  state: 'ready'
  requestId: string
  file: MatrixCompanyFileRef
  resource: { storage: string; space: string; opaque: string }
  etag: string
}

export interface MatrixCompanyFileStatusPublished {
  schemaVersion: 1
  state: 'published'
  requestId: string
  file: MatrixCompanyFileRef
  roomId: string
  eventId: string
  matrixTransactionId: string
  resource?: { storage: string; space: string; opaque: string }
  etag?: string
}

export interface MatrixCompanyFileStatusPending {
  schemaVersion: 1
  state: 'reserved' | 'writing' | 'unknown' | 'cancelled'
  requestId: string
  file: MatrixCompanyFileRef
}

export type MatrixCompanyFileStatus =
  | MatrixCompanyFileStatusReady
  | MatrixCompanyFileStatusPublished
  | MatrixCompanyFileStatusPending

export interface MatrixCompanyFilePublished {
  schemaVersion: 1
  state: 'published'
  file: MatrixCompanyFileRef
  roomId: string
  eventId: string
  matrixTransactionId: string
}

export interface MatrixCompanyFileDownloadGrant {
  schemaVersion: 1
  state: 'ready'
  file: MatrixCompanyFileRef
  serverUrl: string
  downloadGrant: MatrixCompanyFileNativeGrant
}

export type MatrixCompanyFileValue =
  | MatrixCompanyFileReserved
  | MatrixCompanyFileStatus
  | MatrixCompanyFilePublished
  | MatrixCompanyFileDownloadGrant

function invalid(): never {
  throw new MatrixCompanyFileError('invalid')
}

/** No renderer URL, bearer, principal, provider object, or filesystem handle is admitted. */
export function parseMatrixCompanyFileRequest(value: unknown): MatrixCompanyFileRequest {
  if (!object(value)) {
    return invalid()
  }

  switch (value.action) {
    case 'reserve':
      if (!exact(value, ['action', 'companyId', 'channelId', 'requestId', 'name', 'contentType', 'size', 'sha256']) ||
        !uuid(value.companyId) || !uuid(value.channelId) || !uuid(value.requestId) || !fileName(value.name) ||
        !contentType(value.contentType) || !byteSize(value.size) || !sha256(value.sha256)) {
        return invalid()
      }
      return value as unknown as MatrixCompanyFileReserveRequest
    case 'status':
      if (!exact(value, ['action', 'companyId', 'channelId', 'requestId']) || !uuid(value.companyId) ||
        !uuid(value.channelId) || !uuid(value.requestId)) {
        return invalid()
      }
      return value as unknown as MatrixCompanyFileStatusRequest
    case 'publish':
      if (!exact(value, ['action', 'companyId', 'channelId', 'requestId', 'fileId', 'revision', 'roomId', 'eventId', 'matrixTransactionId']) ||
        !uuid(value.companyId) || !uuid(value.channelId) || !uuid(value.requestId) || !uuid(value.fileId) ||
        value.revision !== 1 || typeof value.roomId !== 'string' || !ROOM_ID.test(value.roomId) ||
        typeof value.eventId !== 'string' || !EVENT_ID.test(value.eventId) || typeof value.matrixTransactionId !== 'string' ||
        !TRANSACTION_ID.test(value.matrixTransactionId)) {
        return invalid()
      }
      return value as unknown as MatrixCompanyFilePublishRequest
    case 'download':
      if (!exact(value, ['action', 'companyId', 'channelId', 'fileId', 'revision']) || !uuid(value.companyId) ||
        !uuid(value.channelId) || !uuid(value.fileId) || value.revision !== 1) {
        return invalid()
      }
      return value as unknown as MatrixCompanyFileDownloadRequest
    default:
      return invalid()
  }
}

function parseFile(value: unknown, companyId: string, channelId: string): MatrixCompanyFileRef {
  if (!object(value) || !exact(value, ['v', 'company_id', 'channel_id', 'file_id', 'revision', 'name', 'content_type', 'size', 'sha256']) ||
    value.v !== 1 || value.company_id !== companyId || value.channel_id !== channelId || !uuid(value.file_id) || value.revision !== 1 ||
    !fileName(value.name) || !contentType(value.content_type) || !byteSize(value.size) || !sha256(value.sha256)) {
    return invalid()
  }

  return value as unknown as MatrixCompanyFileRef
}

function parseGrant(value: unknown): MatrixCompanyFileGrant {
  if (!object(value) || !exact(value, ['token', 'expiresAtMs']) || typeof value.token !== 'string' || !TOKEN.test(value.token) ||
    typeof value.expiresAtMs !== 'number' || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs < 0 || value.expiresAtMs > Number.MAX_SAFE_INTEGER) {
    return invalid()
  }

  return value as unknown as MatrixCompanyFileGrant
}

function parseServerUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    return invalid()
  }

  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !/^[A-Za-z0-9.-]+$/u.test(url.hostname)) {
      return invalid()
    }
    return url.origin
  } catch {
    return invalid()
  }
}

function parseReadyResource(value: unknown): { storage: string; space: string; opaque: string } {
  const part = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 255 && /^[!-~]+$/u.test(v)
  if (!object(value) || !exact(value, ['storage', 'space', 'opaque']) || !part(value.storage) || !part(value.space) || !part(value.opaque)) {
    return invalid()
  }
  return value as { storage: string; space: string; opaque: string }
}

function etag(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && /^[!-~]+$/u.test(value)
}

function status(value: Record<string, unknown>, input: MatrixCompanyFileReserveRequest | MatrixCompanyFileStatusRequest): MatrixCompanyFileStatus {
  if (value.requestId !== input.requestId) {
    return invalid()
  }
  const file = parseFile(value.file, input.companyId, input.channelId)
  if (value.state === 'ready') {
    if (!exact(value, ['schemaVersion', 'state', 'requestId', 'file', 'resource', 'etag']) || !etag(value.etag)) {
      return invalid()
    }
    return { schemaVersion: 1, state: 'ready', requestId: input.requestId, file, resource: parseReadyResource(value.resource), etag: value.etag }
  }
  if (value.state === 'published') {
    const resourceNames = Object.hasOwn(value, 'resource') || Object.hasOwn(value, 'etag') ? ['resource', 'etag'] : []
    const publishedEtag = value.etag
    if (!exact(value, ['schemaVersion', 'state', 'requestId', 'file', 'roomId', 'eventId', 'matrixTransactionId', ...resourceNames]) ||
      typeof value.roomId !== 'string' || !ROOM_ID.test(value.roomId) || typeof value.eventId !== 'string' || !EVENT_ID.test(value.eventId) ||
      typeof value.matrixTransactionId !== 'string' || value.matrixTransactionId !== `atum-cf-${input.requestId}` ||
      (resourceNames.length > 0 && !etag(publishedEtag))) {
      return invalid()
    }
    return { schemaVersion: 1, state: 'published', requestId: input.requestId, file, roomId: value.roomId, eventId: value.eventId,
      matrixTransactionId: value.matrixTransactionId,
      ...(resourceNames.length ? { resource: parseReadyResource(value.resource), etag: publishedEtag as string } : {}) }
  }
  if (!['reserved', 'writing', 'unknown', 'cancelled'].includes(String(value.state)) ||
    !exact(value, ['schemaVersion', 'state', 'requestId', 'file'])) {
    return invalid()
  }
  return { schemaVersion: 1, state: value.state as MatrixCompanyFileStatusPending['state'], requestId: input.requestId, file }
}

function response(value: unknown, input: MatrixCompanyFileRequest): MatrixCompanyFileValue {
  if (!object(value) || value.schemaVersion !== 1) {
    return invalid()
  }

  if (input.action === 'reserve') {
    if (value.state === 'ready' || value.state === 'published' || value.state === 'writing' || value.state === 'unknown' || value.state === 'cancelled') {
      return status(value, input)
    }
    if (!exact(value, ['schemaVersion', 'state', 'requestId', 'file', 'serverUrl', 'uploadGrant']) || value.state !== 'reserved' || value.requestId !== input.requestId) {
      return invalid()
    }
    const file = parseFile(value.file, input.companyId, input.channelId)
    if (file.name !== input.name || file.content_type !== input.contentType || file.size !== input.size || file.sha256 !== input.sha256) {
      return invalid()
    }
    const uploadGrant = parseGrant(value.uploadGrant)
    return { schemaVersion: 1, state: 'reserved', requestId: input.requestId, file, serverUrl: parseServerUrl(value.serverUrl),
      uploadGrant: { expiresAtMs: uploadGrant.expiresAtMs, nativeGrant: uploadGrant.token } }
  }

  if (input.action === 'status') {
    return status(value, input)
  }

  if (input.action === 'publish') {
    if (!exact(value, ['schemaVersion', 'state', 'file', 'roomId', 'eventId', 'matrixTransactionId']) || value.state !== 'published' ||
      value.roomId !== input.roomId || value.eventId !== input.eventId || value.matrixTransactionId !== input.matrixTransactionId) {
      return invalid()
    }
    const file = parseFile(value.file, input.companyId, input.channelId)
    if (file.file_id !== input.fileId || file.revision !== input.revision) {
      return invalid()
    }
    return { schemaVersion: 1, state: 'published', file, roomId: input.roomId, eventId: input.eventId, matrixTransactionId: input.matrixTransactionId }
  }

  if (!exact(value, ['schemaVersion', 'state', 'file', 'serverUrl', 'downloadGrant']) || value.state !== 'ready') {
    return invalid()
  }
  const file = parseFile(value.file, input.companyId, input.channelId)
  if (file.file_id !== input.fileId || file.revision !== input.revision) {
    return invalid()
  }
  const downloadGrant = parseGrant(value.downloadGrant)
  return { schemaVersion: 1, state: 'ready', file, serverUrl: parseServerUrl(value.serverUrl),
    downloadGrant: { expiresAtMs: downloadGrant.expiresAtMs, nativeGrant: downloadGrant.token } }
}

async function platformError(response: Response): Promise<never> {
  if (response.status === 401) {
    await response.body?.cancel()
    throw new MatrixCompanyFileError('authentication')
  }
  const code = ({ 400: 'invalid', 403: 'denied', 404: 'missing', 409: 'conflict', 429: 'limit', 503: 'unavailable' } as const)[response.status]
  if (!code || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new MatrixCompanyFileError('unavailable')
  }
  try {
    const value = await readDomainJson(response, 16_384)
    const valid = object(value) && exact(value, ['schemaVersion', 'status', 'headers', 'body']) && value.schemaVersion === 1 &&
      value.status === response.status && object(value.headers) &&
      (exact(value.headers, ['cacheControl']) || exact(value.headers, ['cacheControl', 'retryAfterSeconds'])) &&
      value.headers.cacheControl === 'no-store' &&
      (value.headers.retryAfterSeconds === undefined || (typeof value.headers.retryAfterSeconds === 'number' && Number.isSafeInteger(value.headers.retryAfterSeconds) && value.headers.retryAfterSeconds >= 1 && value.headers.retryAfterSeconds <= 86400)) &&
      object(value.body) && exact(value.body, ['errcode', 'reason']) &&
      ['matrix_invalid', 'matrix_denied', 'matrix_not_found', 'matrix_conflict', 'matrix_limit', 'matrix_unavailable'].includes(String(value.body.errcode)) &&
      ['invalid', 'denied', 'revoked', 'not_found', 'space_preparing', 'upload_incomplete', 'upload_unknown', 'version_conflict', 'limit', 'provider_unavailable'].includes(String(value.body.reason))
    if (!valid) {
      throw new Error('invalid')
    }
    const body = value.body as Record<string, unknown>
    const retry = object(value.headers) && typeof value.headers.retryAfterSeconds === 'number'
      ? value.headers.retryAfterSeconds
      : undefined
    throw new MatrixCompanyFileError(
      code,
      code === 'limit' ? retry : undefined,
      body.reason as MatrixCompanyFileFailureReason
    )
  } catch (error) {
    if (error instanceof MatrixCompanyFileError) {
      throw error
    }
    throw new MatrixCompanyFileError('unavailable')
  }
}

/**
 * Fixed configured domain route only. The platform creates ingress grants; this
 * adapter keeps their raw values in the main process rather than widening IPC.
 */
export async function requestMatrixCompanyFile(
  resource: string,
  grant: NativeGrant,
  value: MatrixCompanyFileRequest,
  signal: AbortSignal
): Promise<MatrixCompanyFileValue> {
  const input = parseMatrixCompanyFileRequest(value)
  const path = input.action === 'reserve'
    ? `/companies/${input.companyId}/channels/${input.channelId}/files`
    : input.action === 'status'
      ? `/companies/${input.companyId}/channels/${input.channelId}/files/by-request/${input.requestId}`
      : input.action === 'publish'
        ? `/companies/${input.companyId}/channels/${input.channelId}/files/${input.fileId}/publish`
        : `/companies/${input.companyId}/channels/${input.channelId}/files/${input.fileId}/download`
  const read = input.action === 'status'
  const body = input.action === 'reserve'
    ? { requestId: input.requestId, name: input.name, contentType: input.contentType, size: input.size, sha256: input.sha256 }
    : input.action === 'publish'
      ? { requestId: input.requestId, fileId: input.fileId, revision: input.revision, roomId: input.roomId, eventId: input.eventId, matrixTransactionId: input.matrixTransactionId }
      : input.action === 'download' ? { revision: input.revision } : undefined
  signal.throwIfAborted()
  let responseValue: Response
  try {
    responseValue = await fetch(`${resource}${path}`, {
      method: read ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${grant.accessToken}`,
        Accept: 'application/json',
        ...(!read ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal
    })
  } catch {
    throw new MatrixCompanyFileError(signal.aborted ? 'cancelled' : 'unavailable')
  }
  if (responseValue.status !== 200) {
    return platformError(responseValue)
  }
  if (!responseValue.headers.get('content-type')?.startsWith('application/json')) {
    await responseValue.body?.cancel()
    throw new MatrixCompanyFileError('unavailable')
  }
  try {
    const parsed = response(await readDomainJson(responseValue, 64 * 1024), input)
    signal.throwIfAborted()
    return parsed
  } catch (error) {
    if (error instanceof MatrixCompanyFileError) {
      throw error
    }
    throw new MatrixCompanyFileError('unavailable')
  }
}
