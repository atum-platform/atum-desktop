import { type ReactNode, useId } from 'react'

import type { AtumShellFrameMotion } from '@/app/atum/shell-frame'
import { AtumWorkspaceSurface } from '@/app/atum/workspace-surface'
import { useI18n } from '@/i18n'
import { Info } from '@/lib/icons'

import { rosterConversationRoom } from '../../shared/agent-conversation'
import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { isAssistantRoom } from '../../shared/matrix-assistant-room'

import { MatrixAgentDeskFiles, MatrixAgentDeskNowSection, useMatrixAgentDesk } from './agent-desk'
import { matrixAgentDeskAgent } from './agent-desk-model'
import { useAssistantCardControls } from './assistant-card/agent-controls'
import { AssistantCard } from './assistant-card/assistant-card'
import { resolveProjectedConversation } from './conversation-marker'
import { matrixAgentTyping } from './local-turns'
import { roomAgentActivity } from './room-agent'
import { matrixRosterAgentName } from './roster-model'
import { useMatrixCloudStop } from './use-cloud-stop'

/**
 * The chat an assistant's card opens beside (one card place, owner 2026-11-26), resolved exactly as
 * the roster opens that assistant (app.tsx `openAssistant`): its marked main conversation first, else
 * the open chat when it is one of its 1:1s, else its latest. Only a chat whose panel shows this agent
 * (`matrixAgentDeskAgent`, what the window's panel reads) counts, so a request always has a panel to open.
 * None (it has no such chat yet): the sheet.
 */
export function matrixAssistantPanelRoom(
  snapshot: Pick<MatrixSnapshot, 'agents' | 'identity' | 'roomId' | 'rooms'>,
  principal: string
): MatrixRoom | undefined {
  const ownerId = snapshot.identity?.userId
  const agentId = snapshot.agents?.find(each => each.principal === principal)?.userId

  if (!ownerId || !agentId) {
    return undefined
  }

  const rooms = snapshot.rooms.filter(
    room =>
      isAssistantRoom(room, ownerId, agentId) && matrixAgentDeskAgent(snapshot as MatrixSnapshot, room)?.principal === principal
  )

  return rosterConversationRoom(rooms, snapshot.roomId, resolveProjectedConversation(rooms, ownerId, agentId).main)
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
  // The room's own agent activity (room-agent.ts), so another Mac-run agent's work shows here too.
  const running = roomAgentActivity(snapshot, room.id)?.state === 'running'

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
  const controls = useAssistantCardControls({ active: true, agent, desk, room })

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
          controls={controls}
          focusName={focus === 'name'}
          focusRoutines={focus === 'routines'}
          key={`${agent.principal}:${focus ?? ''}`}
          lead={<MatrixAgentDeskNowSection cloudStop={cloudStop} desk={desk} />}
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
