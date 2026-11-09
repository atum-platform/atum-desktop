import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { useI18n } from '@/i18n'

import { appLocalizedCopy } from '../../../shared/app-catalog'
import type { MatrixSnapshot } from '../../../shared/matrix'
import { matrixRosterAgentName } from '../roster-model'
import { runMatrixCommand } from '../text-document-actions'

import { AppCard } from './app-card'
import { AssistantCard, AssistantCardSheet, openAssistantChat } from './assistant-card'
import { useAssistantCardCopy } from './copy'
import { $assistantCard, closeAssistantCard } from './store'

export { $assistantCard, $assistantNameOverrides, openAssistantCard, settleAssistantNames, withAssistantNames } from './store'

/**
 * The one card, wherever it was opened from (a roster row's menu, ⌘I, the chat header, an
 * app's "Info"). It follows the snapshot: an assistant that is deleted or leaves the roster
 * takes its card with it.
 */
export function AssistantCardHost({
  compact,
  openChat,
  snapshot
}: {
  compact: boolean
  /** The roster's own way to open (or start) an assistant's chat. */
  openChat?: ((fresh?: boolean, agentId?: string, roomId?: string) => Promise<void>) | null
  snapshot: MatrixSnapshot
}) {
  const target = useStore($assistantCard)
  const copy = useAssistantCardCopy()
  const { locale, t } = useI18n()

  const agent =
    target?.kind === 'agent' ? snapshot.agents?.find(each => each.principal === target.principal) : undefined

  const app = target?.kind === 'app' ? snapshot.apps?.apps.find(each => each.app_id === target.appId) : undefined
  const missing = Boolean(target) && !agent && !app

  // Its assistant is gone (deleted, signed out): the card goes too.
  useEffect(() => {
    if (missing) {
      closeAssistantCard()
    }
  }, [missing])

  if (agent) {
    const name = matrixRosterAgentName(agent, t.matrixShell.assistantName)
    const focusRoutines = target?.kind === 'agent' && target.focus === 'routines'

    return (
      <AssistantCardSheet
        compact={compact}
        focusName={target?.kind === 'agent' && target.focus === 'name'}
        label={copy.sheetLabel(name)}
        onClose={closeAssistantCard}
        open
      >
        <AssistantCard
          agent={agent}
          compact={compact}
          focusName={target?.kind === 'agent' && target.focus === 'name'}
          focusRoutines={focusRoutines}
          key={agent.principal}
          onClose={closeAssistantCard}
          onMessage={() => {
            closeAssistantCard()
            openAssistantChat(agent, snapshot, openChat)
          }}
          snapshot={snapshot}
        />
      </AssistantCardSheet>
    )
  }

  if (app) {
    const name = appLocalizedCopy(app.name, locale, app.app)

    return (
      <AssistantCardSheet compact={compact} label={copy.sheetLabel(name)} onClose={closeAssistantCard} open>
        <AppCard
          app={app}
          compact={compact}
          onClose={closeAssistantCard}
          onOpen={() => {
            closeAssistantCard()
            void runMatrixCommand({ kind: 'selectApp', appId: app.app_id }).catch(() => {})
          }}
        />
      </AssistantCardSheet>
    )
  }

  return null
}
