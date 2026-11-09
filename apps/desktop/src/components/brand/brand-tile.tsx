import type { ComponentPropsWithoutRef, ComponentType, ReactNode, SVGProps } from 'react'
import { forwardRef } from 'react'

import { cn } from '@/lib/utils'

interface BrandTileProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  glyph?: ComponentType<SVGProps<SVGSVGElement>>
  monogram?: string
  /** The glyph is a Tabler outline icon (stroke), not a filled brand mark. */
  outline?: boolean
  /** xs 16px (dense sidebar labels), sm 20px, md 28px (default). */
  size?: BrandTileSize
  status?: ReactNode
}

export type BrandTileSize = 'xs' | 'sm' | 'md'

const TILE: Record<BrandTileSize, { glyph: string; monogram: string; tile: string }> = {
  xs: { glyph: 'size-2.5', monogram: 'text-[0.5rem]', tile: 'size-4 rounded-[0.25rem]' },
  sm: { glyph: 'size-3', monogram: 'text-[0.625rem]', tile: 'size-5 rounded-[0.375rem]' },
  md: { glyph: 'size-[0.9375rem]', monogram: 'text-[0.75rem]', tile: 'size-7 rounded-[0.5rem]' }
}

/**
 * One tile for every third-party identity: messaging platforms (PlatformAvatar),
 * MCP servers (McpAvatar), utility apps. 28px r8 sunk tile, brand glyph in ink
 * at 15px — no per-brand colour wash. Brands without a published mark (Slack,
 * Dingtalk, Feishu, WeCom, unknown MCP servers) get a 12/600 monogram in the
 * same tile. `status` overlays the shared 6px StatusDot at the corner.
 *
 * forwardRef + spread rest so a wrapping <Tip asChild> can attach its trigger.
 */
export const BrandTile = forwardRef<HTMLSpanElement, BrandTileProps>(function BrandTile(
  { className, glyph: Glyph, monogram, outline = false, size = 'md', status, ...rest },
  ref
) {
  const spec = TILE[size]

  return (
    <span
      aria-hidden="true"
      className={cn(
        // Fallbacks keep the tile drawn when the legacy shell (no .atum-shell tokens) is on.
        'relative inline-grid shrink-0 place-items-center bg-[var(--atum-sunk,var(--muted))] text-[var(--atum-ink-soft,var(--muted-foreground))]',
        spec.tile,
        className
      )}
      ref={ref}
      {...rest}
    >
      {Glyph ? (
        <Glyph className={spec.glyph} {...(outline ? {} : { fill: 'currentColor' })} />
      ) : (
        <span className={cn('font-semibold leading-none', spec.monogram)}>
          {(monogram ?? '?').slice(0, 1).toUpperCase()}
        </span>
      )}
      {status ? (
        <span className="absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-[var(--atum-bg,var(--background))] p-px">
          {status}
        </span>
      ) : null}
    </span>
  )
})
