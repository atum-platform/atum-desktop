import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { X } from '@/lib/icons'

/**
 * A conversation dialog's top: its title (and one line under it, when it needs one) beside
 * the close ×. The product shell hides the shared dialog's own close control, so dialogs
 * that are not a confirmation carry this one (DESIGN.md: close is an ×, not a word).
 */
export function MatrixDialogHeader({ description, title }: { description?: ReactNode; title: ReactNode }) {
  const { t } = useI18n()

  return (
    <div className="mb-4 flex items-start justify-between gap-3" data-matrix-dialog-header>
      <div className="min-w-0">
        <DialogTitle className="truncate">{title}</DialogTitle>
        {description && <DialogDescription className="mt-1.5">{description}</DialogDescription>}
      </div>
      <Tip label={t.common.close}>
        <DialogClose asChild>
          <Button aria-label={t.common.close} className="-me-2 -mt-1 shrink-0" size="icon-sm" variant="ghost">
            <X aria-hidden />
          </Button>
        </DialogClose>
      </Tip>
    </div>
  )
}

/** Opening a conversation dialog puts focus on its first field (or the dialog itself),
 * never on the close ×, whose tip would otherwise show with no pointer near it. */
export function focusDialogField(event: Event) {
  event.preventDefault()
  const content = event.currentTarget instanceof HTMLElement ? event.currentTarget : null

  const field = content?.querySelector<HTMLElement>(
    'input:not([disabled]), textarea:not([disabled]), [role="switch"]:not([disabled])'
  )

  ;(field ?? content)?.focus({ preventScroll: true })
}
