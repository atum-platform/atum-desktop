import { useId } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { Activity } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { RosterBadge } from '../roster-badge'
import type { MatrixRosterBadge } from '../roster-preview'

export interface ActivityButtonProps {
  label: string
  /** Mentions are a red count, anything else unread a quiet dot (the company badge rule). */
  badge: MatrixRosterBadge
  selected: boolean
  disabled?: boolean
  onOpen(): void
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function ActivityButton({ badge, disabled = false, label, onOpen, selected }: ActivityButtonProps) {
  const badgeId = useId()

  return (
    <Tip label={label}>
      <button
        aria-describedby={badge ? badgeId : undefined}
        aria-label={label}
        aria-pressed={selected}
        className={cn(
          'ak-iconbtn ak-iconbtn--sm relative shrink-0',
          selected && 'bg-(--ak-fill-press) text-(--ak-ink)'
        )}
        data-matrix-company-activity-button
        data-selected={selected || undefined}
        disabled={disabled}
        onClick={onOpen}
        type="button"
      >
        <Activity aria-hidden className="ak-icon ak-icon--sm" />
        {badge && (
          <span
            className={cn(
              'pointer-events-none absolute',
              badge.kind === 'dot' ? '-top-0.5 -end-0.5' : '-top-1.5 -end-1.5 rounded-full ring-2 ring-(--atum-roster-bg)'
            )}
          >
            <RosterBadge badge={badge} id={badgeId} />
          </span>
        )}
      </button>
    </Tip>
  )
}
