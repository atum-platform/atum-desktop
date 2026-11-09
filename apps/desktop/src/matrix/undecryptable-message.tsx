import { Button } from '@/components/ui/button'

import { matrixDecryptionAction, type MatrixDecryptionReason } from '../../shared/matrix-decryption-reason'

import { matrixChatCopy } from './chat-copy'

export interface MatrixUndecryptableMessageProps {
  reason: MatrixDecryptionReason
  locale: string
  senderName?: string
  backupAvailable: boolean
  onRestore?: () => void
  onDevices?: () => void
  onVerify?: () => void
  onReview?: () => void
}

export function MatrixUndecryptableMessage({
  reason,
  locale,
  senderName,
  backupAvailable,
  onRestore,
  onDevices,
  onVerify,
  onReview
}: MatrixUndecryptableMessageProps) {
  const copy = matrixChatCopy(locale).decryption
  const action = matrixDecryptionAction(reason, backupAvailable)

  const handler = {
    restore: onRestore,
    devices: onDevices,
    verify: onVerify,
    review: onReview,
    none: undefined
  }[action]

  const text =
    reason === 'sender_identity_changed' && senderName ? copy.identityChanged(senderName) : copy.reasons[reason]

  return (
    <p className="flex flex-wrap items-center gap-x-(--ak-s2) [font:var(--ak-t-body)] text-(--ak-ink-3)" data-matrix-undecryptable>
      <span>{text}</span>
      {action !== 'none' && handler && (
        <Button onClick={handler} size="inline" variant="textStrong">
          {copy.actions[action]}
        </Button>
      )}
    </p>
  )
}
