import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { Bell, FolderShare } from '@/lib/icons'
import {
  $atumPermissionPrompt,
  armNotificationPermissionPrompt,
  resolveAtumPermissionPrompt,
  setAtumPermissionSequenceActive
} from '@/store/permission-preprompts'

export function AtumPermissionPrePrompt() {
  const { t } = useI18n()
  const prompt = useStore($atumPermissionPrompt)
  const laterRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setAtumPermissionSequenceActive(true)
    const arm = () => armNotificationPermissionPrompt()
    window.addEventListener('atum:arm-notification-permission', arm)

    return () => {
      window.removeEventListener('atum:arm-notification-permission', arm)
      setAtumPermissionSequenceActive(false)
    }
  }, [])

  useEffect(() => {
    if (prompt) {requestAnimationFrame(() => laterRef.current?.focus())}
  }, [prompt])

  if (!prompt) {return null}

  const notifications = prompt.kind === 'notifications'
  const Icon = notifications ? Bell : FolderShare
  const title = notifications ? t.atum.permissions.notifications.title : t.atum.permissions.files.title

  const body = notifications
    ? t.atum.permissions.notifications.body
    : t.atum.permissions.files.body(prompt.folderName)

  return (
    <ConsentBoundary><Dialog onOpenChange={open => !open && resolveAtumPermissionPrompt(false)} open>
      <DialogContent className="atum-shell max-w-[23.75rem]" data-atum-permission-prompt showCloseButton={false}>
        {/* Mock 2d: 44px r13 sunk tile with a 20px ink glyph, title 18/600,
            body 13.5/1.5 muted, footer secondary + primary. */}
        <span aria-hidden className="grid size-11 place-items-center rounded-[0.8125rem] bg-(--atum-sunk) text-(--atum-ink)">
          <Icon className="size-5" />
        </span>
        <DialogHeader className="mt-4">
          <DialogTitle className="text-[1.125rem]">{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <div className="mt-[1.375rem] flex justify-end gap-2">
          <Button onClick={() => resolveAtumPermissionPrompt(false)} ref={laterRef} variant="secondary">
            {t.atum.permissions.later}
          </Button>
          <Button onClick={() => resolveAtumPermissionPrompt(true)}>
            {notifications ? t.atum.permissions.allow : t.common.continue}
          </Button>
        </div>
      </DialogContent>
    </Dialog></ConsentBoundary>
  )
}
