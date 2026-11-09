import { type MatrixEvent, RelationType, type Room } from 'matrix-js-sdk'

import { canMentionMatrixRoom } from './conversations'
import { shownContent } from './message'

export type MatrixAttentionKind = 'mention' | 'thread_reply'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function matrixEventThreadRoot(event: MatrixEvent): string | undefined {
  const relation = record(event.getWireContent()['m.relates_to']) ??
    record(event.getOriginalContent()['m.relates_to'])

  return relation?.rel_type === RelationType.Thread && typeof relation.event_id === 'string'
    ? relation.event_id
    : undefined
}

/** The Activity inbox and notification gate share this exact intentional-mention rule. */
export function matrixEventMentionsViewer(event: MatrixEvent, room: Room, userId: string): boolean {
  const mentions = record(shownContent(event).content['m.mentions'])
  const direct = Array.isArray(mentions?.user_ids) && mentions.user_ids.includes(userId)
  const sender = event.getSender()

  return direct || Boolean(
    mentions?.room === true && sender && canMentionMatrixRoom(room, sender)
  )
}

/** Mentions include direct/@channel intent plus replies in a thread this account started or joined. */
export function matrixEventAttentionKind(
  event: MatrixEvent,
  room: Room,
  userId: string
): MatrixAttentionKind | undefined {
  if (matrixEventMentionsViewer(event, room, userId)) {
    return 'mention'
  }

  const rootId = matrixEventThreadRoot(event)
  if (!rootId) {
    return undefined
  }

  const thread = room.getThread(rootId)
  const root = room.findEventById(rootId) ?? thread?.rootEvent
  const participated = root?.getSender() === userId ||
    thread?.hasCurrentUserParticipated ||
    thread?.events.some(candidate => candidate.getSender() === userId)

  return participated ? 'thread_reply' : undefined
}
