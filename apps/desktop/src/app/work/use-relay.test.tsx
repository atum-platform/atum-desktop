import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { MatrixWorkBridge } from '../../../shared/matrix-work'
import type { WorkRelayRoomView } from '../../../shared/matrix-work-relay'

import { $workRelayReads, $workRelayRooms, resetWorkStoreForTests } from './store'
import { useWorkRelayRoom, WORK_RELAY_READ_TIMEOUT_MS } from './use-relay'

const room: WorkRelayRoomView = { account: { consent: { provider: 'codex', state: 'on', agents: ['agent'], devices: ['mac'], alsoWhenScheduled: true, revision: 1 }, facts: [] }, status: null, turns: [] }

beforeEach(() => { vi.useFakeTimers(); resetWorkStoreForTests() })
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, 'atumMatrix') })

function mount(readRelay: MatrixWorkBridge['readRelay']) {
  window.atumMatrix = { work: { readRelay } } as typeof window.atumMatrix
  return renderHook(() => useWorkRelayRoom('agent', '!room:test', 'account', vi.fn()))
}

it('settles loading to ready with the native account catalog', async () => {
  let resolve!: (value: WorkRelayRoomView) => void
  const view = mount(() => new Promise(done => { resolve = done }))
  expect($workRelayReads.get()['!room:test']).toBe('loading')
  await act(async () => resolve(room))
  expect($workRelayReads.get()['!room:test']).toBe('ready')
  expect(view.result.current).toEqual(room)
})

it('settles an empty catalog response to unavailable', async () => {
  mount(async () => null as unknown as WorkRelayRoomView)
  await act(async () => {})
  expect($workRelayReads.get()['!room:test']).toBe('unavailable')
})

it('settles an error and recovers on the next poll without flashing loading', async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(room)
  mount(read)
  await act(async () => {})
  expect($workRelayReads.get()['!room:test']).toBe('failed')
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect($workRelayReads.get()['!room:test']).toBe('ready')
})

it('bounds a hung read and ignores its late result', async () => {
  let resolve!: (value: WorkRelayRoomView) => void
  mount(() => new Promise(done => { resolve = done }))
  await act(async () => vi.advanceTimersByTimeAsync(WORK_RELAY_READ_TIMEOUT_MS))
  expect($workRelayReads.get()['!room:test']).toBe('failed')
  await act(async () => resolve(room))
  expect($workRelayRooms.get()['!room:test']).toBeUndefined()
})

it('does not publish a read after leaving the conversation', async () => {
  let resolve!: (value: WorkRelayRoomView) => void
  const view = mount(() => new Promise(done => { resolve = done }))
  view.unmount()
  await act(async () => resolve(room))
  expect($workRelayRooms.get()['!room:test']).toBeUndefined()
})
