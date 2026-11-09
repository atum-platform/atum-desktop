import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { diagnosticFrames } from '../../shared/diagnostic-frames'
import type { MatrixDesktopServicesBridge, MatrixDesktopServicesStatus } from '../../shared/matrix-desktop-services'

import { $matrixDesktopServices, MatrixDesktopServicesBootstrap, reportMatrixRendererError } from './desktop-services'

const status: MatrixDesktopServicesStatus = {
  reporting: { configured: true, diagnosticId: 'diagnostic-id', enabled: true },
  update: { channel: 'latest', progress: null, notes: [], error: null, requiredBelow: null, armed: true, checkedAt: null, packaged: true, state: 'idle', version: null },
  version: '1.0.0',
  busy: false
}

afterEach(() => {
  cleanup()
  $matrixDesktopServices.set(null)
  Reflect.deleteProperty(window, 'atumDesktopServices')
  Reflect.deleteProperty(window, 'atumDiagnostics')
})

it('keeps one optional bridge subscription synchronized with the main-owned status', async () => {
  let changed!: (value: MatrixDesktopServicesStatus) => void
  const unsubscribe = vi.fn()
  window.atumDesktopServices = {
    status: vi.fn(async () => status),
    onChanged: vi.fn(listener => {
      changed = listener

      return unsubscribe
    })
  } as unknown as MatrixDesktopServicesBridge

  const view = render(<MatrixDesktopServicesBootstrap />)

  await waitFor(() => expect($matrixDesktopServices.get()).toEqual(status))
  changed({ ...status, busy: true })
  expect($matrixDesktopServices.get()?.busy).toBe(true)
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('reports only a bounded renderer error classification to the diagnostics bridge', () => {
  const error = vi.fn()
  window.atumDiagnostics = { error }

  reportMatrixRendererError(Object.assign(new Error('private message content'), { name: 'TypeError' }))
  reportMatrixRendererError({ name: 'untrusted value' })

  expect(error).toHaveBeenNthCalledWith(1, { operation: 'renderer', kind: 'TypeError' })
  expect(error).toHaveBeenNthCalledWith(2, { operation: 'renderer', kind: 'Error' })
})

it('keeps shipped source coordinates while stripping arbitrary renderer stack content', () => {
  const error = vi.fn()
  window.atumDiagnostics = { error }
  const failure = new TypeError('private message')
  failure.stack = 'TypeError: private message\n at privateFunction (atum-matrix://ui/assets/matrix-123.js:20:3)\n at /home/example/secret.js:5:1'
  reportMatrixRendererError(failure)
  expect(error).toHaveBeenCalledWith({ operation: 'renderer', kind: 'TypeError', stack: 'at app:///assets/matrix-123.js:20:3' })
})

it('preserves oldest-to-newest Sentry frame order through renderer and main sanitization', () => {
  const error = vi.fn()
  window.atumDiagnostics = { error }
  const failure = new TypeError('private message')
  failure.stack = 'TypeError: private message\n at newest (atum-matrix://ui/assets/matrix-123.js:30:3)\n at /home/example/secret.js:5:1\n at middle (atum-matrix://ui/assets/matrix-123.js:20:2)\n at oldest (atum-matrix://ui/assets/matrix-123.js:10:1)'
  reportMatrixRendererError(failure)
  expect(diagnosticFrames(error.mock.calls[0][0].stack).map(frame => frame.lineno)).toEqual([10, 20, 30])
})

it('does not overwrite a newer preference notification with an older status response', async () => {
  let resolveStatus!: (value: MatrixDesktopServicesStatus) => void
  let changed!: (value: MatrixDesktopServicesStatus) => void
  window.atumDesktopServices = {
    status: () => new Promise(resolve => { resolveStatus = resolve }),
    onChanged: (listener: (value: MatrixDesktopServicesStatus) => void) => {
      changed = listener

      return () => {}
    }
  } as unknown as MatrixDesktopServicesBridge
  render(<MatrixDesktopServicesBootstrap />)
  changed({ ...status, reporting: { ...status.reporting, enabled: false } })
  resolveStatus(status)
  await waitFor(() => expect($matrixDesktopServices.get()?.reporting.enabled).toBe(false))
})
