import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import type * as CloudStop from './cloud-stop'
import type { MatrixStopResult } from './cloud-stop'

const state = vi.hoisted(() => ({
  target: undefined as string | undefined,
  scheduled: false,
  unanswered: { id: '$owner' } as { id: string } | null,
  run: undefined as undefined | (() => Promise<unknown>)
}))

vi.mock('./cloud-status', () => ({ cloudRoomAgent: () => ({}) }))
vi.mock('./no-reply-banner', () => ({ matrixUnansweredOwnerMessage: () => state.unanswered }))
vi.mock('./text-document-actions', () => ({ runMatrixCommand: vi.fn() }))
vi.mock('./cloud-stop', async importOriginal => ({
  ...(await importOriginal<typeof CloudStop>()),
  matrixCloudStopTarget: () => state.target,
  matrixCloudStopScheduled: () => state.scheduled,
  executeMatrixStop: () => state.run?.()
}))

import { MATRIX_STOP_SETTLE_MS, useMatrixCloudStop } from './use-cloud-stop'

function deferred() {
  let settle!: (result: MatrixStopResult) => void
  let fail!: (error: Error) => void

  const promise = new Promise<MatrixStopResult>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  return { promise, settle, fail }
}

const room = { id: '!room:test', membership: 'join', agentPrincipal: 'agent' } as unknown as MatrixRoom
const other = { ...room, id: '!other:test' } as MatrixRoom

const snapshot = {
  agents: [{ principal: 'agent', userId: '@agent:test', runtime: 'hermes' }],
  localTurns: [],
  messages: []
} as unknown as MatrixSnapshot

function mount(target: string | undefined = '$owner') {
  state.target = target

  return renderHook(props => useMatrixCloudStop(props), {
    initialProps: { messages: [], room, snapshot, working: true } as Parameters<typeof useMatrixCloudStop>[0]
  })
}

function press(view: ReturnType<typeof mount>, request: ReturnType<typeof deferred>) {
  state.run = () => request.promise
  act(() => view.result.current.stop())
}

beforeEach(() => {
  state.target = undefined
  state.scheduled = false
  state.unanswered = { id: '$owner' }
  state.run = undefined
  ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { cloudAgent: vi.fn() }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('what the Stop control says after an owner Stop', () => {
  it('says Stopping while the request is out', () => {
    const view = mount()
    press(view, deferred())
    expect(view.result.current).toMatchObject({ stopping: true, refused: false, requested: true })
  })

  it('settles as today once the agent confirms the turn stopped', async () => {
    const view = mount()
    const request = deferred()
    press(view, request)
    await act(async () => request.settle('stopped'))
    expect(view.result.current).toMatchObject({ stopping: false, refused: false, requested: true })
  })

  it('keeps saying Stopping, never stopped, until the final arrives', async () => {
    const view = mount()
    const request = deferred()
    press(view, request)
    await act(async () => request.settle('stopping'))
    expect(view.result.current).toMatchObject({ stopping: true, refused: false })

    // The turn's final clears the target this Stop named.
    state.target = undefined
    state.unanswered = null
    view.rerender({ messages: [], room, snapshot, working: false })
    expect(view.result.current.stopping).toBe(false)
    expect(view.result.current.refused).toBe(false)
  })

  it('settles quietly when no final arrives in a short while', async () => {
    vi.useFakeTimers()
    const view = mount()
    const request = deferred()
    press(view, request)
    await act(async () => request.settle('stopping'))
    act(() => vi.advanceTimersByTime(MATRIX_STOP_SETTLE_MS - 1))
    expect(view.result.current.stopping).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(view.result.current).toMatchObject({ stopping: false, refused: false, requested: true })
  })

  it('shows the failure copy when Stop fails or gets no answer, and allows another try', async () => {
    const view = mount()
    const request = deferred()
    press(view, request)
    await act(async () => request.fail(new Error('matrix_host_stop_unconfirmed')))
    expect(view.result.current).toMatchObject({ stopping: false, refused: true, requested: false })
  })

  it('asks once per turn', () => {
    const view = mount()
    const run = vi.fn(() => deferred().promise)
    state.run = run
    act(() => view.result.current.stop())
    act(() => view.result.current.stop())
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('lets an in-room /stop be sent again', async () => {
    state.scheduled = true
    const view = mount(undefined)
    expect(view.result.current.route.kind).toBe('native')
    const request = deferred()
    press(view, request)
    await act(async () => request.settle('sent'))
    expect(view.result.current).toMatchObject({ stopping: false, refused: false, requested: false })
  })

  it('forgets a Stopping state when the chat changes', async () => {
    const view = mount()
    const request = deferred()
    press(view, request)
    await act(async () => request.settle('stopping'))
    view.rerender({ messages: [], room: other, snapshot, working: true })
    expect(view.result.current.stopping).toBe(false)
  })
})
