import { expect, it, vi } from 'vitest'

import type { AgentTaskEvent } from '../../shared/agent-task'
import type { EncryptedStore } from '../encrypted-store'

import { MatrixAgentTaskControls } from './agent-task-controls'

const TASK = '00000000-0000-4000-8000-bd7662a5eeb4'
const expires = () => Date.now() + 60_000

function store() {
  const values = new Map<string, string>()

  return {
    values,
    store: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value)
    } as unknown as EncryptedStore
  }
}

function event(eventId: string, kind: 'stop' | 'steer', body = 'Use primary sources.'): AgentTaskEvent {
  return {
    v: 1,
    taskId: TASK,
    kind,
    at: 1,
    eventId,
    sender: '@main:test',
    body
  }
}

it('persists a stop before execution and reapplies it after restart', () => {
  const fixture = store()
  const first = new MatrixAgentTaskControls(fixture.store)
  const expiresAt = expires()
  first.offer(event('$stop:test', 'stop'), expiresAt)

  const abort = new AbortController()
  const restarted = new MatrixAgentTaskControls(fixture.store)
  const active = restarted.begin(TASK, { abort, steer: vi.fn() })

  expect(active.stopped()).toBe(true)
  expect(abort.signal.aborted).toBe(true)
  expect(abort.signal.reason).toEqual({ reason: 'stopped' })
  active.finish()
})

it('queues an early steer and records it only after the live Hermes turn accepts it', async () => {
  const fixture = store()
  const controls = new MatrixAgentTaskControls(fixture.store)
  const steer = vi.fn(async () => true)
  const expiresAt = expires()
  controls.offer(event('$steer:test', 'steer'), expiresAt)

  const active = controls.begin(TASK, { abort: new AbortController(), steer })
  await vi.waitFor(() => expect(steer).toHaveBeenCalledExactlyOnceWith('Use primary sources.'))
  expect(JSON.parse(fixture.values.values().next().value!)).toEqual([
    { eventId: '$steer:test', taskId: TASK, kind: 'steer', expiresAt }
  ])

  controls.offer(event('$steer:test', 'steer'), expiresAt)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(steer).toHaveBeenCalledTimes(1)
  active.finish()
})

it('leaves a refused steer unreceipted so a later Matrix scan can retry it', async () => {
  const fixture = store()
  const controls = new MatrixAgentTaskControls(fixture.store)
  const steer = vi.fn(async () => false)
  controls.offer(event('$steer:test', 'steer'), expires())
  const active = controls.begin(TASK, { abort: new AbortController(), steer })

  await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
  expect(fixture.values.size).toBe(0)
  active.finish()
})

it('retries early direction once the task session becomes steerable', async () => {
  const fixture = store()
  const controls = new MatrixAgentTaskControls(fixture.store)
  const steer = vi.fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)
  const expiresAt = expires()
  controls.offer(event('$steer:test', 'steer'), expiresAt)
  const active = controls.begin(TASK, { abort: new AbortController(), steer })

  await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
  controls.retry(TASK)
  await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2))
  expect(JSON.parse(fixture.values.values().next().value!)).toEqual([
    { eventId: '$steer:test', taskId: TASK, kind: 'steer', expiresAt }
  ])
  active.finish()
})

it('drops expired receipts instead of granting an old stop after restart', () => {
  const fixture = store()
  fixture.values.set('matrix-agent-task-controls-v1', JSON.stringify([{
    eventId: '$stop:test', taskId: TASK, kind: 'stop', expiresAt: Date.now() - 1
  }]))

  const abort = new AbortController()
  const controls = new MatrixAgentTaskControls(fixture.store)
  const active = controls.begin(TASK, { abort, steer: vi.fn() })

  expect(active.stopped()).toBe(false)
  expect(abort.signal.aborted).toBe(false)
  expect(JSON.parse(fixture.values.get('matrix-agent-task-controls-v1')!)).toEqual([])
  active.finish()
})

it('never evicts an unexpired stop while bounding recovered steer receipts', async () => {
  const fixture = store()
  const controls = new MatrixAgentTaskControls(fixture.store)
  const expiresAt = expires()
  controls.offer(event('$stop:test', 'stop'), expiresAt)

  const steer = vi.fn(async () => true)
  const active = controls.begin('00000000-0000-4000-8000-b454f82c5857', {
    abort: new AbortController(),
    steer
  })
  for (let index = 0; index < 520; index++) {
    controls.offer({ ...event(`$steer-${index}:test`, 'steer'), taskId: '00000000-0000-4000-8000-b454f82c5857' }, expiresAt)
  }
  await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(520))
  active.finish()

  const restarted = new MatrixAgentTaskControls(fixture.store)
  const abort = new AbortController()
  const stopped = restarted.begin(TASK, { abort, steer: vi.fn() })
  expect(stopped.stopped()).toBe(true)
  expect(abort.signal.aborted).toBe(true)
  expect(JSON.parse(fixture.values.get('matrix-agent-task-controls-v1')!)).toHaveLength(513)
  stopped.finish()
})
