import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type { MatrixMessage } from '../../shared/matrix'
import type { MatrixCompanyActivityItem } from '../../shared/matrix-company-activity'
import { type MatrixCompanyBoardCopy, matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'

import { companyAIAnswerProjection } from './company-ai-answer'
import type { CompanyAIView } from './company-desktop-adapter'
import { $companyWalletScope, companySpaceScope } from './company-space-store'
import { requestTeamSpaceIntent } from './team-space/intents'

export type CompanyAIThreadStatus = 'unfunded' | 'stopped' | 'couldnt_confirm' | 'failed'

/**
 * The lines a Chief of Staff task ends with when it has no answer. The cloud controller seals the
 * code into its outbox and publishes only this frozen English sentence as the thread reply
 * (`apps/desktop/shared/matrix-company-ai-status.tscompanyAIStatusText`), so the app reads the
 * code back from the exact sentence and says it in the reader's language.
 */
const COMPANY_AI_THREAD_LINES: ReadonlyMap<string, CompanyAIThreadStatus> = new Map([
  ['Company AI needs Protons.', 'unfunded'],
  ['Stopped.', 'stopped'],
  ["Company AI couldn't confirm this answer.", 'couldnt_confirm'],
  ['Company AI is unavailable.', 'failed']
])

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function companyAIThreadStatusShown(status: CompanyAIThreadStatus): boolean {
  return status !== 'couldnt_confirm'
}

/**
 * Display only: an Activity entry that is one of the Chief of Staff's status-only lines that show
 * nothing (couldnt_confirm), under the same scope as the room: a thread reply from the company's own
 * Chief of Staff in its channel, or a message from the bound private agent in the private room. An
 * entry carrying an answer projection is an answer, whatever its text, and always stays.
 */
export function companyAIActivityStatusHidden(
  item: Pick<MatrixCompanyActivityItem, 'body' | 'companyAIAnswer' | 'roomId' | 'senderId' | 'threadRootId'>,
  scope: {
    /** The company's Chief of Staff, when the entry's room is one of that company's channels. */
    channelAgentUserId?: string
    /** The bound private Chief of Staff room and its agent. */
    privateCos?: { roomId: string; agentUserId: string }
  }
): boolean {
  const status = item.companyAIAnswer ? undefined : COMPANY_AI_THREAD_LINES.get(item.body.trim())

  if (!status || companyAIThreadStatusShown(status)) {
    return false
  }

  const channelReply = Boolean(item.threadRootId && scope.channelAgentUserId && item.senderId === scope.channelAgentUserId)

  const privateReply = Boolean(
    scope.privateCos && item.roomId === scope.privateCos.roomId && item.senderId === scope.privateCos.agentUserId
  )

  return channelReply || privateReply
}

/** Display only: a thread reply from this company's own Chief of Staff carrying one of its status lines. */
export function companyAIThreadStatus(
  message: Pick<MatrixMessage, 'body' | 'redacted' | 'sender' | 'thread'>,
  view: Pick<CompanyAIView, 'agent'> | undefined
): CompanyAIThreadStatus | undefined {
  // A reply carrying an answer projection is an answer, even when its text matches a status line.
  if (!view || message.redacted || !message.thread || message.sender !== view.agent.userId ||
    companyAIAnswerProjection(message)) {
    return undefined
  }

  return COMPANY_AI_THREAD_LINES.get(message.body.trim())
}

/** Display only: a message from the platform-bound private agent carrying one frozen status line. */
export function companyAIPrivateCosStatus(
  message: Pick<MatrixMessage, 'body' | 'redacted' | 'sender'>,
  agentUserId: string | undefined
): CompanyAIThreadStatus | undefined {
  if (!agentUserId || message.redacted || message.sender !== agentUserId || companyAIAnswerProjection(message)) {
    return undefined
  }

  return COMPANY_AI_THREAD_LINES.get(message.body.trim())
}

export function companyAIThreadStatusText(status: CompanyAIThreadStatus, copy: MatrixCompanyBoardCopy): string {
  switch (status) {
    case 'unfunded':
      return copy.chiefNeedsProtons

    case 'stopped':
      return copy.chiefStopped

    case 'couldnt_confirm':
      return ''

    case 'failed':
      return copy.chiefFailed
  }
}

/**
 * The line in the thread. Out of Protons, someone the workspace will show the company wallet to gets it
 * one click away; anyone else is told who can fix it. Both read the workspace's own wallet gate.
 */
export function CompanyAIThreadStatusLine({
  accountKey,
  companyId,
  status
}: {
  accountKey: string
  companyId: string
  status: CompanyAIThreadStatus
}) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const walletScope = useStore($companyWalletScope)
  const canTopUp = Boolean(companyId) && walletScope === companySpaceScope(accountKey, companyId)

  if (!companyAIThreadStatusShown(status)) {
    return null
  }

  return (
    <>
      {companyAIThreadStatusText(status, copy)}
      {status === 'unfunded' &&
        (canTopUp ? (
          <Button
            className="ms-2"
            onClick={() => requestTeamSpaceIntent({ kind: 'open-wallet', companyId })}
            size="sm"
            type="button"
            variant="text"
          >
            {copy.topUp}
          </Button>
        ) : (
          ` ${copy.askOwnerProtons}`
        ))}
    </>
  )
}
