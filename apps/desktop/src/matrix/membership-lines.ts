import { EventType, type MatrixEvent, type Room } from 'matrix-js-sdk'

import type { MatrixMembershipLine } from '../../shared/matrix'

import { companyChannelBinding } from './message'

/** A display name as an event gave it: text, trimmed and bounded, or nothing. */
function eventName(content: Record<string, unknown>): string | undefined {
  const name = typeof content.displayname === 'string' ? content.displayname.trim() : ''

  return name ? name.slice(0, 256) : undefined
}

/**
 * What one `m.room.member` event says about the channel: someone came in, or someone who was in
 * is no longer. Everything else is not news in a transcript and gets no line: an invitation
 * (the person is not in yet), a declined or withdrawn invitation, an unban, a profile change of
 * someone already in (join to join) and the room manager's own account.
 *
 * A leave or ban counts only when the event itself says the person was in (its previous
 * membership is `join`), so an event without that is no line rather than a guess.
 */
export function matrixMembershipLine(
  event: MatrixEvent,
  managerUserId: string,
  ignored: ReadonlySet<string>
): MatrixMembershipLine | null {
  const userId = event.getStateKey()
  const id = event.getId()

  if (event.getType() !== EventType.RoomMember || !userId || !id || event.isRedacted()) {
    return null
  }

  if (userId === managerUserId || ignored.has(userId)) {
    return null
  }

  const content = event.getContent()
  const previous = event.getPrevContent()
  const membership = content.membership
  const before = previous.membership

  const kind =
    membership === 'join' && before !== 'join'
      ? ('joined' as const)
      : (membership === 'leave' || membership === 'ban') && before === 'join'
        ? ('departed' as const)
        : undefined

  if (!kind) {
    return null
  }

  const name = eventName(content) ?? eventName(previous)

  return { id, timestamp: event.getTs(), kind, userId, ...(name ? { name } : {}) }
}

/**
 * The joins and departures among a Team Space channel room's loaded timeline, oldest first. A
 * room that does not carry the platform's channel binding gets none: Matrix membership in an
 * ordinary chat is not a transcript line.
 */
export function matrixMembershipLines(
  room: Room,
  events: readonly MatrixEvent[],
  ignored: ReadonlySet<string>
): MatrixMembershipLine[] {
  const binding = companyChannelBinding(room)

  if (!binding) {
    return []
  }

  return events.flatMap(event => {
    const line = matrixMembershipLine(event, binding.managerUserId, ignored)

    return line ? [line] : []
  })
}
