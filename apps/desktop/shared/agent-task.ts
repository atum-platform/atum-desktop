/**
 * Durable hand-off between two owned Atum agents.
 *
 * Matrix is only the transport and recovery log.  The target still claims the
 * ordinary invocation ledger and runs with its own executor, model grant and
 * Hermes home.  Nothing in this envelope grants Main or owner authority.
 */
export const MATRIX_AGENT_TASK_ROOM_TYPE = 'io.atum.agent_task.v1'
export const MATRIX_AGENT_TASK_KEY = 'io.atum.agent_task'
export const MATRIX_AGENT_TASK_START_TYPE = 'io.atum.agent_task.start.v1'
export const MATRIX_AGENT_TASK_COORDINATOR_TYPE = 'io.atum.agent_task.coordinator.v1'
export const MATRIX_AGENT_TASK_WATCH_ID = 'agent-task'

export const AGENT_TASK_TERMINAL_STATES = ['completed', 'failed', 'stopped', 'expired'] as const
export type AgentTaskTerminalState = (typeof AGENT_TASK_TERMINAL_STATES)[number]
export type AgentTaskState = 'pending' | 'accepted' | 'running' | AgentTaskTerminalState
export type AgentTaskMessageKind =
  | 'start'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'stop'
  | 'steer'

export interface AgentTaskBinding {
  v: 1
  taskId: string
  owner: string
  originPrincipal: string
  originUser: string
  targetPrincipal: string
  targetUser: string
  /** Main when the room was created. An owner-signed coordinator state event may supersede it. */
  mainPrincipal: string
  mainUser: string
  createdAt: number
  expiresAt: number
}

export interface AgentTaskCoordinator {
  v: 1
  taskId: string
  principal: string
  user: string
}

export interface AgentTaskMessage {
  v: 1
  taskId: string
  kind: AgentTaskMessageKind
  at: number
}

export interface AgentTaskEvent extends AgentTaskMessage {
  eventId: string
  sender: string
  body: string
  /** Homeserver ordering time. The sender-authored marker time is display metadata only. */
  serverAt?: number
}

export interface AgentTaskRoom {
  roomId: string
  binding: AgentTaskBinding
  startEventId?: string
  state: AgentTaskState
  updatedAt: number
  result?: string
}

/** A compact snapshot of the owner's active agent roster, used only for task-room invitation admission. */
export interface AgentTaskOwnedAgent {
  principal: string
  userId: string
}

export interface AgentTaskWatch {
  id: string
  ownerId: string
  agentPrincipal: string
  agentUserId: string
  /** An invitation is never joined unless its creating agent is in this authoritative roster snapshot. */
  ownedAgents?: readonly AgentTaskOwnedAgent[]
  since: number
}

export type AgentTaskRequest =
  | { operation: 'start'; target: string; prompt: string; timeoutMinutes?: number }
  | { operation: 'list' }
  | { operation: 'read'; taskId: string }
  | { operation: 'stop'; taskId: string }
  | { operation: 'steer'; taskId: string; text: string }

export type AgentTaskError = 'denied' | 'invalid' | 'missing' | 'unavailable'

export interface AgentTaskSummary {
  taskId: string
  originPrincipal: string
  originName: string
  targetPrincipal: string
  targetName: string
  state: AgentTaskState
  createdAt: number
  expiresAt: number
  updatedAt: number
  result?: string
  /** Delivery acknowledgement only; the target's status remains authoritative. */
  control?: 'stop_requested' | 'steer_sent'
}

export type AgentTaskResult =
  | { originPrincipal: string; originIsMain: boolean; task: AgentTaskSummary }
  | { originPrincipal: string; originIsMain: boolean; tasks: AgentTaskSummary[] }
  | { error: AgentTaskError }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MATRIX_USER = /^@[^:\s]+:[^\s]+$/u
