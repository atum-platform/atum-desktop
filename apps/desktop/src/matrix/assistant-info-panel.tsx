import { type ReactNode, useId } from 'react'

import type { AtumShellFrameMotion } from '@/app/atum/shell-frame'
import { AtumWorkspaceSurface } from '@/app/atum/workspace-surface'
import { useI18n } from '@/i18n'
import { Info } from '@/lib/icons'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import { MatrixAgentDeskFiles, MatrixAgentDeskNow, useMatrixAgentDesk } from './agent-desk'
import { matrixAgentDeskAgent } from './agent-desk-model'
import { AssistantCardControls } from './assistant-card/agent-controls'
import { AssistantCard } from './assistant-card/assistant-card'
import { matrixAgentTyping } from './local-turns'
import { matrixRosterAgentName } from './roster-model'
import { useMatrixCloudStop } from './use-cloud-stop'

/**
 * The chat an assistant's card opens beside (one card place, owner 2026-11-26): the open chat when it
 * is the owner's own 1:1 with it, else its most recent one. None (it has no chat yet): the sheet.
 */
export function matrixAssistantPanelRoom(
  snapshot: Pick<MatrixSnapshot, 'agents' | 'identity' | 'roomId' | 'rooms'>,
  principal: string
): MatrixRoom | undefined {
  const own = snapshot.rooms.filter(
    each =>
      each.agentPrincipal === principal &&
      each.membership === 'join' &&
      !each.appBot &&
      matrixAgentDeskAgent(snapshot as MatrixSnapshot, each)?.principal === principal
  )

  return own.find(each => each.id === snapshot.roomId) ?? own.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
}

interface PanelProps {
  agent: MatrixAgentView
  compact: boolean
  expanded: boolean
  /** Opened for a field: its name to rename, or its routines (the composer's "Add routines"). */
  focus?: 'name' | 'routines'
  motion: AtumShellFrameMotion
  onClose(): void
  onExpand(value: boolean): void
  onPercentChange(value: number): void
  percent: number
  room: MatrixRoom
  snapshot: MatrixSnapshot
  windowControls: ReactNode
}

/**
 * Chat's neutral right panel in an assistant's chat (layout r2 §2): the assistant's one place. Its
 * card (every row the sheet has, so the primary keeps its own) with the desk's live parts folded in
 * (owner 2026-11-26): what it is doing now while it works or waits, this chat's notifications, your
 * devices it can use, Pause, and its files when it has sent some. Clicking its name or face in the
 * chat opens this panel, not a second sheet. Only the sheet's chrome goes: the panel's × closes it.
 */
export function MatrixAssistantInfoPanel({
  agent,
  compact,
  expanded,
  focus,
  motion,
  onClose,
  onExpand,
  onPercentChange,
  percent,
  room,
  snapshot,
  windowControls
}: PanelProps) {
  const { t } = useI18n()
  const panelId = useId()
  const name = matrixRosterAgentName(agent, t.matrixShell.assistantName)
  const running = snapshot.hermesActivity?.roomId === room.id && snapshot.hermesActivity.state === 'running'

  // The composer's own Stop, as the desk uses it: one hook over the same chat signals.
  const cloudStop = useMatrixCloudStop({
    messages: snapshot.messages,
    room,
    snapshot,
    working: matrixAgentTyping({
      roomId: room.id,
      agentId: agent.userId,
      typing: snapshot.typing,
      turns: snapshot.localTurns,
      running
    })
  })

  const desk = useMatrixAgentDesk({ active: true, agent, cloudStop, room, snapshot })

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
          controls={<AssistantCardControls active agent={agent} desk={desk} room={room} />}
          focusName={focus === 'name'}
          focusRoutines={focus === 'routines'}
          key={`${agent.principal}:${focus ?? ''}`}
          lead={<MatrixAgentDeskNow cloudStop={cloudStop} desk={desk} />}
          onClose={onClose}
          onMessage={onClose}
          placement="panel"
          snapshot={snapshot}
          trail={<MatrixAgentDeskFiles active agent={agent} desk={desk} roomId={room.id} />}
        />
      </div>
    </AtumWorkspaceSurface>
  )
}
