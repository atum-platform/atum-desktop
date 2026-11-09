import { createHash, randomUUID } from 'node:crypto'

import {
  AGENT_TASK_RESULT_MAX_BYTES,
  agentTaskBinding,
  type AgentTaskBinding,
  agentTaskBindingWire,
  type AgentTaskError,
  agentTaskEventId,
  agentTaskRequest,
  agentTaskResult,
  type AgentTaskResult,
  type AgentTaskRoom,
  agentTaskRoomId,
  type AgentTaskSummary
} from './agent-task'
import type { MatrixSdkCommand } from './matrix'

const MAX_ROOM_PROJECTIONS = 100
const MAX_LIST_RESULTS = 100

export interface AgentTaskRosterEntry {
  principal: string
  matrixUser?: string
  displayName: string
  status: 'active' | 'retired'
  isDefault: boolean
}

export interface MatrixAgentTaskManagementOptions {
  roster(signal: AbortSignal): Promise<readonly AgentTaskRosterEntry[] | undefined>
  originPrincipal: string
  ownerUserId: string
  command(value: MatrixSdkCommand, timeoutMs?: number): Promise<unknown>
  current(): boolean
  clock?: () => number
}

function error(value: AgentTaskError): { error: AgentTaskError } {
  return { error: value }
}

/**
 * Bind one start request to its runtime-stamped turn and its normalized task
 * semantics. The bridge assigns a fresh request_id for each tool invocation,
 * so request_id cannot recover a timed-out command retry. Distinct target,
 * prompt, timeout, or later-turn requests intentionally get distinct tasks.
 */
function startTaskId(
  originPrincipal: string,
  turnId: string,
  targetPrincipal: string,
  prompt: string,
  timeoutMinutes: number
): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([
      'atum-agent-task-start-v1',
      originPrincipal,
      turnId,
      targetPrincipal,
      prompt.normalize('NFC').trim(),
      timeoutMinutes
    ]))
    .digest()

  // Format the first 128 bits as a UUIDv5-shaped deterministic task identity.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function runtimeTurnId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return undefined}
  const turnId = (value as Record<string, unknown>).turn_id

  return typeof turnId === 'string' && turnId.length > 0 && turnId.length <= 256 ? turnId : undefined
}

function summary(room: AgentTaskRoom, roster: readonly AgentTaskRosterEntry[]): AgentTaskSummary | undefined {
  const origin = roster.find(agent => agent.principal === room.binding.originPrincipal)
  const target = roster.find(agent => agent.principal === room.binding.targetPrincipal)
  const originName = origin?.displayName ?? room.binding.originPrincipal
  const targetName = target?.displayName ?? room.binding.targetPrincipal

  const result = agentTaskResult({
    originPrincipal: room.binding.originPrincipal,
    originIsMain: false,
    task: {
      taskId: room.binding.taskId,
      originPrincipal: room.binding.originPrincipal,
      originName,
      targetPrincipal: room.binding.targetPrincipal,
      targetName,
      state: room.state,
      createdAt: room.binding.createdAt,
      expiresAt: room.binding.expiresAt,
      updatedAt: room.updatedAt,
      ...(room.result === undefined ? {} : { result: room.result })
    }
  })

  return result && 'task' in result ? result.task : undefined
}

function rooms(value: unknown): AgentTaskRoom[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ROOM_PROJECTIONS) {return undefined}

  const result: AgentTaskRoom[] = []

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {return undefined}
    const room = candidate as Record<string, unknown>

    if (
      !Object.keys(room).every(key => ['roomId', 'binding', 'startEventId', 'state', 'updatedAt', 'result'].includes(key)) ||
      !agentTaskRoomId(room.roomId) ||
      !room.binding ||
      typeof room.binding !== 'object' ||
      Array.isArray(room.binding) ||
      !['pending', 'accepted', 'running', 'completed', 'failed', 'stopped', 'expired'].includes(String(room.state)) ||
      !Number.isSafeInteger(room.updatedAt) ||
      (room.startEventId !== undefined && !agentTaskEventId(room.startEventId)) ||
      (room.result !== undefined &&
        (typeof room.result !== 'string' || new TextEncoder().encode(room.result).byteLength > AGENT_TASK_RESULT_MAX_BYTES))
    ) {return undefined}

    let binding: AgentTaskBinding | undefined
    try {
      binding = agentTaskBinding(agentTaskBindingWire(room.binding as unknown as AgentTaskBinding))
    } catch {
      return undefined
    }
    if (!binding) {return undefined}

    result.push({
      roomId: room.roomId,
      binding,
      state: room.state as AgentTaskRoom['state'],
      updatedAt: room.updatedAt as number,
      ...(room.startEventId === undefined ? {} : { startEventId: room.startEventId as string }),
      ...(room.result === undefined ? {} : { result: room.result as string })
    })
  }

  return result
}

