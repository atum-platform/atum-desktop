import { describe, expect, it, vi } from 'vitest'

import type { AgentTaskBinding, AgentTaskRoom } from './agent-task'
import { type AgentTaskRosterEntry, manageMatrixAgentTask } from './agent-task-management'

const MAIN = '00000000-0000-4000-8000-bd7662a5eeb4'
const ORIGIN = '00000000-0000-4000-8000-b454f82c5857'
const TARGET = '00000000-0000-4000-8000-f6222a1106ee'
const OTHER = '00000000-0000-4000-8000-f1d11edf5c5c'
const CREATED_AT = 1_000_000

const roster: AgentTaskRosterEntry[] = [
  { principal: MAIN, matrixUser: '@main:test', displayName: 'Atum', status: 'active', isDefault: true },
  { principal: ORIGIN, matrixUser: '@origin:test', displayName: 'Planner', status: 'active', isDefault: false },
  { principal: TARGET, matrixUser: '@target:test', displayName: 'Researcher', status: 'active', isDefault: false },
  { principal: OTHER, matrixUser: '@other:test', displayName: 'Writer', status: 'active', isDefault: false }
]

function binding(
  taskId: string,
  originPrincipal = ORIGIN,
  targetPrincipal = TARGET
): AgentTaskBinding {
  const origin = roster.find(agent => agent.principal === originPrincipal)!
  const target = roster.find(agent => agent.principal === targetPrincipal)!

  return {
    v: 1,
    taskId,
    owner: '@owner:test',
    originPrincipal,
    originUser: origin.matrixUser!,
    targetPrincipal,
    targetUser: target.matrixUser!,
    mainPrincipal: MAIN,
    mainUser: '@main:test',
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + 900_000
  }
}

function room(taskId: string, originPrincipal = ORIGIN, targetPrincipal = TARGET): AgentTaskRoom {
  return {
    roomId: `!${taskId}:test`,
    binding: binding(taskId, originPrincipal, targetPrincipal),
    startEventId: `$${taskId}:test`,
    state: 'running',
    updatedAt: CREATED_AT + 1
  }
}

function options(originPrincipal: string, command: ReturnType<typeof vi.fn>) {
  return {
    roster: async () => roster,
    originPrincipal,
    ownerUserId: '@owner:test',
    command,
    current: () => true,
    clock: () => CREATED_AT
  }
}

function start(
  target = TARGET,
  prompt = 'Find primary sources.',
  timeoutMinutes = 15,
  turnId = 'matrix-turn-one'
) {
  return { operation: 'start' as const, target, prompt, timeoutMinutes, turn_id: turnId }
}

