import type { IconProps } from '@tabler/icons-react'
import { forwardRef } from 'react'

import { cn } from '@/lib/utils'

export interface SpinnerProps extends IconProps {
  /** Announce the wait: renders role="status" with this accessible name. Omit it for a decorative glyph. */
  label?: string
}

/**
 * The one loading glyph: a ring with a 15% track and a quarter arc in currentColor.
 * Drop-in for Tabler `Loader2` (exported under that name from `lib/icons.ts`), so
 * call sites keep their `animate-spin` and size classes. Replaces codicon `loading`,
 * inline curve `Loader`s at 20px and under, and `GlyphSpinner` outside the terminal.
 */
export const Spinner = forwardRef<SVGSVGElement, SpinnerProps>(function Spinner(
  { className, label, size = 24, stroke: _stroke, title, ...props },
  ref
) {
  const named = Boolean(label || title)

  return (
    <svg
      aria-hidden={named ? undefined : true}
      aria-label={label}
      className={cn('tabler-icon atum-spinner', className)}
      fill="none"
      height={size}
      ref={ref}
      role={label ? 'status' : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="8.5" strokeOpacity={0.15} />
      <path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" />
    </svg>
  )
})