/** One live Hermes tool request, authorized from the current canonical roster each time. */
export async function manageMatrixAgentTask(
  options: MatrixAgentTaskManagementOptions,
  value: unknown,
  signal: AbortSignal
): Promise<AgentTaskResult> {
  const request = agentTaskRequest(value)

  if (!request) {return error('invalid')}

  const live = () => {
    signal.throwIfAborted()
    if (!options.current()) {throw new Error('matrix_agent_task_stale')}
  }

  try {
    live()
    const roster = await options.roster(AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
    const origin = roster?.find(agent => agent.status === 'active' && agent.principal === options.originPrincipal)

    if (!roster || !origin?.matrixUser) {return error('unavailable')}
    const main = roster.find(agent => agent.status === 'active' && agent.isDefault && agent.matrixUser)
    if (!main?.matrixUser) {return error('unavailable')}
    const ownedAgents = roster.flatMap(agent => agent.status === 'active' && agent.matrixUser
      ? [{ principal: agent.principal, userId: agent.matrixUser }] : [])

    const envelope = (body: { task: AgentTaskSummary } | { tasks: AgentTaskSummary[] }): AgentTaskResult => ({
      originPrincipal: origin.principal,
      originIsMain: origin.isDefault,
      ...body
    })

    if (request.operation === 'start') {
      const target = roster.find(agent => agent.status === 'active' && agent.principal === request.target && agent.matrixUser)

      if (!target?.matrixUser) {return error('missing')}

      if (target.principal === origin.principal) {return error('invalid')}

      // The host provides this runtime-stamped value. Failing closed avoids
      // minting a fresh task when a timed-out call is retried.
      const turnId = runtimeTurnId(value)

      if (!turnId) {return error('unavailable')}

      const createdAt = (options.clock ?? Date.now)()
      const timeoutMinutes = request.timeoutMinutes ?? 30

      const binding: AgentTaskBinding = {
        v: 1,
        taskId: startTaskId(origin.principal, turnId, target.principal, request.prompt, timeoutMinutes),
        owner: options.ownerUserId,
        originPrincipal: origin.principal,
        originUser: origin.matrixUser,
        targetPrincipal: target.principal,
        targetUser: target.matrixUser,
        mainPrincipal: main.principal,
        mainUser: main.matrixUser,
        createdAt,
        expiresAt: createdAt + timeoutMinutes * 60_000
      }

      // A prior command may have created the room and sent start but failed
      // while persisting its recovery pointer. Querying validated room state
      // (not that optional pointer) recovers the task without another dispatch.
      const existing = rooms(await options.command({
        kind: 'listAgentTasks',
        ownerId: options.ownerUserId,
        agentPrincipal: origin.principal,
        agentUserId: origin.matrixUser,
        ownedAgents,
        taskId: binding.taskId
      }, 30_000))

      live()

      if (!existing) {return error('unavailable')}

      const recovered = existing.find(room => room.binding.taskId === binding.taskId)
      const recoveredTask = recovered && summary(recovered, roster)

      if (recoveredTask) {return envelope({ task: recoveredTask })}

      const raw = await options.command({ kind: 'createAgentTask', binding, prompt: request.prompt }, 30_000)
      live()
      const task = summary(raw as AgentTaskRoom, roster)

      return task ? envelope({ task }) : error('unavailable')
    }

    const raw = await options.command({
      kind: 'listAgentTasks',
      ownerId: options.ownerUserId,
      agentPrincipal: origin.principal,
      agentUserId: origin.matrixUser,
      ownedAgents,
      ...(request.operation === 'list' ? { limit: MAX_LIST_RESULTS } : { taskId: request.taskId })
    }, 30_000)
    live()
    const visible = rooms(raw)

    if (!visible) {return error('unavailable')}

    const allowed = visible.filter(room =>
      room.binding.originPrincipal === origin.principal ||
      room.binding.targetPrincipal === origin.principal ||
      origin.isDefault
    )
    const projected = allowed.map(room => summary(room, roster))

    if (projected.some(task => !task)) {return error('unavailable')}
    if (request.operation === 'list') {
      return envelope({
        tasks: (projected as AgentTaskSummary[])
          .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
          .slice(0, MAX_LIST_RESULTS)
      })
    }

    const room = allowed.find(candidate => candidate.binding.taskId === request.taskId)
    const task = room && summary(room, roster)
    if (!room || !task) {return error('missing')}

    if (request.operation === 'read') {return envelope({ task })}
    if (room.binding.originPrincipal !== origin.principal && !origin.isDefault) {return error('denied')}
    if (['completed', 'failed', 'stopped', 'expired'].includes(room.state)) {return envelope({ task })}

    const action = request.operation === 'stop' ? 'stop' as const : 'steer' as const
    await options.command({
      kind: 'sendAgentTask',
      roomId: room.roomId,
      taskId: room.binding.taskId,
      action,
      body: request.operation === 'stop' ? 'Stop requested.' : request.text,
      transactionId: `atum-task-${action}-${room.binding.taskId}-${randomUUID()}`
    }, 30_000)
    live()

    return envelope({
      task: {
        ...task,
        control: request.operation === 'stop' ? 'stop_requested' : 'steer_sent'
      }
    })
  } catch (cause) {
    if (signal.aborted) {throw cause}
    return error('unavailable')
  }
}
