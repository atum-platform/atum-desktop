/**
 * Bounded, owner-authorized advisory-history source contract.  This is shared
 * by Electron main and the renderer, but it deliberately contains no owner or
 * model identity: main derives both from the pending gateway request.
 */

export type AdvisorySearchStatus = 'ok' | 'empty' | 'denied' | 'unavailable' | 'stale' | 'limit'

export interface AdvisorySearchRequest {
  target_assistant_id: string
  conversation_id: string | null
  query: string
  reference: string | null
  limit: number
}

export interface AdvisorySearchMessage {
  id: string
  version: number
  created_at: string
  speaker: { kind: 'owner' | 'specialist' | 'assistant'; id: string }
  text: string
  truncated?: true
}

export interface AdvisorySearchRoom {
  session_id: string
  conversation_id: string
  title: string | null
  audience_revision: number
  context_revision: number
  messages: AdvisorySearchMessage[]
}

export interface AdvisorySearchResult {
  status: AdvisorySearchStatus
  results: AdvisorySearchRoom[]
  next_reference: string | null
  previous_reference: string | null
}

/** The only renderer-controlled data allowed across the preload boundary. */
export interface AdvisorySearchInvocation {
  request_id: string
  session_id: string
  turn_id: string
  profile: string
}

const MAX_RESPONSE_CODEPOINTS = 6_000
const MAX_ROOMS = 5
const MAX_MESSAGES = 12
// Cursor references can carry a Unicode discovery query. The opaque payload is
// bounded to 4,096 code points, plus the `atum-advisory:` namespace prefix.
const MAX_REFERENCE_CODEPOINTS = 4_110
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REFERENCE = /^atum-advisory:[A-Za-z0-9_-]+$/
const STATUSES = new Set<AdvisorySearchStatus>(['ok', 'empty', 'denied', 'unavailable', 'stale', 'limit'])

function unavailable(): AdvisorySearchResult {
  return { status: 'unavailable', results: [], next_reference: null, previous_reference: null }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && Array.from(value).length <= max ? value : null
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null
}

function reference(value: unknown): string | null {
  if (value === null) {
    return null
  }

  return typeof value === 'string' && Array.from(value).length <= MAX_REFERENCE_CODEPOINTS && REFERENCE.test(value)
    ? value
    : null
}

function parseMessage(value: unknown): AdvisorySearchMessage | null {
  const row = object(value)
  const speaker = row ? object(row.speaker) : null
  const id = row ? uuid(row.id) : null
  const speakerId =
    speaker?.kind === 'specialist'
      ? typeof speaker.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(speaker.id)
        ? speaker.id
        : null
      : speaker
        ? uuid(speaker.id)
        : null
  const text = row ? boundedText(row.text, MAX_RESPONSE_CODEPOINTS) : null

  if (
    !row ||
    !speaker ||
    !id ||
    !speakerId ||
    text === null ||
    (speaker.kind !== 'owner' && speaker.kind !== 'specialist' && speaker.kind !== 'assistant') ||
    typeof row.version !== 'number' ||
    !Number.isSafeInteger(row.version) ||
    typeof row.created_at !== 'string' ||
    !row.created_at ||
    (row.truncated !== undefined && typeof row.truncated !== 'boolean')
  ) {
    return null
  }

  return {
    id,
    version: row.version,
    created_at: row.created_at,
    speaker: { kind: speaker.kind, id: speakerId },
    text,
    ...(row.truncated === true ? { truncated: true } : {})
  }
}

function parseRoom(value: unknown): AdvisorySearchRoom | null {
  const row = object(value)
  const sessionId = row ? reference(row.session_id) : null
  const conversationId = row ? uuid(row.conversation_id) : null
  const title = row?.title === null ? null : boundedText(row?.title, 500)

  if (
    !row ||
    !sessionId ||
    !conversationId ||
    (title === null && row.title !== null) ||
    !Array.isArray(row.messages) ||
    typeof row.audience_revision !== 'number' ||
    typeof row.context_revision !== 'number' ||
    !Number.isSafeInteger(row.audience_revision) ||
    !Number.isSafeInteger(row.context_revision)
  ) {
    return null
  }

  const messages = row.messages.map(parseMessage)

  if (messages.some(message => message === null)) {
    return null
  }

  return {
    session_id: sessionId,
    conversation_id: conversationId,
    title,
    audience_revision: row.audience_revision,
    context_revision: row.context_revision,
    messages: messages as AdvisorySearchMessage[]
  }
}

/**
 * Treat an invalid or oversized platform reply as unavailable.  The caller can
 * keep its local Hermes search result rather than turning malformed remote data
 * into prompt context.
 */
export function parseAdvisorySearchResult(value: unknown): AdvisorySearchResult {
  let serialized: string | undefined

  try {
    serialized = JSON.stringify(value)
  } catch {
    return unavailable()
  }

  if (typeof serialized !== 'string' || Array.from(serialized).length > MAX_RESPONSE_CODEPOINTS) {
    return unavailable()
  }

  const row = object(value)
  const status = row?.status
  const nextReference = reference(row?.next_reference)
  const previousReference = reference(row?.previous_reference)

  if (
    !row ||
    typeof status !== 'string' ||
    !STATUSES.has(status as AdvisorySearchStatus) ||
    !Array.isArray(row.results) ||
    row.results.length > MAX_ROOMS
  ) {
    return unavailable()
  }

  const results = row.results.map(parseRoom)
  const messageCount = results.reduce((count, room) => count + (room?.messages.length ?? 0), 0)

  if (results.some(room => room === null) || messageCount > MAX_MESSAGES) {
    return unavailable()
  }

  return {
    status: status as AdvisorySearchStatus,
    results: results as AdvisorySearchRoom[],
    next_reference: nextReference,
    previous_reference: previousReference
  }
}