const MATRIX_EVENT = /^\$[!-~]+$/u
const MATRIX_ROOM = /^![!-~]+$/u
/** Keep one Matrix event comfortably below homeserver JSON/event overhead limits. */
export const AGENT_TASK_TEXT_MAX_BYTES = 40_000
export const AGENT_TASK_RESULT_MAX_BYTES = 32_768
const MAX_NAME_CHARS = 4_096

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function text(value: unknown, maximum = AGENT_TASK_TEXT_MAX_BYTES): value is string {
  return typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= maximum
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/** Model-facing request validation at the native/controller boundary. */
export function agentTaskRequest(value: unknown): AgentTaskRequest | undefined {
  if (!object(value) || typeof value.operation !== 'string') {return undefined}

  if (value.operation === 'list') {
    return exact(value, ['operation', 'request_id', 'turn_id']) ? { operation: 'list' } : undefined
  }

  if (value.operation === 'start') {
    if (
      !exact(value, ['operation', 'target', 'prompt', 'timeoutMinutes', 'request_id', 'turn_id']) ||
      typeof value.target !== 'string' ||
      !UUID.test(value.target) ||
      !text(value.prompt) ||
      (value.timeoutMinutes !== undefined &&
        (!Number.isSafeInteger(value.timeoutMinutes) || Number(value.timeoutMinutes) < 1 || Number(value.timeoutMinutes) > 30))
    ) {
      return undefined
    }

    return {
      operation: 'start',
      target: value.target,
      prompt: value.prompt,
      ...(value.timeoutMinutes === undefined ? {} : { timeoutMinutes: Number(value.timeoutMinutes) })
    }
  }

  if (
    !['read', 'stop', 'steer'].includes(value.operation) ||
    !exact(value, ['operation', 'taskId', 'text', 'request_id', 'turn_id']) ||
    typeof value.taskId !== 'string' ||
    !UUID.test(value.taskId)
  ) {
    return undefined
  }

  if (value.operation === 'steer') {
    return text(value.text)
      ? { operation: 'steer', taskId: value.taskId, text: value.text }
      : undefined
  }

  if (value.text !== undefined) {return undefined}

  return { operation: value.operation as 'read' | 'stop', taskId: value.taskId }
}

/** Strict immutable room binding from m.room.create. */
export function agentTaskBinding(value: unknown): AgentTaskBinding | undefined {
  if (
    !object(value) ||
    !exact(value, [
      'v',
      'task_id',
      'owner',
      'origin_principal',
      'origin_user',
      'target_principal',
      'target_user',
      'main_principal',
      'main_user',
      'created_at',
      'expires_at'
    ]) ||
    value.v !== 1 ||
    typeof value.task_id !== 'string' ||
    !UUID.test(value.task_id) ||
    typeof value.owner !== 'string' ||
    !MATRIX_USER.test(value.owner) ||
    typeof value.origin_principal !== 'string' ||
    !UUID.test(value.origin_principal) ||
    typeof value.origin_user !== 'string' ||
    !MATRIX_USER.test(value.origin_user) ||
    typeof value.target_principal !== 'string' ||
    !UUID.test(value.target_principal) ||
    typeof value.target_user !== 'string' ||
    !MATRIX_USER.test(value.target_user) ||
    typeof value.main_principal !== 'string' ||
    !UUID.test(value.main_principal) ||
    typeof value.main_user !== 'string' ||
    !MATRIX_USER.test(value.main_user) ||
    !timestamp(value.created_at) ||
    !timestamp(value.expires_at) ||
    value.expires_at <= value.created_at ||
    value.expires_at - value.created_at > 30 * 60_000 ||
    value.origin_principal === value.target_principal ||
    value.origin_user === value.target_user
  ) {
    return undefined
  }

  return {
    v: 1,
    taskId: value.task_id,
    owner: value.owner,
    originPrincipal: value.origin_principal,
    originUser: value.origin_user,
    targetPrincipal: value.target_principal,
    targetUser: value.target_user,
    mainPrincipal: value.main_principal,
    mainUser: value.main_user,
    createdAt: value.created_at,
    expiresAt: value.expires_at
  }
}

export function agentTaskBindingWire(value: AgentTaskBinding): Record<string, unknown> {
  const valid = agentTaskBinding({
    v: 1,
    task_id: value.taskId,
    owner: value.owner,
    origin_principal: value.originPrincipal,
    origin_user: value.originUser,
    target_principal: value.targetPrincipal,
    target_user: value.targetUser,
    main_principal: value.mainPrincipal,
    main_user: value.mainUser,
    created_at: value.createdAt,
    expires_at: value.expiresAt
  })

  if (!valid) {throw new Error('matrix_agent_task_invalid')}

  return {
    v: 1,
    task_id: valid.taskId,
    owner: valid.owner,
    origin_principal: valid.originPrincipal,
    origin_user: valid.originUser,
    target_principal: valid.targetPrincipal,
    target_user: valid.targetUser,
    main_principal: valid.mainPrincipal,
    main_user: valid.mainUser,
    created_at: valid.createdAt,
    expires_at: valid.expiresAt
  }
}

/** Strict io.atum.agent_task message envelope; its words stay in the normal Matrix body. */
export function agentTaskMessage(value: unknown): AgentTaskMessage | undefined {
  if (
    !object(value) ||
    !exact(value, ['v', 'task_id', 'kind', 'at']) ||
    value.v !== 1 ||
    typeof value.task_id !== 'string' ||
    !UUID.test(value.task_id) ||
    ![
      'start',
      'accepted',
      'running',
      'completed',
      'failed',
      'stopped',
      'stop',
      'steer'
    ].includes(String(value.kind)) ||
    !timestamp(value.at)
  ) {
    return undefined
  }

  return { v: 1, taskId: value.task_id, kind: value.kind as AgentTaskMessageKind, at: value.at }
}

export function agentTaskMessageWire(taskId: string, kind: AgentTaskMessageKind, at: number): Record<string, unknown> {
  const value = agentTaskMessage({ v: 1, task_id: taskId, kind, at })

  if (!value) {throw new Error('matrix_agent_task_invalid')}

  return { v: 1, task_id: value.taskId, kind: value.kind, at: value.at }
}

/** Sender role for a task message. Current Main authority is rechecked outside Matrix. */
export function agentTaskMessageSender(binding: AgentTaskBinding, event: Pick<AgentTaskEvent, 'kind' | 'sender'>): boolean {
  if (event.kind === 'start') {return event.sender === binding.originUser}
  if (event.kind === 'stop' || event.kind === 'steer') {
    return event.sender === binding.originUser || event.sender === binding.mainUser
  }
  return event.sender === binding.targetUser
}

/** A task result is one Matrix message so list/read always returns the whole published result. */
export function agentTaskResultText(value: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= AGENT_TASK_RESULT_MAX_BYTES) {return value}

  const suffix = '…'
  let bytes = encoder.encode(suffix).byteLength
  const kept: string[] = []
  for (const character of value) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > AGENT_TASK_RESULT_MAX_BYTES) {break}
    kept.push(character)
    bytes += size
  }
  return kept.join('') + suffix
}

