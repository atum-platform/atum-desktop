import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'

import { matrixDeviceHealthCopy, MatrixDeviceHealthNotice } from './device-health-notice'
import { MatrixLaunchNotice } from './launch-notice'

function bridge() {
  const value = {
    signOut: vi.fn(async () => {}),
    signIn: vi.fn(async () => {}),
    repairOwnerDevice: vi.fn(async () => ({ state: 'repaired' as const })),
    openStorageSettings: vi.fn(async () => {})
  }

  Object.defineProperty(window, 'atumMatrix', { configurable: true, value })

  return value
}

type HealthSnapshot = Pick<MatrixSnapshot, 'deviceDamaged'>

function draw(snapshot: HealthSnapshot, locale: Locale = 'en') {
  const content = (next: HealthSnapshot) => (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixDeviceHealthNotice snapshot={next} />
    </I18nProvider>
  )

  const rendered = render(content(snapshot))

  return {
    ...rendered,
    rerenderSnapshot: (next: HealthSnapshot) => rendered.rerender(content(next))
  }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('this Mac’s own health, once for the whole window', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('catalogs the composer disk-full notice in %s', locale => {
    const copy = matrixDeviceHealthCopy(locale)

    expect(copy.diskFullTitle.trim()).not.toBe('')
    expect(copy.diskFullBody.trim()).not.toBe('')
    expect(copy.openStorage.trim()).not.toBe('')
  })

  it('says nothing while the device is sound', () => {
    bridge()
    const { container } = draw({})
    expect(container.textContent).toBe('')
  })

  // A nearly-full disk stays in the status indicator; a failed write now belongs to the composer.
  it('draws no disk band or pill of its own', () => {
    bridge()
    const { container } = draw({})

    expect(container.querySelector('[data-matrix-disk]')).toBeNull()
    expect(container.querySelector('[data-matrix-disk-dismissed]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Storage|Dismiss for now/u })).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('re-verifies a damaged human without signing out', async () => {
    const native = bridge()
    draw({ deviceDamaged: true })

    expect(screen.getByText('This device needs to be re-verified')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Re-verify' }))
    await waitFor(() => expect(native.repairOwnerDevice).toHaveBeenCalledOnce())
    expect(native.signOut).not.toHaveBeenCalled()
    expect(native.signIn).not.toHaveBeenCalled()
  })

  // 2026-10-21: with a chat open, the window's health band (status stack) and the
  // assistant's launch notice are both mounted. The health band owns the device offer;
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  it('does not revive the removed enrollment prompt or duplicate the disk warning', () => {
    bridge()

    const snapshot: MatrixSnapshot = {
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'MAC' },
      rooms: [],
      roomId: null,
      messages: [],
      error: null,
      readiness: { phase: 'ready', since: 1 },
      deviceControlRequired: true,
      // A critical disk is in the snapshot; the window says it in the status indicator, not here.
      disk: { state: 'critical', freeGb: 2.5 }
    }

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <div data-matrix-status-stack>
          <MatrixDeviceHealthNotice snapshot={snapshot} />
        </div>
        <MatrixLaunchNotice name="Luna" snapshot={snapshot} />
      </I18nProvider>
    )

    expect(screen.queryByText('Cho phép trợ lý dùng máy Mac này')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cho phép' })).toBeNull()
    expect(screen.queryByText(/Mac gần như hết dung lượng/)).toBeNull()
  })
})
