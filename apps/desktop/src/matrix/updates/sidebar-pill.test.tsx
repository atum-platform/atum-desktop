import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { createInitialDesktopUpdateState } from '../../../vendor/t3-updates/apps/desktop/src/updates/updateMachine'
import { SidebarUpdatePill } from './sidebar-pill'

function fixture() {
  const initial = createInitialDesktopUpdateState('1.0.0', {
    hostArch: 'arm64', appArch: 'arm64', runningUnderArm64Translation: false
  }, 'latest')
  const bridge = {
    checkUpdates: vi.fn(async () => true), downloadUpdate: vi.fn(async () => true), restart: vi.fn(async () => true)
  }
  render(<SidebarUpdatePill
    bridge={bridge}
    busy={false}
    locale="en"
    openReleaseHistory={vi.fn()}
    state={{ ...initial, enabled: true, status: 'downloaded', downloadedVersion: '1.1.0' }}
  />)

  return bridge
}

it('confirms the expected version before asking the bridge to restart', async () => {
  const bridge = fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
  fireEvent.click(screen.getByRole('button', { name: 'Later' }))
  expect(bridge.restart).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
  await act(async () => {fireEvent.click(screen.getByRole('button', { name: 'Restart' }))})
  expect(bridge.restart).toHaveBeenCalledExactlyOnceWith('1.1.0')
})

it('allows postponement throughout the five-second countdown', async () => {
  vi.useFakeTimers()
  try {
    const bridge = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Update everything' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Update everything' }))
    expect(screen.getByRole('status').textContent).toBe('Restarting in 5s')
    await act(async () => {await vi.advanceTimersByTimeAsync(4000)})
    expect(bridge.restart).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    await act(async () => {await vi.advanceTimersByTimeAsync(2000)})
    expect(bridge.restart).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