export function agentTaskState(events: readonly AgentTaskEvent[], expiresAt: number, now = Date.now()): Pick<AgentTaskRoom, 'startEventId' | 'state' | 'updatedAt' | 'result'> {
  const ordered = events
    .filter(event => MATRIX_EVENT.test(event.eventId) && text(event.body) && timestamp(event.at))
    .sort((a, b) => (a.serverAt ?? a.at) - (b.serverAt ?? b.at) || a.eventId.localeCompare(b.eventId))
  const startIndex = ordered.findIndex(event => event.kind === 'start')
  const start = startIndex < 0 ? undefined : ordered[startIndex]
  // Status and control events cannot create a task.  Ignore anything ordered before the
  // authenticated start marker; a homeserver or stale room history must not be able to make an
  // unstarted task look accepted, running, or terminal.
  const lifecycle = startIndex < 0 ? [] : ordered.slice(startIndex)
  let state: AgentTaskState = 'pending'
  let result: string | undefined
  let updatedAt = start ? (start.serverAt ?? start.at) : 0

  for (const event of lifecycle) {
    if (AGENT_TASK_TERMINAL_STATES.includes(state as AgentTaskTerminalState)) {break}
    if (event.kind === 'accepted' && state === 'pending') {state = 'accepted'}
    else if (event.kind === 'running' && (state === 'pending' || state === 'accepted')) {state = 'running'}
    else if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'stopped') {
      state = event.kind
      result = event.body
    }
    updatedAt = Math.max(updatedAt, event.serverAt ?? event.at)
  }

  if (!AGENT_TASK_TERMINAL_STATES.includes(state as AgentTaskTerminalState) && now >= expiresAt) {
    state = 'expired'
    updatedAt = Math.max(updatedAt, expiresAt)
  }

  return {
    ...(start ? { startEventId: start.eventId } : {}),
    state,
    updatedAt,
    ...(result === undefined ? {} : { result })
  }
}

export function agentTaskRoomId(value: unknown): value is string {
  return typeof value === 'string' && MATRIX_ROOM.test(value) && value.length <= 1_024
}

export function agentTaskEventId(value: unknown): value is string {
  return typeof value === 'string' && MATRIX_EVENT.test(value) && value.length <= 1_024
}

