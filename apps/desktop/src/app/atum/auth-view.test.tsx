import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'

vi.mock('@/store/atum-messaging', async () => {
  const { atom } = await import('nanostores')

  return {
    $atumAccountScopeId: atom(null),
    $atumAccountStatus: atom<AtumAccountStatus>({
      state: 'signed_out',
      configured: true,
      account: null,
      errorCode: null,
      providers: { google: true, password: true }
    }),
    cancelAtumSignIn: vi.fn(),
    retryAtumAccountRestore: vi.fn(),
    signInToAtum: vi.fn(),
    signInToAtumWithPassword: vi.fn()
  }
})

const { $atumAccountStatus, cancelAtumSignIn, retryAtumAccountRestore, signInToAtum } = await import('@/store/atum-messaging')
const { AtumAuthView } = await import('./auth-view')
const { completeDesktopBoot, waitForDesktopAccount } = await import('@/store/boot')

const signedOut: AtumAccountStatus = {
  state: 'signed_out',
  configured: true,
  account: null,
  errorCode: null,
  providers: { google: true, password: true }
}

const setMode = vi.fn(async () => ({ ok: true }))

afterEach(cleanup)

beforeEach(() => {
  completeDesktopBoot()
  vi.clearAllMocks()
  $atumAccountStatus.set(signedOut)
  globalThis.window.hermesDesktop = { atumWindow: { setMode } } as never
})

