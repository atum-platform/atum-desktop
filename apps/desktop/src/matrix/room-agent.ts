import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'
import { isAssistantRoom, matrixPrimaryAgent } from '../../shared/matrix-assistant-room'

import { resolveProjectedConversation } from './conversation-marker'

/** Platform default role wins; the singular user is an older-snapshot fallback. */
export function primaryAgent(snapshot: MatrixSnapshot): MatrixAgentView | undefined {
  return matrixPrimaryAgent(snapshot)
}

/** The person's other agents, in roster order (the default agent has its own row). */
export function otherAgents(snapshot: MatrixSnapshot): MatrixAgentView[] {
  const primary = primaryAgent(snapshot)

  return (snapshot.agents ?? []).filter(agent => agent !== primary)
}

/** The agent's own room with the owner, as main named it. */
export function agentRoomId(snapshot: MatrixSnapshot, principal: string): string | undefined {
  const agent = snapshot.agents?.find(each => each.principal === principal)
  const resolution = resolveProjectedConversation(snapshot.rooms, snapshot.identity?.userId, agent?.userId)

  return resolution.main ?? snapshot.rooms.find(room => room.agentPrincipal === principal && room.membership === 'join')?.id
}

/**
 * The snapshot as the selected room's agent sees it (
 * §2.8). In another agent's room, that agent's user, readiness, backend, model, setup, room
 * watch and work in progress take the place of the default agent's singular fields, so the
 * conversation reads one shape. A cloud primary without local enrollment uses the same
 * projection. Anywhere else the snapshot is returned as it is.
 */
export function snapshotForRoom(snapshot: MatrixSnapshot): MatrixSnapshot {
  const room = snapshot.rooms.find(each => each.id === snapshot.roomId)

  const agent = room?.agentPrincipal
    ? (otherAgents(snapshot).find(each => each.principal === room.agentPrincipal) ??
      // A cloud primary has no local enrollment to supply the singular assistant identity.
      (!snapshot.assistant
        ? snapshot.agents?.find(each => each.principal === room.agentPrincipal && each.answering === 'cloud')
        : undefined))
    : undefined

  if (!room || !agent) {
    return snapshot
  }

  const turn = snapshot.agentTurns?.find(each => each.roomId === room.id)

  return {
    ...snapshot,
    assistant: { userId: agent.userId, deviceId: agent.deviceId ?? '' },
    readiness: agent.readiness,
    hermes: agent.hermes,
    atumModel: agent.atumModel,
    // Another agent's own connection: its name for the picker.
    connectedModel: agent.connectedModel,
    localModel: agent.localModel,
    assistantSetup: agent.setup,
    hermesListening: agent.listening,
    hermesActivity: turn?.activity,
    hermesPrompts: turn?.prompts ? { roomId: room.id, prompts: turn.prompts } : undefined,
    hermesPromptNotice: turn?.notice,
    // An app's turn runs in its own room; it never pauses another agent's.
    appTurn: snapshot.appTurn?.roomId === room.id ? snapshot.appTurn : undefined
  }
}

/**
 * The native activity of one room's agent, as `snapshotForRoom` projects it: the singular field when it
 * names this room (the primary on this Mac), else that room's own `agentTurns[].activity` (another
 * Mac-run agent). The agent's desk and panel read this, so a secondary agent's work shows there too.
 */
export function roomAgentActivity(
  snapshot: Pick<MatrixSnapshot, 'agentTurns' | 'hermesActivity'>,
  roomId: string
): MatrixSnapshot['hermesActivity'] {
  return snapshot.hermesActivity?.roomId === roomId
    ? snapshot.hermesActivity
    : snapshot.agentTurns?.find(turn => turn.roomId === roomId)?.activity
}

/** Some agent is waiting for the person's input: native views step aside for the prompts. */
export function anyAgentPrompts(snapshot: MatrixSnapshot): boolean {
  return Boolean(
    snapshot.hermesPrompts?.prompts.length || snapshot.agentTurns?.some(turn => Boolean(turn.prompts?.length))
  )
}

/** A room nudge follows that room's assistant even after Main changes. */
export function assistantTarget(snapshot: MatrixSnapshot, agentId?: string, roomId?: string): string | undefined {
  if (!roomId) {return agentId ?? primaryAgent(snapshot)?.userId ?? snapshot.assistant?.userId}
  const room = snapshot.rooms.find(value => value.id === roomId)
  const agent = snapshot.agents?.find(value => room?.agentPrincipal === value.principal) ??
    snapshot.agents?.find(value => room && isAssistantRoom(room, snapshot.identity?.userId, value.userId))

  const target = agent?.userId ?? snapshot.assistant?.userId

  return room && isAssistantRoom(room, snapshot.identity?.userId, target) ? target : undefined
}
