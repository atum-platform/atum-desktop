import { AGENT_SOURCE_GATES_PACK } from './contract-packs'
import { messageViolations } from './schema'

/** Mirrored from `@atum/protocol` 0.7.57 and the pinned `spec/agent-source-gates/v1` pack. */
export const AGENT_SOURCE_GATES_PROFILE = 'atum.agent-source-gates/1' as const
export const AGENT_SOURCE_GATES_PACK_PIN = '74dd2fc488707138bf906eb655138b6b5e70884cd03fb25ad175eace99fb6af4' as const
export const AGENT_SOURCE_GATES_PROTOCOL_VERSION = '0.7.57' as const

export const AGENT_SOURCE_GATE_KEYS = Object.freeze([
  'google',
  'folders',
  'messages',
  'browser',
  'location',
  'team_spaces'
] as const)

export type AgentSourceGate = typeof AGENT_SOURCE_GATE_KEYS[number]
export type AgentSourceGates = Record<AgentSourceGate, boolean>

export interface AgentSourceGateSnapshot {
  profile: typeof AGENT_SOURCE_GATES_PROFILE
  revision: number
  gates: AgentSourceGates
}

export interface AgentSourceGateWrite {
  profile: typeof AGENT_SOURCE_GATES_PROFILE
  requestId: string
  expectedRevision: number
  gates: AgentSourceGates
}

export interface AgentSourceGateWriteConflict {
  profile: typeof AGENT_SOURCE_GATES_PROFILE
  error: 'revision_conflict'
  current: AgentSourceGateSnapshot
}

export type AgentSourceGateMessage = 'gate.snapshot' | 'gate.write' | 'gate.write-conflict'

export function validAgentSourceGateMessage(message: AgentSourceGateMessage, value: unknown): boolean {
  return messageViolations(AGENT_SOURCE_GATES_PACK, message, value).length === 0
}

function parse<T>(message: AgentSourceGateMessage, value: unknown): T {
  if (!validAgentSourceGateMessage(message, value)) {
    throw new Error('agent_source_gates_invalid')
  }

  return value as T
}

export const parseAgentSourceGateSnapshot = (value: unknown) =>
  parse<AgentSourceGateSnapshot>('gate.snapshot', value)
export const parseAgentSourceGateWrite = (value: unknown) =>
  parse<AgentSourceGateWrite>('gate.write', value)
export const parseAgentSourceGateWriteConflict = (value: unknown) =>
  parse<AgentSourceGateWriteConflict>('gate.write-conflict', value)

export function sameAgentSourceGates(left: AgentSourceGates, right: AgentSourceGates): boolean {
  return AGENT_SOURCE_GATE_KEYS.every(key => left[key] === right[key])
}
