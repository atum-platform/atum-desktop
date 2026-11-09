import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { MatrixNotificationSettings } from './display-settings'
import { MatrixNotificationPolicySettings } from './notification-policy-settings'

const identity = { userId: '@alice:test', deviceId: 'ONE' }

function snapshot(
  notifications = true,
  sound = true,
  current = identity,
  state: MatrixSnapshot['state'] = 'ready'
): MatrixSnapshot {
  return {
    state,
    identity: current,
    error: null,
    rooms: [],
    roomId: null,
    messages: [],
    displayPreferences: {
      appearance: { value: 'system', writable: true },
      textSize: { value: 100, writable: true },
      notifications: { value: notifications, writable: true },
      sound: { value: sound, writable: true }
    },
    notificationPolicy: {
      version: 1,
      accountLevel: 'mentions',
      quietHours: { enabled: false, startMinute: 1_320, endMinute: 420, timeZone: 'Asia/Ho_Chi_Minh' },
      channelOverrides: {},
      threadOverrides: {},
      writable: true
    }
  }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function fixture() {
  const command = vi.fn(async () => null)
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  const view = (s: MatrixSnapshot) => (
    <StrictMode>
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixNotificationSettings snapshot={s} />
        <MatrixNotificationPolicySettings snapshot={s} />
      </I18nProvider>
    </StrictMode>
  )

  const rendered = render(view(snapshot()))

  return { command, update: (s: MatrixSnapshot) => rendered.rerender(view(s)) }
}

it('uses independent glass switches and sync confirmation instead of optimistic changes or localStorage', async () => {
  const f = fixture()
  const notifications = screen.getByRole('switch', { name: 'Notifications' }) as HTMLButtonElement
  const sound = screen.getByRole('switch', { name: 'Sounds' }) as HTMLButtonElement
  fireEvent.click(notifications)
  await waitFor(() =>
    expect(f.command).toHaveBeenCalledExactlyOnceWith({
      kind: 'displayPreference',
      identity,
      field: 'notifications',
      value: false
    })
  )
  expect(notifications.getAttribute('aria-checked')).toBe('true')
  expect(notifications.disabled).toBe(true)
  expect(sound.disabled).toBe(false)
  f.update(snapshot(false))
  await waitFor(() => expect(notifications.disabled).toBe(false))
  expect(notifications.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(sound)
  await waitFor(() =>
    expect(f.command).toHaveBeenLastCalledWith({ kind: 'displayPreference', identity, field: 'sound', value: false })
  )
  f.update(snapshot(false, false))
  await waitFor(() => expect(sound.disabled).toBe(false))
  expect(sound.getAttribute('aria-checked')).toBe('false')
})

it('offers retry on failed save, refuses offline writes and never paints a late failure onto the next identity', async () => {
  const f = fixture()
  f.command.mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(screen.getByRole('switch', { name: 'Sounds' }))
  expect(await screen.findByText('Could not save this setting. Try again.')).toBeTruthy()
  let reject!: (error: Error) => void
  f.command.mockImplementationOnce(() => new Promise((_resolve, fail) => (reject = fail)))
  fireEvent.click(screen.getByRole('switch', { name: 'Sounds' }))
  f.update(snapshot(true, true, { ...identity, userId: '@bob:test' }))
  await act(async () => reject(new Error('late')))
  expect(screen.queryByText('Could not save this setting. Try again.')).toBeNull()
  f.update(snapshot(true, true, identity, 'offline'))
  const control = screen.getByRole('switch', { name: 'Notifications' }) as HTMLButtonElement
  expect(control.disabled).toBe(true)
  fireEvent.click(control)
  expect(f.command).toHaveBeenCalledTimes(2)
})

it('saves portable quiet hours with their IANA time zone and reveals the daily window after sync', async () => {
  const f = fixture()
  const quiet = screen.getByRole('switch', { name: 'Quiet hours' })
  fireEvent.click(quiet)
  await waitFor(() => expect(f.command).toHaveBeenLastCalledWith({
    kind: 'notificationPolicy',
    identity,
    scope: 'quietHours',
    quietHours: { enabled: true, startMinute: 1_320, endMinute: 420, timeZone: 'Asia/Ho_Chi_Minh' }
  }))

  const next = snapshot()
  next.notificationPolicy!.quietHours.enabled = true
  f.update(next)
  expect(screen.getByLabelText('From')).toHaveProperty('value', '22:00')
  expect(screen.getByLabelText('Until')).toHaveProperty('value', '07:00')
  expect(screen.getByRole('combobox', { name: 'Time zone' }).textContent).toContain('Asia/Ho_Chi_Minh')
  expect(screen.getByRole('combobox', { name: 'Team space messages' }).textContent).toContain('Mentions & replies')
})
