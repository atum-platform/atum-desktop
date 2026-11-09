import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'

import type {
  GroupAssistant,
  GroupMember,
  GroupOperationInput,
  GroupOperationResult,
  GroupReportReason,
  GroupRoom,
  GroupSpecialist
} from '../../../shared/atum-group-conversations'

export type GroupReportTarget =
  | { kind: 'member'; member: GroupMember }
  | { kind: 'specialist'; specialist: GroupSpecialist }
  | { kind: 'assistant'; assistant: GroupAssistant }
  | { kind: 'message'; label: string; messageId: string }

export type GroupReportInput = Extract<GroupOperationInput, { action: 'report' }>

export interface GroupRoomReportDialogProps {
  createOperationId: () => string
  onOpenChange: (open: boolean) => void
  onOperate: (input: GroupOperationInput) => Promise<GroupOperationResult>
  /** Parent-owned copy survives a close that unmounts this dialog. */
  onPendingReportChange?: (input: GroupReportInput | null) => void
  operationResults?: readonly GroupOperationResult[]
  open: boolean
  pendingReport?: GroupReportInput | null
  room: GroupRoom
  target: GroupReportTarget
}

const REASONS: readonly GroupReportReason[] = ['harassment', 'spam', 'unsafe', 'other']

/** Controlled member/message report dialog. Server selects evidence and result. */
export function GroupRoomReportDialog({
  createOperationId,
  onOpenChange,
  onOperate,
  onPendingReportChange,
  operationResults,
  open,
  pendingReport: controlledPendingReport,
  room,
  target
}: GroupRoomReportDialogProps) {
  const { t } = useI18n()
  const copy = t.dm.group.report
  const [reason, setReason] = useState<GroupReportReason>('harassment')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<GroupOperationResult | null>(null)
  const [failed, setFailed] = useState(false)
  const [localPendingReport, setLocalPendingReport] = useState<GroupReportInput | null>(null)
  const handledFinalResult = useRef('')

  const targetLabel =
    target.kind === 'member'
      ? target.member.displayName
      : target.kind === 'specialist'
        ? target.specialist.displayName
        : target.kind === 'assistant'
          ? target.assistant.displayName
          : target.label

  const pendingReport = controlledPendingReport ?? localPendingReport

  const persistedResult = pendingReport
    ? (operationResults?.find(candidate => candidate.operationId === pendingReport.clientOperationId) ?? null)
    : null

  const activeResult =
    persistedResult?.state === 'sent' ||
    persistedResult?.state === 'failed_terminal' ||
    persistedResult?.state === 'conflicted'
      ? persistedResult
      : (result ?? persistedResult)

  const setPendingReport = useCallback(
    (input: GroupReportInput | null) => {
      setLocalPendingReport(input)
      onPendingReportChange?.(input)
    },
    [onPendingReportChange]
  )

  useEffect(() => {
    if (!pendingReport || !activeResult) {
      return
    }

    const resolution = `${pendingReport.clientOperationId}:${activeResult.state}`

    if (handledFinalResult.current === resolution) {
      return
    }

    if (activeResult.state === 'sent') {
      handledFinalResult.current = resolution
      setPendingReport(null)
      setResult(null)
      setFailed(false)
      setReason('harassment')
      setNote('')
      onOpenChange(false)
    } else if (activeResult.state === 'failed_terminal' || activeResult.state === 'conflicted') {
      // A later edit is a new report intent and must receive a new operation ID.
      handledFinalResult.current = resolution
      setPendingReport(null)
    }
  }, [activeResult, onOpenChange, pendingReport, setPendingReport])

  const submit = async () => {
    if (pending) {
      return
    }

    const input: GroupReportInput =
      pendingReport ??
      (() => {
        const base = {
          action: 'report' as const,
          clientOperationId: createOperationId(),
          conversationId: room.conversationId,
          note: note.trim() || undefined,
          reason
        }

        return target.kind === 'member'
          ? { ...base, memberUserId: target.member.userId }
          : target.kind === 'specialist'
            ? { ...base, memberSpecialist: target.specialist.specialist }
            : target.kind === 'assistant'
              ? { ...base, memberAssistant: target.assistant.assistantId }
              : { ...base, messageId: target.messageId }
      })()

    setPending(true)
    setFailed(false)
    setResult(null)
    setPendingReport(input)

    try {
      const next = await onOperate(input)

      setResult(next)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent aria-busy={pending} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description(targetLabel)}</DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium text-(--atum-ink)">
            {copy.reason}
          </legend>
          {REASONS.map(value => (
            <label
              className="flex items-center gap-2 text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink)"
              key={value}
            >
              <input
                checked={reason === value}
                disabled={pending || Boolean(pendingReport)}
                name="atum-group-report-reason"
                onChange={() => setReason(value)}
                type="radio"
                value={value}
              />
              {copy.reasons[value]}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-1.5">
          <label
            className="text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium text-(--atum-ink)"
            htmlFor="atum-group-report-note"
          >
            {copy.note}
          </label>
          <Textarea
            disabled={pending || Boolean(pendingReport)}
            id="atum-group-report-note"
            onChange={event => setNote(event.target.value)}
            value={note}
          />
        </div>
        {pending && (
          <div className="flex items-center gap-2" role="status">
            <Spinner className="size-4 animate-spin" /> {copy.sending}
          </div>
        )}
        {activeResult && (
          <p
            role={activeResult.state === 'failed_terminal' || activeResult.state === 'conflicted' ? 'alert' : 'status'}
          >
            {activeResult.state === 'queued'
              ? copy.queued
              : activeResult.state === 'sent'
                ? copy.sent
                : activeResult.state === 'sending'
                  ? copy.sending
                  : copy.failed}
          </p>
        )}
        {failed && <ErrorBanner>{copy.failed}</ErrorBanner>}
        <DialogFooter>
          <Button disabled={pending} onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={pending} onClick={() => void submit()} size="sm" type="button">
            {pending ? copy.sending : copy.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
