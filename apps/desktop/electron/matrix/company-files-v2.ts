import { randomUUID } from 'node:crypto'

import {
  type MatrixCompanyFileAudience,
  matrixCompanyFileRef,
  type MatrixCompanyFileRefV2
} from '../../shared/matrix-company-files'

import type { NativeGrant } from './authorization'
import { MatrixCompanyFileError } from './company-files'
import { readDomainJson } from './domain'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,63}$/u
const SHA256 = /^[a-f0-9]{64}$/u

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const exact = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join(',') === [...names].sort().join(',')

const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

const generation = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

export interface MatrixCompanyFileAuthorityV2 {
  companyId: string
  audience: MatrixCompanyFileAudience
  viewerAdmissionEpoch: number
  audienceGeneration: number
}

interface AuthorityFields extends MatrixCompanyFileAuthorityV2 {
  file: MatrixCompanyFileRefV2
}

export type MatrixCompanyFileRequestV2 =
  | (MatrixCompanyFileAuthorityV2 & {
      action: 'reserve-v2'
      requestId: string
      name: string
      contentType: string
      size: number
      sha256: string
    })
  | (AuthorityFields & { action: 'publish-v2'; requestId: string })
  | (AuthorityFields & { action: 'status-v2' })
  | (AuthorityFields & { action: 'download-v2'; requestId: string })

export type MatrixCompanyFileValueV2 =
  | {
      schemaVersion: 2
      state: 'reserved'
      file: MatrixCompanyFileRefV2
      uploadSessionId: string
      audienceGeneration: number
      replayed: boolean
    }
  | {
      schemaVersion: 2
      state: 'ready'
      file: MatrixCompanyFileRefV2
      audienceGeneration: number
      replayed: boolean
    }
  | {
      schemaVersion: 2
      state: 'reserved' | 'uploading' | 'ready' | 'failed'
      fileId: string
      audienceGeneration: number
      viewerAdmissionEpoch: number
    }
  | {
      schemaVersion: 2
      state: 'download'
      fileId: string
      downloadGrantId: string
      expiresAtMs: number
      audienceGeneration: number
      viewerAdmissionEpoch: number
      replayed: boolean
    }

function invalid(): never {
  throw new MatrixCompanyFileError('invalid')
}

function audience(value: unknown): MatrixCompanyFileAudience {
  if (!record(value)) {return invalid()}

  if (value.kind === 'channel' && exact(value, ['kind', 'channel_id', 'visibility']) && uuid(value.channel_id) &&
      (value.visibility === 'public' || value.visibility === 'private')) {
    return value as unknown as MatrixCompanyFileAudience
  }

  if (value.kind === 'conversation' && exact(value, ['kind', 'conversation_id']) && uuid(value.conversation_id)) {
    return value as unknown as MatrixCompanyFileAudience
  }

  return invalid()
}

function sameAudience(left: MatrixCompanyFileAudience, right: MatrixCompanyFileAudience): boolean {
  return left.kind === 'channel' && right.kind === 'channel'
    ? left.channel_id === right.channel_id && left.visibility === right.visibility
    : left.kind === 'conversation' && right.kind === 'conversation' && left.conversation_id === right.conversation_id
}

function sameFile(left: MatrixCompanyFileRefV2, right: MatrixCompanyFileRefV2): boolean {
  return left.v === right.v && left.company_id === right.company_id && sameAudience(left.audience, right.audience) &&
    left.file_id === right.file_id && left.revision === right.revision && left.name === right.name &&
    left.content_type === right.content_type && left.size === right.size && left.sha256 === right.sha256
}

