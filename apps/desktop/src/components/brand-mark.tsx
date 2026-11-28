import { useId } from 'react'

import { cn } from '@/lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Brand badge: the Atum mark on its own full-bleed dark tile. The old white
// wrapper made the mark look like a small icon pasted into a generic app-icon
// container — especially obvious in Launchpad and the full-window auth gate.
// Size via className (default size-14).
//
// `inset` is the avatar cut (the roster's rows): the eclipse sits inside the
// tile with room around it, like an initial in its square, and a hairline
// keeps the tile's edge on a dark panel. Full bleed at avatar sizes read as a
// black disc spilling past its square.
export function BrandMark({ className, inset = false, ...props }: React.ComponentProps<'span'> & { inset?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[#141311]',
        inset && 'shadow-[inset_0_0_0_0.5px_var(--atum-line-strong)]',
        className
      )}
      data-brand-mark={inset ? 'inset' : undefined}
      {...props}
    >
      <img
        alt=""
        className={inset ? 'size-[64%] object-contain' : 'size-full object-cover'}
        src={assetPath('atum-mark.svg')}
      />
    </span>
  )
}

/**
 * The bare mark (owner 2026-11-27: "the bare circle-and-dot version … no black background, just mark +
 * name"): the eclipse's ring and its dot from `atum-mark.svg`'s own geometry, with no tile and no halo,
 * painted in `currentColor` so it is ink on a light band and bone on a dark one. One optical change for
 * small sizes: the ring stops short of the dot, which otherwise melts into it below ~24 px. Size via
 * className.
 */
export function AtumGlyph({ className, ...props }: React.ComponentProps<'svg'>) {
  const mask = useId()

  return (
    <svg className={cn('size-5 shrink-0', className)} data-atum-glyph="" viewBox="0 0 64 64" {...props}>
      <defs>
        <mask id={mask}>
          <rect fill="white" height="64" width="64" />
          <circle cx="29.5" cy="34.5" fill="black" r="25.5" />
          {/* A thin gap around the dot, so ring and dot read as two shapes at title-bar size. */}
          <circle cx="49.5" cy="14.5" fill="black" r="7.4" />
        </mask>
      </defs>
      <circle cx="32" cy="32" fill="currentColor" mask={`url(#${mask})`} r="28.5" />
      <circle cx="49.5" cy="14.5" fill="currentColor" r="4.8" />
    </svg>
  )
}

/** The title bar's brand: the bare mark and the name, as T3 wears its wordmark. It names the app and does nothing. */
export function AtumBrandLockup({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-(--atum-ink) select-none', className)}
      data-atum-brand-lockup=""
      {...props}
    >
      <AtumGlyph aria-hidden className="size-5" />
      <span className="text-[0.9375rem] leading-none font-semibold tracking-[-0.01em]">Atum</span>
    </span>
  )
}
