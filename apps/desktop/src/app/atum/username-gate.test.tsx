import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'

vi.mock('@/store/atum-messaging', async () => {
  const { atom } = await import('nanostores')

  const $atumAccountStatus = atom<AtumAccountStatus>({
    state: 'signed_in',
    configured: true,
    account: { id: 'account-1', displayName: 'Nguyễn An Anh', handle: 'binh-sen-4821', handleCustomized: false },
    errorCode: null,
    providers: { google: true, password: true }
  })

  return {
    $atumAccountStatus,
    refreshAtumAccountStatus: vi.fn(async () => {
      const current = $atumAccountStatus.get()
      $atumAccountStatus.set({ ...current, account: { ...current.account!, handle: 'nguyen-an-anh', handleCustomized: true } })

      return $atumAccountStatus.get()
    })
  }
})

const { $atumAccountStatus, refreshAtumAccountStatus } = await import('@/store/atum-messaging')
const { AtumUsernameGate } = await import('./username-gate')

const handleAvailability = vi.fn(async () => ({ available: true, reason: null, retryAfterSeconds: null }))
const renameHandle = vi.fn(async (handle: string) => ({ id: 'account-1', displayName: 'Nguyễn An Anh', handle, handleCustomized: true }))

const signedIn = (): AtumAccountStatus => ({
  state: 'signed_in',
  configured: true,
  account: { id: 'account-1', displayName: 'Nguyễn An Anh', handle: 'binh-sen-4821', handleCustomized: false },
  errorCode: null,
  providers: { google: true, password: true }
})

beforeEach(() => {
  window.localStorage.clear()
  handleAvailability.mockClear()
  renameHandle.mockClear()
  vi.mocked(refreshAtumAccountStatus).mockClear()
  $atumAccountStatus.set(signedIn())
  Object.assign(window, { hermesDesktop: { ...window.hermesDesktop, messaging: { handleAvailability, renameHandle } } })
})

afterEach(cleanup)

describe('AtumUsernameGate', () => {
  it('opens once the plane says the username was never chosen, prefilled from the name', async () => {
    render(<AtumUsernameGate />)

    expect(screen.getByRole('dialog', { name: 'Choose your username' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Username' }) as HTMLInputElement).value).toBe('nguyen-an-anh')
    await waitFor(() => expect(handleAvailability).toHaveBeenCalledWith('nguyen-an-anh'))
  })

  it('does not open when the plane did not say, or when the username is already chosen', () => {
    $atumAccountStatus.set({ ...signedIn(), account: { id: 'account-1', displayName: 'A', handle: 'a-b-1' } })
    const { unmount } = render(<AtumUsernameGate />)
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()

    $atumAccountStatus.set({ ...signedIn(), account: { id: 'account-1', displayName: 'A', handle: 'a-b-1', handleCustomized: true } })
    render(<AtumUsernameGate />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('claims the username and closes on the plane-refreshed identity', async () => {
    render(<AtumUsernameGate />)

    await waitFor(() => expect(screen.getByText('This name is available.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Use this username' }))

    await waitFor(() => expect(renameHandle).toHaveBeenCalledWith('nguyen-an-anh'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect($atumAccountStatus.get().account?.handleCustomized).toBe(true)
  })

  it('keeps the placeholder on request and remembers that for this account only', () => {
    const { unmount } = render(<AtumUsernameGate />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep @binh-sen-4821 for now' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(renameHandle).not.toHaveBeenCalled()
    unmount()

    render(<AtumUsernameGate />)
    expect(screen.queryByRole('dialog')).toBeNull()

    $atumAccountStatus.set({ ...signedIn(), account: { ...signedIn().account!, id: 'account-2' } })
    cleanup()
    render(<AtumUsernameGate />)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('cannot be dismissed by Escape — keeping the placeholder is the only way out', () => {
    render(<AtumUsernameGate />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
