import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { createInitialDesktopUpdateState } from '../../../vendor/t3-updates/apps/desktop/src/updates/updateMachine'
import type { DesktopUpdateState } from '../../../vendor/t3-updates/packages/contracts/src/desktopUpdates'

import { SidebarUpdatePill } from './sidebar-pill'

function state(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  const initial = createInitialDesktopUpdateState('1.0.0', {
    hostArch: 'arm64', appArch: 'arm64', runningUnderArm64Translation: false
  }, 'latest')

  return { ...initial, enabled: true, ...overrides }
}

function renderPill(overrides: Partial<DesktopUpdateState> = { status: 'downloaded', downloadedVersion: '1.1.0' }) {
  const bridge = {
    checkUpdates: vi.fn(async () => true), downloadUpdate: vi.fn(async () => true), restart: vi.fn(async () => true)
  }

  const view = render(<SidebarUpdatePill
    bridge={bridge}
    busy={false}
    locale="en"
    openReleaseHistory={vi.fn()}
    state={state(overrides)}
  />)

  return { bridge, view }
}

it('confirms the expected version before asking the bridge to restart', async () => {
  const { bridge } = renderPill()
  fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
  fireEvent.click(screen.getByRole('button', { name: 'Later' }))
  expect(bridge.restart).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
  await act(async () => {fireEvent.click(screen.getByRole('button', { name: 'Restart' }))})
  expect(bridge.restart).toHaveBeenCalledExactlyOnceWith('1.1.0')
})

it('allows postponement throughout the five-second countdown, from the dialog', async () => {
  vi.useFakeTimers()

  try {
    const { bridge } = renderPill()
    fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update everything' }))
    expect(within(dialog).getByRole('status').textContent).toBe('Restarting in 5s')
    await act(async () => {await vi.advanceTimersByTimeAsync(4000)})
    expect(bridge.restart).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Later' }))
    await act(async () => {await vi.advanceTimersByTimeAsync(2000)})
    expect(bridge.restart).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it.each([
  [{ status: 'idle' }, 'idle', 'Check for updates'],
  [{ status: 'up-to-date' }, 'idle', 'Up to date'],
  [{ status: 'checking' }, 'checking', 'Checking for updates…'],
  [{ status: 'available', availableVersion: '1.1.0' }, 'available', 'Update available'],
  [{ status: 'downloading', availableVersion: '1.1.0', downloadPercent: 42 }, 'downloading', 'Downloading update… 42%'],
  [{ status: 'downloaded', downloadedVersion: '1.1.0' }, 'ready', 'Update ready — restart to install'],
  [{ status: 'error', errorContext: 'check', message: 'offline' }, 'error', 'Try again']
] as const)('draws %o as one rail glyph, %s, with no words in the rail', (overrides, glyph, label) => {
  const { view } = renderPill(overrides as Partial<DesktopUpdateState>)
  const buttons = screen.getAllByRole('button')
  expect(buttons).toHaveLength(1)
  expect(buttons[0].getAttribute('data-atum-update-glyph')).toBe(glyph)
  expect(buttons[0].getAttribute('aria-label')).toBe(label)
  expect(buttons[0].querySelectorAll('svg')).toHaveLength(1)
  expect(view.container.textContent).toBe('')
})

it('fills the download ring to the reported progress and marks only a ready update with the dot', () => {
  const downloading = renderPill({ status: 'downloading', availableVersion: '1.1.0', downloadPercent: 42 })
  expect(downloading.view.container.querySelector('[data-spinner-value]')?.getAttribute('data-spinner-value')).toBe('42')
  expect(downloading.view.container.querySelector('[data-atum-nav-badge]')).toBeNull()
  downloading.view.unmount()

  const ready = renderPill()
  expect(ready.view.container.querySelector('[data-atum-nav-badge="unread"]')).not.toBeNull()
})

it('checks for updates from the idle glyph and shows the failure as the glyph and its label', async () => {
  const { bridge } = renderPill({ status: 'idle' })
  bridge.checkUpdates.mockResolvedValueOnce(false)
  await act(async () => {fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))})
  expect(bridge.checkUpdates).toHaveBeenCalledOnce()
  const failed = screen.getByRole('button', { name: 'Could not check for updates. Please try again.' })
  expect(failed.getAttribute('data-atum-update-glyph')).toBe('error')
})
