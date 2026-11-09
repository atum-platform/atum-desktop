import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { atumSignedInIdentityFixture } from '@/lib/atum-account-facts'
import { $atumAccountStatus } from '@/store/atum-messaging'

import type { UtilityResult, UtilityStatus } from '../../../../shared/atum-utilities'

import { UtilityConnectionCard } from './connection-card'
import { $utilities, refreshUtilities } from './store'

let sequence = 0
let status: UtilityStatus
beforeEach(() => {
  const id = `utility-user-${++sequence}`
  status = { accountId: id, generation: 1, sources: [], available: { google: true, 'apple-calendar': true } }
  $utilities.set({ status: null, loading: true, busy: false, error: null })
  window.hermesDesktop = {
    ...window.hermesDesktop,
    utilities: {
      status: vi.fn(async () => ({ status })),
      connect: vi.fn(async () => ({ status })),
      disconnect: vi.fn(async () => ({ status })),
      cancel: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => ({ status }))
    }
  }
  $atumAccountStatus.set(atumSignedInIdentityFixture(id).status)
})
afterEach(cleanup)

function connectedSources() {
  return (['email', 'calendar', 'drive'] as const).map(kind => ({
    id: kind,
    kind,
    provider: 'google' as const,
    accountKey: 'google-a',
    label: kind === 'calendar' ? 'Personal' : 'first@example.com',
    detail: 'first@example.com',
    state: 'connected' as const,
    enabled: true
  }))
}

it('shows three branded pills on first use and hides when all services connect', async () => {
  const { container } = render(<UtilityConnectionCard />)
  const email = await screen.findByRole('button', { name: 'Connect email' })
  const calendar = screen.getByRole('button', { name: 'Connect calendar' })
  const drive = screen.getByRole('button', { name: 'Connect Drive' })
  expect(email.querySelectorAll('img')).toHaveLength(1)
  expect(calendar.querySelectorAll('img')).toHaveLength(2)
  expect(drive.querySelectorAll('img')).toHaveLength(1)
  expect(screen.queryByText('Connect your email and calendar')).toBeNull()
  expect(screen.queryByRole('button', { name: /skip|later|dismiss|icloud/i })).toBeNull()
  expect(screen.getByRole('region', { name: 'Connections' }).className).not.toContain('bg-')
  status = { ...status, sources: connectedSources().filter(source => source.kind !== 'drive') }
  await refreshUtilities()
  expect(screen.getByRole('button', { name: 'Connect Drive' })).toBeTruthy()
  status = { ...status, sources: connectedSources() }
  await refreshUtilities()
  await waitFor(() => expect(container.querySelector('[data-slot="utility-connection-card"]')).toBeNull())
  status = { ...status, sources: status.sources.map(source => ({ ...source, state: 'reconnect' })) }
  await refreshUtilities()
  expect(await screen.findByRole('button', { name: 'Connect email' })).toBeTruthy()
})

it('connects and reconnects Drive through its disclosed consent action', async () => {
  const submit = vi.fn(event => event.preventDefault())
  status.sources = [
    {
      id: 'drive-only',
      kind: 'drive',
      provider: 'google',
      accountKey: 'drive-account',
      label: 'drive@example.com',
      state: 'reconnect',
      enabled: true
    }
  ]
  render(
    <form onSubmit={submit}>
      <UtilityConnectionCard manage />
    </form>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Add Drive account' }))
  expect(window.hermesDesktop.utilities!.connect).not.toHaveBeenCalled()
  expect(screen.getByText(/Drive can be searched and supported files can be read/u)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() =>
    expect(window.hermesDesktop.utilities!.connect).toHaveBeenCalledWith({ provider: 'google', service: 'drive' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect · Drive' }))
  expect(window.hermesDesktop.utilities!.connect).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(window.hermesDesktop.utilities!.connect).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: 'Disconnect drive@example.com' })).toBeTruthy()
  expect(submit).not.toHaveBeenCalled()
})

it('requires a service-specific disclosure before Google OAuth and offers both calendar providers', async () => {
  const submit = vi.fn(event => event.preventDefault())
  render(
    <form onSubmit={submit}>
      <UtilityConnectionCard />
    </form>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Connect email' }))
  expect(window.hermesDesktop.utilities!.connect).not.toHaveBeenCalled()
  expect(screen.getByText(/Gmail can be read and sent after you confirm each send/u)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toBe(
    'https://www.atumplatform.com/privacy'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(window.hermesDesktop.utilities!.connect).toHaveBeenCalledWith({ provider: 'google' })
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect calendar' }))
  expect(screen.getByRole('button', { name: 'Google — Gmail and Calendar' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Calendar on this Mac' })).toBeTruthy()
})

it('cancels a disclosure without starting OAuth', async () => {
  render(<UtilityConnectionCard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Drive' }))
  expect(window.hermesDesktop.utilities!.connect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(window.hermesDesktop.utilities!.connect).not.toHaveBeenCalled()
  expect(window.hermesDesktop.utilities!.cancel).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
})

it('manages multiple accounts and toggles individual sources with account-scoped disconnect', async () => {
  status.sources = [
    ...connectedSources(),
    {
      id: 'work',
      kind: 'calendar',
      provider: 'google',
      accountKey: 'google-b',
      detail: 'work@example.com',
      label: 'Work',
      state: 'connected',
      enabled: false
    }
  ]
  render(<UtilityConnectionCard manage />)
  const personal = await screen.findByRole('checkbox', { name: 'Personal' })
  expect((personal as HTMLInputElement).checked).toBe(true)
  fireEvent.click(personal)
  await waitFor(() =>
    expect(window.hermesDesktop.utilities!.setEnabled).toHaveBeenCalledWith([{ id: 'calendar', enabled: false }])
  )
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect work@example.com' }))
  expect(window.hermesDesktop.utilities!.disconnect).toHaveBeenCalledWith({
    provider: 'google',
    accountKey: 'google-b'
  })
  expect(screen.getByRole('button', { name: 'Add Google account' })).toBeTruthy()
})

it('discards a late prior-account result and preserves keyboard ownership in Settings', async () => {
  status.sources = connectedSources()
  const keydown = vi.fn()
  render(
    <div onKeyDown={keydown}>
      <UtilityConnectionCard manage />
    </div>
  )
  const checkbox = await screen.findByRole('checkbox', { name: 'Personal' })
  fireEvent.keyDown(checkbox, { key: 'Enter' })
  expect(keydown).not.toHaveBeenCalled()
  fireEvent.keyDown(checkbox, { key: 'Escape' })
  expect(keydown).toHaveBeenCalled()
  let finish!: (result: UtilityResult) => void
  vi.mocked(window.hermesDesktop.utilities!.status).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const pending = refreshUtilities()
  const previous = status
  status = { ...status, accountId: 'new-user', sources: [] }
  $atumAccountStatus.set(atumSignedInIdentityFixture('new-user').status)
  finish({ status: previous })
  await pending
  await waitFor(() => expect(screen.queryByText(/first@example.com/)).toBeNull())
})

it('keeps empty Mac connections manageable and exposes changed calendar selection', async () => {
  status = { ...status, appleConnected: true, calendarSelectionRequired: true }
  render(<UtilityConnectionCard manage />)
  await act(() => refreshUtilities())
  expect(await screen.findByRole('button', { name: 'Disconnect Calendar on this Mac' })).toBeTruthy()
  expect(screen.getByText('No calendars are available on this Mac yet.')).toBeTruthy()
  expect(screen.getByText('The calendar list changed. Choose which calendars to use in Settings.')).toBeTruthy()
})
