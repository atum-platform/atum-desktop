import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixApprovalCopy } from '../../shared/matrix-approval-copy'
import type { MatrixApprovalNumbers, MatrixApprovalView } from '../../shared/matrix-security'

/** A wait this long with no answer from the other device says what it needs. */
export const MATRIX_APPROVAL_SLOW_MS = 20_000

function useApprovalCopy() {
  return matrixApprovalCopy(useI18n().locale)
}

function numberCodeLabel(numbers: MatrixApprovalNumbers): string {
  return numbers.map(value => String(value).padStart(4, '0')).join(', ')
}

/** Whether `since` is older than `ms`, re-checked while it is not. */
function useOlderThan(since: number, ms: number): boolean {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (now - since >= ms) {
      return
    }

    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, since + ms - now))

    return () => window.clearTimeout(timer)
  }, [ms, now, since])

  return now - since >= ms
}

/**
 * The new Mac's side of one-tap approval (electron/matrix/device-approval.ts), inside the
 * recovery step: which device to open, then the complete standard Matrix decimal code to pick
 * there, then the unlock. The person can
 * always use their key instead, or say they have no other device.
 */
export function MatrixApprovalRequest({
  approval,
  onNoDevice,
  onUseKey
}: {
  approval: MatrixApprovalView
  onNoDevice(): void
  onUseKey(): void
}) {
  const copy = useApprovalCopy()
  const device = approval.deviceName ?? copy.otherDevice
  const slow = useOlderThan(approval.since, MATRIX_APPROVAL_SLOW_MS)
  const [pending, setPending] = useState(false)
  const ended = ['mismatch', 'declined', 'timeout', 'failed'].includes(approval.state)

  const retry = () => {
    setPending(true)
    void window.atumMatrix.approval
      ?.retry()
      .catch(() => {})
      .finally(() => setPending(false))
  }

  // A new Mac with nothing to check the person's identity against confirms only once they say
  // they picked its number code on the other device.
  const picked = () => {
    setPending(true)
    void window.atumMatrix.approval
      ?.confirm()
      .catch(() => {})
      .finally(() => setPending(false))
  }

  const ending = {
    mismatch: copy.mismatch,
    declined: copy.declined,
    timeout: copy.timeout,
    failed: copy.failed
  } as const

  return (
    <div className="flex flex-col gap-3 text-start" data-matrix-approval-request={approval.state}>
      {approval.state === 'waiting' && (
        <>
          <p className="text-(--atum-ink-muted)">{copy.requestWaiting(device)}</p>
          <div className="flex items-center gap-2 text-(--atum-ink-muted)" role="status">
            <Loader aria-hidden="true" className="size-4" role="presentation" size="sm" />
            {slow ? copy.slow : null}
          </div>
        </>
      )}

      {approval.state === 'compare' && approval.numbers && (
        <>
          <p className="text-(--atum-ink-muted)">{copy.requestCompare(device)}</p>
          <div
            aria-label={numberCodeLabel(approval.numbers)}
            className="atum-approval-code self-start"
            data-matrix-approval-code
            role="group"
          >
            {approval.numbers.map((value, index) => (
              <span aria-hidden="true" className="atum-approval-number" key={index}>
                {String(value).padStart(4, '0')}
              </span>
            ))}
          </div>
          {approval.confirm && (
            <>
              {/* The comparison ends about a minute after the pick there (the SAS timeout). */}
              <p className="text-(--atum-ink-muted)">{copy.pickedHint}</p>
              <Button className="self-start" data-matrix-approval-picked disabled={pending} onClick={picked} size="sm">
                {copy.picked}
              </Button>
            </>
          )}
        </>
      )}

      {approval.state === 'unlocking' && (
        <div className="flex items-center gap-2 text-(--atum-ink-muted)" role="status">
          <Loader aria-hidden="true" className="size-4" role="presentation" size="sm" />
          {copy.unlocking}
        </div>
      )}

      {approval.state === 'done' && (
        <p className="text-(--atum-ink-muted)" role="status">
          {copy.done}
        </p>
      )}

      {ended && (
        <div className="flex flex-col items-start gap-2">
          <NoticeBand role="status" tone="notice">
            {ending[approval.state as keyof typeof ending]}
          </NoticeBand>
          <Button disabled={pending} onClick={retry} size="sm">
            {copy.tryAgain}
          </Button>
        </div>
      )}

      {approval.state !== 'done' && approval.state !== 'unlocking' && (
        <p className="flex flex-wrap items-center gap-x-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
          <Button className="h-auto px-0" onClick={onUseKey} size="sm" variant="text">
            {copy.useKey}
          </Button>
          <span aria-hidden="true">·</span>
          <Button className="h-auto px-0" onClick={onNoDevice} size="sm" variant="text">
            {copy.noOtherDevice}
          </Button>
        </p>
      )}
    </div>
  )
}

/**
 * The approving side (electron/matrix/device-approval.ts): another of the person's devices asks
 * to be let in. Three complete number codes, one of them the code on that device's screen; the
 * person taps it, and the rows go: the sheet says to tap "I picked this code" on that device.
 * Any other, or none, refuses, and so does "This wasn't me"; both offer to sign that device out.
 * A comparison that took too long offers Try again here too.
 * Atum never asks for this by phone or message, and the sheet says so.
 */
