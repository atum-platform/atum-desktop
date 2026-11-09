import type { ChainStamp, ParticipationMode, RoomPolicy, RoomUsage } from './types'

/** Owner-SDK facts, never a model tool or renderer authority. */
export interface GroupRoomTarget {
  roomId: string
  ownerId: string
  agentId: string
}

export interface GroupPolicyRead {
  policy: RoomPolicy
  usage: RoomUsage
}

/** A person's bounded preference change; identity and roster are supplied by native. */
export type GroupPolicyChange =
  | { agentId: string; mode: ParticipationMode }
  | { dailyTurns: number }
  | { routingDisclosure: 1 }

export interface GroupPolicySettings {
  roomId: string
  ownerId: string
  agentIds: readonly string[]
  change?: GroupPolicyChange
}

export interface GroupSettledTarget extends GroupRoomTarget {
  eventId: string
  agentIds: readonly string[]
}

export interface GroupUsageChange extends GroupRoomTarget {
  change: 'claimed' | 'paused'
  dailyTurns: number
  /** A notice acknowledgment belongs to its original UTC day, even across midnight. */
  day?: string
  invocationId?: string
}

export type GroupRuntimeCommand =
  | ({ kind: 'readRoomPolicy' } & GroupRoomTarget)
  | ({ kind: 'readGroupSettled' } & GroupSettledTarget)
  | ({ kind: 'writeRoomUsage' } & GroupUsageChange)
  | ({ kind: 'ownerGroupPolicy' } & GroupPolicySettings)

export interface GroupParticipation {
  chain?: ChainStamp
  participation: ParticipationMode
  ownAgentIds: readonly string[]
  dailyTurns: number
  floor: { acceptedAt: number; position: number }
}

export interface GroupChainPublication extends ChainStamp {
  recipients: readonly { userId: string; name: string }[]
}
