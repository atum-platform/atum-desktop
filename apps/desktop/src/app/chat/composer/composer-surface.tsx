import type { ReactNode, Ref } from 'react'

import { composerFill, composerSurfaceGlass } from '@/components/chat/composer-dock'
import { cn } from '@/lib/utils'

export interface ComposerSurfaceProps {
  /** Content adjacent to, but not inside, the pill (for example a utility card). */
  before?: ReactNode
  /** Content above the input fade, such as a coding-status row. */
  children?: ReactNode
  top?: ReactNode
  leading?: ReactNode
  input: ReactNode
  actions?: ReactNode
  bottom?: ReactNode
  stacked?: boolean
  /**
   * `t3`: T3 Code's composer (pingdotgg/t3code v0.1.11 ComposerSurface + ChatComposer, vendored in
   * packages/atum-kit/t3/): the editor above a footer row, leading controls left, actions right.
   * styles.css ("T3 composer") paints it from T3's own variables.
   */
  recipe?: 'atum' | 't3'
  faded?: boolean
  className?: string
  contentClassName?: string
  surfaceRef?: Ref<HTMLDivElement>
}

/** Shared floating Atum composer material. Callers own inputs, controls, and actions. */
export function ComposerSurface({
  actions,
  before,
  bottom,
  children,
  className,
  contentClassName,
  faded = false,
  input,
  leading,
  recipe = 'atum',
  stacked = false,
  surfaceRef,
  top
}: ComposerSurfaceProps) {
  return (
    <div className="relative w-full rounded-[inherit]">
      {before}
      <div
        className={cn(
          'group/composer-surface relative z-4 isolate grid grid-rows-[auto_1fr] overflow-hidden rounded-[inherit] border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))]',
          className
        )}
        data-composer-recipe={recipe === 't3' ? 't3' : undefined}
        data-slot="composer-surface"
        ref={surfaceRef}
      >
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 -z-10 rounded-[inherit]',
            composerFill,
            composerSurfaceGlass
          )}
          data-slot="composer-fill"
        />
        {children}
        <div
          className={cn(
            'relative z-1 flex min-h-0 w-full flex-col gap-(--composer-row-gap) overflow-hidden rounded-[inherit] px-(--composer-surface-pad-x) py-(--composer-surface-pad-y) transition-opacity duration-200 ease-out',
            faded
              ? 'opacity-30 group-hover/composer:opacity-100 group-focus-within/composer-surface:opacity-100'
              : 'opacity-100',
            contentClassName
          )}
          data-slot="composer-fade"
        >
          {recipe === 't3' ? (
            <>
              {top && <div data-slot="composer-top">{top}</div>}
              <div className="min-w-0" data-slot="composer-body">
                {input}
              </div>
              <div className="flex min-w-0 items-center" data-slot="composer-footer">
                {leading && (
                  <div className="flex items-center" data-slot="composer-leading">
                    {leading}
                  </div>
                )}
                {actions && (
                  <div className="flex min-w-0 flex-1 items-center justify-end" data-slot="composer-actions">
                    {actions}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {top}
              <div
                className={cn(
                  'grid w-full',
                  stacked
                    ? 'grid-cols-[auto_1fr] gap-(--composer-row-gap) [grid-template-areas:"input_input"_"menu_controls"]'
                    : 'grid-cols-[auto_1fr_auto] items-center gap-(--composer-control-gap) [grid-template-areas:"menu_input_controls"]'
                )}
              >
                {leading && (
                  <div className="flex translate-y-[3px] items-start gap-(--composer-control-gap) self-start [grid-area:menu]">
                    {leading}
                  </div>
                )}
                <div className="min-w-0 [grid-area:input]">{input}</div>
                {actions && (
                  <div
                    className="flex items-center justify-end gap-(--composer-control-gap) [grid-area:controls]"
                    data-slot="composer-actions"
                  >
                    {actions}
                  </div>
                )}
              </div>
            </>
          )}
          {bottom}
        </div>
      </div>
    </div>
  )
}
