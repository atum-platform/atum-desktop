import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { useI18n } from '@/i18n'
import { Check, Terminal, X } from '@/lib/icons'

import type { MatrixCommand, MatrixMessage } from '../../shared/matrix'
import type { MatrixNativeMacBridge } from '../../shared/matrix-native-mac'
import { matrixNativeMacCopy } from '../../shared/matrix-native-mac-copy'

/**
 * Native Hermes asks before a command its smart approvals judge dangerous and unclear. On Matrix its
 * gateway posts one message (a fenced command, its reason, the typed `!approve` / `!deny` hints) and
 * seeds the reactions that answer it (`plugins/platforms/matrix/adapter.py`). The window draws that
 * message as one card, and answers with the same reaction on the same event: no new protocol, and a
 * reaction answers exactly the prompt it sits on, never a newer one. Approving asks for Touch ID first.
 */
export const NATIVE_APPROVE_KEY = '✅'
export const NATIVE_DENY_KEY = '❌'
const DENY_KEYS = new Set(['❌', '❎'])
/** How long a fresh prompt may wait for the gateway to seed its reactions before it reads as closed. */
const SEEDING_MS = 15_000

export type MatrixNativeApprovalState = 'waiting' | 'arriving' | 'approved' | 'denied' | 'closed'

export interface MatrixNativeApproval {
  command: string
  /** Hermes's own words for why it asks, when it gave them. */
  reason?: string
  state: MatrixNativeApprovalState
}

/**
 * The approval this message is, or null. Language-free markers only: the gateway's typed commands
 * (never translated), one fenced block, and the answers its own sender seeded.
 */
export function matrixNativeApproval(message: MatrixMessage, now = Date.now()): MatrixNativeApproval | null {
  if (message.own || message.redacted || message.attachment || !message.id.startsWith('$')) {
    return null
  }

  const body = message.body

  if (!body.includes('`!approve') || !body.includes('`!deny`')) {
    return null
  }

  const fence = /```[^\n]*\n([\s\S]*?)\n?```[^\S\n]*\n?([^\n]*)/u.exec(body)
  const command = fence?.[1]?.trim()

  if (!command) {
    return null
  }

  const reasonLine = fence?.[2]?.trim() ?? ''
  const split = reasonLine.indexOf(': ')
  const reason = (split > 0 ? reasonLine.slice(split + 2) : reasonLine).trim()
  const reactions = message.reactions ?? []
  const own = (keys: (key: string) => boolean) => reactions.some(each => each.own && keys(each.key))
  const seeded = reactions.some(each => each.key === NATIVE_APPROVE_KEY && each.senders.includes(message.sender))

  const state: MatrixNativeApprovalState = own(key => key === NATIVE_APPROVE_KEY)
    ? 'approved'
    : own(key => DENY_KEYS.has(key))
      ? 'denied'
      : seeded
        ? 'waiting'
        : now - message.timestamp < SEEDING_MS
          ? 'arriving'
          : 'closed'

  return { command, ...(reason ? { reason } : {}), state }
}

type Phase = 'idle' | 'confirming' | 'sending' | 'failed' | 'unavailable'

/**
 * The card (Atum Kit Ask): what will run and where, the command on one line (all of it and the
 * reason one click away), Approve and Deny. Once answered it keeps one quiet line.
 */
