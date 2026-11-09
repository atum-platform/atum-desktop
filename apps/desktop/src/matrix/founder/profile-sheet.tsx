import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import { VerifiedMark } from '@/components/verified-mark'
import { X } from '@/lib/icons'

import type { MatrixSnapshot } from '../../../shared/matrix'
import { focusMatrixComposer } from '../composer-focus'
import { focusDialogField } from '../dialog-header'
import { runMatrixCommand } from '../text-document-actions'

import { FounderAvatar } from './founder-avatar'
import { useFounderCopy } from './founder-copy'
import { $founderProfileOpen, closeFounderProfile } from './founder-store'
import { founderRoom } from './roster-founder'

/**
 * The Founder's profile (plan D10): the raven, the name with its mark, who they are, their
 * @handle when the platform gives one, the reply promise, one line on what the filled mark
 * means (the Founder is official only; the hollow mark is for others) and Message. It opens from the chat's header, the roster's menu and nowhere else; it is
 * mounted once, beside the Founder row, and only while that row exists.
 */
export function FounderProfileSheet({
  fail,
  onOpenChat,
  snapshot
}: {
  fail(cause?: unknown): void
  /** Brings the chat list's chosen chat to the front (the roster's own navigation). */
  onOpenChat(): void
  snapshot: MatrixSnapshot
}) {
  const copy = useFounderCopy()
  const open = useStore($founderProfileOpen)
  const room = founderRoom(snapshot)
  const handle = snapshot.founder?.handle

  const message = () => {
    closeFounderProfile()

    if (!room) {
      return
    }

    if (snapshot.roomId === room.id) {
      requestAnimationFrame(() => focusMatrixComposer())

      return
    }

    onOpenChat()
    void runMatrixCommand({ kind: 'select', roomId: room.id }).catch(fail)
  }

  return (
    <Dialog onOpenChange={value => (value ? undefined : closeFounderProfile())} open={open && Boolean(room)}>
      <DialogContent
        className="atum-sheet max-w-sm"
        data-founder-profile
        // The sheet takes focus itself, never its close ×, whose tip would show unasked.
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <div className="-mt-1 -me-2 flex justify-end">
          <Tip label={copy.close}>
            <DialogClose asChild>
              <Button aria-label={copy.close} size="icon-sm" variant="ghost">
                <X aria-hidden />
              </Button>
            </DialogClose>
          </Tip>
        </div>
        <div className="flex flex-col items-center text-center">
          <FounderAvatar size={128} />
          <DialogTitle className="mt-4 flex items-center gap-1.5 text-lg font-semibold">
            <span>{copy.name}</span>
            <VerifiedMark size="md" tier="official" />
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-(length:--atum-t-control) text-(--atum-ink-muted)">
            {copy.subtitle}
          </DialogDescription>
          {handle && (
            <p className="mt-0.5 text-(length:--atum-t-control) text-(--atum-ink-faint)" data-founder-handle>
              @{handle}
            </p>
          )}
          <p className="mt-4 text-[0.9375rem] text-(--atum-ink-soft)">{copy.replyPromise}</p>
          <p
            className="mt-3 inline-flex items-center gap-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)"
            data-founder-legend
          >
            {/* The line says what the mark means; the mark itself is not read a second time. */}
            <VerifiedMark aria-hidden size="xs" tier="official" tip={false} />
            {copy.legendOfficial}
          </p>
          <Button className="mt-5 w-full" data-founder-message onClick={message}>
            {copy.message}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
