import { createHash } from 'node:crypto'

import type {
  AwarenessAttachment,
  AwarenessAuthor,
  AwarenessEnvelopeContext,
  AwarenessNormalized,
  AwarenessObject,
  AwarenessRevision,
  AwarenessSource,
  AwarenessVisibility
} from './types'

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const MAX_REF_LENGTH = 1024
const MAX_MIME_LENGTH = 255
const MAX_TEXT_CODEPOINTS = 65_536
const MAX_ATTACHMENTS = 16

const sourceKinds = new Set<AwarenessSource['kind']>([
  'assistant_chat',
  'human_dm',
  'human_group',
  'app_exchange',
  'drive_file',
  'native_memory',
  'owner_statement'
])

const objectKinds = new Set<AwarenessObject['kind']>([
  'message',
  'edit',
  'redaction',
  'file_version',
  'memory_revision'
])

const authorKinds = new Set<AwarenessAuthor['kind']>(['owner', 'human', 'agent', 'app'])
const attachmentKinds = new Set<AwarenessAttachment['kind']>(['file', 'image', 'audio'])
const attachmentParses = new Set<AwarenessAttachment['parse']>(['parsed', 'pending', 'unsupported'])
const visibilities = new Set<AwarenessVisibility>(['joined', 'invited', 'shared', 'world_readable', 'not_applicable'])

const recognizedCredentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:^|[\s(])Bearer[ \t]+[A-Za-z0-9._~+/=-]{24,}(?=$|[\s,;)\]])/,
  /(?:^|[^A-Za-z0-9_])sk[-_][A-Za-z0-9_-]{24,}(?![A-Za-z0-9_])/,
  /(?:^|[^A-Za-z0-9_])ghp_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])/,
  /(?:^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{30,}(?![A-Za-z0-9_])/
]

type Validation = 'valid' | 'invalid' | 'unsupported'
type Provenance = 'unmarked' | 'google' | 'invalid'

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function validRef(value: unknown, maxLength = MAX_REF_LENGTH): value is string {
  return typeof value === 'string' && /^[!-~]+$/.test(value) && value.length <= maxLength
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SAFE_INTEGER
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_INTEGER
}

function validationForEnum(value: unknown, values: Set<string>): Validation {
  if (typeof value !== 'string') {
    return 'invalid'
  }

  return values.has(value) ? 'valid' : 'unsupported'
}

function sourceValidation(source: unknown): Validation {
  if (!isRecord(source)) {
    return 'invalid'
  }

  const kindResult = validationForEnum(source.kind, sourceKinds)

  if (kindResult !== 'valid') {
    return kindResult
  }

  if (!validRef(source.id)) {
    return 'invalid'
  }

  if (hasOwn(source, 'agentPrincipal') && !validUuid(source.agentPrincipal)) {
    return 'invalid'
  }

  return 'valid'
}

/** True only for a source reference the normalizer can reconstruct safely. */
export function validSource(source: unknown): source is AwarenessSource {
  return (
    sourceValidation(source) === 'valid' &&
    isRecord(source) &&
    Object.keys(source).every(key => key === 'kind' || key === 'id' || key === 'agentPrincipal')
  )
}

/** Collision-free stable key for an already validated source reference. */
export function sourceKey(source: AwarenessSource): string {
  return JSON.stringify([source.kind, source.id, source.agentPrincipal ?? null])
}

function provenanceOf(revision: Record<string, unknown>): Provenance {
  if (!hasOwn(revision, 'provenance')) {
    return 'unmarked'
  }

  const provenance = revision.provenance

  if (!isRecord(provenance)) {
    return 'invalid'
  }

  const keys = Object.keys(provenance)

  return keys.length === 2 &&
    keys.includes('v') &&
    keys.includes('google') &&
    provenance.v === 1 &&
    provenance.google === true
    ? 'google'
    : 'invalid'
}

function contextValidation(context: unknown): Validation {
  if (!isRecord(context)) {
    return 'invalid'
  }

  if (context.destination !== 'managed' && context.destination !== 'local') {
    return 'invalid'
  }

  if (
    !validUuid(context.operationId) ||
    !validTimestamp(context.observedTime) ||
    !validPositiveInteger(context.epoch)
  ) {
    return 'invalid'
  }

  if (
    typeof context.accountFence !== 'boolean' ||
    typeof context.visibility !== 'string' ||
    !visibilities.has(context.visibility as AwarenessVisibility)
  ) {
    return 'invalid'
  }

  return 'valid'
}

function authorValidation(author: unknown): Validation {
  if (!isRecord(author)) {
    return 'invalid'
  }

  const kindResult = validationForEnum(author.kind, authorKinds)

  if (kindResult !== 'valid') {
    return kindResult
  }

  return validRef(author.id) ? 'valid' : 'invalid'
}

function objectValidation(object: unknown): Validation {
  if (!isRecord(object)) {
    return 'invalid'
  }

  const kindResult = validationForEnum(object.kind, objectKinds)

  if (kindResult !== 'valid') {
    return kindResult
  }

  if (!validRef(object.id) || !validPositiveInteger(object.revision)) {
    return 'invalid'
  }

  const needsReplacement = object.kind === 'edit' || object.kind === 'redaction'

  if (needsReplacement && !validRef(object.replaces)) {
    return 'invalid'
  }

  if (hasOwn(object, 'replaces') && !validRef(object.replaces)) {
    return 'invalid'
  }

  return 'valid'
}

function attachmentValidation(attachment: unknown): Validation {
  if (!isRecord(attachment)) {
    return 'invalid'
  }

  const kindResult = validationForEnum(attachment.kind, attachmentKinds)

  if (kindResult !== 'valid') {
    return kindResult
  }

  const parseResult = validationForEnum(attachment.parse, attachmentParses)

  if (parseResult !== 'valid') {
    return parseResult
  }

  if (!validRef(attachment.ref) || !validRef(attachment.mime, MAX_MIME_LENGTH)) {
    return 'invalid'
  }

  return validTimestamp(attachment.bytes) ? 'valid' : 'invalid'
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').normalize('NFC')
}

