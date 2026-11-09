import type * as React from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { iconSize, RosetteCheck, RosetteCheckFilled } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { VerificationTier } from '../../shared/verification'
import { founderCopy } from '../matrix/founder/founder-copy'

export interface VerifiedMarkProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /** The tier from its one source: an account's from the official accounts, an app's from its
   * descriptor, a bot's from its app. Anything else renders nothing. */
  tier: VerificationTier | null | undefined
  /** The label's wording; default an account. */
  subject?: 'account' | 'app'
  /** 12, 14 or 16 px; default 14 (roster rows, headers, cards, member lists). */
  size?: 'xs' | 'sm' | 'md'
  /** A tip with the label; default on. */
  tip?: boolean
}

/**
 * The verification mark, inline after a name: `official` is a filled check in full ink (run by
 * Atum), `verified` a hollow one in muted ink (verified by Atum), anything else nothing. Never a
 * chip, never the accent colour, never in a message body or a notification. It is the only
 * place the rosette glyphs (src/lib/icons.ts) are drawn: nothing else draws a verification tick.
 */
export function VerifiedMark({
  className,
  size = 'sm',
  subject = 'account',
  tier,
  tip = true,
  ...props
}: VerifiedMarkProps) {
  const { locale } = useI18n()

  if (tier !== 'official' && tier !== 'verified') {
    return null
  }

  const copy = founderCopy(locale)
  const label = tier === 'verified' ? copy.verified : subject === 'app' ? copy.officialApp : copy.officialAccount
  const Glyph = tier === 'official' ? RosetteCheckFilled : RosetteCheck

  const mark = (
    <span
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center',
        tier === 'official' ? 'text-(--atum-ink)' : 'text-(--atum-ink-muted)',
        className
      )}
      data-verified-mark={tier}
      role="img"
      {...props}
    >
      <Glyph aria-hidden className={iconSize[size]} />
    </span>
  )

  return tip ? <Tip label={label}>{mark}</Tip> : mark
}