describe('agent task management', () => {
  it('creates one exact Matrix binding from the current roster without caller-selected authority', async () => {
    const command = vi.fn(async value => {
      if (value.kind === 'listAgentTasks') {return []}
      expect(value).toMatchObject({ kind: 'createAgentTask', prompt: 'Find primary sources.' })
      const created = value as { binding: AgentTaskBinding }

      return {
        roomId: '!new:test',
        binding: created.binding,
        startEventId: '$start:test',
        state: 'pending',
        updatedAt: CREATED_AT
      }
    })

    await expect(manageMatrixAgentTask(
      options(ORIGIN, command),
      { operation: 'start', target: TARGET, prompt: 'Find primary sources.', role: 'main' },
      new AbortController().signal
    )).resolves.toEqual({ error: 'invalid' })

    const result = await manageMatrixAgentTask(
      options(ORIGIN, command),
      start(),
      new AbortController().signal
    )

    expect(command).toHaveBeenCalledTimes(2)
    expect(command.mock.calls[0]![0]).toMatchObject({
      kind: 'listAgentTasks',
      ownedAgents: roster.map(agent => ({ principal: agent.principal, userId: agent.matrixUser })),
      taskId: expect.any(String)
    })
    expect(command.mock.calls[1]![0]).toMatchObject({
      kind: 'createAgentTask',
      binding: {
        owner: '@owner:test',
        originPrincipal: ORIGIN,
        originUser: '@origin:test',
        targetPrincipal: TARGET,
        targetUser: '@target:test',
        mainPrincipal: MAIN,
        mainUser: '@main:test',
        createdAt: CREATED_AT,
        expiresAt: CREATED_AT + 900_000
      }
    })
    expect(result).toMatchObject({
      originPrincipal: ORIGIN,
      originIsMain: false,
      task: {
        originPrincipal: ORIGIN,
        originName: 'Planner',
        targetPrincipal: TARGET,
        targetName: 'Researcher',
        state: 'pending'
      }
    })
  })

  it('recovers the same task after room and start succeed but its pointer write fails', async () => {
    let recovered: AgentTaskRoom | undefined

    const command = vi.fn(async value => {
      if (value.kind === 'listAgentTasks') {return recovered ? [recovered] : []}

      if (value.kind === 'createAgentTask') {
        const created = value as { binding: AgentTaskBinding }

        // This is the authoritative room identity that is synced despite the
        // optional start pointer write failing after start was sent.
        recovered = {
          roomId: '!recovered:test',
          binding: created.binding,
          state: 'pending',
          updatedAt: CREATED_AT
        }
        throw new Error('matrix_start_pointer_failed')
      }

      throw new Error('unexpected command')
    })

    await expect(manageMatrixAgentTask(
      options(ORIGIN, command), start(), new AbortController().signal
    )).resolves.toEqual({ error: 'unavailable' })

    await expect(manageMatrixAgentTask(
      options(ORIGIN, command), start(), new AbortController().signal
    )).resolves.toMatchObject({
      task: { taskId: recovered!.binding.taskId, state: 'pending' }
    })

    expect(command.mock.calls.filter(([value]) => value.kind === 'createAgentTask')).toHaveLength(1)
    expect(command.mock.calls.filter(([value]) => value.kind === 'listAgentTasks').map(([value]) => value.taskId))
      .toEqual([recovered!.binding.taskId, recovered!.binding.taskId])
  })

  it('creates a later-turn or distinct start request independently', async () => {
    const created: AgentTaskBinding[] = []

    const command = vi.fn(async value => {
      if (value.kind === 'listAgentTasks') {return []}

      const request = value as { binding: AgentTaskBinding }

      created.push(request.binding)

      return { roomId: `!${request.binding.taskId}:test`, binding: request.binding,
        startEventId: '$start:test', state: 'pending', updatedAt: CREATED_AT }
    })

    await manageMatrixAgentTask(options(ORIGIN, command), start(TARGET, 'Find primary sources.', 15, 'turn-one'), new AbortController().signal)
    await manageMatrixAgentTask(options(ORIGIN, command), start(TARGET, 'Find primary sources.', 15, 'turn-two'), new AbortController().signal)
    await manageMatrixAgentTask(options(ORIGIN, command), start(OTHER, 'Find primary sources.', 15, 'turn-one'), new AbortController().signal)

    expect(created.map(binding => binding.taskId)).toHaveLength(3)
    expect(new Set(created.map(binding => binding.taskId))).toHaveLength(3)
  })

  it('returns a matching stopped task instead of silently restarting it', async () => {
    const stopped = room('00000000-0000-4000-8000-303617b97302')
    let taskId = ''

    const command = vi.fn(async value => {
      if (value.kind === 'listAgentTasks') {
        taskId = value.taskId

        return [{ ...stopped, binding: { ...stopped.binding, taskId: value.taskId }, state: 'stopped' }]
      }

      throw new Error('start must not be recreated')
    })

    const result = await manageMatrixAgentTask(options(ORIGIN, command), start(), new AbortController().signal)

    expect(result).toMatchObject({ task: { taskId, state: 'stopped' } })
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('fails closed for a start without its runtime turn identity', async () => {
    const command = vi.fn()

    await expect(manageMatrixAgentTask(
      options(ORIGIN, command), { operation: 'start', target: TARGET, prompt: 'Find primary sources.' }, new AbortController().signal
    )).resolves.toEqual({ error: 'unavailable' })
    expect(command).not.toHaveBeenCalled()
  })

  it('shows ordinary agents only participating tasks while Main sees the owned roster tasks', async () => {
    const visible = room('00000000-0000-4000-8000-303617b97302')
    const hidden = room('00000000-0000-4000-8000-00f765af1c54', TARGET, OTHER)
    const command = vi.fn(async () => [visible, hidden])

    await expect(manageMatrixAgentTask(
      options(ORIGIN, command),
      { operation: 'list' },
      new AbortController().signal
    )).resolves.toMatchObject({ tasks: [{ taskId: visible.binding.taskId }] })
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'listAgentTasks', limit: 100 }), 30_000)

    await expect(manageMatrixAgentTask(
      options(MAIN, command),
      { operation: 'list' },
      new AbortController().signal
    )).resolves.toMatchObject({
      originIsMain: true,
      tasks: [{ taskId: visible.binding.taskId }, { taskId: hidden.binding.taskId }]
    })
  })

  it('allows only the origin or current Main to send controls', async () => {
    const task = room('00000000-0000-4000-8000-50d86b120e98')
    const command = vi.fn(async value => value.kind === 'listAgentTasks' ? [task] : '$control:test')

    await expect(manageMatrixAgentTask(
      options(OTHER, command),
      { operation: 'stop', taskId: task.binding.taskId },
      new AbortController().signal
    )).resolves.toEqual({ error: 'missing' })

    const mainResult = await manageMatrixAgentTask(
      options(MAIN, command),
      { operation: 'steer', taskId: task.binding.taskId, text: 'Use primary sources.' },
      new AbortController().signal
    )

    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'listAgentTasks',
      taskId: task.binding.taskId
    }), 30_000)
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'sendAgentTask',
      taskId: task.binding.taskId,
      action: 'steer',
      body: 'Use primary sources.'
    }), 30_000)
    expect(mainResult).toMatchObject({ task: { control: 'steer_sent' } })
  })

  it('rejects malformed room projections instead of trusting a native cast', async () => {
    const malformed = { ...room('00000000-0000-4000-8000-0bb5de138389'), binding: { taskId: 'forged' } }
    const command = vi.fn(async () => [malformed])

    await expect(manageMatrixAgentTask(
      options(MAIN, command),
      { operation: 'list' },
      new AbortController().signal
    )).resolves.toEqual({ error: 'unavailable' })
  })

  it('keeps a durable task readable after its target leaves the active roster', async () => {
    const task = room('00000000-0000-4000-8000-6cc9b1298c8f')
    const command = vi.fn(async () => [task])

    await expect(manageMatrixAgentTask(
      { ...options(MAIN, command), roster: async () => roster.filter(agent => agent.principal !== TARGET) },
      { operation: 'read', taskId: task.binding.taskId },
      new AbortController().signal
    )).resolves.toMatchObject({
      task: {
        originName: 'Planner',
        targetPrincipal: TARGET,
        targetName: TARGET
      }
    })
  })
})
