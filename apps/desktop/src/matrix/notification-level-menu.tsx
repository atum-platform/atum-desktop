import { useEffect, useState } from 'react'

import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { Bell } from '@/lib/icons'

import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixNotificationCopy } from '../../shared/matrix-notification-copy'
import {
  type MatrixNotificationOverride,
  validMatrixNotificationOverride
} from '../../shared/matrix-notification-policy'

import { runMatrixCommand } from './text-document-actions'

const LEVELS: readonly MatrixNotificationOverride[] = ['inherit', 'all', 'mentions', 'nothing']

export function MatrixNotificationLevelMenu({
  fail,
  roomId,
  rootId,
  snapshot,
  value
}: {
  fail(cause?: unknown): void
  roomId: string
  rootId?: string
  snapshot: MatrixSnapshot
  value: MatrixNotificationOverride
}) {
  const { locale } = useI18n()
  const copy = matrixNotificationCopy(locale)
  const [pending, setPending] = useState<MatrixNotificationOverride>()

  useEffect(() => setPending(undefined), [roomId, rootId, value])

  const current = pending ?? value
  const disabled = pending !== undefined || snapshot.state !== 'ready' ||
    !snapshot.identity || !snapshot.notificationPolicy?.writable

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <Bell aria-hidden />
        {copy.notifications}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-48">
        <DropdownMenuRadioGroup
          onValueChange={next => {
            if (!validMatrixNotificationOverride(next) || next === current || !snapshot.identity) {
              return
            }

            setPending(next)
            void runMatrixCommand({
              kind: 'notificationPolicy',
              identity: snapshot.identity,
              ...(rootId
                ? { scope: 'thread', roomId, rootId, level: next }
                : { scope: 'channel', roomId, level: next })
            }).catch(cause => {
              setPending(undefined)
              fail(cause)
            })
          }}
          value={current}
        >
          {LEVELS.map(level => (
            <DropdownMenuRadioItem key={level} value={level}>
              {copy.overrides[level]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
