import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixSignInMethod, MatrixSnapshot } from '../../shared/matrix'

import { MatrixSignIn, type MatrixSignInProps } from './sign-in'
import { matrixSignInCopy } from './sign-in-copy'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function view(props: Partial<MatrixSignInProps> = {}, locale: Locale = 'en') {
  const handlers = { onCancel: vi.fn(), onSignIn: vi.fn() }
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixSignIn error={null} failed={false} state="signed_out" {...handlers} {...props} />
    </I18nProvider>
  )
  return handlers
}

function Live({ onSignIn }: { onSignIn: (method: MatrixSignInMethod) => void }) {
  const [state, setState] = useState<MatrixSnapshot['state']>('signed_out')

  return (
    <MatrixSignIn
      error={null}
      failed={false}
      onCancel={() => setState('signed_out')}
      onSignIn={method => {
        onSignIn(method)
        setState('signing_in')
      }}
      state={state}
    />
  )
}

describe('the approved first-run sign-in board', () => {
  it('shows one centered screen with exactly Google and email, legal copy and language', () => {
    const { onSignIn } = view()

    expect(screen.getByRole('heading', { name: 'Welcome to Atum' })).toBeTruthy()
    expect(window.document.querySelector('[data-atum-auth-align="center"]')).not.toBeNull()
    expect(window.document.querySelector('[data-matrix-pet-stroll]')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Continue with/ }).map(button => button.textContent)).toEqual([
      'Continue with Google',
      'Continue with email'
    ])
    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(window.document.querySelector('[data-matrix-cloud-consent]')).toBeNull()
    expect(window.document.querySelector('[data-matrix-language-settings]')).not.toBeNull()
    expect(window.document.querySelector('[data-matrix-legal]')?.textContent).toContain('18 or older')

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }))
    expect(onSignIn.mock.calls).toEqual([['google'], ['email']])
  })

  it('waits on the selected way and lets Escape or Cancel return to the two choices', () => {
    const onSignIn = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <Live onSignIn={onSignIn} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }))
    const waiting = screen.getByRole('button', { name: 'Waiting for you to finish in your browser…' })
    expect(waiting.hasAttribute('data-matrix-sign-in-email')).toBe(true)
    expect(waiting.getAttribute('aria-busy')).toBe('true')
    expect((screen.getByRole('button', { name: 'Continue with Google' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Continue with email' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Waiting for you to finish in your browser…' })).toBeNull()
    expect(onSignIn.mock.calls).toEqual([['email'], ['google']])
  })

  it('distinguishes opening the browser, waiting there and returning here', () => {
    view({ state: 'signing_in', browser: false })
    expect(screen.getByRole('button', { name: 'Opening your browser…' })).toBeTruthy()
    cleanup()
    view({ state: 'signing_in', browser: true })
    expect(screen.getByRole('button', { name: 'Waiting for you to finish in your browser…' })).toBeTruthy()
    cleanup()
    view({ state: 'signing_in', returned: true })
    expect(screen.getByRole('button', { name: 'Signing you in…' })).toBeTruthy()
  })

  it('keeps both ways disabled while connecting', () => {
    view({ state: 'connecting' })
    expect((screen.getByRole('button', { name: 'Continue with Google' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Continue with email' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers only Google when email is unavailable', () => {
    view({ email: 'unavailable' })
    expect(screen.getAllByRole('button', { name: /^Continue with/ }).map(button => button.textContent)).toEqual([
      'Continue with Google'
    ])
    expect(screen.getByText('New to Atum? Continue with Google to create your account.')).toBeTruthy()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('localizes both approved ways in for %s', locale => {
    const { onSignIn } = view({}, locale)
    const words = matrixSignInCopy(locale)
    fireEvent.click(screen.getByRole('button', { name: words.continueWithEmail }))
    expect(onSignIn).toHaveBeenCalledExactlyOnceWith('email')
  })
})

describe('sign-in recovery states', () => {
  it('names an email refusal, a timeout and a connection failure without changing the choices', () => {
    view({ error: 'matrix_password_unavailable' })
    expect(screen.getByRole('status').textContent).toBe(
      'Email sign-in isn’t supported yet. Continue with Google for now.'
    )
    cleanup()
    view({ error: 'matrix_login_timed_out' })
    expect(screen.getByRole('status').textContent).toBe('Sign-in timed out. Choose a way in to start again.')
    cleanup()
    view({ state: 'error', error: 'matrix_connection_failed' })
    expect(screen.getByRole('status').textContent).toBe('Atum couldn’t connect. Check your connection, then try again.')
  })

  it('says a server-ended session in every locale', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
      view({ error: 'matrix_session_ended' }, locale)
      expect(screen.getByRole('status').textContent).toBe(matrixSignInCopy(locale).sessionEnded)
      cleanup()
    }
  })

  it('offers explicit sign-out only after an account mismatch', async () => {
    const signOut = vi.fn(async () => {})
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { signOut } })
    view({ error: 'matrix_account_mismatch', attempted: true })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(screen.getByText('Sign out of Atum on this Mac?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }))
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce())
  })
})

describe('the terms line', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('links Terms and Privacy in %s', locale => {
    const openLink = vi.fn(async () => {})
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { openLink } })
    view({}, locale)
    const words = matrixSignInCopy(locale)
    const legal = window.document.querySelector('[data-matrix-legal]') as HTMLElement

    fireEvent.click(within(legal).getByRole('button', { name: words.terms }))
    fireEvent.click(within(legal).getByRole('button', { name: words.privacy }))
    expect(openLink.mock.calls).toEqual([
      ['https://atumplatform.com/terms'],
      ['https://atumplatform.com/privacy']
    ])
    expect(legal.textContent).toMatch(/\b18\b/)
  })
})
