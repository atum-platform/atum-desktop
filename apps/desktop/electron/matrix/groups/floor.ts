import { type MatrixInvocationMessage, matrixOwnerWireType } from '../../../shared/matrix'
import { matrixGroupAudience, matrixGroupMode } from '../../../shared/matrix-group-room'
import {
  classifyGroupTrigger,
  effectiveMode,
  EVERYONE_ANSWERS_MAX,
  isGroupFresh,
  planFloor
} from '../../../shared/room-participation'
import type { GroupTriggerFacts, RoomPolicy } from '../../../shared/room-participation'
import type { GroupPolicyRead } from '../../../shared/room-participation/runtime'

import { groupBudget } from './budget'

export async function groupFloor(
  input: Omit<GroupTriggerFacts, 'mode'> & {
    eventId: string
    policy: RoomPolicy
    joinedAgentIds: readonly string[]
    relevantAgentIds?: readonly string[]
  }
) {
  const mode = effectiveMode({ roomMode: input.roomMode, stored: input.policy.agents[input.agentUserId]?.mode })

  const explicit =
    input.mentions.some(id => input.ownAgentIds.includes(id)) ||
    (input.replySenderId !== undefined && input.ownAgentIds.includes(input.replySenderId))

  // An ambient meeting message has one shared candidate set. The local agent's mode decides only
  // whether it is in that set, not whether other joined agents are eligible for relevance routing.
  const requestedKind = classifyGroupTrigger({ ...input, mode: explicit ? mode : 'joins' })

  const candidates = [...new Set(input.joinedAgentIds)].filter(id => {
    const candidate = effectiveMode({ roomMode: input.roomMode, stored: input.policy.agents[id]?.mode })

    return candidate !== 'off' && (requestedKind !== 'everyone' || candidate === 'joins')
  })

  const kind = requestedKind === 'everyone' && !candidates.length ? 'none' : requestedKind

  const order =
    kind === 'everyone' && input.relevantAgentIds !== undefined
      ? relevantFloor(candidates, input.relevantAgentIds)
      : (await planFloor({ ...input, kind, candidates })).order

  return { mode, kind, candidates, order, position: order.indexOf(input.agentUserId) }
}

/** Re-read owner authority before waiting; hint contents grant no participation. */
export function requireGroupOwnerEvent(
  message: MatrixInvocationMessage,
  input: {
    roomId: string
    eventId: string
    ownerId: string
    since: number
    acceptedAt: number
  }
) {
  if (
    message?.roomId !== input.roomId ||
    message.eventId !== input.eventId ||
    !matrixOwnerWireType(message.wireType) ||
    message.sender !== input.ownerId ||
    message.senderVerified !== true ||
    !message.senderDevice ||
    message.content?.msgtype !== 'm.text' ||
    message.content.invalidMentions ||
    message.thread === true ||
    (message.related !== false && !(message.related === true && typeof message.content.replyTo === 'string')) ||
    !Number.isSafeInteger(message.timestamp) ||
    message.timestamp! <= input.since ||
    !isGroupFresh({ timestamp: message.timestamp!, now: input.acceptedAt })
  ) {
    throw new Error('matrix_invocation_untrusted')
  }

  return message
}

export interface GroupFloorSnapshot extends GroupPolicyRead {
  members: readonly { userId: string; membership: string }[]
  ownAgentIds: readonly string[]
}

