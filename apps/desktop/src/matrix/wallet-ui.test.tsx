import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixWalletBridge, MatrixWalletHistory } from '../../shared/matrix-wallet'

import { microProtons, useMatrixWalletHistory, wholeProtons } from './wallet-ui'

const snapshot = (userId = '@owner:test', petScope = 'scope-a'): MatrixSnapshot => ({
  state: 'ready',
  identity: { userId, deviceId: 'DEVICE' },
  petScope,
  rooms: [],
  roomId: null,
  messages: [],
  error: null
})

const page = (id: string, next: string | null): MatrixWalletHistory => ({
  entries: [
    {
      id,
      at: '2026-10-02T00:00:00Z',
      kind: 'future_kind',
      status: 'future_status',
      amount: 1_000_000,
      reference: null,
      closedAt: null
    }
  ],
  next
})

describe('wallet display values', () => {
  it('rounds only spendable micro-Protons down and preserves fractions elsewhere', () => {
    expect(wholeProtons(1_999_999)).toBe(1)
    expect(wholeProtons(2_000_000)).toBe(2)
    expect(microProtons(250_000, 'en')).toBe('0.25')
    expect(microProtons(1, 'en')).toBe('0.000001')
  })
})

describe('wallet history', () => {
  it('loads only while open, paginates once per cursor, and fails closed on a repeated cursor', async () => {
    const history = vi.fn<MatrixWalletBridge['history']>()
    history.mockResolvedValueOnce(page('newest', 'before-1')).mockResolvedValueOnce(page('older', 'before-1'))
    const bridge: MatrixWalletBridge = { history, refresh: vi.fn(async () => {}) }

    const hook = renderHook(({ open }) => useMatrixWalletHistory(snapshot(), open, bridge), {
      initialProps: { open: false }
    })

    expect(history).not.toHaveBeenCalled()
    hook.rerender({ open: true })
    await waitFor(() => expect(hook.result.current.entries.map(entry => entry.id)).toEqual(['newest']))
    expect(history).toHaveBeenCalledWith(undefined)

    act(() => hook.result.current.loadMore())
    await waitFor(() => expect(hook.result.current.error).toBe(true))
    expect(hook.result.current.entries.map(entry => entry.id)).toEqual(['newest'])
    act(() => hook.result.current.loadMore())
    expect(history).toHaveBeenCalledTimes(2)
  })

  it('masks cached history synchronously when the pane closes or its scope changes', async () => {
    let resolveOld: ((value: MatrixWalletHistory) => void) | undefined
    let resolveNew: ((value: MatrixWalletHistory) => void) | undefined

    const history = vi
      .fn<MatrixWalletBridge['history']>()
      .mockImplementationOnce(
        () =>
          new Promise<MatrixWalletHistory>(done => {
            resolveOld = done
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<MatrixWalletHistory>(done => {
            resolveNew = done
          })
      )

    const bridge: MatrixWalletBridge = { history, refresh: vi.fn(async () => {}) }

    const hook = renderHook(({ current, open }) => useMatrixWalletHistory(current, open, bridge), {
      initialProps: { current: snapshot(), open: true }
    })

    await waitFor(() => expect(history).toHaveBeenCalledOnce())
    hook.rerender({ current: snapshot('@other:test', 'scope-b'), open: true })
    expect(hook.result.current.entries).toEqual([])

    await waitFor(() => expect(history).toHaveBeenCalledTimes(2))
    hook.rerender({ current: snapshot('@other:test', 'scope-b'), open: false })
    expect(hook.result.current.entries).toEqual([])
    expect(hook.result.current.loading).toBe(false)

    act(() => {
      resolveOld?.(page('old-account', null))
      resolveNew?.(page('new-account', null))
    })
    await waitFor(() => expect(hook.result.current.entries).toEqual([]))
  })
})
