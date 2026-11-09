import { type ComponentProps, useLayoutEffect, useRef } from 'react'

import { cn } from '@/lib/utils'

/** Set on the dock's parent: the dock's live height in px. The transcript's foot clearance and the
 * jump-to-bottom control read it, so the last message can always scroll fully above the composer. */
export const COMPOSER_DOCK_HEIGHT_VAR = '--atum-dock-height'

/** The composer's layer: above the transcript and its scroll edge (z-20), below the companion stage
 * (`PET_STAGE_Z` in pet/stage.tsx) and every layer that covers the chat (z-30 and up). The companion
 * walks the ground in front of the glass and springs onto its rim (pet/surface-model.ts): the glass
 * never hides her. */
export const COMPOSER_DOCK_Z = 24

/**
 * Everything under a chat's transcript (companion lane, notices, the composer) floats over the
 * foot of the column instead of sitting under it. The transcript runs to the column's bottom edge
 * and scrolls behind this dock, so the composer's glass has the conversation to blur. The dock
 * paints no plate of its own and lets the pointer through anywhere nothing of its own is drawn (the
 * margins either side of the composer still scroll the transcript). Beside it, at the same height, it keeps
 * an edge layer that paints nothing in a chat: the composer's own glass is the only softening (Atum Kit),
 * because a band the dock's height (the companion's lane included) reads as a ledge over the transcript.
 * Team Space's Slack layout paints that edge as solid ground under its pinned box.
 *
 * The parent must be the positioned column (the dock and its edge are siblings in it). The dock's height follows its content (a multi-line
 * draft, a staged file, a notice), published without a re-render as COMPOSER_DOCK_HEIGHT_VAR.
 */
export function ComposerDock({ children, className, ...props }: ComponentProps<'div'>) {
  const dock = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = dock.current
    const column = element?.parentElement

    if (!element || !column || typeof ResizeObserver === 'undefined') {
      return
    }

    const publish = (height: number) => column.style.setProperty(COMPOSER_DOCK_HEIGHT_VAR, `${Math.ceil(height)}px`)

    // The first delivery lands before paint, so the transcript never shows an unpadded frame.
    const observer = new ResizeObserver(entries => {
      const entry = entries.at(-1)

      publish(entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height)
    })

    observer.observe(element)

    return () => {
      observer.disconnect()
      column.style.removeProperty(COMPOSER_DOCK_HEIGHT_VAR)
    }
  }, [])

  return (
    <>
      {/* The dock edge: the dock's own height, under the dock and under the companion's layer. Invisible in a
          chat (styles.css); Team Space's Slack layout fills it as solid ground. The pet world ignores it. */}
      <div
        aria-hidden
        className={cn('pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[var(--atum-dock-height,0px)]', className)}
        data-matrix-dock-edge
      />
      <div
        {...props}
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 flex flex-col [&>*:not([data-matrix-pet])]:pointer-events-auto',
          className
        )}
        data-matrix-composer-dock
        ref={dock}
        style={{ zIndex: COMPOSER_DOCK_Z, ...props.style }}
      >
        {children}
      </div>
    </>
  )
}