function containsRecognizedCredential(text: string): boolean {
  return recognizedCredentialPatterns.some(pattern => pattern.test(text))
}

function contentValidation(content: unknown, redaction: boolean): Validation {
  if (!isRecord(content) || typeof content.text !== 'string' || !Array.isArray(content.attachments)) {
    return 'invalid'
  }

  if (redaction && (content.text !== '' || content.attachments.length !== 0)) {
    return 'invalid'
  }

  const normalizedText = normalizeText(content.text)

  if (Array.from(normalizedText).length > MAX_TEXT_CODEPOINTS || content.attachments.length > MAX_ATTACHMENTS) {
    return 'invalid'
  }

  if (containsRecognizedCredential(normalizedText)) {
    return 'unsupported'
  }

  for (const attachment of content.attachments) {
    const result = attachmentValidation(attachment)

    if (result !== 'valid') {
      return result
    }
  }

  return 'valid'
}

function normalizedSource(source: Record<string, unknown>): AwarenessSource {
  const result: AwarenessSource = { kind: source.kind as AwarenessSource['kind'], id: source.id as string }

  if (hasOwn(source, 'agentPrincipal')) {
    result.agentPrincipal = source.agentPrincipal as string
  }

  return result
}

function normalizedObject(object: Record<string, unknown>): AwarenessObject {
  const result: AwarenessObject = {
    kind: object.kind as AwarenessObject['kind'],
    id: object.id as string,
    revision: object.revision as number
  }

  if (hasOwn(object, 'replaces')) {
    result.replaces = object.replaces as string
  }

  return result
}

function normalizedAuthor(author: Record<string, unknown>): AwarenessAuthor {
  return { kind: author.kind as AwarenessAuthor['kind'], id: author.id as string }
}

function normalizedAttachments(attachments: unknown[]): AwarenessAttachment[] {
  return attachments.map(attachment => {
    const record = attachment as Record<string, unknown>

    return {
      kind: record.kind as AwarenessAttachment['kind'],
      ref: record.ref as string,
      mime: record.mime as string,
      bytes: record.bytes as number,
      parse: record.parse as AwarenessAttachment['parse']
    }
  })
}

function failed(result: Validation): AwarenessNormalized {
  return result === 'unsupported' ? { kind: 'unsupported' } : { kind: 'invalid' }
}

/**
 * Produces the compact awareness contract envelope from one untrusted revision.
 * Only CRLF is canonicalized to LF; text is NFC-normalized but never trimmed or
 * truncated. The result deliberately copies only contract fields, so source-only
 * adapter metadata (including any owner, audience, or token-shaped fields) cannot
 * enter an envelope. Its narrow credential screen recognizes complete PEM private
 * key headers and long Bearer/sk-/sk_/ghp_/github_pat_ forms only; it is defense in
 * depth, not a replacement for trusted source adapters stripping hidden reasoning
 * and private app instructions.
 */
export function normalizeAwarenessRevision(
  revision: AwarenessRevision,
  context: AwarenessEnvelopeContext
): AwarenessNormalized {
  const validContext = contextValidation(context)

  if (validContext !== 'valid') {
    return failed(validContext)
  }

  if (!isRecord(revision)) {
    return { kind: 'invalid' }
  }

  // A present marker is never silently treated as unmarked. For managed output,
  // fence it before inspecting payload content so marked content cannot escape.
  const provenance = provenanceOf(revision)

  if (provenance === 'invalid') {
    return context.destination === 'managed' ? { kind: 'blocked', reason: 'google_fence' } : { kind: 'invalid' }
  }

  if (context.destination === 'managed' && provenance === 'google') {
    return { kind: 'blocked', reason: 'google_fence' }
  }

  const sourceResult = sourceValidation(revision.source)

  if (sourceResult !== 'valid') {
    return failed(sourceResult)
  }

  const source = revision.source as unknown as Record<string, unknown>

  if (context.destination === 'managed' && source.kind === 'drive_file' && context.accountFence) {
    return { kind: 'blocked', reason: 'google_fence' }
  }

  const objectResult = objectValidation(revision.object)

  if (objectResult !== 'valid') {
    return failed(objectResult)
  }

  const authorResult = authorValidation(revision.author)

  if (authorResult !== 'valid') {
    return failed(authorResult)
  }

  if (!validTimestamp(revision.eventTime)) {
    return { kind: 'invalid' }
  }

  const object = revision.object as unknown as Record<string, unknown>
  const contentResult = contentValidation(revision.content, object.kind === 'redaction')

  if (contentResult !== 'valid') {
    return failed(contentResult)
  }

  const content = revision.content as unknown as Record<string, unknown>
  const text = object.kind === 'redaction' ? '' : normalizeText(content.text as string)
  const attachments = object.kind === 'redaction' ? [] : normalizedAttachments(content.attachments as unknown[])

  return {
    kind: 'envelope',
    envelope: {
      contract: 'atum.awareness/1',
      operationId: context.operationId,
      source: normalizedSource(source),
      object: normalizedObject(object),
      author: normalizedAuthor(revision.author as unknown as Record<string, unknown>),
      eventTime: revision.eventTime,
      observedTime: context.observedTime,
      policy: {
        epoch: context.epoch,
        visibility: context.visibility,
        googleDerived: provenance === 'google',
        accountFence: context.accountFence
      },
      content: { text, attachments },
      digest: createHash('sha256').update(text, 'utf8').digest('hex')
    }
  }
}
