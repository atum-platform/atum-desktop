import { cn } from '@/lib/utils'

import { useChatCopy } from './chat-copy'
import { useReadStateCopy } from './read-state-copy'
import { useRosterCopy } from './roster-copy'
import { type MatrixRosterBadge, matrixRosterBadgeCount } from './roster-preview'

/**
 * Element's badge, in Atum's ink: a mention is the strong badge (danger, with the count), a
 * notification count is the ink pill, a chat you marked unread is an ink dot and messages
 * that did not notify (a muted chat) are a quieter dot. Capped at 99+.
 */
export function RosterBadge({ badge, id }: { badge: MatrixRosterBadge; id?: string }) {
  const read = useReadStateCopy()
  const roster = useRosterCopy()
  const chat = useChatCopy()

  if (!badge) {
    return null
  }

  if (badge.kind === 'dot') {
    return (
      <span
        className="grid h-(--atum-unread-pill) w-(--atum-unread-pill) shrink-0 place-items-center"
        data-roster-unread={badge.tone}
        id={id}
      >
        <span
          aria-hidden
          className={cn('size-2 rounded-full', badge.tone === 'marked' ? 'bg-(--atum-ink)' : 'bg-(--atum-ink-faint)')}
        />
        <span className="sr-only">{badge.tone === 'marked' ? chat.markedUnread : roster.newMessages}</span>
      </span>
    )
  }

  const label = `${badge.kind === 'mention' ? roster.mentions : read.notifications}: ${badge.count}`

  return (
    <span
      aria-label={label}
      className={cn(
        'grid h-(--atum-unread-pill) min-w-(--atum-unread-pill) shrink-0 place-items-center rounded-full px-1.5 text-(length:--atum-t-label) leading-none font-semibold tabular-nums text-(--atum-on-accent)',
        badge.kind === 'mention' ? 'bg-(--atum-danger)' : 'bg-(--atum-ink)'
      )}
      data-roster-unread={badge.kind}
      id={id}
    >
      <span aria-hidden>{matrixRosterBadgeCount(badge.count)}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
