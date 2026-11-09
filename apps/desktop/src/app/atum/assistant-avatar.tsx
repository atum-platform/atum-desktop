import { useEffect, useState } from 'react'

import { atumAvatarInitial } from '@/lib/atum-avatar'
import { cn } from '@/lib/utils'

import type { AtumAssistantMark } from '../../../shared/atum-agent-portability'

const MARK_COLORS: Record<AtumAssistantMark['color'], string> = {
  snow: 'var(--atum-mark-snow)', earth: 'var(--atum-mark-earth)', coral: 'var(--atum-mark-coral)',
  orange: 'var(--atum-mark-orange)', amber: 'var(--atum-mark-amber)', mint: 'var(--atum-mark-mint)',
  teal: 'var(--atum-mark-teal)', blue: 'var(--atum-mark-blue)', violet: 'var(--atum-mark-violet)',
  pink: 'var(--atum-mark-pink)', stone: 'var(--atum-mark-stone)'
}
const MARK_CLIPS: Record<AtumAssistantMark['shape'], string> = {
  circle: 'circle(50%)',
  rounded_square: 'inset(0 round 27%)',
  diamond: 'polygon(50% 0,100% 50%,50% 100%,0 50%)',
  spark: 'polygon(50% 0,60% 40%,100% 50%,60% 60%,50% 100%,40% 60%,0 50%,40% 40%)',
  clover: 'polygon(50% 8%,65% 20%,82% 18%,92% 34%,82% 50%,92% 66%,82% 82%,65% 80%,50% 92%,35% 80%,18% 82%,8% 66%,18% 50%,8% 34%,18% 18%,35% 20%)',
  heart: 'polygon(50% 92%,8% 50%,5% 30%,18% 10%,38% 8%,50% 24%,62% 8%,82% 10%,95% 30%,92% 50%)',
  flower: 'polygon(50% 0,63% 25%,85% 15%,75% 38%,100% 50%,75% 62%,85% 85%,63% 75%,50% 100%,37% 75%,15% 85%,25% 62%,0 50%,25% 38%,15% 15%,37% 25%)',
  drop: 'polygon(50% 0,78% 35%,92% 60%,82% 84%,50% 100%,18% 84%,8% 60%,22% 35%)',
  pebble: 'inset(8% 0 round 42% 30% 44% 34%)',
  triangle: 'polygon(50% 0,100% 100%,0 100%)',
  pentagon: 'polygon(50% 0,98% 38%,80% 100%,20% 100%,2% 38%)',
  star: 'polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 94%,50% 72%,21% 94%,32% 57%,2% 35%,39% 35%)',
  hexagon: 'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)'
}

/**
 * One profile image projection for the assistant roster, header and editor.
 * The hosted URL is authoritative when present; old symbolic metadata is
 * deliberately ignored so newly edited identities always read as a photo or
 * the first grapheme of their name.
 *
 * The master assistant is the exception: it IS Atum, so with no photo of its
 * own it wears the product mark rather than the first letter of whatever the
 * plane happens to have stored as its name. A tinted "H" for a row a person
 * reads as "Atum" is not an identity — it is a fallback showing through.
 */
export function AtumAssistantAvatar({
  avatarUrl,
  brand = false,
  className,
  id,
  inset = false,
  mark,
  name,
  rosterAvatar = false,
  testId
}: {
  avatarUrl?: null | string
  /** The master assistant: falls back to the Atum mark, never to an initial. */
  brand?: boolean
  className: string
  id: string
  /** The mark drawn inside its tile, as an avatar (the chat list's rows). */
  inset?: boolean
  mark?: AtumAssistantMark
  name: string
  rosterAvatar?: boolean
  testId?: string
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  // A replacement must retry its new URL even when the previous image failed.
  useEffect(() => setFailedUrl(null), [avatarUrl])

  if (avatarUrl && failedUrl !== avatarUrl) {
    return (
      <img
        alt=""
        className={cn('ak-avatar atum-avatar', className, 'object-cover')}
        data-atum-assistant-avatar={rosterAvatar || undefined}
        data-testid={testId}
        onError={() => setFailedUrl(avatarUrl)}
        src={avatarUrl}
      />
    )
  }

  if (brand) {
    return (
      <span
        aria-hidden
        className={cn('ak-avatar atum-avatar', className)}
        data-atum-assistant-avatar={rosterAvatar || undefined}
        data-atum-eclipse-face
        data-atum-eclipse-inset={inset || undefined}
        data-testid={testId}
        // The app icon's dark tile, inline so the Kit's monogram background cannot win.
        style={{ background: 'var(--atum-brand-tile)' }}
      >
        {/* The real Atum logo file (owner 2026-10-31): a redrawn crescent read as a moon. */}
        <img
          alt=""
          // Inset like the app icon: the crescent rim and the bead stay legible at avatar sizes.
          className={cn('object-contain', inset ? 'size-[64%]' : 'size-[70%]')}
          data-atum-mark
          src={`${import.meta.env.BASE_URL}atum-mark.svg`}
        />
      </span>
    )
  }

  if (mark) {
    return (
      <span
        aria-hidden
        className={cn('ak-avatar atum-avatar', className, 'grid place-items-center bg-(--ak-fill-quiet)')}
        data-atum-assistant-avatar={rosterAvatar || undefined}
        data-testid={testId}
      >
        <span
          className={inset ? 'size-[62%]' : 'size-[58%]'}
          data-atum-agent-mark={`${mark.shape}:${mark.color}`}
          style={{ background: MARK_COLORS[mark.color], clipPath: MARK_CLIPS[mark.shape] }}
        />
      </span>
    )
  }

  return (
    <span
      aria-hidden
      className={cn(
        'ak-avatar atum-avatar',
        className,
        'grid place-items-center bg-(--ak-fill-quiet) font-semibold text-(--ak-ink-2)'
      )}
      data-atum-assistant-avatar={rosterAvatar || undefined}
      data-testid={testId}
    >
      {atumAvatarInitial(name).toLocaleUpperCase()}
    </span>
  )
}
