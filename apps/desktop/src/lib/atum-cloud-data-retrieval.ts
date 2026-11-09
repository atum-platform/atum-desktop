const CONTRACT = 'atum.cloud-data/1'
const MAX_ITEMS = 50
const MAX_CONTENT_UTF8_BYTES = 65_536
const MAX_SOURCES_PER_DERIVED_ITEM = 16
const MAX_IDENTIFIER_LENGTH = 200

const BUNDLE_KEYS = new Set([
  'agent_class',
  'bundle_id',
  'content_utf8_bytes',
  'contract',
  'created_at',
  'fresh',
  'items',
  'scope',
  'source_watermark',
  'truncated'
])

const ITEM_KEYS = new Set(['content', 'item_id', 'provenance', 'source', 'untrusted_input'])
const SOURCE_KEYS = new Set(['generation', 'lifecycle', 'occurred_at', 'record_id', 'record_kind', 'revision'])
const DERIVED_SOURCE_KEYS = new Set([...SOURCE_KEYS, 'source_refs'])
const SOURCE_REF_KEYS = new Set(['generation', 'record_id', 'revision'])
const PROVENANCE_KEYS = new Set(['recorded_at', 'source_kind'])
const SCOPE_KEYS = new Set(['id', 'kind'])

const SCOPE_KINDS = new Set(['app_thread', 'p2p_thread', 'personal'])
const RECORD_KINDS = new Set(['app_event', 'artifact', 'memory_fact', 'message'])
const PROVENANCE_KINDS = new Set(['app_event', 'artifact', 'derived', 'memory_fact', 'message'])

export type AtumCloudDataScopeKind = 'app_thread' | 'p2p_thread' | 'personal'
export type AtumCloudDataRecordKind = 'app_event' | 'artifact' | 'memory_fact' | 'message'

export interface AtumCloudDataScope {
  id: string
  kind: AtumCloudDataScopeKind
}

export interface PersonalRetrievalExpectation {
  /** Current S2-owned subject. Never read this value from retrieval bytes. */
  activeSubject: string
  /** Subject captured by the trusted caller when the request was issued. */
  boundSubject: string
  maxContentUtf8Bytes: number
  maxItems: number
  minimumSourceGenerations?: Readonly<Record<string, number>>
  scope: AtumCloudDataScope
}

export interface PersonalRetrievalSourceRef {
  generation: number
  recordId: string
  revision: number
}

export interface PersonalRetrievalSource {
  generation: number
  lifecycle: 'active'
  occurredAt: string
  recordId: string
  recordKind: AtumCloudDataRecordKind
  revision: number
  sourceRefs?: readonly PersonalRetrievalSourceRef[]
}

export interface PersonalRetrievalItem {
  content: string
  itemId: string
  provenance: {
    recordedAt: string
    sourceKind: string
  }
  source: PersonalRetrievalSource
  untrustedInput: true
}

export interface PersonalRetrievalBundle {
  agentClass: 'personal'
  bundleId: string
  contentUtf8Bytes: number
  contract: typeof CONTRACT
  createdAt: string
  fresh: true
  items: readonly PersonalRetrievalItem[]
  scope: AtumCloudDataScope
  sourceWatermark: number
  truncated: boolean
}

export type PersonalRetrievalRejection =
  | 'agent_class_mismatch'
  | 'invalid_binding'
  | 'invalidated_provenance'
  | 'malformed_bundle'
  | 'scope_mismatch'
  | 'stale_bundle'
  | 'stale_generation'
  | 'subject_mismatch'
  | 'unsupported_contract'

export type PersonalRetrievalParseResult =
  | { bundle: PersonalRetrievalBundle; ok: true }
  | { code: PersonalRetrievalRejection; ok: false }

interface JsonRecord {
  [key: string]: unknown
}

function reject(code: PersonalRetrievalRejection): PersonalRetrievalParseResult {
  return { code, ok: false }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: JsonRecord, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)

  return keys.length === allowed.size && keys.every(key => allowed.has(key))
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !Array.from(value).some(character => {
      const codePoint = character.codePointAt(0)

      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
    })
  )
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function parseScope(value: unknown): AtumCloudDataScope | null {
  if (!isRecord(value) || !hasExactKeys(value, SCOPE_KEYS)) {
    return null
  }

  if (typeof value.kind !== 'string' || !SCOPE_KINDS.has(value.kind) || !isBoundedIdentifier(value.id)) {
    return null
  }

  return { id: value.id, kind: value.kind as AtumCloudDataScopeKind }
}

