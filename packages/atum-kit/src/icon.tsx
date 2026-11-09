import type { ComponentProps } from 'react'

import icons from '../dist/phosphor-icons.json'

/** A Phosphor icon the kit exposes (icons.json); add a name there and rebuild for more. */
export type AkIconName = keyof typeof icons.light
export type AkIconWeight = 'light' | 'fill'
/** The kit's icon sizes: sm 16, md 18 (default), lg 20, xl 24 (`--ak-i-*`). */
export type AkIconSize = 'sm' | 'md' | 'lg' | 'xl'

export interface AkIconProps extends Omit<ComponentProps<'svg'>, 'children' | 'viewBox'> {
  name: AkIconName
  /** Light for every resting state; Fill for the selected/active state of the same glyph. */
  weight?: AkIconWeight
  size?: AkIconSize
  /** Accessible name. Without one the icon is decorative and hidden from assistive technology. */
  label?: string
}

const SIZE_CLASS: Record<AkIconSize, string | undefined> = {
  sm: 'ak-icon--sm',
  md: undefined,
  lg: 'ak-icon--lg',
  xl: 'ak-icon--xl'
}

/** Path data of a kit Phosphor icon (256 x 256 view box). */
export function akIconPaths(name: AkIconName, weight: AkIconWeight = 'light'): readonly string[] {
  return icons[weight][name]
}

/** A Phosphor Light/Fill icon with the kit's `.ak-icon` sizing; it paints in `currentColor`. */
export function AkIcon({ name, weight = 'light', size = 'md', label, className, ...props }: AkIconProps) {
  const classes = ['ak-icon', SIZE_CLASS[size], className].filter(Boolean).join(' ')

  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={classes}
      fill="currentColor"
      focusable="false"
      role={label ? 'img' : undefined}
      viewBox="0 0 256 256"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {akIconPaths(name, weight).map(d => (
        <path d={d} key={d} />
      ))}
    </svg>
  )
}
