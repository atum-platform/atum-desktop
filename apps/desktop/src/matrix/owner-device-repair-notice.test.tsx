import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import { MatrixOwnerDeviceRepairNotice, type OwnerDeviceRepairSnapshot } from './owner-device-repair-notice'

function bridge() {
  const value = {
    repairOwnerDevice: vi.fn(async () => ({ state: 'repaired' as 'repaired' | 'resume_pending' })),
    cancelOwnerDeviceRepair: vi.fn(async () => {}),
    cloudAgent: vi.fn(async () => ({})),
    signOut: vi.fn(),
    signIn: vi.fn(),
    reconnectAgent: vi.fn()
  }
  Object.defineProperty(window, 'atumMatrix', { configurable: true, value })
  return value
}
function draw(snapshot: OwnerDeviceRepairSnapshot, locale: Locale = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixOwnerDeviceRepairNotice snapshot={snapshot} />
    </I18nProvider>
  )
}
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the human repair notice', () => {
  it('is absent unless main reports damage, progress or a device-service mismatch', () => {
    bridge()
    expect(draw({}).container.textContent).toBe('')
  })
  it.each([
    ['en', 'This device needs to be re-verified', 'Re-verify'],
    ['vi', 'Thiết bị này cần xác minh lại', 'Xác minh lại'],
    ['ja', 'このデバイスを再確認してください', '再確認'],
    ['zh', '此设备需要重新验证', '重新验证'],
    ['zh-hant', '此裝置需要重新驗證', '重新驗證']
  ] as const)('offers repair in %s without another lifecycle action', async (locale, title, label) => {
    const native = bridge()
    draw({ deviceDamaged: true }, locale)
    expect(screen.getByText(title)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(native.repairOwnerDevice).toHaveBeenCalledOnce())
    expect(native.signOut).not.toHaveBeenCalled()
    expect(native.signIn).not.toHaveBeenCalled()
    expect(native.reconnectAgent).not.toHaveBeenCalled()
  })
  it('keeps main-owned busy progress visible after the deviceDamaged flag disappears', async () => {
    const native = bridge()
    draw({ ownerDeviceRepair: { state: 'verifying' } })
    expect((screen.getByRole('button', { name: 'Verifying…' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(native.cancelOwnerDeviceRepair).toHaveBeenCalledOnce())
  })
  it('retries resume_pending through repair, with no new login; cancel remains scoped', async () => {
    const native = bridge()
    native.repairOwnerDevice.mockResolvedValue({ state: 'resume_pending' })
    draw({ ownerDeviceRepair: { state: 'resume_pending' } })
    expect(screen.getByText('Signed in. Reconnecting…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(native.repairOwnerDevice).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(native.cancelOwnerDeviceRepair).toHaveBeenCalledOnce())
    expect(native.signIn).not.toHaveBeenCalled()
    expect(native.signOut).not.toHaveBeenCalled()
  })
  it.each([
    ['matrix_account_mismatch', "Sign in with the account you're already using."],
    ['private raw error', "Couldn't verify. Try again later."]
  ])('renders a closed local error for %s', async (error, sentence) => {
    const native = bridge()
    native.repairOwnerDevice.mockRejectedValue(new Error(`Error invoking remote method 'matrix:ui': Error: ${error}`))
    draw({ deviceDamaged: true })
    fireEvent.click(screen.getByRole('button', { name: 'Re-verify' }))
    expect((await screen.findByRole('alert')).textContent).toBe(sentence)
    expect(screen.getByText('This device needs to be re-verified')).toBeTruthy()
  })
  it('retains main-owned errors after the surface remounts', () => {
    bridge()
    draw({ deviceDamaged: true, ownerDeviceRepair: { state: 'failed', error: 'matrix_account_mismatch' } })
    expect(screen.getByRole('alert').textContent).toBe("Sign in with the account you're already using.")
  })
  it('does not turn automatic device-service recovery into a prompt', () => {
    const native = bridge()
    const view = draw({ deviceControlRequired: true })

    expect(view.container.textContent).toBe('')
    expect(native.cloudAgent).not.toHaveBeenCalled()
    expect(native.repairOwnerDevice).not.toHaveBeenCalled()
  })
})