/** Native orchestration through owner-SDK ports. No history read occurs before the wait. */
export async function prepareGroupFloor(
  input: {
    roomId: string
    eventId: string
    ownerId: string
    agentId: string
    since: number
    acceptedAt: number
  },
  deps: {
    ownerEvent: () => Promise<MatrixInvocationMessage>
    snapshot: () => Promise<GroupFloorSnapshot>
    replySender: (eventId: string) => Promise<string | undefined>
    relevance?: (input: {
      message: MatrixInvocationMessage
      candidateIds: readonly string[]
      ownAgentIds: readonly string[]
      routingDisclosed: boolean
      replySenderId?: string
    }) => Promise<readonly string[]>
    ownerDeviceDenied?: (deviceId: string) => void
    now?: () => number
  }
) {
  const now = deps.now ?? Date.now
  const read = await deps.ownerEvent()

  if (
    read?.roomId === input.roomId &&
    read.eventId === input.eventId &&
    read.wireType === 'm.room.encrypted' &&
    read.sender === input.ownerId &&
    read.senderVerified === false &&
    typeof read.senderDevice === 'string' &&
    read.senderDevice.length > 0 &&
    read.senderDevice.length <= 255
  ) {
    deps.ownerDeviceDenied?.(read.senderDevice)
  }

  const message = requireGroupOwnerEvent(read, input)
  const replySenderId = message.content.replyTo ? await deps.replySender(message.content.replyTo) : undefined

  const select = async (snapshot: GroupFloorSnapshot, relevantAgentIds?: readonly string[]) => {
    const roomMode = matrixGroupMode(snapshot.members, input.ownerId, snapshot.ownAgentIds)

    const selection = await groupFloor({
      ownerUserId: input.ownerId,
      agentUserId: input.agentId,
      senderUserId: message.sender,
      senderVerified: message.senderVerified,
      roomMode,
      eventId: input.eventId,
      eventKind: 'text',
      policy: snapshot.policy,
      ownAgentIds: snapshot.ownAgentIds,
      joinedAgentIds: snapshot.members
        .filter(member => member.membership === 'join' && snapshot.ownAgentIds.includes(member.userId))
        .map(member => member.userId),
      mentions: message.content.mentionedUserIds ?? [],
      replySenderId,
      relevantAgentIds
    })

    return {
      ...selection,
      roomMode,
      audience: matrixGroupAudience(snapshot.members, input.ownerId, snapshot.ownAgentIds)
    }
  }

  const initial = await deps.snapshot()
  const preliminary = await select(initial)
  const budget = groupBudget(initial, now())

  if (!budget.allowed) {
    return preliminary.position < 0
      ? { state: 'ignored' as const }
      : { state: 'paused' as const, budget, position: preliminary.position }
  }

  const relevantAgentIds =
    preliminary.kind === 'everyone' && deps.relevance
      ? freezeRelevantAgentIds(
          preliminary.candidates,
          await deps.relevance({
            message,
            candidateIds: preliminary.candidates,
            ownAgentIds: Object.freeze([...initial.ownAgentIds]),
            routingDisclosed: initial.policy.routingDisclosure === 1,
            ...(replySenderId ? { replySenderId } : {})
          })
        )
      : undefined

  const selection = relevantAgentIds === undefined ? preliminary : await select(initial, relevantAgentIds)

  if (selection.position < 0) {
    return { state: 'ignored' as const }
  }

  // Selected assistants no longer wait for one another. Every independent turn gets the
  // ordinary freshness window; selection.position remains presentation-only (cap notice).
  const floor = { acceptedAt: input.acceptedAt, position: 0 }

  const validate = async () => {
    const fresh = await deps.snapshot()
    let current: Awaited<ReturnType<typeof select>>

    try {
      current = await select(fresh, relevantAgentIds)
    } catch (error) {
      if (error instanceof Error && error.message === 'matrix_group_routing_invalid') {
        throw new Error('matrix_group_changed')
      }

      throw error
    }

    if (
      current.roomMode !== selection.roomMode ||
      current.mode !== selection.mode ||
      current.audience.join('\n') !== selection.audience.join('\n') ||
      current.candidates.join('\n') !== selection.candidates.join('\n') ||
      current.order.join('\n') !== selection.order.join('\n')
    ) {
      throw new Error('matrix_group_changed')
    }

    // Freshness was judged when this Mac took the message up (requireGroupOwnerEvent, at
    // `acceptedAt`), and is not judged again here: this runs inside the room queue, after the
    // time the message waited behind the agent's other turn, which must not drop it (LB9, plan
    // 6.1 A "queue it"). The policy and membership checks above still apply to the room as it is now.
    return fresh
  }

  return {
    state: 'ready' as const,
    position: selection.position,
    /** Call inside the room queue: another local turn may have consumed the last answer. */
    async finish() {
      const fresh = await validate()
      const currentBudget = groupBudget(fresh, now())

      if (!currentBudget.allowed) {
        throw new Error('matrix_group_room_cap')
      }

      return {
        mode: selection.roomMode,
        audience: selection.audience,
        participation: selection.mode,
        ownAgentIds: fresh.ownAgentIds,
        dailyTurns: currentBudget.cap,
        floor
      }
    }
  }
}

function relevantFloor(candidates: readonly string[], relevantAgentIds: readonly string[]): string[] {
  if (!Array.isArray(relevantAgentIds)) {
    throw new Error('matrix_group_routing_invalid')
  }

  const allowed = new Set(candidates)
  const selected: string[] = []

  for (const id of relevantAgentIds) {
    if (typeof id !== 'string' || !allowed.has(id)) {
      throw new Error('matrix_group_routing_invalid')
    }

    if (!selected.includes(id)) {
      selected.push(id)
    }
  }

  return selected.slice(0, EVERYONE_ANSWERS_MAX)
}

function freezeRelevantAgentIds(candidates: readonly string[], relevantAgentIds: readonly string[]): string[] {
  return relevantFloor(candidates, relevantAgentIds)
}

/** Serialize only callers that deliberately share a key. Main uses room + agent, so
 * different assistants in one room work independently while each assistant keeps order. */
export class GroupRoomQueue {
  private tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.tails.set(key, next)

    try {
      return await next
    } finally {
      if (this.tails.get(key) === next) {
        this.tails.delete(key)
      }
    }
  }
}

export { isGroupFresh }
