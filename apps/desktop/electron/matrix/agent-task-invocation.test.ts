import { expect, it, vi } from 'vitest'

import { type AgentTaskBinding, agentTaskBindingWire } from '../../shared/agent-task'
import {
  MATRIX_PLAIN_SENDER_DEVICE,
  type MatrixEnrollmentIdentity,
  type MatrixIdentity,
  type MatrixInvocationMessage
} from '../../shared/matrix'
import type { EncryptedStore } from '../encrypted-store'

import type { MatrixAgentDefinitionRecord } from './agent-definition'
import { type AgentTaskInvocationDependencies, invokeMatrixAgentTask } from './agent-task-invocation'

const OWNER_PRINCIPAL = '00000000-0000-4000-8000-bd7662a5eeb4'
const ORIGIN = '00000000-0000-4000-8000-b454f82c5857'
const TARGET = '00000000-0000-4000-8000-f6222a1106ee'
const MAIN = '00000000-0000-4000-8000-f1d11edf5c5c'
const TASK = '00000000-0000-4000-8000-fbfe405ca65f'
const EXECUTOR = '00000000-0000-4000-8000-a9703d75e616'
const INVOCATION = '00000000-0000-4000-8000-f2da1f9533d4'
const TRANSACTION = '00000000-0000-4000-8000-c8f367a876b2'

function record(principal: string, matrixUser: string, displayName: string, isDefault = false): MatrixAgentDefinitionRecord {
  return {
    id: principal,
    identityId: principal,
    principal,
    matrixUser,
    displayName,
    avatar: '✦',
    avatarUrl: null,
    isDefault,
    lifecycleRevision: 1,
    identityRevision: 1,
    definitionRevision: 1,
    status: 'active'
  }
}

function fixture() {
  const now = Date.now()
  const binding: AgentTaskBinding = {
    v: 1,
    taskId: TASK,
    owner: '@owner:test',
    originPrincipal: ORIGIN,
    originUser: '@origin:test',
    targetPrincipal: TARGET,
    targetUser: '@target:test',
    mainPrincipal: MAIN,
    mainUser: '@main:test',
    createdAt: now - 1_000,
    expiresAt: now + 10 * 60_000
  }
  const human: MatrixIdentity = { userId: '@owner:test', deviceId: 'OWNER' }
  const agent: MatrixEnrollmentIdentity = {
    issuer: 'https://issuer.test',
    subject: 'subject',
    principal: OWNER_PRINCIPAL,
    userId: '@target:test',
    deviceId: 'TARGET-DEVICE',
    executorId: EXECUTOR,
    agentPrincipal: TARGET,
    expiresAt: now + 60 * 60_000
  }
  const message: MatrixInvocationMessage = {
    roomId: '!task:test',
    eventId: '$start:test',
    wireType: 'm.room.message',
    sender: '@origin:test',
    senderDevice: MATRIX_PLAIN_SENDER_DEVICE,
    senderVerified: true,
    timestamp: now,
    related: false,
    roomPlain: true,
    content: {
      msgtype: 'm.text',
      body: 'Research this.',
      agentTask: { v: 1, taskId: TASK, kind: 'start', at: binding.createdAt }
    }
  }
  const values = new Map<string, string>()
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    failureCode: () => null
  } as unknown as EncryptedStore
  const operations: string[] = []
  const commands: unknown[] = []
  const read = vi.fn(async command => {
    commands.push(command)
    if (command.kind === 'readAgentTaskRoom') {return binding}
    if (command.kind === 'readInvocation') {return message}
    if (command.kind === 'publishResult') {return '$result:test'}
    if (command.kind === 'sendAgentTask') {return `$${command.action}:test`}
    throw new Error(`unexpected ${command.kind}`)
  })
  const authorize = vi.fn(async request => {
    const operation = String(request.operation)
    operations.push(operation)
    const state = operation === 'claim' ? 'claimed' : operation === 'dispatch' ? 'dispatched' : 'completed'

    return {
      ...request,
      owner: OWNER_PRINCIPAL,
      payer: OWNER_PRINCIPAL,
      capability: 'agent-task',
      agentPrincipal: TARGET,
      agentDevice: 'TARGET-DEVICE',
      invocationId: INVOCATION,
      state,
      expiresAt: binding.expiresAt,
      task: agentTaskBindingWire(binding),
      ...(operation === 'complete' ? { transactionId: TRANSACTION } : {}),
      ...(operation === 'published' ? { publishedEvent: '$result:test' } : {})
    }
  })
  const execute = vi.fn(async (_input: Parameters<AgentTaskInvocationDependencies['execute']>[0]) => ({
    text: 'Primary-source result.',
    storedSession: 'task-session'
  }))

  return {
    binding,
    message,
    values,
    operations,
    commands,
    execute,
    deps: {
      context: () => ({ human, agent }),
      roster: async () => [
        record(ORIGIN, '@origin:test', 'Planner'),
        record(TARGET, '@target:test', 'Researcher'),
        record(MAIN, '@main:test', 'Atum', true)
      ],
      read,
      authorize,
      leaseToken: '00000000-0000-4000-8000-e8d95748107a',
      prepare: vi.fn(async ({ conversationKey }) => Object.freeze({ conversationKey })),
      execute,
      store,
      stopped: () => false
    }
  }
}

