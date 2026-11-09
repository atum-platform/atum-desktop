import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import type { MatrixCommand, MatrixIdentity, MatrixMessage, MatrixRoom, MatrixSdkCommand } from '../../shared/matrix'
import {
  companyPrivateCosMarked,
  isAgentCreatedAssistantInvitation,
  isAssistantRoom,
  MATRIX_ASSISTANT_ROOM_TYPE,
  withoutPersonalAgent
} from '../../shared/matrix-assistant-room'
import { MATRIX_GROUP_AGENT_LIMIT } from '../../shared/matrix-group-room'
import { resolveProjectedConversation } from '../../src/matrix/conversation-marker'

export interface AssistantInviteProjection {
  agentId: string
  hiddenRoomId: string
  mainRoomId?: string
}

/**
 * Reader identity is enrollment metadata, not the liveness of its SDK process. Each of the
 * owner's private rooms with one of their agents names that agent (display only).
 *
 * `assistant` marks the default assistant's own chats: the private room type, or an older
 * private chat made before that type (a direct room of just the owner and the assistant). A
 * group the assistant is a member of is a group: marking it would drop it from the groups
 * list and give it the assistant's composer. A company's private Chief of Staff room shares the
 * room type but is the company's (its marker wins): never marked, never given a personal agent.
 */
export function assistantRooms(
  rooms: MatrixRoom[],
  assistant?: MatrixIdentity,
  agents: ReadonlyArray<{ principal: string; userId: string }> = [],
  ownerId?: string
): MatrixRoom[] {
  const agentIds = new Set([
    ...agents.map(agent => agent.userId),
    ...(assistant?.userId ? [assistant.userId] : [])
  ])

  const visibleRooms = AGENT_ONE_CONVERSATION
    ? rooms.filter(
        room => ![...agentIds].some(agentId => isAgentCreatedAssistantInvitation(room, ownerId, agentId))
      )
    : rooms

  return visibleRooms.map(room => {
    if (companyPrivateCosMarked(room)) {
      return { ...withoutPersonalAgent(room), assistant: false }
    }

    const agent = agents.find(each => isAssistantRoom(room, ownerId, each.userId))
    const participants = (room.participants ?? []).filter(member => ['join', 'invite'].includes(member.membership))

    return {
      ...room,
      assistant:
        (room.roomType === MATRIX_ASSISTANT_ROOM_TYPE && room.membership === 'join') ||
        Boolean(
          assistant &&
          !room.roomType &&
          room.direct &&
          participants.length === 2 &&
          participants.some(member => member.userId === assistant.userId)
        ),
      ...(agent ? { agentPrincipal: agent.principal } : {})
    }
  })
}

/** Count only known agent invitations that coexist with a joined room for the same pair. */
export function assistantInviteCoexistences(
  rooms: readonly MatrixRoom[],
  projected: readonly MatrixRoom[],
  agents: ReadonlyArray<{ principal: string; userId: string }>,
  ownerId?: string
): number {
  return agents.filter(
    agent =>
      rooms.some(room => isAgentCreatedAssistantInvitation(room, ownerId, agent.userId)) &&
      projected.some(room => isAssistantRoom(room, ownerId, agent.userId))
  ).length
}

/**
 * A selected controller invitation stays out of the renderer and names the joined conversation
 * main should select instead. The SDK selection is changed by main; this helper never fabricates
 * the joined room's messages under the invitation's selection.
 */
export function projectAssistantRooms(
  rooms: MatrixRoom[],
  selectedRoomId: string | null,
  assistant?: MatrixIdentity,
  agents: ReadonlyArray<{ principal: string; userId: string }> = [],
  ownerId?: string
): { rooms: MatrixRoom[]; roomId: string | null; hiddenInvite?: AssistantInviteProjection } {
  const projected = assistantRooms(rooms, assistant, agents, ownerId)

  if (!selectedRoomId || projected.some(room => room.id === selectedRoomId)) {
    return { rooms: projected, roomId: selectedRoomId }
  }

  const hidden = rooms.find(room => room.id === selectedRoomId)
  const agent = agents.find(each => Boolean(hidden && isAgentCreatedAssistantInvitation(hidden, ownerId, each.userId)))

  if (!agent) {
    return { rooms: projected, roomId: selectedRoomId }
  }

  const joined = projected.filter(room => isAssistantRoom(room, ownerId, agent.userId))
  const mainRoomId =
    resolveProjectedConversation(joined, ownerId, agent.userId).main ??
    [...joined].sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0) || left.id.localeCompare(right.id))[0]
      ?.id

  return {
    rooms: projected,
    roomId: null,
    hiddenInvite: {
      agentId: agent.userId,
      hiddenRoomId: selectedRoomId,
      ...(mainRoomId ? { mainRoomId } : {})
    }
  }
}

/** Placed/pending-trust agents are cloud-owned before the roster says `answering: cloud`. */
export function assistantInviteAdoptionEnabled(input: { cloud: boolean; cloudOnly: boolean }): boolean {
  return input.cloud || input.cloudOnly
}

