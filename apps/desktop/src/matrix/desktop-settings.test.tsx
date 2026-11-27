import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixDesktopServicesBridge, MatrixDesktopServicesStatus } from '../../shared/matrix-desktop-services'

import { $matrixDesktopServices } from './desktop-services'
import {
  $matrixFeedbackOpen,
  MatrixDesktopSettings,
  MatrixFeedbackDialog,
  MatrixUpdateFooter
} from './desktop-settings'

const idle: MatrixDesktopServicesStatus = {
  reporting: { configured: true, diagnosticId: 'matrix-diagnostic-id', enabled: true },
  update: {
    channel: 'latest',
    progress: null,
    notes: [],
    error: null,
    requiredBelow: null,
    armed: true,
    checkedAt: null,
    packaged: true,
    state: 'idle',
    version: null
  },
  version: '1.0.0',
  busy: false
}

// The rail's Update asks in a popover, which measures itself.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  $matrixDesktopServices.set(null)
  $matrixFeedbackOpen.set(false)
  Reflect.deleteProperty(window, 'atumDesktopServices')
  Reflect.deleteProperty(window, 'atumMatrix')
})

function fixture(status: MatrixDesktopServicesStatus = idle) {
  const bridge = {
    setEnabled: vi.fn(async (enabled: boolean) => ({ ...status, reporting: { ...status.reporting, enabled } })),
    feedback: vi.fn(async () => ({ sent: true })),
    checkUpdates: vi.fn(async () => true),
    restart: vi.fn(async () => true)
  }

  const onOpenFeedback = vi.fn(() => $matrixFeedbackOpen.set(true))
  const openLink = vi.fn(async () => undefined)

  window.atumDesktopServices = bridge as unknown as MatrixDesktopServicesBridge
  Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { openLink } })
  $matrixDesktopServices.set(status)

  return {
    bridge,
    openLink,
    onOpenFeedback,
    ...render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixDesktopSettings onOpenFeedback={onOpenFeedback} />
        <MatrixUpdateFooter />
        <MatrixFeedbackDialog />
      </I18nProvider>
    )
  }
}

it('persists the sharing choice in a few words, and explains it in one sentence inside its row', async () => {
  const { bridge } = fixture()

  const row = screen.getByRole('switch', { name: 'Share usage data' }).closest('.atum-settings-row') as HTMLElement
  expect(within(row).getByText(/never your messages, files or passwords/)).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: 'Share usage data' }))
  await waitFor(() => expect(bridge.setEnabled).toHaveBeenCalledWith(false))
})

it('names the version beside the honest never-checked update status', () => {
  fixture()
  expect(screen.getByText('Atum 1.0.0 · Not checked yet')).toBeTruthy()
})

it('sends feedback from its own sheet, with the diagnostic ID one copy away, and forgets a closed draft', async () => {
  const { bridge, onOpenFeedback } = fixture()
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

  fireEvent.click(screen.getByRole('button', { name: 'Send feedback…' }))
  expect(onOpenFeedback).toHaveBeenCalledOnce()
  const sheet = await screen.findByRole('dialog', { name: 'Send feedback' })
  // Never printed: support asks for it, and it is one quiet copy away.
  expect(within(sheet).queryByText(/matrix-diagnostic-id/)).toBeNull()
  fireEvent.click(within(sheet).getByRole('button', { name: 'Copy diagnostic ID' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('matrix-diagnostic-id'))
  expect(await within(sheet).findByRole('button', { name: 'Copied' })).toBeTruthy()

  fireEvent.change(within(sheet).getByRole('textbox', { name: 'Send feedback' }), { target: { value: 'draft' } })
  fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  act(() => $matrixFeedbackOpen.set(true))
  const again = await screen.findByRole('dialog', { name: 'Send feedback' })
  expect((within(again).getByRole('textbox', { name: 'Send feedback' }) as HTMLTextAreaElement).value).toBe('')

  fireEvent.change(within(again).getByRole('textbox', { name: 'Send feedback' }), {
    target: { value: 'Please improve this.' }
  })
  fireEvent.click(within(again).getByRole('button', { name: 'Send feedback' }))
  await waitFor(() => expect(bridge.feedback).toHaveBeenCalledWith('Please improve this.'))
  expect(await within(again).findByText('Thanks for your feedback.')).toBeTruthy()
})

it('forgets a reply that arrives after the sheet closed, so reopening starts fresh', async () => {
  const { bridge } = fixture()

  let resolve: (value: { sent: boolean }) => void = () => {}
  bridge.feedback.mockImplementationOnce(() => new Promise(done => (resolve = done)))

  act(() => $matrixFeedbackOpen.set(true))
  const sheet = await screen.findByRole('dialog', { name: 'Send feedback' })
  fireEvent.change(within(sheet).getByRole('textbox', { name: 'Send feedback' }), { target: { value: 'In flight.' } })
  fireEvent.click(within(sheet).getByRole('button', { name: 'Send feedback' }))
  fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  await act(async () => resolve({ sent: true }))
  act(() => $matrixFeedbackOpen.set(true))
  const again = await screen.findByRole('dialog', { name: 'Send feedback' })
  expect(within(again).queryByText('Thanks for your feedback.')).toBeNull()
  expect((within(again).getByRole('textbox', { name: 'Send feedback' }) as HTMLTextAreaElement).value).toBe('')
})

it('offers a manual update check, and restart only after a download', async () => {
  const { bridge } = fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  await waitFor(() => expect(bridge.checkUpdates).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Update ready — restart to install' })).toBeNull()

  act(() => $matrixDesktopServices.set({ ...idle, update: { ...idle.update, state: 'downloaded', version: '1.0.1' } }))
  // Settings restarts in one click; the rail's update mark asks first.
  fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }))
  await waitFor(() => expect(bridge.restart).toHaveBeenCalledOnce())

})

it('shows an updater error in Settings and offers recovery', async () => {
  const failure = {
    ...idle,
    update: {
      ...idle.update,
      state: 'error' as const,
      error: {
        code: 'transport' as const,
        message: 'Could not reach the update server.',
        stage: 'download' as const
      }
    }
  }

  const { bridge } = fixture(failure)

  expect(screen.getByRole('status').textContent).toContain('Could not reach the update server.')
  fireEvent.click(screen.getAllByRole('button', { name: 'Try again' }).at(-1)!)
  await waitFor(() => expect(bridge.checkUpdates).toHaveBeenCalledOnce())
})



it('does not offer undeliverable feedback in an unconfigured build', () => {
  fixture({ ...idle, reporting: { ...idle.reporting, configured: false } })
  expect(screen.queryByRole('button', { name: 'Send feedback…' })).toBeNull()
  expect(screen.getByRole('switch', { name: 'Share usage data' })).toBeTruthy()
})
