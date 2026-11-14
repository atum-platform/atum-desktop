import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import { ActionStatus } from '@/components/ui/action-status'
import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { AlertTriangle } from '@/lib/icons'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  // Does the work. Throw to surface an inline error and keep the dialog open.
  onConfirm: () => Promise<void> | void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  busyLabel?: string
  doneLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /** Close as soon as onConfirm resolves — for optimistic actions that finish in the background. */
  dismissOnConfirm?: boolean
  /** The action is no longer available while the dialog is open: this is shown instead, and Confirm is off. */
  blockedReason?: string
  onCloseAutoFocus?: (event: Event) => void
}

// Shared confirmation dialog: Enter confirms (from anywhere in the dialog),
// Esc/Cancel/backdrop dismiss. Owns the pending → done → close beat and inline
// error, so callers pass only an async onConfirm that does the work.
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  busyLabel,
  doneLabel,
  cancelLabel,
  destructive = false,
  dismissOnConfirm = false,
  blockedReason,
  onCloseAutoFocus
}: ConfirmDialogProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'done' | 'idle' | 'saving'>('idle')
  const [error, setError] = useState<null | string>(null)
  const busy = status === 'saving' || status === 'done'
  const blocked = Boolean(blockedReason)
  const resolvedConfirmLabel = confirmLabel ?? t.common.confirm
  const resolvedBusyLabel = busyLabel ?? t.common.loading
  const resolvedDoneLabel = doneLabel ?? t.common.done
  const resolvedCancelLabel = cancelLabel ?? t.common.cancel

  // The done beat closes after a short delay; a dialog unmounted before then must not call back.
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  useEffect(() => {
    if (open) {
      setStatus('idle')
      setError(null)
    }
  }, [open])

  async function run() {
    if (busy || blocked) {
      return
    }

    setError(null)

    if (dismissOnConfirm) {
      try {
        await onConfirm()
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : t.errors.genericFailure)
      }

      return
    }

    setStatus('saving')

    try {
      await onConfirm()
      setStatus('done')
      window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(onClose, 600)
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : t.errors.genericFailure)
    }
  }

  return (
    <ConsentBoundary><Dialog onOpenChange={value => !value && !busy && onClose()} open={open}>
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
        onKeyDown={event => {
          // Enter/Space confirm regardless of which button holds focus
          // (preventDefault stops a focused Cancel from swallowing it).
          if ((event.key === 'Enter' || event.key === ' ') && !busy) {
            event.preventDefault()
            void run()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {(blockedReason ?? error) && (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-confirm-blocked={blocked || undefined}
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{blockedReason ?? error}</span>
          </div>
        )}

        <DialogFooter>
          <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
            {resolvedCancelLabel}
          </Button>
          <Button disabled={busy || blocked} onClick={() => void run()} variant={destructive ? 'destructive' : 'default'}>
            <ActionStatus
              busy={resolvedBusyLabel}
              done={resolvedDoneLabel}
              idle={resolvedConfirmLabel}
              state={status}
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog></ConsentBoundary>
  )
}
