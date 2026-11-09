import { createHash } from 'node:crypto'

import {
  AGENT_TASK_RESULT_MAX_BYTES,
  agentTaskBinding,
  type AgentTaskBinding,
  agentTaskBindingWire,
  agentTaskResultText
} from '../../shared/agent-task'
import type {
  MatrixEnrollmentIdentity,
  MatrixIdentity,
  MatrixInvocationMessage,
  MatrixSdkCommand
} from '../../shared/matrix'
import { MATRIX_PLAIN_SENDER_DEVICE } from '../../shared/matrix'
import type { EncryptedStore } from '../encrypted-store'

import type { MatrixAgentDefinitionRecord } from './agent-definition'
import { matrixConversationKey, type MatrixGrant } from './invocation'
import type { MatrixPreparedConversation } from './prepared-conversation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DISPATCH_MARGIN_MS = 15_000

interface StoredTaskOutcome {
  v: 1
  invocationId: string
  status: 'completed' | 'failed' | 'stopped'
  text: string
  storedSession?: string
  publishedEvent?: string
}

export interface AgentTaskInvocationDependencies {
  context(): { human: MatrixIdentity; agent: MatrixEnrollmentIdentity }
  roster(signal: AbortSignal): Promise<readonly MatrixAgentDefinitionRecord[] | undefined>
  read(command: MatrixSdkCommand, timeoutMs?: number): Promise<unknown>
  authorize(input: Record<string, unknown>): Promise<unknown>
  leaseToken: string
  prepare(input: { conversationKey: string; signal: AbortSignal }): Promise<MatrixPreparedConversation>
  execute(input: {
    invocationId: string
    conversationKey: string
    conversation: MatrixPreparedConversation
    text: string
    signal: AbortSignal
    deadlineAt: number
  }): Promise<{ text: string; storedSession: string }>
  store: EncryptedStore
  stopped(): boolean
  /**
   * The task's result went through the platform's outbox (atum.agent-home/2.1): the platform's worker records the
   * event on the ledger itself, so the legacy "published" acknowledgement is not sent for it.
   */
  ledgerPublishes?(invocationId: string): boolean
}

export type AgentTaskInvocationOutcome =
  | { state: 'published'; eventId: string }
  | { state: 'ignored' }
  | { state: 'unknown' }

function requestHash(binding: AgentTaskBinding, message: MatrixInvocationMessage): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'atum-agent-task-v1',
      binding.taskId,
      binding.owner,
      binding.originPrincipal,
      binding.originUser,
      binding.targetPrincipal,
      binding.targetUser,
      binding.createdAt,
      binding.expiresAt,
      message.content.body
    ]))
    .digest('hex')
}

function outcomeKey(context: { human: MatrixIdentity; agent: MatrixEnrollmentIdentity }, binding: AgentTaskBinding): string {
  return `matrix-agent-task-outcome-${createHash('sha256')
    .update(JSON.stringify([
      context.agent.issuer,
      context.agent.principal,
      context.agent.agentPrincipal,
      context.agent.deviceId,
      context.human.userId,
      binding.taskId
    ]))
    .digest('hex')}`
}

function storedOutcome(value: string | null): StoredTaskOutcome | undefined {
  if (value === null) {return undefined}

  const parsed = JSON.parse(value) as StoredTaskOutcome

  if (
    parsed?.v !== 1 ||
    !UUID.test(parsed.invocationId) ||
    !['completed', 'failed', 'stopped'].includes(parsed.status) ||
    typeof parsed.text !== 'string' ||
    !parsed.text ||
    new TextEncoder().encode(parsed.text).byteLength > AGENT_TASK_RESULT_MAX_BYTES ||
    (parsed.storedSession !== undefined && (typeof parsed.storedSession !== 'string' || !parsed.storedSession)) ||
    (parsed.publishedEvent !== undefined &&
      (typeof parsed.publishedEvent !== 'string' || !parsed.publishedEvent.startsWith('$')))
  ) {
    throw new Error('matrix_agent_task_outcome_invalid')
  }

  return parsed
}

