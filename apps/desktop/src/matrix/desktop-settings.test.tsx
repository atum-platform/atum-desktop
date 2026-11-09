import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixDesktopServicesBridge, MatrixDesktopServicesStatus } from '../../shared/matrix-desktop-services'

import { ATUM_LINKS } from './atum-links'
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
        <MatrixUpdateFooter onOpenUpdates={() => {}} />
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
  const rail = screen.getByRole('button', { name: 'Update ready — restart to install' })
  fireEvent.click(rail)
  expect(await screen.findByText('Atum 1.0.1 is ready. Restart now?')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
  await waitFor(() => expect(bridge.restart).toHaveBeenCalledTimes(2))
})

it('shows honest updater errors in Settings and keeps rail recovery in the existing surface', async () => {
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

  const { bridge, openLink } = fixture(failure)

  expect(screen.getByRole('status').textContent).toContain('Could not reach the update server.')
  fireEvent.click(screen.getByRole('button', { name: 'Update needs attention' }))
  await screen.findAllByText('Could not reach the update server.')
  fireEvent.click(screen.getAllByRole('button', { name: 'Download Atum' }).at(-1)!)
  fireEvent.click(screen.getAllByRole('button', { name: 'Try again' }).at(-1)!)
  await waitFor(() => expect(openLink).toHaveBeenCalledOnce())
  expect(openLink).toHaveBeenLastCalledWith(ATUM_LINKS.download)
  await waitFor(() => expect(bridge.checkUpdates).toHaveBeenCalledOnce())
})

it('lets the rail’s update wait: Later closes it without restarting', async () => {
  const { bridge } = fixture({ ...idle, update: { ...idle.update, state: 'downloaded', version: '1.0.1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Later' }))
  await waitFor(() => expect(screen.queryByText('Atum 1.0.1 is ready. Restart now?')).toBeNull())
  expect(bridge.restart).not.toHaveBeenCalled()
})

it('does not offer undeliverable feedback in an unconfigured build', () => {
  fixture({ ...idle, reporting: { ...idle.reporting, configured: false } })
  expect(screen.queryByRole('button', { name: 'Send feedback…' })).toBeNull()
  expect(screen.getByRole('switch', { name: 'Share usage data' })).toBeTruthy()
})

it('defers restart while the Matrix shell reports work in progress, and says why', async () => {
  const { bridge } = fixture({ ...idle, busy: true, update: { ...idle.update, state: 'downloaded', version: '1.0.1' } })

  fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
  const restart = await screen.findByRole('button', { name: 'Restart' })
  expect((restart as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(restart)
  expect(bridge.restart).not.toHaveBeenCalled()
  expect(screen.getAllByText('Finish current work to restart.').length).toBeGreaterThan(0)
})

it('shows a failed rail restart and allows a real retry', async () => {
  const { bridge } = fixture({ ...idle, update: { ...idle.update, state: 'downloaded', version: '1.0.1' } })
  bridge.restart.mockResolvedValueOnce(false)
  const rail = () => screen.getByRole('button', { name: 'Update ready — restart to install' })

  fireEvent.click(rail())
  fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
  expect(await screen.findByText('The update could not restart Atum. Please try again.')).toBeTruthy()
  expect(rail().hasAttribute('data-update-attention')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
  await waitFor(() => expect(bridge.restart).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(rail().hasAttribute('data-failed')).toBe(false))
})

it('reveals the rail update button when a download finishes, not while it downloads', () => {
  fixture()

  expect(screen.queryByRole('button', { name: 'Update ready — restart to install' })).toBeNull()

  act(() =>
    $matrixDesktopServices.set({
      ...idle,
      update: { ...idle.update, progress: 100, state: 'downloading', version: '1.0.1' }
    })
  )
  expect(screen.queryByRole('button', { name: 'Update ready — restart to install' })).toBeNull()

  act(() =>
    $matrixDesktopServices.set({
      ...idle,
      update: { ...idle.update, progress: 100, state: 'downloaded', version: '1.0.1' }
    })
  )
  const rail = screen.getByRole('button', { name: 'Update ready — restart to install' })
  expect(rail.hasAttribute('data-update-attention')).toBe(true)
})

it('draws the rail’s update as one glyph, no word, named by its label and the same tip', async () => {
  fixture({ ...idle, update: { ...idle.update, state: 'downloaded', version: '1.0.1' } })
  const rail = screen.getByRole('button', { name: 'Update ready — restart to install' })

  expect(rail.textContent).toBe('')
  expect(rail.querySelectorAll('svg')).toHaveLength(1)
  fireEvent.pointerMove(rail, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toBe('Update ready — restart to install')
})

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
  'names the rail’s update mark in %s with the words its tip shows',
  async locale => {
    window.atumDesktopServices = { restart: vi.fn(async () => true) } as unknown as MatrixDesktopServicesBridge
    $matrixDesktopServices.set({ ...idle, update: { ...idle.update, state: 'downloaded', version: '1.0.1' } })

    const { container } = render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixUpdateFooter onOpenUpdates={() => {}} />
      </I18nProvider>
    )

    const rail = container.querySelector('.atum-rail-update') as HTMLElement
    const label = rail.getAttribute('aria-label') ?? ''
    expect(label.trim().length).toBeGreaterThan(0)
    // Translated, not the English fallback.
    expect(locale === 'en' || label !== 'Update ready — restart to install').toBe(true)
    fireEvent.pointerMove(rail, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toBe(label)
  }
)
