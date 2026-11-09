import type { ReactNode } from 'react'

import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import type { MatrixUserPresence } from '../../shared/matrix-presence'
import { matrixPresenceCopy } from '../../shared/matrix-presence-copy'

import { useMatrixPresence } from './presence-store'

export function matrixPresenceLabel(presence: MatrixUserPresence, locale: string): string {
  const copy = matrixPresenceCopy(locale)

  const parts = [
    presence.status?.dnd ? copy.doNotDisturb : presence.state ? copy[presence.state] : undefined,
    presence.status?.emoji,
    presence.status?.text
  ].filter(Boolean)

  return parts.join(' · ')
}

export function MatrixPresenceBadge({ presence }: { presence: MatrixUserPresence }) {
  const { locale } = useI18n()
  const label = matrixPresenceLabel(presence, locale)

  if (!presence.state && !presence.status?.dnd) {
    return null
  }

  return (
    <span
      aria-label={label}
      className={cn(
        // Geometry lives in styles.css (`.atum-person-face`): the dot's centre sits on the face's
        // edge at 45°, in a notch cut out of the photo, at every face size.
        'grid size-2 place-items-center rounded-full',
        presence.status?.dnd
          ? 'bg-(--ak-ink)'
          : presence.state === 'online'
            ? 'bg-(--ak-ok)'
            : presence.state === 'away'
              ? 'bg-(--ak-warn)'
              : 'border border-(--ak-ink-3) bg-(--ak-surface)'
      )}
      data-person-presence={presence.status?.dnd ? 'dnd' : presence.state}
      role="img"
      title={label}
    >
      {presence.status?.dnd && <span aria-hidden className="h-px w-1 bg-(--ak-on-ink)" />}
    </span>
  )
}

/** A person's face with their observed presence. Pass `presence={false}` where a dot would be
 * noise (Atum Kit §13a): message rows, stacked faces, chat rows. The face keeps its tooltip. */
export function MatrixPresenceFace({ children, className, presence: showPresence = true, userId }: {
  children: ReactNode
  className: string
  presence?: boolean
  userId: string
}) {
  const presence = useMatrixPresence(userId)
  const { locale } = useI18n()

  return (
    <span
      className={cn('ak-avatar atum-avatar atum-person-face relative inline-grid rounded-full', className)}
      data-person-avatar={userId}
      title={presence ? matrixPresenceLabel(presence, locale) : undefined}
    >
      <span className="contents" data-person-avatar-image>{children}</span>
      {presence && showPresence && <MatrixPresenceBadge presence={presence} />}
    </span>
  )
}

export function MatrixPresenceLine({ presence }: { presence: MatrixUserPresence | undefined }) {
  const { locale } = useI18n()

  if (!presence?.status) {
    return null
  }

  return (
    <span className="truncate text-xs text-(--atum-ink-muted)" data-person-status>
      {presence.status.dnd && <span aria-hidden>⛔ </span>}
      {presence.status.emoji && <span aria-hidden>{presence.status.emoji} </span>}
      {presence.status.text ?? matrixPresenceCopy(locale).doNotDisturb}
    </span>
  )
}
