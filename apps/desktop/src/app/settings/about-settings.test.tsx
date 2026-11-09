import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $atumShellEnabled } from '@/store/atum-shell'
import { $atumUpdate } from '@/store/atum-updates'

import { AboutSettings } from './about-settings'

function installBridge(status: { armed: boolean; packaged: boolean }) {
  const check = vi.fn().mockResolvedValue({ accepted: status.armed })

  // The app bootstrap owns IPC; About consumes its shared state.
  $atumUpdate.set({
    ...status, channel: 'latest', state: status.armed ? 'idle' : 'unavailable', version: null, checkedAt: null,
    progress: null, notes: [], error: null, requiredBelow: null
  })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      api: vi.fn().mockResolvedValue({}),
      appUpdate: { check, onDownloaded: () => () => undefined, relaunch: vi.fn(), status: vi.fn().mockResolvedValue(status) }
    }
  })

  return { check }
}

function renderAbout() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <AboutSettings />
    </I18nProvider>
  )
}

beforeEach(() => {
  $atumShellEnabled.set(true)
  $atumUpdate.set(null)
})
afterEach(() => {
  cleanup()
  $atumUpdate.set(null)
  $atumShellEnabled.set(true)
})

describe('About → updates in the Atum shell', () => {
  it('waits for packaging status before offering either updater', () => {
    const { container } = renderAbout()

    expect(container.querySelector('[data-atum-updates]')).toBeNull()
    expect(container.textContent).not.toContain('Branch ')
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
  })

  it('offers only the Atum updater when a packaged build is armed, never the Hermes checkout controls', async () => {
    const { check } = installBridge({ armed: true, packaged: true })
    const { container } = renderAbout()

    await waitFor(() => expect(container.querySelector('[data-atum-updates="armed"]')).toBeTruthy())
    expect(container.textContent).not.toContain('Branch ')
    expect(screen.queryByText("See what's new")).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('says plainly that an unarmed packaged build cannot update itself', async () => {
    installBridge({ armed: false, packaged: true })
    const { container } = renderAbout()

    await waitFor(() => expect(container.querySelector('[data-atum-updates="unavailable"]')).toBeTruthy())
    expect(screen.getByText("This build can't update itself from inside the app.")).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
  })

  it('keeps the Hermes checkout updater for a developer (unpackaged) build', async () => {
    installBridge({ armed: false, packaged: false })
    const { container } = renderAbout()

    await waitFor(() => expect(container.textContent).toContain('Branch '))
    expect(container.querySelector('[data-atum-updates]')).toBeNull()
  })
})