function scopesMatch(left: AtumCloudDataScope, right: AtumCloudDataScope): boolean {
  return left.id === right.id && left.kind === right.kind
}

function expectationIsValid(expectation: PersonalRetrievalExpectation): boolean {
  if (
    !isBoundedIdentifier(expectation.activeSubject) ||
    !isBoundedIdentifier(expectation.boundSubject) ||
    !isPositiveSafeInteger(expectation.maxItems) ||
    expectation.maxItems > MAX_ITEMS ||
    !isPositiveSafeInteger(expectation.maxContentUtf8Bytes) ||
    expectation.maxContentUtf8Bytes > MAX_CONTENT_UTF8_BYTES ||
    !parseScope(expectation.scope)
  ) {
    return false
  }

  return Object.entries(expectation.minimumSourceGenerations ?? {}).every(
    ([recordId, generation]) => isBoundedIdentifier(recordId) && isPositiveSafeInteger(generation)
  )
}

function parseSourceRef(value: unknown): PersonalRetrievalSourceRef | null {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_REF_KEYS)) {
    return null
  }

  if (
    !isBoundedIdentifier(value.record_id) ||
    !isPositiveSafeInteger(value.revision) ||
    !isPositiveSafeInteger(value.generation)
  ) {
    return null
  }

  return { generation: value.generation, recordId: value.record_id, revision: value.revision }
}

function parseSource(
  value: unknown,
  minimumSourceGenerations: Readonly<Record<string, number>>
): { rejection?: PersonalRetrievalRejection; source?: PersonalRetrievalSource } {
  if (!isRecord(value) || typeof value.record_kind !== 'string' || !RECORD_KINDS.has(value.record_kind)) {
    return { rejection: 'malformed_bundle' }
  }

  const derived = value.record_kind === 'memory_fact'

  if (!hasExactKeys(value, derived ? DERIVED_SOURCE_KEYS : SOURCE_KEYS)) {
    return { rejection: 'malformed_bundle' }
  }

  if (value.lifecycle !== 'active') {
    return { rejection: 'invalidated_provenance' }
  }

  if (
    !isBoundedIdentifier(value.record_id) ||
    !isPositiveSafeInteger(value.revision) ||
    !isPositiveSafeInteger(value.generation) ||
    !isUtcTimestamp(value.occurred_at)
  ) {
    return { rejection: 'malformed_bundle' }
  }

  const minimumGeneration = Object.prototype.hasOwnProperty.call(minimumSourceGenerations, value.record_id)
    ? minimumSourceGenerations[value.record_id]
    : undefined

  if (minimumGeneration !== undefined && value.generation < minimumGeneration) {
    return { rejection: 'stale_generation' }
  }

  let sourceRefs: readonly PersonalRetrievalSourceRef[] | undefined

  if (derived) {
    if (
      !Array.isArray(value.source_refs) ||
      value.source_refs.length === 0 ||
      value.source_refs.length > MAX_SOURCES_PER_DERIVED_ITEM
    ) {
      return { rejection: 'invalidated_provenance' }
    }

    const parsed = value.source_refs.map(parseSourceRef)

    if (parsed.some(ref => ref === null)) {
      return { rejection: 'invalidated_provenance' }
    }

    sourceRefs = parsed as PersonalRetrievalSourceRef[]

    for (const ref of sourceRefs) {
      const minimumRefGeneration = Object.prototype.hasOwnProperty.call(minimumSourceGenerations, ref.recordId)
        ? minimumSourceGenerations[ref.recordId]
        : undefined

      if (minimumRefGeneration !== undefined && ref.generation < minimumRefGeneration) {
        return { rejection: 'stale_generation' }
      }
    }
  }

  return {
    source: {
      generation: value.generation,
      lifecycle: 'active',
      occurredAt: value.occurred_at,
      recordId: value.record_id,
      recordKind: value.record_kind as AtumCloudDataRecordKind,
      revision: value.revision,
      ...(sourceRefs ? { sourceRefs } : {})
    }
  }
}