/** A completed local result can be reconciled after the coordinator pointer changes. */
export function hasStoredMatrixAgentTaskOutcome(
  store: Pick<EncryptedStore, 'getItem' | 'failureCode'>,
  context: { human: MatrixIdentity; agent: MatrixEnrollmentIdentity },
  binding: AgentTaskBinding
): boolean {
  if (store.failureCode()) {return false}

  try {
    return Boolean(storedOutcome(store.getItem(outcomeKey(context, binding))))
  } catch {
    return false
  }
}

function grant(
  value: unknown,
  expected: {
    context: { human: MatrixIdentity; agent: MatrixEnrollmentIdentity }
    binding: AgentTaskBinding
    request: Record<string, unknown>
    invocationId?: string
  }
): MatrixGrant {
  const result = value as MatrixGrant & Record<string, unknown>
  const task = agentTaskBinding(result?.task)
  const expectedTask = agentTaskBinding(expected.request.task)

  if (
    result?.owner !== expected.context.agent.principal ||
    result.payer !== expected.context.agent.principal ||
    result.capability !== 'agent-task' ||
    result.agentPrincipal !== expected.context.agent.agentPrincipal ||
    result.agentDevice !== expected.context.agent.deviceId ||
    !task || !expectedTask ||
    JSON.stringify(agentTaskBindingWire(task)) !== JSON.stringify(agentTaskBindingWire(expectedTask)) ||
    Object.entries(expected.request).some(([key, want]) =>
      !['task', 'protocol', 'admission', 'leaseToken'].includes(key) && result[key] !== want
    ) ||
    typeof result.invocationId !== 'string' ||
    !UUID.test(result.invocationId) ||
    (expected.invocationId !== undefined && result.invocationId !== expected.invocationId) ||
    !['claimed', 'dispatched', 'completed'].includes(result.state) ||
    !Number.isFinite(result.expiresAt) ||
    (result.transactionId !== undefined && !UUID.test(result.transactionId)) ||
    (result.publishedEvent !== undefined &&
      (typeof result.publishedEvent !== 'string' || !result.publishedEvent.startsWith('$')))
  ) {
    throw new Error('matrix_agent_task_grant_invalid')
  }

  return result
}

function taskPrompt(binding: AgentTaskBinding, originName: string, targetName: string, prompt: string): string {
  return [
    `Authenticated Atum task from your owned teammate ${originName} (${binding.originPrincipal}).`,
    `You are ${targetName} (${binding.targetPrincipal}). Use only your own identity, tools, permissions, model grant, billing, and Hermes home.`,
    'Return the completed result for this task; do not claim authority inherited from the sender.',
    '',
    prompt
  ].join('\n')
}

/**
 * Run one durable named-agent task through the existing invocation fence.
 * Matrix is transport and recovery log; this function grants nothing from room membership.
 */
