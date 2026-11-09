import type { ComponentProps, ReactNode } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { AlertTriangle, iconSize, Info } from '@/lib/icons'
import { cn } from '@/lib/utils'

// The single canonical error glyph (codicon's filled error mark). Use this
// everywhere an error is surfaced (boundaries, dialogs, banners) so failures
// read identically — one icon, one color, no background chip.
export function ErrorIcon({ className, size = '1.75rem' }: { className?: string; size?: string }) {
  return <Codicon className={cn('text-destructive', className)} name="error" size={size} />
}

/**
 * `failure` — the person asked for something and did not get it. Red is earned.
 * `notice` — a condition they did not ask about (found at startup, reported
 * while they were doing something else). Neutral ramp: announcing it is
 * honest, colouring it as an alarm is not.
 */
export type NoticeTone = 'failure' | 'notice'

export interface NoticeBandProps extends Omit<ComponentProps<'div'>, 'children' | 'role'> {
  children: ReactNode
  /**
   * Keep the live region mounted but visually hidden. A `role="alert"` element
   * that unmounts between failures is announced unreliably, so surfaces that
   * park an empty alert (the DM connect card) stay mounted and hide instead.
   */
  quiet?: boolean
  /**
   * `alert` interrupts, `status` waits its turn, absent announces nothing.
   * Deliberately undefaulted: whether a band is worth interrupting for is the
   * call site's judgement, not this component's.
   */
  role?: 'alert' | 'status'
  /** Only for a surface that deliberately moves focus here after a failure. */
  tone?: NoticeTone
}

/**
 * The one contained band for a failure or a condition — glyph column, tinted
 * fill, hairline, product radius. Replaces both the bare `--atum-danger`
 * paragraphs that had spread across the Atum shell and the Hermes-tinted box
 * this file used to ship, which reached the Atum shell anyway through the
 * group-room dialogs the roster opens.
 *
 * The palette is not a prop: `.notice-band` resolves every token through the
 * Atum ramp first and falls back to the Hermes ramp, so the same element is
 * Atum red inside `.atum-shell` (and inside the Atum-scoped portalled dialogs)
 * and Hermes red on the legacy chrome.
 *
 * This is for a failure that annotates no single control. A validation message
 * bound to one field belongs under that field as plain text — a band there
 * competes with the input it is describing.
 */
export function NoticeBand({
  children,
  className,
  quiet = false,
  role,
  tone = 'failure',
  ...props
}: NoticeBandProps) {
  if (quiet) {
    return (
      <div {...props} className={cn('sr-only', className)} role={role}>
        {children}
      </div>
    )
  }

  const Glyph = tone === 'failure' ? AlertTriangle : Info

  return (
    <div {...props} className={cn('notice-band', className)} data-tone={tone} role={role}>
      <Glyph aria-hidden className={cn('mt-0.5 shrink-0', iconSize.md)} />
      <span className="min-w-0 whitespace-pre-wrap break-words">{children}</span>
    </div>
  )
}

/**
 * Inline error banner for detail panes (born in Messaging's platform error, now
 * shared with the MCP config pane). Kept as the name those call sites already
 * import; the look is `NoticeBand`'s.
 * For centered full-surface failures use ErrorState below instead.
 */
export function ErrorBanner({ children, className }: { children: ReactNode; className?: string }) {
  return <NoticeBand className={className}>{children}</NoticeBand>
}

export interface ErrorStateProps {
  /** Optional actions row/stack rendered below the copy. */
  children?: ReactNode
  className?: string
  description?: ReactNode
  /** Defaults to a destructive AlertCircle. */
  icon?: ReactNode
  title: ReactNode
}

// Shared, presentation-only error layout: the canonical ErrorIcon (no bg chip)
// over a centered title + body, with an optional actions stack. Used by the
// React error boundary, the in-dialog update error, and the boot-failure banner
// so every failure reads the same. Title/description accept nodes so Radix
// Dialog callers can pass DialogTitle/DialogDescription for accessibility.
export function ErrorState({ children, className, description, icon, title }: ErrorStateProps) {
  return (
    <div className={cn('grid gap-5', className)}>
      <div className="flex flex-col items-center gap-1.5 text-center">
        {/* Atum Kit 0.1 state: the glyph sits in a quiet circle, then a headline and one line. */}
        <div className="ak-state-mark">{icon ?? <ErrorIcon size="1.5rem" />}</div>

        {typeof title === 'string' ? <h2 className="ak-state-title">{title}</h2> : title}

        {typeof description === 'string' ? (
          <p className="ak-state-body">{description}</p>
        ) : (
          description
        )}
      </div>

      {children && <div className="grid gap-2">{children}</div>}
    </div>
  )
}
