export const MATRIX_COMPANY_FILE = 'io.atum.company_file'
export const MATRIX_COMPANY_FILE_MAX_BYTES = 20 * 1024 * 1024

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const EVENT_ID = /^\$[!-~]{1,511}$/u
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,63}$/u
const SHA256 = /^[a-f0-9]{64}$/u

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const exact = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join(',') === [...names].sort().join(',')

const fileName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  [...value].length <= 255 &&
  [...value].every(character => character.codePointAt(0)! > 31 && character.codePointAt(0) !== 127)

export interface MatrixCompanyFileRefV1 {
  v: 1
  company_id: string
  channel_id: string
  file_id: string
  revision: 1
  name: string
  content_type: string
  size: number
  sha256: string
}

export type MatrixCompanyFileAudience =
  | { kind: 'channel'; channel_id: string; visibility: 'public' | 'private' }
  | { kind: 'conversation'; conversation_id: string }

export type MatrixCompanyFileTarget =
  | { kind: 'channel'; channelId: string }
  | { kind: 'conversation'; conversationId: string }

export interface MatrixCompanyFileRefV2 {
  v: 2
  company_id: string
  audience: MatrixCompanyFileAudience
  file_id: string
  revision: 1
  name: string
  content_type: string
  size: number
  sha256: string
}

export type MatrixCompanyFileRef = MatrixCompanyFileRefV1 | MatrixCompanyFileRefV2

export interface MatrixCompanyFileContext {
  companyId: string
  target: MatrixCompanyFileTarget
  roomId: string
  threadRootId?: string
  replyTo?: string
}

/** Trusted main → hidden human SDK only. None of these commands carries a grant or provider URL. */
export type MatrixCompanyFileSdkCommand =
  | { kind: 'companyFileContext'; roomId: string; threadRootId?: string; replyTo?: string }
  | {
      kind: 'companyFileSend'
      roomId: string
      requestId: string
      file: MatrixCompanyFileRef
      matrixTransactionId: string
      threadRootId?: string
      replyTo?: string
    }
  | { kind: 'companyFileReference'; roomId: string; eventId: string }

export function matrixCompanyFileRef(
  value: unknown,
  expected?: { companyId: string; target: MatrixCompanyFileTarget }
): MatrixCompanyFileRef | undefined {
  if (!record(value) ||
    typeof value.company_id !== 'string' ||
    !UUID.test(value.company_id) ||
    typeof value.file_id !== 'string' ||
    !UUID.test(value.file_id) ||
    value.revision !== 1 ||
    !fileName(value.name) ||
    typeof value.content_type !== 'string' ||
    !CONTENT_TYPE.test(value.content_type) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    Number(value.size) > MATRIX_COMPANY_FILE_MAX_BYTES ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    (expected !== undefined && value.company_id !== expected.companyId)
  ) {
    return undefined
  }

  if (value.v === 1) {
    if (!exact(value, ['v', 'company_id', 'channel_id', 'file_id', 'revision', 'name', 'content_type', 'size', 'sha256']) ||
        typeof value.channel_id !== 'string' || !UUID.test(value.channel_id) ||
        (expected !== undefined && (expected.target.kind !== 'channel' || value.channel_id !== expected.target.channelId))) {
      return undefined
    }

    return value as unknown as MatrixCompanyFileRefV1
  }

  if (value.v !== 2 ||
      !exact(value, ['v', 'company_id', 'audience', 'file_id', 'revision', 'name', 'content_type', 'size', 'sha256']) ||
      !record(value.audience)) {
    return undefined
  }

  const audience = value.audience
  const targetMatches = audience.kind === 'channel'
    ? exact(audience, ['kind', 'channel_id', 'visibility']) && typeof audience.channel_id === 'string' &&
      UUID.test(audience.channel_id) && (audience.visibility === 'public' || audience.visibility === 'private') &&
      (expected === undefined || expected.target.kind === 'channel' && audience.channel_id === expected.target.channelId)
    : audience.kind === 'conversation' && exact(audience, ['kind', 'conversation_id']) &&
      typeof audience.conversation_id === 'string' && UUID.test(audience.conversation_id) &&
      (expected === undefined || expected.target.kind === 'conversation' && audience.conversation_id === expected.target.conversationId)

  if (!targetMatches) {
    return undefined
  }

  return value as unknown as MatrixCompanyFileRefV2
}

/**
 * Strict protected Matrix content. `undefined` means no protected marker; `null` means a marker
 * was present but the event is unsafe or not the frozen shape.
 */
export function matrixCompanyFileContent(
  value: unknown,
  expected?: { companyId: string; target: MatrixCompanyFileTarget }
): MatrixCompanyFileRef | null | undefined {
  if (!record(value) || !Object.hasOwn(value, MATRIX_COMPANY_FILE)) {
    return undefined
  }

  const allowed = ['msgtype', 'body', 'info', MATRIX_COMPANY_FILE]
  if (Object.hasOwn(value, 'm.relates_to')) {
    allowed.push('m.relates_to')
  }
  if (!exact(value, allowed) || value.msgtype !== 'm.file') {
    return null
  }

  const file = matrixCompanyFileRef(value[MATRIX_COMPANY_FILE], expected)
  if (!file || value.body !== file.name || !record(value.info) || !exact(value.info, ['mimetype', 'size']) ||
      value.info.mimetype !== file.content_type || value.info.size !== file.size) {
    return null
  }

  if (Object.hasOwn(value, 'm.relates_to')) {
    const relation = value['m.relates_to']
    if (!record(relation) || !exact(relation, ['rel_type', 'event_id', 'is_falling_back', 'm.in_reply_to']) ||
        relation.rel_type !== 'm.thread' || relation.is_falling_back !== true ||
        typeof relation.event_id !== 'string' || !EVENT_ID.test(relation.event_id) ||
        !record(relation['m.in_reply_to']) || !exact(relation['m.in_reply_to'], ['event_id']) ||
        typeof relation['m.in_reply_to'].event_id !== 'string' ||
        !EVENT_ID.test(relation['m.in_reply_to'].event_id)) {
      return null
    }
  }

  return file
}