export function MatrixNativeApprovalCard({
  approval,
  bridge = window.atumMatrix?.nativeMac,
  eventId,
  roomId,
  send = command => window.atumMatrix.command(command)
}: {
  approval: MatrixNativeApproval
  bridge?: MatrixNativeMacBridge
  eventId: string
  roomId: string
  send?: (command: MatrixCommand) => Promise<unknown>
}) {
  const { locale } = useI18n()
  const copy = matrixNativeMacCopy[locale].approval
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [answered, setAnswered] = useState<'approved' | 'denied'>()
  const detailsId = useId()
  const state = answered ?? approval.state

  const answer = async (key: string, result: 'approved' | 'denied') => {
    setPhase('sending')

    try {
      await send({ kind: 'react', roomId, eventId, key, reacted: true })
      setAnswered(result)
      setPhase('idle')
    } catch {
      setPhase('failed')
    }
  }

  const approve = async () => {
    if (!bridge) {
      setPhase('unavailable')

      return
    }

    setPhase('confirming')
    let presence: Awaited<ReturnType<MatrixNativeMacBridge['confirmCommand']>>

    try {
      presence = await bridge.confirmCommand(approval.command)
    } catch {
      presence = 'unavailable'
    }

    if (presence === 'confirmed') {
      await answer(NATIVE_APPROVE_KEY, 'approved')
    } else {
      setPhase(presence === 'unavailable' ? 'unavailable' : 'idle')
    }
  }

  const busy = phase === 'confirming' || phase === 'sending'
  const asking = state === 'waiting' || state === 'arriving'

  return (
    <section aria-label={copy.label} className="ak-ask w-full" data-matrix-native-approval={state}>
      <div className="ak-ask-head">
        <span className="ak-ask-mark">
          <Terminal aria-hidden className="ak-icon" />
        </span>
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
          <p className="ak-ask-title">{copy.title}</p>
          <button
            aria-controls={open ? detailsId : undefined}
            aria-expanded={open}
            aria-label={copy.showAll}
            className="ak-ask-body flex min-w-0 items-center gap-1 text-start"
            data-matrix-native-approval-toggle
            onClick={() => setOpen(value => !value)}
            type="button"
          >
            <code className="min-w-0 truncate font-mono" data-matrix-native-approval-command>
              {approval.command}
            </code>
            <DisclosureCaret className="shrink-0 text-(--ak-ink-3)" open={open} />
          </button>
        </div>
      </div>
      {open && (
        <div className="grid gap-(--ak-s2) ps-11" id={detailsId}>
          <pre
            className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-(--ak-r-md) bg-(--ak-sunk) px-(--ak-s3) py-(--ak-s2) font-mono [font-size:12px] text-(--ak-ink)"
            data-matrix-native-approval-full
          >
            {approval.command}
          </pre>
          {approval.reason && (
            <p className="[font:var(--ak-t-callout)] text-(--ak-ink-3)">
              {copy.why}: {approval.reason}
            </p>
          )}
        </div>
      )}
      <div className="ak-ask-actions items-center">
        {state === 'approved' ? (
          <span className="ak-ask-line ak-ask-line--ok" role="status">
            <Check aria-hidden className="ak-icon" />
            {copy.approved}
          </span>
        ) : state === 'denied' ? (
          <span className="ak-ask-line" role="status">
            <X aria-hidden className="ak-icon" />
            {copy.denied}
          </span>
        ) : state === 'closed' ? (
          <span className="ak-ask-line" role="status">{copy.closed}</span>
        ) : phase === 'confirming' ? (
          <span className="ak-ask-line" role="status">{copy.confirming}</span>
        ) : (
          <>
            {phase !== 'unavailable' && (
              <Button
                className="ak-btn ak-btn--primary ak-btn--sm"
                data-matrix-native-approval-approve
                disabled={busy || state !== 'waiting'}
                onClick={() => void approve()}
                size="sm"
              >
                {copy.approve}
              </Button>
            )}
            <Button
              className="ak-btn ak-btn--plain ak-btn--sm"
              data-matrix-native-approval-deny
              disabled={busy || state !== 'waiting'}
              onClick={() => void answer(NATIVE_DENY_KEY, 'denied')}
              size="sm"
              variant="text"
            >
              {copy.deny}
            </Button>
          </>
        )}
      </div>
      {asking && (phase === 'failed' || phase === 'unavailable') && (
        <p className="ps-11 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-matrix-native-approval-note role="status">
          {phase === 'failed' ? copy.sendFailed : copy.unavailable}
        </p>
      )}
    </section>
  )
}
