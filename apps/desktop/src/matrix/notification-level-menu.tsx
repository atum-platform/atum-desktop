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

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
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
  rootId: string
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
              scope: 'thread',
              roomId,
              rootId,
              level: next
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

export function MatrixRoomNotificationMenu({
  fail,
  room,
  snapshot
}: {
  fail(cause?: unknown): void
  room: MatrixRoom
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const copy = matrixNotificationCopy(locale)
  const [saving, setSaving] = useState(false)
  const mode = room.notificationMode?.mode ?? 'inherit'
  const legacy = snapshot.notificationPolicy?.channelOverrides[room.id]
  const selected = mode === 'inherit' && (legacy === 'mentions' || legacy === 'nothing') ? legacy : mode
  const defaultLevel = room.notificationMode?.defaultLevel
  const disabled = saving || snapshot.state !== 'ready'

  const save = (next: MatrixNotificationOverride) => {
    if (disabled || (next === mode && legacy === undefined)) {
      return
    }

    setSaving(true)
    void runMatrixCommand({ kind: 'roomNotificationMode', roomId: room.id, mode: next })
      .catch(fail)
      .finally(() => setSaving(false))
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <Bell aria-hidden />
        {copy.notifications}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-48">
        <DropdownMenuRadioGroup value={selected}>
          {LEVELS.map(level => {
            const hint = level === 'inherit'
              ? defaultLevel && copy.roomModes[defaultLevel]
              : level === 'mentions' && room.encrypted
                ? copy.encryptedMentionsHelp
                : copy.roomModeHelp[level]

            return (
              <DropdownMenuRadioItem
                aria-description={hint || undefined}
                aria-label={copy.roomModes[level]}
                key={level}
                onSelect={() => save(level)}
                value={level}
              >
                <span>
                  {copy.roomModes[level]}
                  {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
