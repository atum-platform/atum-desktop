export const MATRIX_DRAFTS_ACCOUNT_DATA = 'com.atum.drafts'
export const MATRIX_DRAFT_ACCOUNT_DATA_PREFIX = 'com.atum.draft.v2.'
export const MATRIX_DRAFTS_MAX = 200
export const MATRIX_DRAFT_TEXT_MAX_BYTES = 16 * 1024

const ROOM_ID = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
const EVENT_ID = /^\$[!-~]{1,1023}$/u
const MAX_DATE_MS = 8_640_000_000_000_000

export interface MatrixDraftTarget {
  roomId: string
  threadRootId?: string
}

export interface MatrixDraftRecord {
  room_id: string
  thread_root_id?: string
  text: string
  updated_at: number
}

/** Private per-user Matrix account data. Entries are newest first and bounded. */
export interface MatrixDraftsContent {
  version: 1
  drafts: MatrixDraftRecord[]
}

/** One independently writable target. Empty text is a tombstone, not absence. */
export interface MatrixDraftTargetContent {
  version: 2
  revision: number
  expected_revision: number
  target: MatrixDraftRecord
}

export interface MatrixDraftsSnapshot {
  records: MatrixDraftRecord[]
  /** False while offline/unknown or when a newer/unreadable schema is present. */
  writable: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function utf8Bytes(character: string): number {
  const point = character.codePointAt(0) ?? 0

  return point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
}

/** Keep account data bounded without splitting a Unicode scalar. The local composer remains uncut. */
export function boundedMatrixDraftText(value: string): string {
  let bytes = 0
  let text = ''

  for (const character of value) {
    const next = utf8Bytes(character)

    if (bytes + next > MATRIX_DRAFT_TEXT_MAX_BYTES) {
      break
    }

    bytes += next
    text += character
  }

  return text
}

export function matrixDraftKey(target: MatrixDraftTarget): string {
  return `${target.roomId}\0${target.threadRootId ?? ''}`
}

function parseDraft(value: unknown): MatrixDraftRecord | null {
  if (!record(value)) {
    return null
  }

  const roomId = String(value.room_id)
  const threadRootId = value.thread_root_id === undefined ? undefined : String(value.thread_root_id)
  const text = typeof value.text === 'string' ? value.text : ''
  const updatedAt = Number(value.updated_at)

  if (
    !ROOM_ID.test(roomId) ||
    (threadRootId !== undefined && !EVENT_ID.test(threadRootId)) ||
    !text ||
    boundedMatrixDraftText(text) !== text ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    updatedAt > MAX_DATE_MS
  ) {
    return null
  }

  return {
    room_id: roomId,
    ...(threadRootId ? { thread_root_id: threadRootId } : {}),
    text,
    updated_at: updatedAt
  }
}

/** Strict per-target record. A tombstone has empty text and still suppresses legacy data. */
export function parseMatrixDraftTarget(value: unknown): MatrixDraftTargetContent | null {
  if (!record(value) || value.version !== 2) {
    return null
  }

  const revision = Number(value.revision)
  const expectedRevision = Number(value.expected_revision)
  const target = record(value.target) ? value.target : null

  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision !== revision - 1 ||
    !target
  ) {
    return null
  }

  const roomId = String(target.room_id)
  const threadRootId = target.thread_root_id === undefined ? undefined : String(target.thread_root_id)
  const text = typeof target.text === 'string' ? target.text : ''
  const updatedAt = Number(target.updated_at)

  if (
    !ROOM_ID.test(roomId) ||
    (threadRootId !== undefined && !EVENT_ID.test(threadRootId)) ||
    boundedMatrixDraftText(text) !== text ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    updatedAt > MAX_DATE_MS
  ) {
    return null
  }

  return {
    version: 2,
    revision,
    expected_revision: expectedRevision,
    target: {
      room_id: roomId,
      ...(threadRootId ? { thread_root_id: threadRootId } : {}),
      text,
      updated_at: updatedAt
    }
  }
}

