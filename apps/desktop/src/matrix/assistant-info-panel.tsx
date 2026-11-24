import { type ReactNode, useId } from 'react'

import type { AtumShellFrameMotion } from '@/app/atum/shell-frame'
import { AtumWorkspaceSurface } from '@/app/atum/workspace-surface'
import { useI18n } from '@/i18n'
import { Info } from '@/lib/icons'

import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'

import { AssistantCard } from './assistant-card/assistant-card'
import { matrixRosterAgentName } from './roster-model'

interface PanelProps {
  agent: MatrixAgentView
  compact: boolean
  expanded: boolean
  motion: AtumShellFrameMotion
  onClose(): void
  onExpand(value: boolean): void
  onPercentChange(value: number): void
  percent: number
  snapshot: MatrixSnapshot
  windowControls: ReactNode
}

/**
 * Chat's neutral right panel in an assistant's chat (layout r2 §2): the assistant's own card, the
 * same `AssistantCard` the sheet shows, so the primary assistant keeps every row other assistants
 * have plus its own (Check-ins, the main badge) and nothing is hidden here that the sheet shows.
 * Only the sheet's chrome goes: the panel's × closes it, and you are already in the chat.
 */
export function MatrixAssistantInfoPanel({
  agent,
  compact,
  expanded,
  motion,
  onClose,
  onExpand,
  onPercentChange,
  percent,
  snapshot,
  windowControls
}: PanelProps) {
  const { t } = useI18n()
  const panelId = useId()
  const name = matrixRosterAgentName(agent, t.matrixShell.assistantName)

  return (
    <AtumWorkspaceSurface
      activeId="assistant"
      drawer={compact}
      fullFrame={expanded}
      hidden={false}
      motionPhase={motion.phase}
      onActivate={() => {}}
      onClose={onClose}
      onCloseTab={onClose}
      onExpand={onExpand}
      onMotionEnd={motion.finishExit}
      onPercentChange={onPercentChange}
      panelId={panelId}
      percent={percent}
      tabs={[
        {
          id: 'assistant',
          title: name,
          icon: <Info aria-hidden className="size-3.5" />,
          pinned: true
        }
      ]}
      windowControls={windowControls}
    >
      <div className="atum-assistant-panel h-full min-h-0 overflow-y-auto pb-6" data-matrix-assistant-info={agent.principal}>
        <AssistantCard
          agent={agent}
          compact
          focusName={false}
          key={agent.principal}
          onClose={onClose}
          onMessage={onClose}
          placement="panel"
          snapshot={snapshot}
        />
      </div>
    </AtumWorkspaceSurface>
  )
}
