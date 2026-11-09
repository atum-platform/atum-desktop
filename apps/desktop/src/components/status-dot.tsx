import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/** `good` is kept as an alias of `live` so existing call sites compile unchanged. */
export type StatusTone = 'idle' | 'live' | 'good' | 'muted' | 'warn' | 'bad'

const TONE_BG: Record<StatusTone, string> = {
  idle: 'bg-(--atum-ink-faint)',
  muted: 'bg-(--atum-ink-faint)',
  live: 'bg-(--atum-ink)',
  good: 'bg-(--atum-ink)',
  warn: 'bg-(--atum-warn)',
  bad: 'bg-(--atum-danger)'
}

interface StatusDotProps extends ComponentProps<'span'> {
  tone: StatusTone
}

/** 6px dot. Monochrome except warn / bad, which use the Atum status tokens. */
export function StatusDot({ className, tone, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE_BG[tone], className)}
      {...props}
    />
  )
}
