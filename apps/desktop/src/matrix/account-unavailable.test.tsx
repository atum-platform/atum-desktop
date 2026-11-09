import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'

import { MatrixAccountUnavailable, matrixAccountUnavailable } from './account-unavailable'
import { $matrixDesktopServices } from './desktop-services'
import { matrixLaunchCopy } from './launch-copy'
import { matrixSignInCopy } from './sign-in-copy'

const noAccount: MatrixSnapshot = {
  state: 'error',
  identity: null,
  rooms: [],
  roomId: null,
  messages: [],
  error: 'matrix_vault_unavailable'
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
  Reflect.deleteProperty(window, 'atumDesktopServices')
  $matrixDesktopServices.set(null)
})

function draw(snapshot: MatrixSnapshot, locale: Locale = 'en') {
  const handlers = { onRetry: vi.fn(async () => {}), onSignOut: vi.fn(async () => {}) }

  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixAccountUnavailable {...handlers} snapshot={snapshot} />
    </I18nProvider>
  )

  return handlers
}

describe('which window an account it cannot open gets', () => {
  it('is about the saved account only for the account’s own errors', () => {
    expect(matrixAccountUnavailable(noAccount)).toBe(true)

    for (const error of [
      'matrix_snapshot_unavailable',
      'matrix_sign_out_pending',
      'matrix_sdk_start_failed',
      'matrix_sdk_stopped',
      'matrix_disk_full'
    ]) {
      expect(matrixAccountUnavailable({ state: 'error', error })).toBe(true)
    }
  })

  it('is not shown for an error that says nothing about a saved account', () => {
    // A failed first snapshot or sign-in on a Mac that may never have signed in: the
    // sign-in window shows it as a notice, never a card with Sign out.
    expect(matrixAccountUnavailable({ state: 'error', error: 'matrix_connection_failed' })).toBe(false)
    expect(matrixAccountUnavailable({ state: 'error', error: null })).toBe(false)
  })

  it('is never shown for a session that is over, whose Try again could never work', () => {
    // The sign-in server ended it: the sign-in, with its notice (sign-in.tsx).
    expect(matrixAccountUnavailable({ state: 'signed_out', error: 'matrix_session_ended' })).toBe(false)
    expect(matrixAccountUnavailable({ state: 'error', error: 'matrix_session_ended' })).toBe(false)
    // A refused token alone is main's question to the sign-in server, not a card.
    expect(matrixAccountUnavailable({ state: 'error', error: 'matrix_signed_out' })).toBe(false)
  })

  it('is never shown for signing out, signed out or a sign-in in progress', () => {
    for (const state of ['signed_out', 'signing_in', 'connecting'] as const) {
      expect(matrixAccountUnavailable({ state, error: 'matrix_vault_unavailable' })).toBe(false)
    }
  })
})

describe('the window for an account it cannot open', () => {
  it('offers Try again and, quietly, signing out (confirmed in place), never the ways in', async () => {
    const signOut = vi.fn(async () => {})
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { signOut } })
    const { onRetry } = draw(noAccount)

    expect(screen.getByRole('heading', { name: 'Couldn’t open your saved sign-in' })).toBeTruthy()
    expect(
      screen.getByText('Atum couldn’t open the sign-in saved on this Mac. Try again, or sign out and sign in again.')
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(screen.getByText('Sign out of Atum on this Mac?')).toBeTruthy()
    expect(signOut).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce())
  })

  it('says the chats could not open, not the network, when the chat engine did not start', () => {
    draw({ ...noAccount, error: 'matrix_sdk_start_failed' })

    expect(screen.getByRole('heading', { name: 'Couldn’t open your chats' })).toBeTruthy()
    expect(screen.queryByText(/Check your connection/)).toBeNull()
  })

  it.each(['vi', 'en', 'ja', 'zh', 'zh-hant'] as const)(
    'says, in %s, that a full disk is why the chats stopped and that they come back by themselves',
    locale => {
      draw({ ...noAccount, error: 'matrix_disk_full' }, locale)
      const words = matrixLaunchCopy(locale)

      expect(screen.getByRole('heading', { name: words.engineTitle })).toBeTruthy()
      expect(screen.getByText(words.diskFullHelp)).toBeTruthy()
      expect(screen.queryByText(words.engineHelp)).toBeNull()
    }
  )

  it('offers only Try again when nothing is known about an account here', () => {
    const { onRetry } = draw({ ...noAccount, error: 'matrix_snapshot_unavailable' })

    expect(screen.getByRole('heading', { name: 'Can’t reach Atum right now' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('offers feedback quietly when reporting is set up, in place', () => {
    $matrixDesktopServices.set({ reporting: { configured: true } } as never)
    Object.defineProperty(window, 'atumDesktopServices', { configurable: true, value: {} })
    draw(noAccount)

    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect(window.document.querySelector('[data-matrix-account-feedback]')).toBeTruthy()
  })

  it('finishes an unfinished sign-out with one Sign out, and offers nothing else', () => {
    const { onRetry, onSignOut } = draw({ ...noAccount, error: 'matrix_sign_out_pending' })

    expect(screen.getByRole('heading', { name: 'Signing out didn’t finish' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    const buttons = screen.getAllByRole('button', { name: 'Sign out' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(onSignOut).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it.each(['vi', 'ja', 'zh', 'zh-hant'] as const)('speaks %s', locale => {
    draw(noAccount, locale)
    const words = matrixSignInCopy(locale)

    expect(screen.getByRole('heading', { name: words.vaultTitle })).toBeTruthy()
    expect(screen.getByText(words.vaultHelp)).toBeTruthy()
  })
})
