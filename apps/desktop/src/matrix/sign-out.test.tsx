import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'

import { $matrixRecoveryWriteDown } from './security-panel'
import { $matrixSignOutOpen, MatrixSignOutConfirm, MatrixSignOutDialog, matrixSignOutRecovery } from './sign-out'

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'D' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

function bridge() {
  const value = { signOut: vi.fn(async () => {}) }
  Object.defineProperty(window, 'atumMatrix', { configurable: true, value })

  return value
}

function openDialog(snapshot: MatrixSnapshot) {
  const onSetUpRecovery = vi.fn()

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixSignOutDialog onSetUpRecovery={onSetUpRecovery} snapshot={snapshot} />
    </I18nProvider>
  )
  act(() => $matrixSignOutOpen.set(true))

  return onSetUpRecovery
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  $matrixSignOutOpen.set(false)
  $matrixRecoveryWriteDown.set(false)
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('signing out of this Mac', () => {
  it('counts a recovery key only once it is confirmed', () => {
    expect(matrixSignOutRecovery(base)).toBe('unknown')
    expect(matrixSignOutRecovery({ ...base, security: { recovery: 'idle' } })).toBe('unknown')
    expect(matrixSignOutRecovery({ ...base, security: { recovery: 'working' } })).toBe('unknown')
    expect(matrixSignOutRecovery({ ...base, security: { recovery: 'failed' } })).toBe('unknown')
    expect(matrixSignOutRecovery({ ...base, security: { recovery: 'idle', storage: 'absent' } })).toBe('absent')
    expect(matrixSignOutRecovery({ ...base, security: { recovery: 'idle', storage: 'present' } })).toBe('present')
    // Set up or restored on this Mac a moment ago, before sync says so.
    expect(matrixSignOutRecovery({ ...base, security: { recovery: 'ready', storage: 'absent' } })).toBe('present')
  })

  it.each([
    ['still syncing', undefined],
    ['not known yet', { recovery: 'idle' as const }]
  ])('treats a recovery key that is %s as missing: the warning, then the key first', async (_, security) => {
    const native = bridge()
    const onSetUpRecovery = openDialog({ ...base, security })
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

    expect(within(dialog).getByText(/Make sure you have your recovery key/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Sign out' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up recovery key first' }))
    expect(onSetUpRecovery).toHaveBeenCalledOnce()
    expect(native.signOut).not.toHaveBeenCalled()
  })

  it('still signs out from the warning, one quieter click away', async () => {
    const native = bridge()
    openDialog(base)
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(native.signOut).toHaveBeenCalledOnce())
  })

  it('says plainly that no key is saved when the account has none', async () => {
    bridge()
    openDialog({ ...base, security: { recovery: 'idle', storage: 'absent' } })
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

    expect(within(dialog).getByText(/haven’t saved a recovery key/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Set up recovery key first' })).toBeTruthy()
  })

  it('signs out in one step once a recovery key is confirmed', async () => {
    const native = bridge()
    openDialog({ ...base, security: { recovery: 'idle', storage: 'present' } })
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

    expect(within(dialog).getByText(/You’ll need your recovery key/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Set up recovery key first' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(native.signOut).toHaveBeenCalledOnce())
  })

  it('clears local workbench recents only after sign-out succeeds', async () => {
    const native = bridge()
    window.localStorage.setItem('atum:matrix-workbench-recents:v1', '{"version":1,"scopes":[]}')
    openDialog({ ...base, security: { recovery: 'idle', storage: 'present' } })
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(native.signOut).toHaveBeenCalledOnce())
    await waitFor(() => expect(window.localStorage.getItem('atum:matrix-workbench-recents:v1')).toBeNull())
  })

  it('warns in place at launch too while the key is not confirmed', () => {
    bridge()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixSignOutConfirm onCancel={() => {}} snapshot={base} />
      </I18nProvider>
    )

    expect(screen.getByText(/Make sure you have your recovery key/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out anyway' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
  })

  // A key made quietly at first run (custody `device`) and never written down leaves with the
  // sign-out (golden path): the dialog says where it is and opens it to write down first.
  it.each([
    ['confirmed on the account', { recovery: 'idle' as const, storage: 'present' as const, custody: 'device' as const }],
    ['while the account still syncs', { recovery: 'idle' as const, custody: 'device' as const }]
  ])('asks to save a key only this Mac holds first, %s', async (_, security) => {
    const native = bridge()
    const onSetUpRecovery = openDialog({ ...base, security })
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

    expect(within(dialog).getByText(/saved only on this Mac/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Sign out' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Sign out anyway' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save your recovery key first' }))
    expect($matrixRecoveryWriteDown.get()).toBe(true)
    expect(onSetUpRecovery).toHaveBeenCalledOnce()
    expect(native.signOut).not.toHaveBeenCalled()
  })

  it('says no key is saved, not that it is on this Mac, when the account has none', async () => {
    bridge()
    openDialog({ ...base, security: { recovery: 'idle', storage: 'absent', custody: 'device' } })
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

    expect(within(dialog).getByText(/haven’t saved a recovery key/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up recovery key first' }))
    expect($matrixRecoveryWriteDown.get()).toBe(false)
  })

  it('warns in place at launch about a key only this Mac holds', () => {
    bridge()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixSignOutConfirm
          onCancel={() => {}}
          snapshot={{ ...base, security: { recovery: 'idle', storage: 'present', custody: 'device' } }}
        />
      </I18nProvider>
    )

    expect(screen.getByText(/saved only on this Mac/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out anyway' })).toBeTruthy()
  })

  // 0.18.2: the key is kept for the person (owner-keys.ts), so signing out no longer loses it.
  describe('with the recovery key kept on this Mac', () => {
    const kept = { recovery: 'idle' as const, storage: 'present' as const, kept: true as const }

    it('keeps it: signing in again here just works, in one step', async () => {
      const native = bridge()
      openDialog({ ...base, security: kept })
      const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

      expect(within(dialog).getByText(/keeps your recovery key on this Mac, so next time you just sign in/)).toBeTruthy()
      expect(within(dialog).queryByRole('button', { name: 'Set up recovery key first' })).toBeNull()
      const forget = within(dialog).getByRole('checkbox', { name: /Forget the key on this Mac/ })
      expect(forget.getAttribute('aria-checked')).toBe('false')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
      await waitFor(() => expect(native.signOut).toHaveBeenCalledWith(undefined))
    })

    it('keeps it even when it was made here and never written down', async () => {
      const native = bridge()
      openDialog({ ...base, security: { ...kept, custody: 'device' } })
      const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

      expect(within(dialog).getByText(/next time you just sign in/)).toBeTruthy()
      expect(within(dialog).queryByRole('button', { name: 'Save your recovery key first' })).toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
      await waitFor(() => expect(native.signOut).toHaveBeenCalledWith(undefined))
    })

    it('forgets it only when asked, with the ordinary warning for a key the person has', async () => {
      const native = bridge()
      openDialog({ ...base, security: kept })
      const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

      fireEvent.click(within(dialog).getByRole('checkbox', { name: /Forget the key on this Mac/ }))
      expect(within(dialog).getByText(/You’ll need your recovery key/)).toBeTruthy()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
      await waitFor(() => expect(native.signOut).toHaveBeenCalledWith({ forgetKey: true }))
    })

    it('says forgetting here leaves the copy in iCloud Keychain', async () => {
      bridge()
      openDialog({ ...base, security: { ...kept, icloud: 'on' } })
      const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
      const icloud = /The copy in iCloud Keychain stays, so signing in on this Mac again still unlocks it/

      expect(within(dialog).queryByText(icloud)).toBeNull()
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /Forget the key on this Mac/ }))
      expect(within(dialog).getByText(icloud)).toBeTruthy()
    })

    it('asks to save a never-written key before forgetting it, and can still forget it', async () => {
      const native = bridge()
      const onSetUpRecovery = openDialog({ ...base, security: { ...kept, custody: 'device' } })
      const dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })

      fireEvent.click(within(dialog).getByRole('checkbox', { name: /Forget the key on this Mac/ }))
      expect(within(dialog).getByText(/saved only on this Mac/)).toBeTruthy()
      expect(within(dialog).getByRole('button', { name: 'Save your recovery key first' })).toBeTruthy()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out anyway' }))
      await waitFor(() => expect(native.signOut).toHaveBeenCalledWith({ forgetKey: true }))
      expect(onSetUpRecovery).not.toHaveBeenCalled()
    })

    it('starts from keeping the key each time the question opens', async () => {
      bridge()
      openDialog({ ...base, security: kept })
      let dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /Forget the key on this Mac/ }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      act(() => $matrixSignOutOpen.set(true))
      dialog = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
      expect(within(dialog).getByRole('checkbox', { name: /Forget the key on this Mac/ }).getAttribute('aria-checked')).toBe(
        'false'
      )
    })

    it('offers the same choice in place at launch', async () => {
      const native = bridge()

      render(
        <I18nProvider configClient={null} initialLocale="vi">
          <MatrixSignOutConfirm onCancel={() => {}} snapshot={{ ...base, security: kept }} />
        </I18nProvider>
      )

      expect(screen.getByText('Atum vẫn nhớ khóa khôi phục trên Mac này, nên lần sau bạn chỉ cần đăng nhập.')).toBeTruthy()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Quên khóa trên Mac này (khi bán hoặc cho máy)' }))
      fireEvent.click(screen.getByRole('button', { name: 'Đăng xuất' }))
      await waitFor(() => expect(native.signOut).toHaveBeenCalledWith({ forgetKey: true }))
    })
  })
})
