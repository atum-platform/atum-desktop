import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { MatrixUiBridge } from '../../shared/matrix'

import { ATTEND_RETRY_MS, useMatrixReadAttention } from './read-attention'

let focused = true
let visibility: DocumentVisibilityState = 'visible'
let attend: ReturnType<typeof vi.fn<NonNullable<MatrixUiBridge['attend']>>>

beforeEach(() => {
  focused = true
  visibility = 'visible'
  vi.spyOn(window.document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(window.document, 'visibilityState', 'get').mockImplementation(() => visibility)
  attend = vi.fn<NonNullable<MatrixUiBridge['attend']>>(async () => null)
  window.atumMatrix = { attend } as unknown as MatrixUiBridge
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const flush = () => act(async () => {})

function hook(initial: { roomId: string | null; onScreen: boolean; connected: boolean }) {
  return renderHook(props => useMatrixReadAttention(props), { initialProps: initial })
}

it('tells the SDK the conversation on screen in a focused window, once per change', async () => {
  const view = hook({ roomId: '!room:test', onScreen: true, connected: true })
  await flush()
  expect(attend).toHaveBeenCalledExactlyOnceWith('!room:test')
  expect(view.result.current).toBe('!room:test')

  view.rerender({ roomId: '!room:test', onScreen: true, connected: true })
  await flush()
  expect(attend).toHaveBeenCalledOnce()

  view.rerender({ roomId: '!next:test', onScreen: true, connected: true })
  await flush()
  expect(attend).toHaveBeenLastCalledWith('!next:test')
})

it('stops attending when the window loses focus or hides, or something covers the transcript', async () => {
  const view = hook({ roomId: '!room:test', onScreen: true, connected: true })
  await flush()

  focused = false
  act(() => void window.dispatchEvent(new Event('blur')))
  await flush()
  expect(attend).toHaveBeenLastCalledWith(null)

  focused = true
  act(() => void window.dispatchEvent(new Event('focus')))
  await flush()
  expect(attend).toHaveBeenLastCalledWith('!room:test')

  visibility = 'hidden'
  act(() => void window.document.dispatchEvent(new Event('visibilitychange')))
  await flush()
  expect(attend).toHaveBeenLastCalledWith(null)

  visibility = 'visible'
  act(() => void window.document.dispatchEvent(new Event('visibilitychange')))
  await flush()
  expect(attend).toHaveBeenLastCalledWith('!room:test')

  view.rerender({ roomId: '!room:test', onScreen: false, connected: true })
  await flush()
  expect(attend).toHaveBeenLastCalledWith(null)
  expect(view.result.current).toBeNull()
  expect(attend.mock.calls.map(([roomId]) => roomId)).toEqual([
    '!room:test',
    null,
    '!room:test',
    null,
    '!room:test',
    null
  ])
})

it('says nothing while disconnected and repeats the answer to a new connection', async () => {
  const view = hook({ roomId: '!room:test', onScreen: true, connected: false })
  await flush()
  expect(attend).not.toHaveBeenCalled()

  view.rerender({ roomId: '!room:test', onScreen: true, connected: true })
  await flush()
  expect(attend).toHaveBeenCalledExactlyOnceWith('!room:test')

  view.rerender({ roomId: '!room:test', onScreen: true, connected: false })
  view.rerender({ roomId: '!room:test', onScreen: true, connected: true })
  await flush()
  expect(attend).toHaveBeenCalledTimes(2)
  expect(attend).toHaveBeenLastCalledWith('!room:test')
})

it('repeats a refused answer a few times, then waits for the next change', async () => {
  vi.useFakeTimers()
  attend.mockRejectedValue(new Error('matrix_sdk_unavailable'))
  const view = hook({ roomId: '!room:test', onScreen: true, connected: true })
  await act(async () => {})
  expect(attend).toHaveBeenCalledTimes(1)

  for (const [index, delay] of ATTEND_RETRY_MS.entries()) {
    await act(() => vi.advanceTimersByTimeAsync(delay))
    expect(attend).toHaveBeenCalledTimes(index + 2)
  }

  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
  expect(attend).toHaveBeenCalledTimes(ATTEND_RETRY_MS.length + 1)

  // A change is said at once, and an accepted answer ends the retries.
  attend.mockResolvedValue(null)
  view.rerender({ roomId: '!room:test', onScreen: false, connected: true })
  await act(async () => {})
  expect(attend).toHaveBeenLastCalledWith(null)
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
  expect(attend).toHaveBeenCalledTimes(ATTEND_RETRY_MS.length + 2)
})