it('runs a task only as the target and commits one terminal result through the ordinary fence', async () => {
  const f = fixture()
  const result = await invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )

  expect(result).toEqual({ state: 'published', eventId: '$result:test' })
  expect(f.operations).toEqual(['claim', 'dispatch', 'complete', 'published'])
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.execute.mock.calls[0]![0]).toMatchObject({
    invocationId: INVOCATION,
    text: expect.stringContaining('Use only your own identity, tools, permissions, model grant, billing, and Hermes home.')
  })
  expect(f.commands).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'sendAgentTask', action: 'accepted', taskId: TASK }),
    expect.objectContaining({ kind: 'sendAgentTask', action: 'running', taskId: TASK }),
    expect.objectContaining({
      kind: 'publishResult',
      task: true,
      taskOutcome: 'completed',
      body: 'Primary-source result.',
      invocationId: INVOCATION,
      transactionId: TRANSACTION
    })
  ]))
  expect([...f.values.values()].some(value => value.includes('Primary-source result.'))).toBe(true)
})

it('accepts an owner-reconciled task when Main is reassigned after room creation', async () => {
  const f = fixture()
  f.binding.mainPrincipal = ORIGIN
  f.binding.mainUser = '@origin:test'
  f.deps.roster = async () => [
    record(ORIGIN, '@origin:test', 'Planner', true),
    record(TARGET, '@target:test', 'Researcher'),
    record(MAIN, '@main:test', 'Former Main')
  ]

  await expect(invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )).resolves.toEqual({ state: 'published', eventId: '$result:test' })
})

it('publishes a saved result after Main changes and the task expires before coordinator reconciliation', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    const authorize = f.deps.authorize
    let interruptCompletion = true
    f.deps.authorize = vi.fn(async request => {
      if (request.operation === 'complete' && interruptCompletion) {
        interruptCompletion = false
        throw new Error('connection_lost')
      }

      return authorize(request)
    })

    await expect(invokeMatrixAgentTask(
      f.deps,
      { roomId: '!task:test', eventId: '$start:test' },
      new AbortController().signal
    )).rejects.toThrow('connection_lost')
    expect(f.execute).toHaveBeenCalledTimes(1)

    vi.setSystemTime(f.binding.expiresAt + 1)
    f.deps.roster = async () => [
      record(ORIGIN, '@origin:test', 'Planner', true),
      record(TARGET, '@target:test', 'Researcher'),
      record(MAIN, '@main:test', 'Former Main')
    ]

    await expect(invokeMatrixAgentTask(
      f.deps,
      { roomId: '!task:test', eventId: '$start:test' },
      new AbortController().signal
    )).resolves.toEqual({ state: 'published', eventId: '$result:test' })
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.operations).toEqual(['claim', 'dispatch', 'complete', 'published'])
    expect(f.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'publishResult', task: true, body: 'Primary-source result.' })
    ]))
  } finally {
    vi.useRealTimers()
  }
})

it('refuses a stale coordinator binding after Main is reassigned', async () => {
  const f = fixture()
  f.deps.roster = async () => [
    record(ORIGIN, '@origin:test', 'Planner', true),
    record(TARGET, '@target:test', 'Researcher'),
    record(MAIN, '@main:test', 'Former Main')
  ]

  await expect(invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )).rejects.toThrow('matrix_agent_task_denied')
  expect(f.operations).toEqual([])
})

