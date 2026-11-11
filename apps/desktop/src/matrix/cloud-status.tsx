import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { matrixFundsCopy } from '../../shared/matrix-funds-copy'

import { useMatrixCloudAccess } from './cloud-access'
import { FundsLine } from './funds/funds-line'
import { openFundsTopUp } from './funds/top-up-request'

/**
 * Only the roster's answering fact labels a chat as cloud; local readiness is separate. A Mac that
 * holds the agent's term under the saved policy (`macRole: 'answering'`) answers it itself, with
 * the ordinary local path for a linked document and no cloud service to wait on (R5): the chat is
 * not "the cloud's" then, whatever the roster's route flag says.
 */
export function cloudRoomAgent(snapshot: MatrixSnapshot, room: MatrixRoom): MatrixAgentView | undefined {
  return room.assistant
    ? snapshot.agents?.find(
        agent => agent.principal === room.agentPrincipal && agent.answering === 'cloud' && agent.macRole !== 'answering'
      )
    : undefined
}

/**
 * Why a cloud assistant cannot answer while the account has no Protons to spend: one quiet line and
 * the one thing to do, Add Protons, which opens the top-up in place. Every reason the access read
 * gives here is an empty wallet now (the cloud trial is gone). One read serves every cloud surface
 * (`cloud-access.ts`); a Mac-run assistant never asks for it and never shows this band.
 */
export function MatrixCloudAccessBand({ agent }: { agent: MatrixAgentView }) {
  const { locale } = useI18n()
  const copy = matrixFundsCopy(locale)
  const enabled = agent.answering === 'cloud' && agent.macRole !== 'answering'
  const access = useMatrixCloudAccess(enabled)

  if (!enabled || access?.effective !== 'none') {
    return null
  }

  return (
    <NoticeBand data-matrix-cloud-access tone="notice">
      <FundsLine action={copy.addProtons} onAction={() => openFundsTopUp()} text={copy.outOfProtonsPaused} />
    </NoticeBand>
  )
}

/**
 * A cloud assistant in a chat with a linked Word document: the composer is paused (app.tsx),
 * and this says why and what to do instead, without saying where the assistant answers.
 */
export function LinkedDocumentNotice({ snapshot, room }: { snapshot: MatrixSnapshot; room: MatrixRoom }) {
  const { t } = useI18n()

  if (!snapshot.linkedDocument || !cloudRoomAgent(snapshot, room)) {
    return null
  }

  return (
    <NoticeBand data-linked-document-notice tone="notice">
      {t.cloud.wordRefusal}
    </NoticeBand>
  )
}
