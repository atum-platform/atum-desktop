import { type MatrixInvocationMessage, matrixOwnerWireType } from '../../../shared/matrix'
import { matrixGroupMode } from '../../../shared/matrix-group-room'
import { effectiveMode, isGroupFresh, verifyChain } from '../../../shared/room-participation'
import { CHAIN_ORIGIN_AGE_MS } from '../../../shared/room-participation/limits'
import type { GroupParticipation } from '../../../shared/room-participation/runtime'
import type { ChainEvent, ChainStamp } from '../../../shared/room-participation/types'

import { groupBudget } from './budget'
import type { GroupFloorSnapshot } from './floor'

export function groupChainEvent(message: MatrixInvocationMessage): ChainEvent {
  return {
    roomId: message.roomId,
    eventId: message.eventId,
    senderUserId: message.sender,
    senderVerified: message.senderVerified === true && Boolean(message.senderDevice),
    at: message.timestamp ?? NaN,
    eventKind:
      message.content?.msgtype === 'm.text' &&
      !message.content.invalidMentions &&
      !message.thread &&
      (message.related === false || (message.related === true && Boolean(message.content.replyTo)))
        ? 'text'
        : 'edit',
    mentions: message.content.mentionedUserIds ?? [],
    ...(message.content.chain ? { chain: message.content.chain } : {})
  }
}

/** This preflight walks stored SDK events; all consumed-turn counts are enforced atomically by 0200. */
export async function prepareGroupChain(
  input: { roomId: string; eventId: string; ownerId: string; agentId: string; since: number; acceptedAt: number },
  deps: {
    read: (eventId: string) => Promise<MatrixInvocationMessage>
    snapshot: () => Promise<GroupFloorSnapshot>
    now?: () => number
  }
) {
  const now = deps.now ?? Date.now
  const message = await deps.read(input.eventId)
  const stamp = message.content.chain

  if (
    !stamp ||
    message.roomId !== input.roomId ||
    message.eventId !== input.eventId ||
    !matrixOwnerWireType(message.wireType) ||
    message.sender === input.ownerId ||
    !Number.isSafeInteger(message.timestamp) ||
    message.timestamp! <= input.since ||
    !isGroupFresh({ timestamp: message.timestamp!, now: input.acceptedAt })
  ) {
    throw new Error('matrix_group_chain_invalid')
  }

  let first: GroupParticipation | undefined

  const validate = async () => {
    const snapshot = await deps.snapshot()
    const joined = snapshot.members.filter(member => member.membership === 'join').map(member => member.userId)
    const mode = matrixGroupMode(snapshot.members, input.ownerId, snapshot.ownAgentIds)
    const participation = effectiveMode({ roomMode: mode, stored: snapshot.policy.agents[input.agentId]?.mode })

    if (
      mode !== 'meeting' ||
      !joined.includes(input.ownerId) ||
      !joined.includes(input.agentId) ||
      !joined.includes(message.sender) ||
      participation === 'off'
    ) {
      throw new Error('matrix_group_chain_invalid')
    }

    const budget = groupBudget(snapshot, now())

    let originAt = NaN
    const ownAgentIds = snapshot.ownAgentIds.filter(id => joined.includes(id))

    const decision = await verifyChain(
      {
        roomId: input.roomId,
        eventId: input.eventId,
        ownerUserId: input.ownerId,
        agentUserId: input.agentId,
        ownAgentIds,
        roomMode: mode,
        now: now(),
        spokenAgentIds: [],
        originTurns: stamp.depth,
        budgetAllowed: budget.allowed
      },
      {
        readOwnerEvent: async (roomId, eventId) => {
          const read = await deps.read(eventId)

          if (!matrixOwnerWireType(read.wireType)) {
            throw new Error('matrix_group_chain_invalid')
          }

          if (read.sender === input.ownerId) {
            originAt = read.timestamp ?? NaN
          }

          return groupChainEvent(read)
        }
      }
    )

    if (decision.allowed === false) {
      throw new Error(`matrix_group_chain_${decision.code}`)
    }

    if (!Number.isSafeInteger(originAt) || now() - originAt > CHAIN_ORIGIN_AGE_MS) {
      throw new Error('matrix_group_chain_stale_origin')
    }

    const current = {
      participation,
      ownAgentIds,
      dailyTurns: budget.cap,
      floor: { acceptedAt: input.acceptedAt, position: 0 },
      chain: { ...stamp }
    }

    if (
      first &&
      (first.participation !== current.participation ||
        [...first.ownAgentIds].sort().join('\n') !== [...current.ownAgentIds].sort().join('\n'))
    ) {
      throw new Error('matrix_group_changed')
    }

    first ??= current

    return { mode: 'meeting' as const, audience: [] as string[], ...current }
  }

  await validate()

  return { state: 'ready' as const, position: 0, finish: validate }
}

export function groupChainSender(
  message: MatrixInvocationMessage,
  input: {
    ownerId: string
    agentId: string
    mode: string
    ownAgentIds?: readonly string[]
    chain?: ChainStamp
  }
) {
  return (
    input.mode === 'meeting' &&
    Boolean(input.chain) &&
    message.sender !== input.ownerId &&
    message.sender !== input.agentId &&
    Boolean(input.ownAgentIds?.includes(message.sender)) &&
    message.senderVerified === true &&
    Boolean(message.senderDevice) &&
    JSON.stringify(message.content.chain) === JSON.stringify(input.chain) &&
    message.content.mentionedUserIds?.includes(input.agentId) === true
  )
}