describe('AtumAuthView', () => {
  it('shows pending account status and recovers a failed initial read through the existing retry', async () => {
    waitForDesktopAccount()
    $atumAccountStatus.set({ ...signedOut, configured: false, state: 'unconfigured' })
    render(<AtumAuthView />)
    expect(screen.getByRole('status').textContent).toBe('Checking connection…')

    act(() => $atumAccountStatus.set({ ...signedOut, configured: false, state: 'error', errorCode: 'hosted_session_unavailable' }))
    vi.mocked(retryAtumAccountRestore).mockImplementationOnce(async () => {
      $atumAccountStatus.set(signedOut)

      return false
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry connection' })))
    expect(retryAtumAccountRestore).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox', { name: /Username/ })).toBeTruthy()
  })

  it('carries the Google mark on the OAuth button, and drops it while opening the browser', () => {
    render(<AtumAuthView />)
    const google = screen.getByRole('button', { name: 'Continue with Google' })

    // Four brand paths, decorative: the label carries the meaning.
    const mark = google.querySelector('svg')!
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.querySelectorAll('path')).toHaveLength(4)

    fireEvent.click(google)
    act(() => $atumAccountStatus.set({ ...signedOut, state: 'signing_in' }))

    // The pending state replaces the row wholesale, so no orphan mark is left
    // beside "Opening your browser…".
    expect(screen.getByRole('button', { name: 'Opening your browser…' }).querySelector('svg')).toBeNull()
  })

  it('is a full-window gate: no rail, no roster, no chat behind it', () => {
    const { container } = render(<AtumAuthView />)

    expect(container.querySelector('nav[aria-label]')).toBeNull()
    expect(container.querySelector('[data-atum-roster]')).toBeNull()
    expect(container.querySelector('.atum-plate-chat')).toBeNull()
  })

  it('focuses the identifier on mount so typing works immediately', () => {
    render(<AtumAuthView />)

    expect(globalThis.document.activeElement).toBe(screen.getByRole('textbox', { name: /Username/ }))
  })

  it('does not move focus during a provider-only or unresolved state', () => {
    $atumAccountStatus.set({ ...signedOut, providers: { google: true, password: false } })
    render(<AtumAuthView />)

    expect(globalThis.document.activeElement).not.toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('offers Google first, then the identifier/password fallback', () => {
    render(<AtumAuthView />)

    const google = screen.getByRole('button', { name: 'Continue with Google' })
    const identifier = screen.getByRole('textbox', { name: /Username/ })

    expect(google.compareDocumentPosition(identifier) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('or')).toBeTruthy()
  })

  it('hides Google truthfully when provider status says it is unavailable', () => {
    $atumAccountStatus.set({ ...signedOut, providers: { google: false, password: true } })
    render(<AtumAuthView />)

    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
    expect(screen.getByRole('textbox', { name: /Username/ })).toBeTruthy()
  })

  it('says so plainly when no provider is available at all', () => {
    $atumAccountStatus.set({ ...signedOut, providers: { google: false, password: false } })
    render(<AtumAuthView />)

    expect(screen.getByText("Sign-in isn't available in this build.")).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('runs the real Google sign-in action', () => {
    render(<AtumAuthView />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))

    expect(signInToAtum).toHaveBeenCalledOnce()
  })

  it('parks the Google button in a waiting-in-browser state with a live cancel path', () => {
    render(<AtumAuthView />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    act(() => $atumAccountStatus.set({ ...signedOut, state: 'signing_in' }))

    // The work is happening in the system browser, not in this window, so the
    // button says so instead of claiming a local spinner.
    const waiting = screen.getByRole('button', { name: 'Opening your browser…' })

    expect(waiting.hasAttribute('disabled')).toBe(true)
    expect(waiting.getAttribute('aria-busy')).toBe('true')

    // Cancel must stay reachable: the browser round trip is five minutes long.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelAtumSignIn).toHaveBeenCalledOnce()
  })

  it('returns to the idle Google affordance once a failed attempt settles', () => {
    const { rerender } = render(<AtumAuthView />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    act(() => $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode: 'authorization_timeout' }))
    rerender(<AtumAuthView />)

    expect(screen.getByRole('button', { name: 'Continue with Google' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('alert').textContent).toBe("Sign-in wasn't finished in your browser. Try again.")
  })

  it('shows a truthful progress label and a cancel affordance while signing in', () => {
    $atumAccountStatus.set({ ...signedOut, state: 'signing_in' })
    render(<AtumAuthView />)

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Signing in…' }).hasAttribute('disabled')).toBe(true)
  })

  it('cancels an in-flight sign-in on Escape and does nothing else', () => {
    $atumAccountStatus.set({ ...signedOut, state: 'signing_in' })
    const { container } = render(<AtumAuthView />)

    fireEvent.keyDown(container.firstChild!, { key: 'Escape' })
    expect(cancelAtumSignIn).toHaveBeenCalledOnce()
  })

  it('does not treat Escape as a dismissal when idle — the gate is not dismissable', () => {
    const { container } = render(<AtumAuthView />)

    fireEvent.keyDown(container.firstChild!, { key: 'Escape' })
    expect(cancelAtumSignIn).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
  })

  it.each([
    ['password_sign_in_rejected:400', 'Incorrect username or password.'],
    ['password_sign_in_timeout', "Can't connect. Check your network and try again."],
    [
      'account_storage_encrypt_failed',
      "Secure sign-in storage isn't available. Check your system's credential storage and try again."
    ],
    ['account_open_timeout', "Atum couldn't open your account safely on this device. Restart Atum and try again."],
    ['account_local_failure', "Atum couldn't complete sign-in on this device. Restart Atum and try again."],
    ['provider_not_configured', 'Sign-in is temporarily unavailable. Try again in a few minutes.'],
    // The native Google lane: a closed consent tab and a declined consent are
    // different stories, and neither of them is "check your network".
    ['authorization_timeout', "Sign-in wasn't finished in your browser. Try again."],
    ['authorization_browser_unavailable', "Sign-in wasn't finished in your browser. Try again."],
    ['authorization_callback_denied', 'Sign-in with Google was cancelled.']
  ])('maps %s to its own copy and focuses the alert after an attempt', (errorCode, expected) => {
    const { rerender } = render(<AtumAuthView />)

    // The copy above is written for a rejected attempt, so the test has to make
    // one. A failure that merely arrived at startup takes the quieter band
    // below — see the startup-notice suite.
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    act(() => $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode }))
    rerender(<AtumAuthView />)

    const alert = screen.getByRole('alert')

    expect(alert.textContent).toBe(expected)
    expect(globalThis.document.activeElement).toBe(alert)
    expect(alert.getAttribute('data-tone')).toBe('failure')
  })

  // A cold start can reach the gate already carrying a failure: the account
  // service was unreachable, or the stored credential had lapsed. Announcing
  // "Sign-in is temporarily unavailable. Try again in a few minutes." over a
  // form nobody has touched answers a question that was never asked, and blames
  // sign-in for something sign-in never ran.
  it.each([['hosted_session_timeout'], ['hosted_session_unavailable'], ['hosted_session_rejected:503']])(
    'reports %s found at startup as a condition, not a rejected attempt',
    errorCode => {
      $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode })
      render(<AtumAuthView />)

      const notice = screen.getByRole('status')

      expect(notice.textContent).toContain("Atum couldn't connect to verify your saved sign-in. Check your connection and retry.")
      expect(screen.getByRole('button', { name: 'Retry connection' })).toBeTruthy()
      expect(notice.getAttribute('data-tone')).toBe('notice')
      expect(screen.queryByRole('alert')).toBeNull()
    }
  )

  it('retries saved sign-in once without OAuth, and keeps failures actionable', async () => {
    $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode: 'hosted_session_unavailable' })
    let finish!: (success: boolean) => void
    vi.mocked(retryAtumAccountRestore).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<AtumAuthView />)
    const retry = screen.getByRole('button', { name: 'Retry connection' })
    retry.focus()
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(retryAtumAccountRestore).toHaveBeenCalledOnce()
    expect(signInToAtum).not.toHaveBeenCalled()
    expect(retry.getAttribute('aria-busy')).toBe('true')
    expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Continue with Google' }) as HTMLButtonElement).disabled).toBe(true)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    expect(retry.matches(':focus')).toBe(true)
    await act(async () => finish(false))
    expect((screen.getByRole('button', { name: 'Retry connection' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(false)
    expect(retry.matches(':focus')).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Still unable to verify your saved sign-in.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not offer startup retry when a failed switch leaves an account installed', () => {
    $atumAccountStatus.set({ ...signedOut, state: 'error', account: { id: 'active-account' }, errorCode: 'hosted_session_rejected:503' })
    render(<AtumAuthView />)
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
  })

  it.each(['provider_not_configured', 'account_storage_decrypt_failed', 'account_restore_rejected'])(
    'does not offer saved-session retry for %s', errorCode => {
      $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode })
      render(<AtumAuthView />)
      expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    }
  )

  it('leaves the caret in the form when the failure is not the user’s to answer for', () => {
    $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode: 'provider_not_configured' })
    render(<AtumAuthView />)

    // The identifier still gets mount focus; the band does not take it away.
    expect(globalThis.document.activeElement).toBe(screen.getByRole('textbox', { name: /Username/ }))
    expect(globalThis.document.activeElement).not.toBe(screen.getByRole('status'))
  })

  it('keeps device-class copy at startup — those read as conditions already', () => {
    $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode: 'account_storage_encrypt_failed' })
    render(<AtumAuthView />)

    expect(screen.getByRole('status').textContent).toBe(
      "Secure sign-in storage isn't available. Check your system's credential storage and try again."
    )
  })

  it('escalates to the loud band once the person actually tries', () => {
    $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode: 'provider_not_configured' })
    const { rerender } = render(<AtumAuthView />)

    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('notice')

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    act(() => $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode: 'provider_not_configured' }))
    rerender(<AtumAuthView />)

    const alert = screen.getByRole('alert')

    expect(alert.textContent).toBe('Sign-in is temporarily unavailable. Try again in a few minutes.')
    expect(alert.getAttribute('data-tone')).toBe('failure')
  })

  // The band is a contained Atum surface now. It used to be bare red text that
  // took the shell's generic focus pill — a hard square rectangle around red
  // type, because `border-radius: inherit` resolves to 0 on a <p>.
  it('is a contained band, not loose red text', () => {
    const { rerender } = render(<AtumAuthView />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    act(() => $atumAccountStatus.set({ ...signedOut, state: 'error', errorCode: 'invalid_credentials' }))
    rerender(<AtumAuthView />)

    const alert = screen.getByRole('alert')

    expect(alert.classList.contains('notice-band')).toBe(true)
    expect(alert.className).not.toContain('outline-none')
    expect(alert.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps Google available after main recovers an invalid account marker', () => {
    $atumAccountStatus.set({
      ...signedOut,
      state: 'error',
      errorCode: 'account_context_unavailable',
      configured: true,
      providers: { google: true, password: true }
    })
    render(<AtumAuthView />)

    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
  })

  it('switches to the expired story without losing the user work', () => {
    $atumAccountStatus.set({ ...signedOut, state: 'expired' })
    render(<AtumAuthView />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sign in again to continue')
    expect(screen.getByText('Your session expired. Your chats are still here.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })
})

// The gate is an OS-level surface, so it owns OS-level geometry while it is up.
// Before this contract, a 400px form sat inside a ~1220x800 transparent window
// that intercepted every click meant for the desktop behind it.
describe('AtumAuthView — window mode lifecycle', () => {
  it('asks for the compact auth window on mount', () => {
    render(<AtumAuthView />)

    expect(setMode).toHaveBeenCalledTimes(1)
    expect(setMode).toHaveBeenCalledWith('auth')
  })

  it('restores the normal window when the gate goes away (signed in / restored)', () => {
    const { unmount } = render(<AtumAuthView />)

    setMode.mockClear()
    unmount()

    expect(setMode).toHaveBeenCalledTimes(1)
    expect(setMode).toHaveBeenCalledWith('normal')
  })

  it.each(['signed_out', 'signing_in', 'expired', 'error'] as const)(
    'does not re-request the mode as the gate moves through %s',
    state => {
      const { rerender } = render(<AtumAuthView />)

      setMode.mockClear()
      $atumAccountStatus.set({ ...signedOut, state })
      rerender(<AtumAuthView />)

      expect(setMode).not.toHaveBeenCalled()
    }
  )

  it('renders (and signs in) normally when the window bridge is unavailable', () => {
    globalThis.window.hermesDesktop = undefined as never
    render(<AtumAuthView />)

    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
  })

  it('survives a rejected mode request without breaking the form', async () => {
    setMode.mockRejectedValueOnce(new Error('not-main-window'))
    render(<AtumAuthView />)

    await Promise.resolve()

    expect(screen.getByRole('textbox', { name: /Username/ })).toBeTruthy()
  })

  it('fills the compact window itself — no plate, no title band, no product title (mock 1c)', () => {
    const { container } = render(<AtumAuthView />)

    const window = container.querySelector('[data-atum-auth]')!

    // Atum Shell v2: the window ground is the surface. Nothing floats inside
    // it, and the old title band with the product name is gone.
    expect(window.className).toMatch(/h-dvh/u)
    expect(container.querySelector('.atum-auth-plate')).toBeNull()
    expect(container.querySelector('[data-atum-auth-lights]')).not.toBeNull()
    expect(container.textContent).not.toContain('Siêu ứng dụng')
    expect(container.querySelector('.atum-auth-contents')!.className).toMatch(/flex-1/u)
  })
})
