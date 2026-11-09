import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import type { MatrixDriveBridge, MatrixDriveView } from '../../shared/matrix-drive'

import { matrixDriveAvailable, useMatrixDriveAvailable } from './drive-availability'

const view = (state: MatrixDriveView['state'], revision: number): MatrixDriveView => ({
  state,
  revision,
  rows: [],
  canGoBack: false,
  truncated: false
})

function fakeDrive(first: MatrixDriveView) {
  const listeners = new Set<(next: MatrixDriveView) => void>()
  let resolveRead!: (value: MatrixDriveView) => void

  const bridge = {
    read: vi.fn(() => new Promise<MatrixDriveView>(resolve => (resolveRead = resolve))),
    subscribe: vi.fn((listener: (next: MatrixDriveView) => void) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    })
  } as unknown as MatrixDriveBridge

  return {
    bridge,
    answerRead: (value = first) => act(() => resolveRead(value)),
    push: (next: MatrixDriveView) => act(() => listeners.forEach(listener => listener(next))),
    listeners
  }
}

it('treats only a build without Drive as having no Drive; every other state has a page', () => {
  expect(matrixDriveAvailable(view('unavailable', 0))).toBe(false)
  expect(matrixDriveAvailable(undefined)).toBe(false)

  for (const state of ['disconnected', 'authorizing', 'connecting', 'syncing', 'ready', 'offline', 'paused', 'reauthenticate', 'error', 'cleanup_failed'] as const) {
    expect(matrixDriveAvailable(view(state, 1))).toBe(true)
  }
})

it('offers nothing without a Drive bridge', () => {
  const { result } = renderHook(() => useMatrixDriveAvailable(undefined))
  expect(result.current).toBe(false)
})

it('waits for the native answer, then follows Drive appearing and going away', async () => {
  const drive = fakeDrive(view('unavailable', 1))
  const { result } = renderHook(() => useMatrixDriveAvailable(drive.bridge))
  expect(result.current).toBe(false)
  await drive.answerRead()
  expect(result.current).toBe(false)
  drive.push(view('disconnected', 2))
  expect(result.current).toBe(true)
  drive.push(view('unavailable', 3))
  expect(result.current).toBe(false)
})

it('never lets a late, older read undo a newer state', async () => {
  const drive = fakeDrive(view('unavailable', 1))
  const { result } = renderHook(() => useMatrixDriveAvailable(drive.bridge))
  drive.push(view('ready', 5))
  expect(result.current).toBe(true)
  await drive.answerRead(view('unavailable', 1))
  expect(result.current).toBe(true)
})

it('stops listening when unmounted', async () => {
  const drive = fakeDrive(view('ready', 1))
  const { unmount } = renderHook(() => useMatrixDriveAvailable(drive.bridge))
  await waitFor(() => expect(drive.listeners.size).toBe(1))
  unmount()
  expect(drive.listeners.size).toBe(0)
})
