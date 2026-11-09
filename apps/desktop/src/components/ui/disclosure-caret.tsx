import { ChevronRight, type IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface DisclosureCaretProps extends Omit<React.ComponentProps<IconComponent>, 'ref' | 'size'> {
  open: boolean
  /** CSS length for the glyph box. Omit it for sm 14; a `size-*` class works too. */
  size?: number | string
}

// Chevron for collapsible sections: right when closed, rotated 90° when open.
// Override `className` to layer hover/opacity styling; twMerge resolves
// transition conflicts.
export function DisclosureCaret({ className, open, size, style, ...props }: DisclosureCaretProps) {
  const dimension = size === undefined ? undefined : typeof size === 'number' ? `${size}px` : size

  return (
    <ChevronRight
      aria-hidden
      className={cn('size-3.5 shrink-0 transition-transform duration-150 ease-out', open && 'rotate-90', className)}
      style={dimension ? { height: dimension, width: dimension, ...style } : style}
      {...props}
    />
  )
}
