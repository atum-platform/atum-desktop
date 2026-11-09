import './atum-atom.css'

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/**
 * Atum's working glyph: the Kit's thin orbit, nucleus and one travelling electron in
 * `currentColor`. It means only that the assistant is at work (thinking, a running step);
 * an app wait is the Kit spinner (`Loader`), never the atom. Size it with a `size-*`
 * class (16px by default); it stays crisp from 14px up. Decorative by default — the
 * words around it say what is happening; pass `label` when it stands alone so it is
 * announced as a status.
 */
export function AtumAtom({
  className,
  label,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { label?: string }) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn('atum-atom size-4', className)}
      data-atum-atom=""
      role={label ? 'status' : undefined}
      {...props}
    >
      <svg aria-hidden className="atum-atom-orbit" fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10.5" />
      </svg>
      <i className="atum-atom-nucleus" />
      <span className="atum-atom-track">
        <i className="atum-atom-electron" />
      </span>
    </span>
  )
}