export function MatrixApprovalSheet({
  open: shown,
  snapshot
}: {
  /** Whether the sheet is shown (attention-indicator.tsx: from the indicator, or by itself while
   * the window is in front); absent, it shows whenever another device asks. */
  open?: boolean
  snapshot: Pick<MatrixSnapshot, 'security'>
}) {
  const copy = useApprovalCopy()
  const approval = snapshot.security?.approval
  const open = approval?.role === 'approve' && (shown ?? true)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const bridge = window.atumMatrix?.approval
  const name = approval?.deviceName ?? copy.newDevice

  useEffect(() => {
    setFailed(false)
    setPending(false)
  }, [approval?.state])

  const run = (work: () => Promise<unknown> | undefined) => {
    setPending(true)
    setFailed(false)
    void Promise.resolve(work())
      .catch(() => setFailed(true))
      .finally(() => setPending(false))
  }

  const close = () => run(() => bridge?.dismiss())
  const content = useRef<HTMLDivElement>(null)
  const live = approval && ['asked', 'waiting', 'compare', 'unlocking'].includes(approval.state)

  return (
    <Dialog onOpenChange={value => !value && !pending && close()} open={open}>
      <DialogContent
        className="atum-sheet max-w-[28rem]"
        data-matrix-approval-sheet={approval?.state}
        // It opens by itself: the question takes focus, never a code (a stray Enter must not
        // answer for the person).
        onOpenAutoFocus={event => {
          event.preventDefault()
          content.current?.focus({ preventScroll: true })
        }}
        ref={content}
        showCloseButton={false}
        tabIndex={-1}
      >
        <DialogHeader>
          <DialogTitle>{copy.approveTitle}</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </DialogHeader>

        {approval?.state === 'asked' && <p className="mt-4 text-(--atum-ink-muted)">{copy.approveAsk}</p>}

        {approval?.state === 'waiting' && (
          <div className="mt-4 flex items-center gap-2 text-(--atum-ink-muted)" role="status">
            <Loader aria-hidden="true" className="size-4" role="presentation" size="sm" />
            {copy.approveWaiting}
          </div>
        )}

        {approval?.state === 'compare' && approval.choices && (
          <div className="mt-4 flex flex-col gap-4">
            <p className="text-(--atum-ink-muted)">{copy.approveBody}</p>
            <div className="flex flex-col items-center gap-2" role="group">
              {approval.choices.map((row, index) => (
                <button
                  aria-label={numberCodeLabel(row)}
                  className="atum-approval-choice"
                  data-matrix-approval-choice={index}
                  disabled={pending}
                  key={index}
                  onClick={() => run(() => bridge?.pick(index))}
                  type="button"
                >
                  {row.map((value, at) => (
                    <span aria-hidden="true" key={at}>
                      {String(value).padStart(4, '0')}
                    </span>
                  ))}
                </button>
              ))}
            </div>
            <Button disabled={pending} onClick={() => run(() => bridge?.pick(null))} variant="text">
              {copy.none}
            </Button>
          </div>
        )}

        {approval?.state === 'compare' && approval.picked && (
          <div
            className="mt-4 flex items-center gap-2 text-(--atum-ink-muted)"
            data-matrix-approval-tap-there
            role="status"
          >
            <Loader aria-hidden="true" className="size-4" role="presentation" size="sm" />
            {copy.approveTapThere(approval.deviceName)}
          </div>
        )}

        {approval?.state === 'unlocking' && (
          <div className="mt-4 flex items-center gap-2 text-(--atum-ink-muted)" role="status">
            <Loader aria-hidden="true" className="size-4" role="presentation" size="sm" />
            {copy.sending}
          </div>
        )}

        {approval?.state === 'done' && <p className="mt-4 text-(--atum-ink-muted)">{copy.approved(name)}</p>}
        {approval?.state === 'mismatch' && <p className="mt-4 text-(--atum-ink-muted)">{copy.approveMismatch}</p>}
        {approval?.state === 'declined' && <p className="mt-4 text-(--atum-ink-muted)">{copy.approveDeclined}</p>}
        {approval?.state === 'timeout' && <p className="mt-4 text-(--atum-ink-muted)">{copy.timeout}</p>}
        {approval?.state === 'failed' && (
          // What happened, by its closed reason, and one button. Never a button on the other
          // device, nor a promise that this Mac asks again.
          <p className="mt-4 text-(--atum-ink-muted)" data-matrix-approval-failed role="status">
            {approval.failure === 'there'
              ? copy.approveUnfinished(approval.deviceName)
              : copy.approveFailed(approval.deviceName)}
          </p>
        )}

        {failed && (
          <NoticeBand className="mt-3" role="status" tone="failure">
            {copy.actionFailed}
          </NoticeBand>
        )}

        {live && <p className="mt-4 text-(length:--atum-t-caption) text-(--atum-ink-faint)">{copy.footer}</p>}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {live ? (
            <>
              <Button disabled={pending} onClick={() => run(() => bridge?.decline())} variant="text">
                {copy.notMe}
              </Button>
              {approval?.state === 'asked' && (
                <Button disabled={pending} onClick={() => run(() => bridge?.accept())}>
                  {copy.itsMe}
                </Button>
              )}
            </>
          ) : (
            <>
              {(approval?.state === 'declined' || approval?.state === 'mismatch') && (
                <Button disabled={pending} onClick={() => run(() => bridge?.signOutDevice())} variant="secondary">
                  {copy.signThatOut}
                </Button>
              )}
              <Button disabled={pending} onClick={close} variant={approval?.state === 'timeout' ? 'text' : undefined}>
                {copy.close}
              </Button>
              {approval?.state === 'timeout' && (
                <Button data-matrix-approval-again disabled={pending} onClick={() => run(() => bridge?.retry())}>
                  {copy.tryAgain}
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
