import type { KeyboardEventHandler, ReactNode } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { cn } from '@/lib/utils'

export interface AuthFrameProps {
  brand?: ReactNode
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** Pinned under the content, at the foot of the window: quiet fine print. */
  aside?: ReactNode
  /** `top` pins the column a fixed distance under the title bar, so a notice that appears
   * pushes only what is below it; `center` (the default) centres it in the window. */
  align?: 'center' | 'top'
  /** Centre the column's text and controls too (Atum Kit sign-in board), not only the column. */
  centred?: boolean
  exiting?: boolean
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
}

/** Pure Atum authentication material; callers keep all account and window authority. */
export function AuthFrame({
  align = 'center',
  aside,
  brand,
  centred = false,
  children,
  description,
  exiting = false,
  footer,
  onKeyDown,
  title
}: AuthFrameProps) {
  return (
    <div
      className="atum-shell flex h-dvh min-h-0 flex-col atum-window-ground text-(--atum-ink) [-webkit-app-region:drag]"
      data-atum-auth
      onKeyDown={onKeyDown}
    >
      {/* Native traffic lights sit at 18/18 in the compact window. */}
      <div aria-hidden className="h-[1.875rem] shrink-0" data-atum-auth-lights />
      <main
        className="atum-auth-contents flex min-h-0 flex-1 flex-col overflow-y-auto px-11 pb-3 [-webkit-app-region:no-drag]"
        data-atum-motion={exiting ? 'exiting' : 'open'}
        data-pet-stage
      >
        {/* The compact window's column (460 - 2 x 44): a window that could not shrink,
            such as one still in full screen, keeps the form this size instead of
            stretching it across the screen. */}
        <div
          className={cn(
            'mx-auto w-full max-w-[23.25rem]',
            align === 'top' ? 'mt-[clamp(1.5rem,11dvh,5.5rem)] mb-auto' : 'my-auto',
            centred && 'flex flex-col items-center text-center'
          )}
          data-atum-auth-align={align}
        >
          {brand ?? <BrandMark className="size-10 rounded-[var(--atum-r-sidebar)]" />}
          <h1 className="atum-auth-heading mt-2 w-full text-(length:--atum-t-display) leading-(--atum-lh-display) font-semibold tracking-[-0.02em] text-(--atum-ink)">
            {title}
          </h1>
          {description && (
            <p className="mt-1 w-full text-[0.875rem] leading-[1.5] text-(--atum-ink-muted) text-pretty">{description}</p>
          )}
          {children}
          {footer}
        </div>
        {aside && (
          <div
            className={cn('mx-auto w-full max-w-[23.25rem] shrink-0 pt-6 pb-1.5', centred && 'text-center')}
            data-atum-auth-aside
          >
            {aside}
          </div>
        )}
      </main>
    </div>
  )
}
