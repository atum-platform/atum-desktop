import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

import { MATRIX_REPORT_REASON_MAX } from '../../shared/matrix'

import { useChatCopy } from './chat-copy'
import { focusDialogField, MatrixDialogHeader } from './dialog-header'

/**
 * One short confirmation for a report (a message or a person): its title, one line, an
 * optional one-line reason and Report. Nothing else is asked; the reason is the person's own
 * words, sent with the Matrix report and never with message content. A failure says so and the
 * dialog stays open; a sent report shows Done for a beat, then closes.
 */
export function MatrixReportDialog({
  body,
  onCloseAutoFocus,
  onOpenChange,
  onReport,
  open,
  title
}: {
  body: string
  onCloseAutoFocus?: (event: Event) => void
  onOpenChange(open: boolean): void
  /** Rejects when the report could not be sent. */
  onReport(reason?: string): Promise<unknown>
  open: boolean
  title: string
}) {
  const chat = useChatCopy()
  const { t } = useI18n()
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle')
  const [failed, setFailed] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const busy = status !== 'idle'

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  useEffect(() => {
    if (open) {
      setReason('')
      setStatus('idle')
      setFailed(false)
    }
  }, [open])

  const send = () => {
    if (busy) {
      return
    }

    setStatus('sending')
    setFailed(false)
    void onReport(reason.trim() || undefined).then(
      () => {
        setStatus('done')
        window.clearTimeout(closeTimer.current)
        closeTimer.current = window.setTimeout(() => onOpenChange(false), 600)
      },
      () => {
        setStatus('idle')
        setFailed(true)
      }
    )
  }

  return (
    <Dialog onOpenChange={value => !busy && onOpenChange(value)} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-sm"
        data-matrix-report-dialog
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader description={body} title={title} />
        <form
          onSubmit={event => {
            event.preventDefault()
            send()
          }}
        >
          <Input
            aria-label={chat.reportReason}
            className="atum-input"
            data-matrix-report-reason
            disabled={busy}
            maxLength={MATRIX_REPORT_REASON_MAX}
            onChange={event => setReason(event.target.value)}
            placeholder={chat.reportReason}
            value={reason}
          />
          {failed && (
            <NoticeBand className="mt-3" role="alert" tone="failure">
              {chat.errorGeneric}
            </NoticeBand>
          )}
          <DialogFooter className="mt-4">
            <Button disabled={busy} onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {chat.cancel}
            </Button>
            <Button data-matrix-report-send disabled={busy} type="submit">
              {status === 'done' ? t.common.done : status === 'sending' ? t.common.loading : chat.report}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