export async function invokeMatrixAgentTask(
  deps: AgentTaskInvocationDependencies,
  input: { roomId: string; eventId: string },
  signal: AbortSignal
): Promise<AgentTaskInvocationOutcome> {
  signal.throwIfAborted()
  const context = structuredClone(deps.context())
  const roster = await deps.roster(signal)

  if (!roster) {throw new Error('matrix_agent_task_roster_unavailable')}

  const binding = (await deps.read({
    kind: 'readAgentTaskRoom',
    roomId: input.roomId,
    ownerId: context.human.userId,
    agentPrincipal: context.agent.agentPrincipal,
    agentUserId: context.agent.userId
  })) as AgentTaskBinding
  signal.throwIfAborted()

  const origin = roster.find(agent => agent.status === 'active' && agent.principal === binding?.originPrincipal)
  const target = roster.find(agent => agent.status === 'active' && agent.principal === binding?.targetPrincipal)
  const currentMain = roster.find(agent => agent.status === 'active' && agent.isDefault)

  if (
    !binding ||
    binding.owner !== context.human.userId ||
    binding.targetPrincipal !== context.agent.agentPrincipal ||
    binding.targetUser !== context.agent.userId ||
    origin?.matrixUser !== binding.originUser ||
    target?.matrixUser !== binding.targetUser
  ) {
    throw new Error('matrix_agent_task_denied')
  }

  const key = outcomeKey(context, binding)
  const raw = deps.store.getItem(key)

  if (deps.store.failureCode()) {throw new Error('matrix_vault_unavailable')}

  let saved = storedOutcome(raw)
  if (!saved && (
    currentMain?.principal !== binding.mainPrincipal ||
    currentMain.matrixUser !== binding.mainUser ||
    binding.expiresAt <= Date.now()
  )) {
    throw new Error('matrix_agent_task_denied')
  }

  const message = (await deps.read({ kind: 'readInvocation', ...input })) as MatrixInvocationMessage
  signal.throwIfAborted()

  if (
    message?.roomId !== input.roomId ||
    message.eventId !== input.eventId ||
    message.wireType !== 'm.room.message' ||
    message.roomPlain !== true ||
    message.senderVerified !== true ||
    message.senderDevice !== MATRIX_PLAIN_SENDER_DEVICE ||
    message.sender !== binding.originUser ||
    message.related !== false ||
    message.content?.msgtype !== 'm.text' ||
    typeof message.content.body !== 'string' ||
    !message.content.body.trim() ||
    message.content.agentTask?.taskId !== binding.taskId ||
    message.content.agentTask.kind !== 'start' ||
    message.content.agentTask.at !== binding.createdAt ||
    !Number.isSafeInteger(message.timestamp) ||
    message.timestamp! > Date.now() + 300_000 ||
    message.timestamp! < binding.createdAt - 300_000
  ) {
    throw new Error('matrix_agent_task_untrusted')
  }

  const hash = requestHash(binding, message)
  const request = {
    roomId: input.roomId,
    eventId: input.eventId,
    executorId: context.agent.executorId,
    requestHash: hash,
    senderDevice: `agent:${binding.originPrincipal}`,
    protocol: 2,
    admission: 'automatic',
    leaseToken: deps.leaseToken,
    task: agentTaskBindingWire(binding)
  }
  const ask = async (operation: string, invocationId?: string, publishedEvent?: string) =>
    grant(
      await deps.authorize({
        ...request,
        operation,
        ...(invocationId ? { invocationId } : {}),
        ...(publishedEvent ? { publishedEvent } : {})
      }),
      { context, binding, request, ...(invocationId ? { invocationId } : {}) }
    )

  if (!saved && deps.stopped()) {
    await deps.read({
      kind: 'sendAgentTask',
      roomId: input.roomId,
      taskId: binding.taskId,
      action: 'stopped',
      body: 'Task stopped before execution.',
      transactionId: `atum-task-stopped-${binding.taskId}`
    })

    return { state: 'ignored' }
  }

  if (!saved) {
    let authority = await ask('claim')

    if (authority.publishedEvent) {return { state: 'published', eventId: authority.publishedEvent }}
    if (authority.state !== 'claimed') {return { state: 'unknown' }}

    if (deps.stopped()) {
      await deps.read({
        kind: 'sendAgentTask',
        roomId: input.roomId,
        taskId: binding.taskId,
        action: 'stopped',
        body: 'Task stopped before execution.',
        transactionId: `atum-task-stopped-${binding.taskId}`
      })

      return { state: 'ignored' }
    }

    await deps.read({
      kind: 'sendAgentTask',
      roomId: input.roomId,
      taskId: binding.taskId,
      action: 'accepted',
      body: 'Task accepted.',
      transactionId: `atum-task-accepted-${binding.taskId}`
    })
    signal.throwIfAborted()

    const conversationKey = matrixConversationKey(
      context.agent,
      context.human,
      input.roomId,
      binding.taskId
    )
    let conversation: MatrixPreparedConversation

    try {
      conversation = await deps.prepare({ conversationKey, signal })
    } catch (cause) {
      if (!deps.stopped()) {throw cause}

      await deps.read({
        kind: 'sendAgentTask',
        roomId: input.roomId,
        taskId: binding.taskId,
        action: 'stopped',
        body: 'Task stopped before execution.',
        transactionId: `atum-task-stopped-${binding.taskId}`
      })

      return { state: 'ignored' }
    }
    if (deps.stopped()) {
      await deps.read({
        kind: 'sendAgentTask',
        roomId: input.roomId,
        taskId: binding.taskId,
        action: 'stopped',
        body: 'Task stopped before execution.',
        transactionId: `atum-task-stopped-${binding.taskId}`
      })

      return { state: 'ignored' }
    }
    signal.throwIfAborted()

    if (authority.expiresAt - Date.now() < DISPATCH_MARGIN_MS) {
      throw new Error('matrix_agent_task_claim_expiring')
    }

    authority = await ask('dispatch', authority.invocationId)
    if (authority.state !== 'dispatched' || authority.expiresAt <= Date.now()) {return { state: 'unknown' }}

    await deps.read({
      kind: 'sendAgentTask',
      roomId: input.roomId,
      taskId: binding.taskId,
      action: 'running',
      body: 'Task running.',
      transactionId: `atum-task-running-${binding.taskId}`
    }).catch(() => undefined)

    const deadlineAt = Math.min(authority.expiresAt, binding.expiresAt, context.agent.expiresAt)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()))])

    try {
      const result = await deps.execute({
        invocationId: authority.invocationId,
        conversationKey,
        conversation,
        text: taskPrompt(binding, origin.displayName, target.displayName, message.content.body),
        signal: deadline,
        deadlineAt
      })

      if (typeof result?.text !== 'string' || !result.text || typeof result.storedSession !== 'string' || !result.storedSession) {
        throw new Error('matrix_agent_task_outcome_invalid')
      }

      saved = { v: 1, invocationId: authority.invocationId, status: 'completed',
        text: agentTaskResultText(result.text), storedSession: result.storedSession }
    } catch {
      saved = {
        v: 1,
        invocationId: authority.invocationId,
        status: deps.stopped() ? 'stopped' : 'failed',
        text: deps.stopped()
          ? 'Task stopped.'
          : Date.now() >= deadlineAt
            ? 'Task deadline reached.'
            : 'Task interrupted.'
      }
    }

    deps.store.setItem(key, JSON.stringify(saved))
  }

  const authority = await ask('complete', saved.invocationId)
  if (authority.publishedEvent) {return { state: 'published', eventId: authority.publishedEvent }}
  if (authority.state !== 'completed' || !authority.transactionId) {return { state: 'unknown' }}

  if (!saved.publishedEvent) {
    const eventId = (await deps.read({
      kind: 'publishResult',
      roomId: input.roomId,
      eventId: input.eventId,
      body: saved.text,
      invocationId: saved.invocationId,
      transactionId: authority.transactionId,
      task: true,
      // Completed on the platform's ledger (`ask('complete')` above): where a migrated agent's worker records it.
      ledger: true,
      taskOutcome: saved.status,
      ...(saved.status === 'completed' ? {} : { status: saved.status })
    })) as string

    if (typeof eventId !== 'string' || !eventId.startsWith('$')) {throw new Error('matrix_agent_task_publication_invalid')}
    saved = { ...saved, publishedEvent: eventId }
    deps.store.setItem(key, JSON.stringify(saved))
  }

  if (!deps.ledgerPublishes?.(saved.invocationId)) {
    await ask('published', saved.invocationId, saved.publishedEvent)
  }

  return { state: 'published', eventId: saved.publishedEvent }
}