function parseItem(
  value: unknown,
  minimumSourceGenerations: Readonly<Record<string, number>>
): { item?: PersonalRetrievalItem; rejection?: PersonalRetrievalRejection } {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) {
    return { rejection: 'malformed_bundle' }
  }

  if (
    !isBoundedIdentifier(value.item_id) ||
    typeof value.content !== 'string' ||
    value.content.length === 0 ||
    value.content.length > MAX_CONTENT_UTF8_BYTES ||
    value.untrusted_input !== true
  ) {
    return { rejection: 'malformed_bundle' }
  }

  const parsedSource = parseSource(value.source, minimumSourceGenerations)

  if (!parsedSource.source) {
    return { rejection: parsedSource.rejection ?? 'malformed_bundle' }
  }

  if (!isRecord(value.provenance) || !hasExactKeys(value.provenance, PROVENANCE_KEYS)) {
    return { rejection: 'malformed_bundle' }
  }

  if (
    typeof value.provenance.source_kind !== 'string' ||
    !PROVENANCE_KINDS.has(value.provenance.source_kind) ||
    !isUtcTimestamp(value.provenance.recorded_at)
  ) {
    return { rejection: 'invalidated_provenance' }
  }

  return {
    item: {
      content: value.content,
      itemId: value.item_id,
      provenance: {
        recordedAt: value.provenance.recorded_at,
        sourceKind: value.provenance.source_kind as string
      },
      source: parsedSource.source,
      untrustedInput: true
    }
  }
}

/**
 * Validates the frozen `atum.cloud-data/1` retrieval response at the personal
 * assistant boundary. It grants no authority and performs no I/O.
 */
export function parsePersonalRetrievalBundle(
  value: unknown,
  expectation: PersonalRetrievalExpectation
): PersonalRetrievalParseResult {
  if (!expectationIsValid(expectation)) {
    return reject('invalid_binding')
  }

  if (expectation.activeSubject !== expectation.boundSubject) {
    return reject('subject_mismatch')
  }

  if (!isRecord(value)) {
    return reject('malformed_bundle')
  }

  if (value.contract !== CONTRACT) {
    return reject('unsupported_contract')
  }

  if (!hasExactKeys(value, BUNDLE_KEYS)) {
    return reject('malformed_bundle')
  }

  if (value.agent_class !== 'personal') {
    return reject('agent_class_mismatch')
  }

  const scope = parseScope(value.scope)

  if (!scope) {
    return reject('malformed_bundle')
  }

  if (!scopesMatch(scope, expectation.scope)) {
    return reject('scope_mismatch')
  }

  if (value.fresh !== true) {
    return reject('stale_bundle')
  }

  if (
    !isBoundedIdentifier(value.bundle_id) ||
    !isPositiveSafeInteger(value.source_watermark) ||
    !Array.isArray(value.items) ||
    value.items.length > expectation.maxItems ||
    value.items.length > MAX_ITEMS ||
    !Number.isSafeInteger(value.content_utf8_bytes) ||
    (value.content_utf8_bytes as number) < 0 ||
    typeof value.truncated !== 'boolean' ||
    !isUtcTimestamp(value.created_at)
  ) {
    return reject('malformed_bundle')
  }

  const minimumGenerations = expectation.minimumSourceGenerations ?? {}
  const items: PersonalRetrievalItem[] = []
  const itemIds = new Set<string>()
  let contentUtf8Bytes = 0

  for (const rawItem of value.items) {
    const parsed = parseItem(rawItem, minimumGenerations)

    if (!parsed.item) {
      return reject(parsed.rejection ?? 'malformed_bundle')
    }

    if (itemIds.has(parsed.item.itemId)) {
      return reject('malformed_bundle')
    }

    itemIds.add(parsed.item.itemId)
    items.push(parsed.item)
    contentUtf8Bytes += new TextEncoder().encode(parsed.item.content).byteLength
  }

  if (
    contentUtf8Bytes !== value.content_utf8_bytes ||
    contentUtf8Bytes > expectation.maxContentUtf8Bytes ||
    contentUtf8Bytes > MAX_CONTENT_UTF8_BYTES
  ) {
    return reject('malformed_bundle')
  }

  return {
    bundle: {
      agentClass: 'personal',
      bundleId: value.bundle_id,
      contentUtf8Bytes,
      contract: CONTRACT,
      createdAt: value.created_at,
      fresh: true,
      items,
      scope,
      sourceWatermark: value.source_watermark,
      truncated: value.truncated
    },
    ok: true
  }
}
