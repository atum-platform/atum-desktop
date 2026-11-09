export const MATRIX_SAVED_MESSAGES_ACCOUNT_DATA = 'com.atum.saved_messages'
export const MATRIX_SAVED_MESSAGES_MAX = 200
export const MATRIX_SAVED_MESSAGE_SNIPPET_MAX = 600

const ROOM_ID = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
const EVENT_ID = /^\$[!-~]{1,1023}$/u
const MAX_DATE_MS = 8_640_000_000_000_000

export interface MatrixSavedMessagePointer {
  room_id: string
  event_id: string
  saved_at: number
}

/** Private per-user Matrix account data. The list is newest first and bounded. */
export interface MatrixSavedMessagesContent {
  version: 1
  messages: MatrixSavedMessagePointer[]
}

export interface MatrixSavedMessagesSnapshot {
  records: MatrixSavedMessagePointer[]
  /** False for offline/unknown state or a record written by a newer/unreadable schema. */
  writable: boolean
}

interface MatrixSavedMessageAvailable extends MatrixSavedMessagePointer {
  available: true
  companyId: string
  roomName: string
  roomKind: 'channel' | 'conversation'
  senderName: string
  own: boolean
  body: string
  sentAt: number
  threadRootId?: string
}

interface MatrixSavedMessageUnavailable extends MatrixSavedMessagePointer {
  available: false
}

export type MatrixSavedMessageView = MatrixSavedMessageAvailable | MatrixSavedMessageUnavailable

export interface MatrixSavedMessageOpenResult {
  threadRootId?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pointer(value: unknown): MatrixSavedMessagePointer | null {
  if (!record(value)) {
    return null
  }

  return ROOM_ID.test(String(value.room_id)) &&
    EVENT_ID.test(String(value.event_id)) &&
    Number.isSafeInteger(value.saved_at) &&
    Number(value.saved_at) >= 0 &&
    Number(value.saved_at) <= MAX_DATE_MS
    ? {
        room_id: String(value.room_id),
        event_id: String(value.event_id),
        saved_at: Number(value.saved_at)
      }
    : null
}

/** Undefined means this account has never saved a message. Malformed/newer data is read-only. */
export function parseMatrixSavedMessages(value: unknown): MatrixSavedMessagesContent | null {
  if (value === undefined) {
    return { version: 1, messages: [] }
  }

  if (!record(value) || value.version !== 1 || !Array.isArray(value.messages) ||
    value.messages.length > MATRIX_SAVED_MESSAGES_MAX) {
    return null
  }

  const messages: MatrixSavedMessagePointer[] = []
  const seen = new Set<string>()

  for (const candidate of value.messages) {
    const parsed = pointer(candidate)
    const key = parsed ? `${parsed.room_id}\0${parsed.event_id}` : ''

    if (!parsed || seen.has(key)) {
      return null
    }

    seen.add(key)
    messages.push(parsed)
  }

  messages.sort((left, right) => right.saved_at - left.saved_at ||
    left.room_id.localeCompare(right.room_id) || left.event_id.localeCompare(right.event_id))

  return { version: 1, messages }
}

export function matrixSavedMessagesSnapshot(value: unknown, ready: boolean): MatrixSavedMessagesSnapshot {
  const parsed = parseMatrixSavedMessages(value)

  return {
    records: parsed?.messages ?? [],
    writable: ready && parsed !== null
  }
}

/** Pure list transition used by the SDK writer and behavior tests. */
export function updateMatrixSavedMessages(
  content: MatrixSavedMessagesContent,
  target: Pick<MatrixSavedMessagePointer, 'room_id' | 'event_id'>,
  saved: boolean,
  savedAt: number
): MatrixSavedMessagesContent {
  const key = `${target.room_id}\0${target.event_id}`
  const existing = content.messages.find(candidate => `${candidate.room_id}\0${candidate.event_id}` === key)

  if (saved && existing) {
    return content
  }

  const rest = content.messages.filter(candidate => `${candidate.room_id}\0${candidate.event_id}` !== key)

  const messages = saved
    ? [{ room_id: target.room_id, event_id: target.event_id, saved_at: savedAt }, ...rest]
        .slice(0, MATRIX_SAVED_MESSAGES_MAX)
    : rest

  return messages.length === content.messages.length && messages.every((candidate, index) =>
    candidate === content.messages[index])
    ? content
    : { version: 1, messages }
}
