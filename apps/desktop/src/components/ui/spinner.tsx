import type { IconProps } from '@tabler/icons-react'
import { forwardRef } from 'react'

import { cn } from '@/lib/utils'

export interface SpinnerProps extends IconProps {
  /** Announce the wait: renders role="status" with this accessible name. Omit it for a decorative glyph. */
  label?: string
  /** Progress, 0-100: the same ring drawn determinate (an arc that grows from the top), not spinning. */
  value?: number | null
}

/**
 * The one loading glyph: a ring with a 15% track and a quarter arc in currentColor.
 * Drop-in for Tabler `Loader2` (exported under that name from `lib/icons.ts`), so
 * call sites keep their `animate-spin` and size classes. Replaces codicon `loading`,
 * inline curve `Loader`s at 20px and under, and `GlyphSpinner` outside the terminal.
 */
export const Spinner = forwardRef<SVGSVGElement, SpinnerProps>(function Spinner(
  { className, label, size = 24, stroke: _stroke, title, value, ...props },
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
      {value === undefined ? (
        <path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" />
      ) : (
        // At 0 the path is empty: a zero-length subpath would draw a round-cap dot.
        <path d={progressArc(progress(value))} data-spinner-value={Math.round(progress(value))} />
      )}
    </svg>
  )
})

/** The arc from twelve o'clock, clockwise, for a share of the ring (a path, so no dashes under non-scaling stroke). */
function progressArc(percent: number): string {
  if (percent <= 0) {return ''}

  if (percent >= 100) {return 'M12 3.5A8.5 8.5 0 1 1 12 20.5A8.5 8.5 0 1 1 12 3.5'}
  const angle = (percent / 100) * 2 * Math.PI
  const x = (12 + 8.5 * Math.sin(angle)).toFixed(3)
  const y = (12 - 8.5 * Math.cos(angle)).toFixed(3)

  return `M12 3.5A8.5 8.5 0 ${percent > 50 ? 1 : 0} 1 ${x} ${y}`
}

function progress(value: number | null): number {
  return value === null || !Number.isFinite(value) ? 0 : Math.min(100, Math.max(0, value))
}
