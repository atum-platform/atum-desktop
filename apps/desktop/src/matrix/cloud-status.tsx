import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { matrixAgentAccessBandText } from '../../shared/matrix-agent-access-band-copy'

import { useMatrixCloudAccess } from './cloud-access'

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
 * Why a cloud assistant cannot answer while the account's access has ended, in the app's own
 * words: the same reason sentence and the one remedy its in-chat notice uses. One read serves
 * every cloud surface (`cloud-access.ts`); a Mac-run assistant never asks for it and never shows
 * this band.
 */
export function MatrixCloudAccessBand({ agent }: { agent: MatrixAgentView }) {
  const { locale } = useI18n()
  const enabled = agent.answering === 'cloud' && agent.macRole !== 'answering'
  const access = useMatrixCloudAccess(enabled)

  if (!enabled || access?.effective !== 'none') {
    return null
  }

  return (
    <NoticeBand data-matrix-cloud-access tone="notice">
      {matrixAgentAccessBandText(access.reason, locale)}
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