it('refuses an expired task before claiming or dispatching when no result was saved', async () => {
  const f = fixture()
  f.binding.expiresAt = Date.now() - 1

  await expect(invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )).rejects.toThrow('matrix_agent_task_denied')
  expect(f.operations).toEqual([])
  expect(f.execute).not.toHaveBeenCalled()
})

it('refuses a forged historical Main participant before claiming', async () => {
  const f = fixture()
  f.binding.mainPrincipal = '00000000-0000-4000-8000-303617b97302'
  f.binding.mainUser = '@forged:test'

  await expect(invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )).rejects.toThrow('matrix_agent_task_denied')
  expect(f.operations).toEqual([])
})

it('publishes one UTF-8-safe bounded terminal result', async () => {
  const f = fixture()
  f.execute.mockResolvedValueOnce({ text: '🙂'.repeat(20_000), storedSession: 'task-session' })

  await invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )

  const published = f.commands.find((command): command is { kind: string; body: string } =>
    typeof command === 'object' && command !== null && (command as { kind?: string }).kind === 'publishResult')
  expect(published).toBeDefined()
  expect(new TextEncoder().encode(published!.body).byteLength).toBeLessThanOrEqual(32_768)
  expect(published!.body.endsWith('…')).toBe(true)
  expect(published!.body).not.toContain('\ufffd')
})

it('refuses a room whose immutable target does not match the held executor identity', async () => {
  const f = fixture()
  f.binding.targetPrincipal = ORIGIN

  await expect(invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )).rejects.toThrow('matrix_agent_task_denied')
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.operations).toEqual([])
})

it('refuses a plaintext start without the SDK plain-sender assertion', async () => {
  const f = fixture()
  f.message.senderVerified = false

  await expect(invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )).rejects.toThrow('matrix_agent_task_untrusted')
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.operations).toEqual([])
})

it('refuses a plaintext start projected with any other sender-device marker', async () => {
  const f = fixture()
  f.message.senderDevice = 'forged-device'

  await expect(invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )).rejects.toThrow('matrix_agent_task_untrusted')
  expect(f.execute).not.toHaveBeenCalled()
})

it('refuses a platform grant that echoes a different task binding', async () => {
  const f = fixture()
  f.deps.authorize = vi.fn(async request => ({
    ...request,
    owner: OWNER_PRINCIPAL,
    payer: OWNER_PRINCIPAL,
    capability: 'agent-task',
    agentPrincipal: TARGET,
    agentDevice: 'TARGET-DEVICE',
    invocationId: INVOCATION,
    state: 'claimed',
    expiresAt: f.binding.expiresAt,
    task: { ...agentTaskBindingWire(f.binding), task_id: '00000000-0000-4000-8000-303617b97302' }
  }))

  await expect(invokeMatrixAgentTask(
    f.deps,
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )).rejects.toThrow('matrix_agent_task_grant_invalid')
  expect(f.execute).not.toHaveBeenCalled()
})

it('names the platform’s ledger as where a task result is recorded, and still acknowledges a direct send', async () => {
  const f = fixture()

  await invokeMatrixAgentTask(f.deps, { roomId: '!task:test', eventId: '$start:test' }, new AbortController().signal)

  expect(f.commands).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'publishResult', task: true, ledger: true, invocationId: INVOCATION })])
  )
  expect(f.operations).toEqual(['claim', 'dispatch', 'complete', 'published'])
})

it('does not acknowledge a task result the platform’s outbox sent: the ledger records the event itself', async () => {
  const f = fixture()
  const ledgerPublishes = vi.fn((invocationId: string) => invocationId === INVOCATION)

  const result = await invokeMatrixAgentTask(
    { ...f.deps, ledgerPublishes },
    { roomId: '!task:test', eventId: '$start:test' },
    new AbortController().signal
  )

  expect(result).toEqual({ state: 'published', eventId: '$result:test' })
  expect(ledgerPublishes).toHaveBeenCalledWith(INVOCATION)
  expect(f.operations).toEqual(['claim', 'dispatch', 'complete'])
})