/**
 * What a command from the owner's window becomes on the owner's SDK. The owner's own
 * assistants (`agentId`, the default one, and `enrolledAgentIds`) are never invited as people:
 *
 * - a direct room with one of them is its private room (`createAssistant`);
 * - a group with some of them, at most MATRIX_GROUP_AGENT_LIMIT, is `createGroup`, and main
 *   then has each one join (owner-only by construction: this is the owner's own window, and
 *   only their enrolled assistants are recognised);
 * - inviting one of them to a group is `inviteAgent`, which the SDK checks is an ordinary
 *   group with room for another assistant;
 * - inviting anyone else is `inviteHuman`, which refuses their private rooms and any room
 *   that would show a newcomer an assistant's earlier transcript.
 */
export function assistantCommand(
  command: MatrixCommand,
  agentId?: string,
  domainOperation = false,
  enrolledAgentIds: readonly string[] = [],
  cloudAgentIds: readonly string[] = []
): MatrixSdkCommand {
  const agents = [...new Set([agentId, ...enrolledAgentIds].filter((id): id is string => Boolean(id)))]
  const own = (id: string) => agents.includes(id)

  if (command.kind === 'create' && command.invite.some(own)) {
    if (domainOperation) {
      throw new Error('matrix_not_ready')
    }

    if (command.direct) {
      if (command.invite.length !== 1) {
        throw new Error('matrix_private_assistant_room_required')
      }

      return {
        ...command,
        kind: 'createAssistant',
        direct: true,
        ...(AGENT_ONE_CONVERSATION && cloudAgentIds.includes(command.invite[0]!) ? { adoptAgentInvite: true } : {})
      }
    }

    const members = [...new Set(command.invite.filter(own))]

    if (members.length > MATRIX_GROUP_AGENT_LIMIT) {
      throw new Error('matrix_group_agents_full')
    }

    return { kind: 'createGroup', name: command.name, invite: command.invite.filter(id => !own(id)), agents: members }
  }

  if (command.kind === 'invite' && own(command.userId)) {
    if (domainOperation) {
      throw new Error('matrix_not_ready')
    }

    return { kind: 'inviteAgent', roomId: command.roomId, userId: command.userId, agentIds: agents }
  }

  // The marker survives enrollment removal; the invitation check must too.
  return command.kind === 'invite' ? { ...command, kind: 'inviteHuman', agentId, agentIds: agents } : command
}

export function assistantBlocked(input: {
  operation: boolean
  domainOperation: boolean
  invocation: boolean
  closing: boolean
  ready: boolean
  agentReady: boolean
  listening: boolean
  fromListener?: boolean
}) {
  return (
    input.operation ||
    input.domainOperation ||
    input.invocation ||
    input.closing ||
    !input.ready ||
    !input.agentReady ||
    (input.listening && !input.fromListener)
  )
}

export function assistantRoomInvalidated(
  rooms: MatrixRoom[],
  roomId: string | undefined,
  ownerId: string,
  agentId?: string
) {
  return Boolean(
    roomId && agentId && !rooms.some(room => room.id === roomId && isAssistantRoom(room, ownerId, agentId))
  )
}

/**
 * Running one of the person's messages in place (`invokeHermes`, the transcript's Retry on
 * the server path) is for their own message in their private chat with that agent, open on
 * screen, settled and readable, not a local-path turn and not answered yet. Returns the
 * closed code that refuses it, or null.
 *
 * This reads display state, so it can only refuse: the run itself re-reads the event and its
 * verified sender through the owner's SDK, checks the room again and claims the message once
 * on the ledger before anything executes (invocation.ts).
 */
export function matrixExplicitInvocationRefusal(input: {
  roomId: string
  eventId: string
  ownerUserId: string
  agentUserId: string
  selectedRoomId?: null | string
  rooms: readonly MatrixRoom[]
  messages: readonly MatrixMessage[]
}): null | string {
  const room = input.rooms.find(value => value.id === input.roomId)

  if (!room || !isAssistantRoom(room, input.ownerUserId, input.agentUserId)) {
    return 'matrix_private_assistant_room_required'
  }

  // The message is checked where it is shown: in the chat that is open.
  if (input.selectedRoomId !== input.roomId) {
    return 'matrix_not_ready'
  }

  const message = input.messages.find(value => value.id === input.eventId)

  if (
    !message ||
    !message.own ||
    message.sender !== input.ownerUserId ||
    message.pending ||
    message.failed ||
    message.redacted ||
    message.decryptionFailed ||
    message.turn !== undefined
  ) {
    return 'matrix_invocation_untrusted'
  }

  // Answered: the agent's reply names it, as the transcript reads it. A notice is not an
  // answer (the agent saying it held this message): it can still run in place.
  if (
    input.messages.some(
      value => !value.own && !value.notice && (value.replyTo === input.eventId || value.resultFor === input.eventId)
    )
  ) {
    return 'matrix_invocation_answered'
  }

  return null
}

/**
 * One run in place per message at a time. A second request for a message whose run is still
 * going is refused, never queued behind it: queued, it would ask for the run's confirmation a
 * second time once the first finished.
 */
export class MatrixInvocationFlights {
  private readonly running = new Set<string>()

  /** Holds the message until the returned release is called; null while it is already held. */
  take(roomId: string, eventId: string): (() => void) | null {
    const key = JSON.stringify([roomId, eventId])

    if (this.running.has(key)) {
      return null
    }

    this.running.add(key)
    let held = true

    return () => {
      if (held) {
        held = false
        this.running.delete(key)
      }
    }
  }
}
