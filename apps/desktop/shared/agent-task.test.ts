import { describe, expect, it } from 'vitest'

import {
  agentTaskBinding,
  type AgentTaskBinding,
  type AgentTaskEvent,
  agentTaskMessage,
  agentTaskRequest,
  agentTaskResult,
  agentTaskResultText,
  agentTaskState
} from './agent-task'

const origin = '00000000-0000-4000-8000-bd7662a5eeb4'
const target = '00000000-0000-4000-8000-b454f82c5857'
const main = '00000000-0000-4000-8000-f6222a1106ee'
const taskId = '00000000-0000-4000-8000-f1d11edf5c5c'

const wire = {
  v: 1,
  task_id: taskId,
  owner: '@owner:test',
  origin_principal: origin,
  origin_user: '@origin:test',
  target_principal: target,
  target_user: '@target:test',
  main_principal: main,
  main_user: '@main:test',
  created_at: 100,
  expires_at: 200
}

describe('agent task contract', () => {
  it('keeps model requests narrow and bounded', () => {
    expect(agentTaskRequest({ operation: 'start', target, prompt: 'Research this', timeoutMinutes: 15 })).toEqual({
      operation: 'start', target, prompt: 'Research this', timeoutMinutes: 15
    })
    expect(agentTaskRequest({ operation: 'start', target: origin, prompt: '', timeoutMinutes: 15 })).toBeUndefined()
    expect(agentTaskRequest({ operation: 'list', target })).toBeUndefined()
    expect(agentTaskRequest({ operation: 'steer', taskId, text: 'Use primary sources' })).toEqual({
      operation: 'steer', taskId, text: 'Use primary sources'
    })
  })

  it('parses exact immutable room and message bindings', () => {
    expect(agentTaskBinding(wire)).toMatchObject({ taskId, originPrincipal: origin, targetPrincipal: target })
    expect(agentTaskBinding({ ...wire, owner_claim: origin })).toBeUndefined()
    expect(agentTaskMessage({ v: 1, task_id: taskId, kind: 'start', at: 101 })).toEqual({
      v: 1, taskId, kind: 'start', at: 101
    })
    expect(agentTaskMessage({ v: 1, task_id: taskId, kind: 'start', at: 101, role: 'main' })).toBeUndefined()
  })

  it('derives terminal state without treating controls as completion', () => {
    const binding = agentTaskBinding(wire) as AgentTaskBinding
    const events: AgentTaskEvent[] = [
      { v: 1, taskId, kind: 'start', at: 101, eventId: '$start:test', sender: binding.originUser, body: 'Do it' },
      { v: 1, taskId, kind: 'steer', at: 102, eventId: '$steer:test', sender: binding.mainUser, body: 'Be brief' },
      { v: 1, taskId, kind: 'running', at: 103, eventId: '$run:test', sender: binding.targetUser, body: 'Running' },
      { v: 1, taskId, kind: 'completed', at: 104, eventId: '$done:test', sender: binding.targetUser, body: 'Done' }
    ]

    expect(agentTaskState(events, 200, 150)).toEqual({
      startEventId: '$start:test', state: 'completed', updatedAt: 104, result: 'Done'
    })
    expect(agentTaskState(events.slice(0, 1), 200, 201).state).toBe('expired')
  })

  it('uses server order and never regresses a terminal task', () => {
    const binding = agentTaskBinding(wire) as AgentTaskBinding
    const events: AgentTaskEvent[] = [
      { v: 1, taskId, kind: 'start', at: 900, serverAt: 101, eventId: '$start:test', sender: binding.originUser, body: 'Do it' },
      { v: 1, taskId, kind: 'completed', at: 1, serverAt: 103, eventId: '$done:test', sender: binding.targetUser, body: 'Done' },
      { v: 1, taskId, kind: 'running', at: 999, serverAt: 104, eventId: '$late:test', sender: binding.targetUser, body: 'Late duplicate' }
    ]

    expect(agentTaskState(events, 1_000, 150)).toEqual({
      startEventId: '$start:test', state: 'completed', updatedAt: 103, result: 'Done'
    })
  })

  it('does not let status events create a lifecycle before the start marker', () => {
    const binding = agentTaskBinding(wire) as AgentTaskBinding
    const events: AgentTaskEvent[] = [
      { v: 1, taskId, kind: 'completed', at: 101, eventId: '$early:test', sender: binding.targetUser, body: 'Forged early result' },
      { v: 1, taskId, kind: 'start', at: 102, eventId: '$start:test', sender: binding.originUser, body: 'Do it' },
      { v: 1, taskId, kind: 'running', at: 103, eventId: '$run:test', sender: binding.targetUser, body: 'Running' }
    ]

    expect(agentTaskState(events, 200, 150)).toEqual({
      startEventId: '$start:test', state: 'running', updatedAt: 103
    })
    expect(agentTaskState(events.slice(0, 1), 200, 150)).toEqual({ state: 'pending', updatedAt: 0 })
  })

  it('rejects malformed native results', () => {
    const result = {
      originPrincipal: origin,
      originIsMain: false,
      task: {
        taskId,
        originPrincipal: origin,
        originName: 'Planner',
        targetPrincipal: target,
        targetName: 'Researcher',
        state: 'pending',
        createdAt: 100,
        expiresAt: 200,
        updatedAt: 100
      }
    }
    expect(agentTaskResult(result)).toEqual(result)
    expect(agentTaskResult({ ...result, task: { ...result.task, roomId: '!secret:test' } })).toBeUndefined()
  })

  it('keeps a terminal result in one bounded UTF-8 message', () => {
    const text = agentTaskResultText('🙂'.repeat(20_000))

    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(32_768)
    expect(text.endsWith('…')).toBe(true)
    expect(text).not.toContain('\ufffd')
    expect(agentTaskResultText('Complete result.')).toBe('Complete result.')
  })
})
