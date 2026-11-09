import type * as React from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Star } from '@/lib/icons'
import { cn } from '@/lib/utils'

export interface MainAgentBadgeProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  tip?: boolean
}

/**
 * Presentation of the canonical `isDefault` role. This component never infers or grants
 * Main authority; callers render it only from the authenticated roster projection.
 */
export function MainAgentBadge({ className, tip = true, ...props }: MainAgentBadgeProps) {
  const { t } = useI18n()
  const label = t.matrixShell.mainAgent
  const badge = (
    <span
      aria-label={label}
      // Ink, not amber: colour is for warnings only (Atum Kit 0.1).
      className={cn('inline-flex shrink-0 items-center text-(--atum-ink-muted)', className)}
      data-main-agent-badge
      role="img"
      {...props}
    >
      <Star aria-hidden className="size-3.5 fill-current" />
    </span>
  )

  return tip ? <Tip label={label}>{badge}</Tip> : badge
}
