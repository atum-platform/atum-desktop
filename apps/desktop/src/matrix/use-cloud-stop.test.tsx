import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixStopResult } from './cloud-stop'
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

function mount(stopKey: string | undefined = '$owner') {
  const initialProps: { roomId: string; stopKey: string | undefined } = { roomId: '!room:test', stopKey }

  return renderHook(props => useMatrixCloudStop(props), { initialProps })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('what the Stop control says after an owner Stop', () => {
  it('says Stopping while the request is out', () => {
    const view = mount()
    act(() => view.result.current.stop(() => deferred().promise))
    expect(view.result.current).toMatchObject({ stopping: true, refused: false, requested: true })
  })

  it('settles as today once the agent confirms the turn stopped', async () => {
    const view = mount()
    const request = deferred()
    act(() => view.result.current.stop(() => request.promise))
    await act(async () => request.settle('stopped'))
    expect(view.result.current).toMatchObject({ stopping: false, refused: false, requested: true })
  })

  it('keeps saying Stopping, never stopped, until the final arrives', async () => {
    const view = mount()
    const request = deferred()
    act(() => view.result.current.stop(() => request.promise))
    await act(async () => request.settle('stopping'))
    expect(view.result.current).toMatchObject({ stopping: true, refused: false })

    // The turn's final clears the target this Stop named.
    view.rerender({ roomId: '!room:test', stopKey: undefined })
    expect(view.result.current.stopping).toBe(false)
    expect(view.result.current.refused).toBe(false)
  })

  it('settles quietly when no final arrives in a short while', async () => {
    vi.useFakeTimers()
    const view = mount()
    const request = deferred()
    act(() => view.result.current.stop(() => request.promise))
    await act(async () => request.settle('stopping'))
    act(() => vi.advanceTimersByTime(MATRIX_STOP_SETTLE_MS - 1))
    expect(view.result.current.stopping).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(view.result.current).toMatchObject({ stopping: false, refused: false, requested: true })
  })

  it('shows the failure copy when Stop fails or gets no answer, and allows another try', async () => {
    const view = mount()
    const request = deferred()
    act(() => view.result.current.stop(() => request.promise))
    await act(async () => request.fail(new Error('matrix_host_stop_unconfirmed')))
    expect(view.result.current).toMatchObject({ stopping: false, refused: true, requested: false })
  })

  it('asks once per turn', () => {
    const view = mount()
    const run = vi.fn(() => deferred().promise)
    act(() => view.result.current.stop(run))
    act(() => view.result.current.stop(run))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('lets an in-room /stop be sent again', async () => {
    const view = mount('native:!room:test')
    const request = deferred()
    act(() => view.result.current.stop(() => request.promise))
    await act(async () => request.settle('sent'))
    expect(view.result.current).toMatchObject({ stopping: false, refused: false, requested: false })
  })

  it('forgets a Stopping state when the chat changes', async () => {
    const view = mount()
    const request = deferred()
    act(() => view.result.current.stop(() => request.promise))
    await act(async () => request.settle('stopping'))
    view.rerender({ roomId: '!other:test', stopKey: '$owner' })
    expect(view.result.current.stopping).toBe(false)
  })
})
