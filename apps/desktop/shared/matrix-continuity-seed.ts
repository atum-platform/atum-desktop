/**
 * Matrix-history continuity for a new Hermes session (moved here from
 * `electron/matrix/continuity.ts` so the cloud controller, which never bundles Electron code,
 * resumes and seeds conversations by the same rules as the Mac; S1 build plan §4 WS-2).
 *
 * Visible dialogue only: never a memory, tool, authority or session-sync protocol.
 */
import { matrixRoomTextTooLong } from './matrix'
import {
  MATRIX_CONTINUITY,
  type MatrixContinuityRead,
  type MatrixContinuityTarget,
  type MatrixConversationWitness,
  type MatrixHistorySeed
} from './matrix-continuity'

export function conversationWitness(value: unknown): MatrixConversationWitness | undefined {
  const item = value as MatrixConversationWitness | undefined

  return item &&
    (item.anchor === undefined || (typeof item.anchor === 'string' && item.anchor.startsWith('$'))) &&
    Array.isArray(item.ours) &&
    item.ours.length <= MATRIX_CONTINUITY.ours &&
    item.ours.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)
    ? { ...(item.anchor ? { anchor: item.anchor } : {}), ours: [...item.ours] }
    : undefined
}

/** Late own publications must not hide a foreign answer between the anchor and
 * the tail. Compare the whole witnessed interval, not just its newest answer. */
export function canResumeConversation(
  witness: MatrixConversationWitness | undefined,
  read: MatrixContinuityRead
): boolean {
  return Boolean(
    witness &&
    read.reachedStop &&
    !read.uncertainAgent &&
    (!witness.anchor || read.entries.some(entry => entry.eventId === witness.anchor)) &&
    read.entries.every(
      entry =>
        entry.role !== 'assistant' ||
        (entry.invocationId && witness.ours.includes(entry.invocationId)) ||
        entry.eventId === witness.anchor
    )
  )
}

export function readContinuityResult(value: unknown, expected: MatrixContinuityTarget): MatrixContinuityRead {
  const read = value as MatrixContinuityRead

  if (
    !read ||
    read.roomId !== expected.roomId ||
    read.ownerId !== expected.ownerId ||
    read.agentId !== expected.agentId ||
    typeof read.reachedStop !== 'boolean' ||
    typeof read.uncertainAgent !== 'boolean' ||
    (read.clipped !== undefined && (read.clipped !== true || !expected.bounded || read.reachedStop)) ||
    !Number.isSafeInteger(read.gaps) ||
    read.gaps < 0 ||
    read.gaps > MATRIX_CONTINUITY.pages * MATRIX_CONTINUITY.pageSize ||
    !Array.isArray(read.entries) ||
    read.entries.length > MATRIX_CONTINUITY.pages * MATRIX_CONTINUITY.pageSize ||
    read.entries.some(
      entry =>
        !entry ||
        typeof entry.eventId !== 'string' ||
        !entry.eventId.startsWith('$') ||
        entry.eventId === expected.before ||
        !['user', 'assistant'].includes(entry.role) ||
        typeof entry.text !== 'string' ||
        !entry.text.trim() ||
        matrixRoomTextTooLong(entry.text) ||
        (entry.invocationId !== undefined &&
          (entry.role !== 'assistant' ||
            typeof entry.invocationId !== 'string' ||
            !entry.invocationId ||
            entry.invocationId.length > 128))
    ) ||
    new Set(read.entries.map(entry => entry.eventId)).size !== read.entries.length
  ) {
    throw new Error('matrix_continuity_unavailable')
  }

  return read
}

export function conversationAnchor(read: MatrixContinuityRead): string | undefined {
  return read.entries.find(entry => entry.role === 'assistant' && entry.invocationId)?.eventId
}

/** Input has already passed readContinuityResult. Never log dialogue or IDs. */
export function continuityDiagnostic(read: MatrixContinuityRead): string | undefined {
  return read.gaps || !read.reachedStop
    ? `[Matrix] conversation history partial: verified=${read.entries.length}, gaps=${read.gaps}, bounded=${!read.reachedStop}`
    : undefined
}

/** Only completed dialogue enters the new session. No trailing unanswered
 * requests, system roles, tools, media or synthetic history instructions. */
export function conversationSeed(read: Pick<MatrixContinuityRead, 'entries'>): MatrixHistorySeed {
  const end = read.entries.findIndex(entry => entry.role === 'assistant')

  if (end < 0) {
    return []
  }

  const result: MatrixHistorySeed = []

  for (const entry of read.entries.slice(end).reverse()) {
    if (!result.length && entry.role === 'assistant') {
      continue
    }

    const previous = result.at(-1)

    if (previous?.role === entry.role) {
      previous.content += `\n\n${entry.text}`
    } else {
      result.push({ role: entry.role, content: entry.text })
    }
  }

  let size = result.reduce((sum, entry) => sum + entry.content.length, 0)

  while (result.length > MATRIX_CONTINUITY.messages || size > MATRIX_CONTINUITY.chars) {
    size -= result.shift()!.content.length
  }

  if (result[0]?.role === 'assistant') {
    result.shift()
  }

  return result
}

export function validHistorySeed(value: unknown): value is MatrixHistorySeed {
  return (
    Array.isArray(value) &&
    value.length <= MATRIX_CONTINUITY.messages &&
    value.every(
      entry =>
        entry &&
        (entry.role === 'user' || entry.role === 'assistant') &&
        typeof entry.content === 'string' &&
        entry.content.trim().length > 0
    ) &&
    value.reduce((sum, entry) => sum + entry.content.length, 0) <= MATRIX_CONTINUITY.chars &&
    (!value.length || (value[0].role === 'user' && value.at(-1)?.role === 'assistant'))
  )
}