/** Immutable recovery pointer stored as room state after the start message is accepted. */
export function agentTaskStartPointer(value: unknown): { taskId: string; eventId: string } | undefined {
  if (!object(value) || !exact(value, ['v', 'task_id', 'event_id']) || value.v !== 1
    || typeof value.task_id !== 'string' || !UUID.test(value.task_id)
    || !agentTaskEventId(value.event_id)) {return undefined}
  return { taskId: value.task_id, eventId: value.event_id }
}

/** Current Main for an existing task, written only by the owner account in room state. */
export function agentTaskCoordinator(value: unknown): AgentTaskCoordinator | undefined {
  if (!object(value) || !exact(value, ['v', 'task_id', 'principal', 'user']) || value.v !== 1
    || typeof value.task_id !== 'string' || !UUID.test(value.task_id)
    || typeof value.principal !== 'string' || !UUID.test(value.principal)
    || typeof value.user !== 'string' || !MATRIX_USER.test(value.user)) {return undefined}

  return { v: 1, taskId: value.task_id, principal: value.principal, user: value.user }
}

export function agentTaskCoordinatorWire(value: AgentTaskCoordinator): Record<string, unknown> {
  const coordinator = agentTaskCoordinator({
    v: 1,
    task_id: value.taskId,
    principal: value.principal,
    user: value.user
  })

  if (!coordinator) {throw new Error('matrix_agent_task_invalid')}

  return {
    v: 1,
    task_id: coordinator.taskId,
    principal: coordinator.principal,
    user: coordinator.user
  }
}

/** Apply the owner's current-Main pointer without mutating the immutable creation record. */
export function agentTaskCoordinatedBinding(
  binding: AgentTaskBinding,
  coordinator: AgentTaskCoordinator | undefined
): AgentTaskBinding | undefined {
  if (!coordinator) {return binding}
  if (coordinator.taskId !== binding.taskId) {return undefined}

  return { ...binding, mainPrincipal: coordinator.principal, mainUser: coordinator.user }
}

/** Validate model-facing task results before they return to Hermes. */
export function agentTaskResult(value: unknown): AgentTaskResult | undefined {
  if (object(value) && exact(value, ['error']) && ['denied', 'invalid', 'missing', 'unavailable'].includes(String(value.error))) {
    return { error: value.error as AgentTaskError }
  }
  if (!object(value) || !exact(value, ['originPrincipal', 'originIsMain', 'task', 'tasks']) ||
      typeof value.originPrincipal !== 'string' || !UUID.test(value.originPrincipal) || typeof value.originIsMain !== 'boolean') {
    return undefined
  }

  const summary = (input: unknown): AgentTaskSummary | undefined => {
    if (!object(input) || !exact(input, [
      'taskId', 'originPrincipal', 'originName', 'targetPrincipal', 'targetName', 'state', 'createdAt', 'expiresAt',
      'updatedAt', 'result', 'control'
    ]) || typeof input.taskId !== 'string' || !UUID.test(input.taskId) ||
      typeof input.originPrincipal !== 'string' || !UUID.test(input.originPrincipal) ||
      typeof input.originName !== 'string' || input.originName.length > MAX_NAME_CHARS ||
      typeof input.targetPrincipal !== 'string' || !UUID.test(input.targetPrincipal) ||
      typeof input.targetName !== 'string' || input.targetName.length > MAX_NAME_CHARS ||
      !['pending', 'accepted', 'running', 'completed', 'failed', 'stopped', 'expired'].includes(String(input.state)) ||
      !timestamp(input.createdAt) || !timestamp(input.expiresAt) || !timestamp(input.updatedAt) ||
      input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > 30 * 60_000 ||
      (input.result !== undefined &&
        (typeof input.result !== 'string' || new TextEncoder().encode(input.result).byteLength > AGENT_TASK_RESULT_MAX_BYTES)) ||
      (input.control !== undefined && !['stop_requested', 'steer_sent'].includes(String(input.control)))) {return undefined}
    return input as unknown as AgentTaskSummary
  }

  if (value.task !== undefined && value.tasks === undefined) {
    const task = summary(value.task)
    return task ? { originPrincipal: value.originPrincipal, originIsMain: value.originIsMain, task } : undefined
  }
  if (Array.isArray(value.tasks) && value.task === undefined && value.tasks.length <= 100) {
    const tasks = value.tasks.map(summary)
    return tasks.every(Boolean)
      ? { originPrincipal: value.originPrincipal, originIsMain: value.originIsMain, tasks: tasks as AgentTaskSummary[] }
      : undefined
  }
  return undefined
}