/** Merge target records over the legacy aggregate while old clients still exist. */
export function mergeMatrixDraftTargets(
  legacy: MatrixDraftsContent | null,
  targets: readonly MatrixDraftTargetContent[]
): MatrixDraftsContent | null {
  if (!legacy && targets.length === 0) {
    return null
  }

  const byTarget = new Map<string, MatrixDraftRecord>()

  for (const draft of legacy?.drafts ?? []) {
    byTarget.set(matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id }), draft)
  }

  for (const entry of targets) {
    const draft = entry.target
    const key = matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id })

    if (draft.text) {
      byTarget.set(key, draft)
    } else {
      byTarget.delete(key)
    }
  }

  return {
    version: 1,
    drafts: [...byTarget.values()]
      .sort(
        (left, right) =>
          right.updated_at - left.updated_at ||
          left.room_id.localeCompare(right.room_id) ||
          (left.thread_root_id ?? '').localeCompare(right.thread_root_id ?? '')
      )
      .slice(0, MATRIX_DRAFTS_MAX)
  }
}

/** Undefined means this account has never saved a draft. Malformed/newer data is read-only. */
export function parseMatrixDrafts(value: unknown): MatrixDraftsContent | null {
  if (value === undefined) {
    return { version: 1, drafts: [] }
  }

  if (!record(value) || value.version !== 1 || !Array.isArray(value.drafts) || value.drafts.length > MATRIX_DRAFTS_MAX) {
    return null
  }

  const drafts: MatrixDraftRecord[] = []
  const seen = new Set<string>()

  for (const candidate of value.drafts) {
    const parsed = parseDraft(candidate)
    const key = parsed ? matrixDraftKey({ roomId: parsed.room_id, threadRootId: parsed.thread_root_id }) : ''

    if (!parsed || seen.has(key)) {
      return null
    }

    seen.add(key)
    drafts.push(parsed)
  }

  drafts.sort(
    (left, right) =>
      right.updated_at - left.updated_at ||
      left.room_id.localeCompare(right.room_id) ||
      (left.thread_root_id ?? '').localeCompare(right.thread_root_id ?? '')
  )

  return { version: 1, drafts }
}

export function matrixDraftsSnapshot(value: unknown, ready: boolean): MatrixDraftsSnapshot {
  const parsed = parseMatrixDrafts(value)

  return { records: parsed?.drafts ?? [], writable: ready && parsed !== null }
}

export function matrixDraftText(snapshot: MatrixDraftsSnapshot | undefined, target: MatrixDraftTarget): string {
  const key = matrixDraftKey(target)

  return snapshot?.records.find(draft =>
    matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id }) === key
  )?.text ?? ''
}

/** Pure transition used by the SDK writer and behavior tests. Empty text clears the target. */
export function updateMatrixDrafts(
  content: MatrixDraftsContent,
  target: MatrixDraftTarget,
  text: string,
  updatedAt: number
): MatrixDraftsContent {
  const key = matrixDraftKey(target)
  const bounded = boundedMatrixDraftText(text)
  const existing = content.drafts.find(draft =>
    matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id }) === key
  )

  if (existing?.text === bounded) {
    return content
  }

  const rest = content.drafts.filter(draft =>
    matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id }) !== key
  )

  const drafts = bounded
    ? [
        {
          room_id: target.roomId,
          ...(target.threadRootId ? { thread_root_id: target.threadRootId } : {}),
          text: bounded,
          updated_at: updatedAt
        },
        ...rest
      ].slice(0, MATRIX_DRAFTS_MAX)
    : rest

  return drafts.length === content.drafts.length && drafts.every((draft, index) => draft === content.drafts[index])
    ? content
    : { version: 1, drafts }
}

/** Remove drafts whose audience is no longer a currently joined Team space room. */
export function pruneMatrixDrafts(content: MatrixDraftsContent, joinedRoomIds: ReadonlySet<string>): MatrixDraftsContent {
  const drafts = content.drafts.filter(draft => joinedRoomIds.has(draft.room_id))

  return drafts.length === content.drafts.length ? content : { version: 1, drafts }
}
