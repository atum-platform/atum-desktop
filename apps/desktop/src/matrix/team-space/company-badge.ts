import type { MatrixRoom } from '../../../shared/matrix'
import type { MatrixRosterBadge } from '../roster-preview'

/**
 * The one badge rule for a company, on the left rail's tiles and the company menu's rows. The phone's
 * company sheet mirrors it from the vectors in `company-badge.test.ts`:
 *
 * - a mention is a number, printed `99+` past 99;
 * - anything else unread is a quiet dot;
 * - the company on screen shows neither (its own channels already say what is waiting).
 */
export interface CompanyUnread {
  /** Mentions and keywords across the company's channels. */
  mentions: number
  /** Something else is waiting: messages not read yet, or a channel marked unread. */
  unread: boolean
}

/** What a company's channel rooms add up to. A muted channel counts only its mentions. */
export function companyUnread(rooms: readonly MatrixRoom[], companyId: string): CompanyUnread {
  let mentions = 0
  let unread = false

  for (const room of rooms) {
    // A channel or a company conversation (a company DM or group DM): both are this company's unread.
    if (room.membership !== 'join' || (room.companyChannel?.companyId ?? room.companyConversation?.companyId) !== companyId) {
      continue
    }

    mentions += Math.max(0, room.highlights ?? 0)

    if (!room.muted && (room.unread || room.markedUnread || (room.unreadNotifications ?? 0) > 0)) {
      unread = true
    }
  }

  return { mentions, unread }
}

/** The badge for a company, drawn by the same `RosterBadge` as the chat list. */
export function companyBadge(counts: CompanyUnread, active = false): MatrixRosterBadge {
  if (active) {
    return null
  }

  if (counts.mentions > 0) {
    return { kind: 'mention', count: counts.mentions }
  }

  return counts.unread ? { kind: 'dot', tone: 'activity' } : null
}
