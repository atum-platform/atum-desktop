import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The Proton mark — Atum's currency glyph: an off-centre ring crossed by an
 * upright bar. Sources: `apps/desktop/brand/proton/` (on-light #1C1B19,
 * on-dark #FAF9F7, mono black/white). Here it is drawn in `currentColor`, so
 * it takes the surrounding ink in both themes instead of those literals.
 *
 * Two geometries, as designed:
 *  - `small` (default) — the 16 px cut: a heavier ring and a square 8-unit bar
 *    that stay legible at icon and text sizes.
 *  - `regular` — the 64 px cut: a finer ring and a rounded bar, for display
 *    sizes (a balance headline).
 *
 * The design files cut the ring with an SVG mask whose id is `p`; many marks
 * on one page would share that id, and a hidden instance can blank the others.
 * The ring is the same shape as an even-odd path, so no id is needed.
 *
 * Props match the icon registry's components, so it drops into an icon slot
 * (settings navigation, menus) where `strokeWidth` is passed and ignored.
 */
export type ProtonMarkProps = Omit<ComponentPropsWithoutRef<'svg'>, 'stroke'> & {
  size?: number | string
  stroke?: number | string
  title?: string
  variant?: 'regular' | 'small'
}

const GEOMETRY = {
  // Outer r23 at (32,32) minus inner r14 at (30,34); bar 28..36 × 3..61.
  small: { ring: 'M9 32a23 23 0 1 0 46 0a23 23 0 1 0-46 0ZM16 34a14 14 0 1 0 28 0a14 14 0 1 0-28 0Z', bar: { x: 28, y: 3, width: 8, height: 58, rx: 0 } },
  // Outer r22.5 at (32,32) minus inner r17.5 at (30.6,33.4); bar 29.4..34.6 × 4..60.
  regular: { ring: 'M9.5 32a22.5 22.5 0 1 0 45 0a22.5 22.5 0 1 0-45 0ZM13.1 33.4a17.5 17.5 0 1 0 35 0a17.5 17.5 0 1 0-35 0Z', bar: { x: 29.4, y: 4, width: 5.2, height: 56, rx: 2.6 } }
} as const

export function ProtonMark({ className, size, stroke: _stroke, strokeWidth: _strokeWidth, title, variant = 'small', ...props }: ProtonMarkProps) {
  const shape = GEOMETRY[variant]

  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={cn('shrink-0', className)}
      data-proton-mark={variant}
      fill="currentColor"
      height={size ?? '1em'}
      role={title ? 'img' : undefined}
      viewBox="0 0 64 64"
      width={size ?? '1em'}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title && <title>{title}</title>}
      <path d={shape.ring} fillRule="evenodd" />
      <rect {...shape.bar} />
    </svg>
  )
}

/**
 * A Proton amount the way money reads: the mark, then the number. The words
 * stay for assistive technology and for copied text: when the full phrase
 * starts with the number ("12,400 Protons" — every locale today), only the
 * rest of it ("Protons") is visually hidden, so the text reads exactly the
 * phrase. Sentences such as "You have 12,400 Protons" keep their words and do
 * not use this.
 */
export function ProtonAmount({
  amount,
  className,
  spoken,
  variant = 'small'
}: {
  /** The number, already formatted for the viewer's locale. */
  amount: string
  className?: string
  /** The full phrase, e.g. `t.atum.protons.balance(amount)`. */
  spoken: string
  variant?: ProtonMarkProps['variant']
}) {
  const rest = spoken.startsWith(amount) ? spoken.slice(amount.length) : null

  return (
    <span className={cn('inline-flex items-center gap-[0.28em] whitespace-nowrap tabular-nums', className)} data-proton-amount>
      <ProtonMark className="size-[0.92em] translate-y-[0.02em]" variant={variant} />
      {rest !== null ? (
        <span>
          {amount}
          <HiddenWords words={rest} />
        </span>
      ) : (
        <>
          <span aria-hidden>{amount}</span>
          <span className="sr-only">{spoken}</span>
        </>
      )}
    </span>
  )
}

/**
 * Words kept for screen readers and copied text, out of sight. The space before them stays
 * a plain text node: inside the hidden span, name computation trims it ("8,000Protons").
 */
function HiddenWords({ words }: { words: string }) {
  const lead = /^\s*/u.exec(words)?.[0] ?? ''
  const rest = words.slice(lead.length)

  return rest ? (
    <>
      {lead}
      <span className="sr-only">{rest}</span>
    </>
  ) : null
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * A price phrase with the mark: every amount in `text` is drawn as the mark then the
 * number, and the currency word right after an amount ("8,000 Protons first month") is
 * visually hidden. Nothing is removed, so copied text and what a screen reader hears stay
 * the whole phrase ("Get · 8,000 Protons"); an amount the text does not contain is left
 * alone. Use it for pills and buttons; prose sentences keep their words.
 */
export function ProtonText({
  amounts,
  className,
  text,
  unit
}: {
  /** The amounts as `text` writes them, already formatted for the viewer's locale. */
  amounts: readonly string[]
  className?: string
  text: string
  /** The currency word, e.g. "Protons" (en) or "Proton" (vi, ja, zh). */
  unit: string
}) {
  const wanted = [...new Set(amounts.filter(Boolean))].sort((a, b) => b.length - a.length)

  if (wanted.length === 0) {
    return <span className={className}>{text}</span>
  }

  // A whole amount only: never the "1,000" inside "11,000" or "0.5".
  const pattern = new RegExp(
    `(?<![\\p{Nd}.,])(${wanted.map(escapeRegExp).join('|')})(?![\\p{Nd}])(${unit ? `\\s+${escapeRegExp(unit)}(?![\\p{L}])` : '(?!)'})?`,
    'gu'
  )
  const pieces: ReactNode[] = []
  let cursor = 0

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    pieces.push(text.slice(cursor, index))
    pieces.push(
      <span className="inline-flex items-center gap-[0.28em] whitespace-nowrap tabular-nums" data-proton-amount key={index}>
        <ProtonMark className="size-[0.92em] translate-y-[0.02em]" />
        <span>
          {match[1]}
          <HiddenWords words={match[2] ?? ''} />
        </span>
      </span>
    )
    cursor = index + match[0].length
  }

  pieces.push(text.slice(cursor))

  return <span className={className}>{pieces}</span>
}
