import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixCloudAccess, MatrixUiBridge } from '../../shared/matrix'

import { $matrixCloudAccess, MATRIX_CLOUD_ACCESS_REFRESH_MS, useMatrixCloudAccess } from './cloud-access'

type Read = (request: { action: 'cloudAccess' }) => Promise<MatrixCloudAccess>

function bridge(read: Read) {
  Object.assign(window, { atumMatrix: { cloudAgent: read } as unknown as MatrixUiBridge })

  return read
}

const flush = () => act(async () => void (await Promise.resolve()))

const focus = () => act(async () => void window.dispatchEvent(new Event('focus')))

beforeEach(() => {
  $matrixCloudAccess.set(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'atumMatrix')
  $matrixCloudAccess.set(undefined)
})

describe('the cloud access read', () => {
  it('polls every ten minutes and on focus, and clears both when the last consumer unmounts', async () => {
    vi.useFakeTimers()
    const read = bridge(vi.fn(async () => ({ effective: 'paid' })) as unknown as Read)
    const { result, unmount } = renderHook(() => useMatrixCloudAccess(true))

    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual({ effective: 'paid' })

    await act(async () => void (await vi.advanceTimersByTimeAsync(MATRIX_CLOUD_ACCESS_REFRESH_MS)))
    expect(read).toHaveBeenCalledTimes(2)

    await focus()
    expect(read).toHaveBeenCalledTimes(3)

    unmount()
    expect($matrixCloudAccess.get()).toBeUndefined()

    await act(async () => void (await vi.advanceTimersByTimeAsync(MATRIX_CLOUD_ACCESS_REFRESH_MS)))
    await focus()
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('ignores a stale in-flight read after unmount and remount', async () => {
    let answerFirst!: (access: MatrixCloudAccess) => void
    const first = new Promise<MatrixCloudAccess>(resolve => (answerFirst = resolve))

    const read = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => ({ effective: 'paid' }))

    bridge(read as unknown as Read)

    const before = renderHook(() => useMatrixCloudAccess(true))
    expect(read).toHaveBeenCalledTimes(1)
    before.unmount()

    const after = renderHook(() => useMatrixCloudAccess(true))
    expect(read).toHaveBeenCalledTimes(2)
    await flush()
    expect(after.result.current).toEqual({ effective: 'paid' })

    await act(async () => {
      answerFirst({ effective: 'none', reason: 'trial_expired' })
      await Promise.resolve()
    })

    expect(after.result.current).toEqual({ effective: 'paid' })
  })

  it('keeps the last confirmed fact when a read fails', async () => {
    const read = vi
      .fn()
      .mockImplementationOnce(async () => ({ effective: 'trial' }))
      .mockImplementationOnce(async () => Promise.reject(new Error('offline')))

    bridge(read as unknown as Read)

    const { result } = renderHook(() => useMatrixCloudAccess(true))
    await flush()
    expect(result.current).toEqual({ effective: 'trial' })

    await focus()
    expect(read).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual({ effective: 'trial' })
  })

  it('never reads while disabled and shows nothing for a Mac-run assistant', () => {
    const read = bridge(vi.fn(async () => ({ effective: 'none' })) as unknown as Read)
    const { result } = renderHook(() => useMatrixCloudAccess(false))

    expect(read).not.toHaveBeenCalled()
    expect(result.current).toBeUndefined()
  })
})
