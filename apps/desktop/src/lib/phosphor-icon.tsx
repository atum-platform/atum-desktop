import { type ComponentPropsWithoutRef, forwardRef, type FunctionComponent } from 'react'

import { cn } from '@/lib/utils'

// Source path, not '@atum/kit/icon': worktrees and release checkouts link node_modules to a shared
// checkout, so the package name can resolve to an older Kit that lacks newer glyphs.
import { type AkIconName, akIconPaths, type AkIconWeight } from '../../../../packages/atum-kit/src/icon'

/**
 * The props every app icon takes. The shape is the one Tabler icons had, so call sites did not
 * change when the app moved to Phosphor (Atum Kit 0.1, owner decision: Phosphor Light). `stroke`
 * is accepted and ignored: Phosphor glyphs are filled outlines with the weight built in.
 */
export interface IconProps extends Partial<Omit<ComponentPropsWithoutRef<'svg'>, 'stroke'>> {
  size?: number | string
  stroke?: number | string
  title?: string
}

/** Any component drawn where an icon goes: a Phosphor glyph, or a mark such as the Protons coin. */
export type IconComponent = FunctionComponent<IconProps>

export interface PhosphorIconOptions {
  /** Light for resting states; Fill for the selected state of the same glyph. */
  weight?: AkIconWeight
  /** Draw the glyph mirrored left to right (a right-hand sidebar from the left-hand one). */
  mirror?: boolean
}

/** One app icon backed by the kit's pinned Phosphor paths. It paints in `currentColor`. */
export function phosphorIcon(name: AkIconName, { weight = 'light', mirror = false }: PhosphorIconOptions = {}) {
  const resting = akIconPaths(name, weight)
  const filled = akIconPaths(name, 'fill')

  const Icon = forwardRef<SVGSVGElement, IconProps>(function PhosphorIcon(
    { className, size = 24, stroke: _stroke, title, style, ...props },
    ref
  ) {
    // With Tabler, `fill-current` on an outline glyph made it solid (a favourite star, a stop
    // square). Phosphor ships the solid shape as its Fill weight, so that class asks for it.
    const solid = weight === 'fill' || /(^|\s)fill-current(\s|$)/.test(className ?? '')
    const paths = solid ? filled : resting

    return (
      <svg
        className={cn('atum-icon', `atum-icon-${name}`, solid && 'atum-icon-fill', className)}
        fill="currentColor"
        height={size}
        ref={ref}
        style={mirror ? { transform: 'scaleX(-1)', ...style } : style}
        viewBox="0 0 256 256"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        {title ? <title>{title}</title> : null}
        {paths.map(d => (
          <path d={d} key={d} />
        ))}
      </svg>
    )
  })

  Icon.displayName = `Icon(${name}${weight === 'fill' ? ':fill' : ''})`

  return Icon as IconComponent
}