export function parseMatrixCompanyFileRequestV2(value: unknown): MatrixCompanyFileRequestV2 {
  if (!record(value) || !uuid(value.companyId) || !generation(value.viewerAdmissionEpoch) ||
      !generation(value.audienceGeneration)) {return invalid()}

  const target = audience(value.audience)

  if (value.action === 'reserve-v2') {
    if (!exact(value, ['action', 'companyId', 'audience', 'viewerAdmissionEpoch', 'audienceGeneration', 'requestId',
      'name', 'contentType', 'size', 'sha256']) || !uuid(value.requestId) || typeof value.name !== 'string' ||
      !value.name.trim() || [...value.name].length > 255 || typeof value.contentType !== 'string' ||
      !CONTENT_TYPE.test(value.contentType) || !Number.isSafeInteger(value.size) || Number(value.size) < 0 ||
      Number(value.size) > 20 * 1024 * 1024 || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {return invalid()}

    return { ...value, audience: target } as unknown as MatrixCompanyFileRequestV2
  }

  const expected = value.action === 'status-v2'
    ? ['action', 'companyId', 'audience', 'viewerAdmissionEpoch', 'audienceGeneration', 'file']
    : ['action', 'companyId', 'audience', 'viewerAdmissionEpoch', 'audienceGeneration', 'file', 'requestId']

  if (!['publish-v2', 'status-v2', 'download-v2'].includes(String(value.action)) || !exact(value, expected) ||
      value.action !== 'status-v2' && !uuid(value.requestId)) {return invalid()}

  const file = matrixCompanyFileRef(value.file)

  if (!file || file.v !== 2 || file.company_id !== value.companyId || !sameAudience(file.audience, target)) {return invalid()}

  return { ...value, audience: target, file } as unknown as MatrixCompanyFileRequestV2
}

function response(value: unknown, input: MatrixCompanyFileRequestV2): MatrixCompanyFileValueV2 {
  if (!record(value) || value.schemaVersion !== 2) {return invalid()}

  if (input.action === 'reserve-v2') {
    const file = matrixCompanyFileRef(value.file)

    if (!exact(value, ['schemaVersion', 'file', 'uploadSessionId', 'audienceGeneration', 'replayed']) ||
        !file || file.v !== 2 || file.company_id !== input.companyId || !sameAudience(file.audience, input.audience) ||
        !uuid(value.uploadSessionId) || value.audienceGeneration !== input.audienceGeneration ||
        typeof value.replayed !== 'boolean' || file.name !== input.name || file.content_type !== input.contentType ||
        file.size !== input.size || file.sha256 !== input.sha256) {return invalid()}

    return { schemaVersion: 2, state: 'reserved', file, uploadSessionId: value.uploadSessionId,
      audienceGeneration: value.audienceGeneration, replayed: value.replayed }
  }

  if (input.action === 'publish-v2') {
    const file = matrixCompanyFileRef(value.file)

    if (!exact(value, ['schemaVersion', 'file', 'status', 'audienceGeneration', 'replayed']) || value.status !== 'ready' ||
        !file || file.v !== 2 || !sameFile(file, input.file) ||
        value.audienceGeneration !== input.audienceGeneration || typeof value.replayed !== 'boolean') {return invalid()}

    return { schemaVersion: 2, state: 'ready', file, audienceGeneration: value.audienceGeneration, replayed: value.replayed }
  }

  if (input.action === 'status-v2') {
    if (!exact(value, ['schemaVersion', 'fileId', 'status', 'audienceGeneration', 'viewerAdmissionEpoch']) ||
        value.fileId !== input.file.file_id || !['reserved', 'uploading', 'ready', 'failed'].includes(String(value.status)) ||
        value.audienceGeneration !== input.audienceGeneration || value.viewerAdmissionEpoch !== input.viewerAdmissionEpoch) {return invalid()}

    return { schemaVersion: 2, state: value.status as 'reserved' | 'uploading' | 'ready' | 'failed',
      fileId: value.fileId, audienceGeneration: value.audienceGeneration, viewerAdmissionEpoch: value.viewerAdmissionEpoch }
  }

  if (!exact(value, ['schemaVersion', 'fileId', 'downloadGrantId', 'expiresAt', 'audienceGeneration',
    'viewerAdmissionEpoch', 'replayed']) || value.fileId !== input.file.file_id || !uuid(value.downloadGrantId) ||
    typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 ||
    value.audienceGeneration !== input.audienceGeneration || value.viewerAdmissionEpoch !== input.viewerAdmissionEpoch ||
    typeof value.replayed !== 'boolean') {return invalid()}

  return { schemaVersion: 2, state: 'download', fileId: value.fileId, downloadGrantId: value.downloadGrantId,
    expiresAtMs: value.expiresAt * 1000, audienceGeneration: value.audienceGeneration,
    viewerAdmissionEpoch: value.viewerAdmissionEpoch, replayed: value.replayed }
}

async function platformError(responseValue: Response): Promise<never> {
  if (responseValue.status === 401) {
    await responseValue.body?.cancel()
    throw new MatrixCompanyFileError('authentication')
  }

  if (responseValue.status === 404) {
    await responseValue.body?.cancel()
    throw new MatrixCompanyFileError('unsupported')
  }

  const code = ({ 400: 'invalid', 403: 'denied', 409: 'conflict', 429: 'limit', 503: 'unavailable' } as const)[responseValue.status]

  if (!code || !responseValue.headers.get('content-type')?.startsWith('application/json')) {
    await responseValue.body?.cancel()
    throw new MatrixCompanyFileError('unavailable')
  }

  try {
    const value = await readDomainJson(responseValue, 16_384)

    if (!record(value) || !exact(value, ['schemaVersion', 'status', 'headers', 'body']) || value.schemaVersion !== 2 ||
        value.status !== responseValue.status || !record(value.headers) || !exact(value.headers, ['cacheControl']) ||
        value.headers.cacheControl !== 'no-store' || !record(value.body) || !exact(value.body, ['errcode', 'reason'])) {invalid()}

    const reason = String(value.body.reason)

    if (!['audience_revoked', 'target_mismatch', 'admission_epoch_stale', 'audience_generation_stale',
      'preview_scope_mismatch', 'preview_unavailable', 'provider_unavailable'].includes(reason)) {invalid()}

    throw new MatrixCompanyFileError(code, undefined, reason === 'audience_revoked' ? 'revoked' :
      reason === 'provider_unavailable' ? 'provider_unavailable' : 'version_conflict')
  } catch (error) {
    if (error instanceof MatrixCompanyFileError) {throw error}
    throw new MatrixCompanyFileError('unavailable')
  }
}

export async function requestMatrixCompanyFileV2(
  resource: string,
  grant: NativeGrant,
  value: MatrixCompanyFileRequestV2,
  signal: AbortSignal
): Promise<MatrixCompanyFileValueV2> {
  const input = parseMatrixCompanyFileRequestV2(value)
  const fileId = input.action === 'reserve-v2' ? undefined : input.file.file_id

  const operation = input.action === 'reserve-v2' ? 'reserve' : input.action === 'publish-v2' ? 'publish'
    : input.action === 'status-v2' ? 'status' : 'download-grant'

  const path = `/companies/${input.companyId}/files${fileId ? `/${fileId}` : ''}/${operation}`

  const body = input.action === 'reserve-v2'
    ? { requestId: input.requestId, companyId: input.companyId, audience: input.audience,
        viewerAdmissionEpoch: input.viewerAdmissionEpoch, audienceGeneration: input.audienceGeneration,
        name: input.name, contentType: input.contentType, size: input.size, sha256: input.sha256 }
    : input.action === 'status-v2'
      ? { file: input.file, viewerAdmissionEpoch: input.viewerAdmissionEpoch,
          audienceGeneration: input.audienceGeneration }
      : { requestId: input.requestId, file: input.file, viewerAdmissionEpoch: input.viewerAdmissionEpoch,
          audienceGeneration: input.audienceGeneration }

  signal.throwIfAborted()
  let responseValue: Response

  try {
    responseValue = await fetch(`${resource}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json',
        'Content-Type': 'application/json', 'Atum-Company-Wire': '1.5' },
      body: JSON.stringify(body), redirect: 'error', credentials: 'omit', cache: 'no-store', signal
    })
  } catch {
    throw new MatrixCompanyFileError(signal.aborted ? 'cancelled' : 'unavailable')
  }

  if (responseValue.status !== 200) {return platformError(responseValue)}

  if (!responseValue.headers.get('content-type')?.startsWith('application/json')) {
    await responseValue.body?.cancel()
    throw new MatrixCompanyFileError('unavailable')
  }

  return response(await readDomainJson(responseValue, 64 * 1024), input)
}

export const newCompanyFileRequestId = () => randomUUID()
