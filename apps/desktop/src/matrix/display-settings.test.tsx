import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { MatrixDisplaySettings, MatrixNotificationSettings } from './display-settings'

const identity = { userId: '@alice:test', deviceId: 'ONE' }

const snapshot = (overrides: Partial<MatrixSnapshot> = {}): MatrixSnapshot => ({
  state: 'ready',
  identity,
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  displayPreferences: { appearance: { value: 'system', writable: true }, textSize: { value: 100, writable: true } },
  ...overrides
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void

  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

function fixture(initial = snapshot()) {
  const command = vi.fn(async () => null)
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  const view = (value: MatrixSnapshot) => (
    <StrictMode>
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixDisplaySettings snapshot={value} />
      </I18nProvider>
    </StrictMode>
  )

  const rendered = render(view(initial))

  return {
    command,
    renderSnapshot: (value: MatrixSnapshot) => rendered.rerender(view(value)),
    unmount: rendered.unmount
  }
}

const dark = () => screen.getByRole('radio', { name: 'Dark' }) as HTMLButtonElement
const size = () => screen.getByRole('radio', { name: 'Large' }) as HTMLButtonElement
const sizeTo = (label: 'Small' | 'Default' | 'Large') => fireEvent.click(screen.getByRole('radio', { name: label }))

it('uses the glass controls and current identity; HTTP acknowledgement alone never changes the confirmed choice', async () => {
  const f = fixture()
  fireEvent.click(dark())
  await waitFor(() =>
    expect(f.command).toHaveBeenCalledWith({ kind: 'displayPreference', identity, field: 'appearance', value: 'dark' })
  )
  expect(dark().getAttribute('aria-checked')).toBe('false')
  expect(dark().disabled).toBe(true)
  expect(size().disabled).toBe(false)
  f.renderSnapshot(
    snapshot({
      displayPreferences: { appearance: { value: 'dark', writable: true }, textSize: { value: 100, writable: true } }
    })
  )
  await waitFor(() => expect(dark().disabled).toBe(false))
  expect(dark().getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByText('Waiting for your setting to sync.')).toBeNull()
})

it('handles a sync echo before the HTTP acknowledgement without an early success or duplicate write', async () => {
  const f = fixture(),
    pending = deferred()

  f.command.mockImplementationOnce(() => pending.promise as never)
  fireEvent.click(dark())
  fireEvent.click(dark())
  expect(f.command).toHaveBeenCalledOnce()
  f.renderSnapshot(
    snapshot({
      displayPreferences: { appearance: { value: 'dark', writable: true }, textSize: { value: 100, writable: true } }
    })
  )
  expect(dark().disabled).toBe(true)
  await act(async () => pending.resolve())
  expect(dark().disabled).toBe(false)
})

it('shows a retryable failed save under StrictMode without presenting optimistic data', async () => {
  const f = fixture()
  f.command.mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(dark())
  expect(await screen.findByText('Could not save this setting. Try again.')).toBeTruthy()
  expect(dark().disabled).toBe(false)
  expect(dark().getAttribute('aria-checked')).toBe('false')
  fireEvent.click(dark())
  await waitFor(() => expect(f.command).toHaveBeenCalledTimes(2))
})

it('reports absent sync after a bounded wait and allows a real retry rather than pretending success', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await act(async () => fireEvent.click(dark()))
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(screen.getByText('Waiting for your setting to sync.')).toBeTruthy()
  expect(dark().disabled).toBe(false)
  expect(dark().getAttribute('aria-checked')).toBe('false')
  await act(async () => fireEvent.click(dark()))
  expect(f.command).toHaveBeenCalledTimes(2)
})

it('fences a late old-account failure and resets pending controls for a new human', async () => {
  const f = fixture(),
    pending = deferred()

  f.command.mockImplementationOnce(() => pending.promise as never)
  fireEvent.click(dark())
  const next = { userId: '@bob:test', deviceId: 'TWO' }
  f.renderSnapshot(snapshot({ identity: next }))
  await act(async () => pending.reject(new Error('late account')))
  expect(screen.queryByText('Could not save this setting. Try again.')).toBeNull()
  expect(dark().disabled).toBe(false)
  sizeTo('Large')
  await waitFor(() =>
    expect(f.command).toHaveBeenLastCalledWith({
      kind: 'displayPreference',
      identity: next,
      field: 'textSize',
      value: 110
    })
  )
})

it('keeps future-format fields read-only without disabling another supported field', async () => {
  const f = fixture(
    snapshot({
      displayPreferences: { appearance: { value: 'dark', writable: false }, textSize: { value: 100, writable: true } }
    })
  )

  expect(dark().disabled).toBe(true)
  expect(screen.getByText('This setting needs a newer Atum version.')).toBeTruthy()
  fireEvent.click(dark())
  expect(f.command).not.toHaveBeenCalled()
  sizeTo('Small')
  await waitFor(() =>
    expect(f.command).toHaveBeenCalledWith({ kind: 'displayPreference', identity, field: 'textSize', value: 90 })
  )
})

it('does not send while connecting/offline or when signed out', () => {
  const f = fixture(snapshot({ state: 'connecting' }))
  fireEvent.click(dark())
  sizeTo('Large')
  expect(f.command).not.toHaveBeenCalled()
  f.renderSnapshot(snapshot({ identity: null }))
  expect(screen.queryByRole('radiogroup')).toBeNull()
})

it('forgets an in-flight result and timer when the settings sheet unmounts', async () => {
  const f = fixture(),
    pending = deferred()

  f.command.mockImplementationOnce(() => pending.promise as never)
  fireEvent.click(dark())
  f.unmount()
  await act(async () => pending.resolve())
  expect(screen.queryByRole('status')).toBeNull()
})

it('offers text size as three named sizes, the current one chosen', () => {
  fixture(
    snapshot({
      displayPreferences: { appearance: { value: 'system', writable: true }, textSize: { value: 110, writable: true } }
    })
  )
  const sizes = screen.getByRole('radiogroup', { name: 'Text size' })
  expect([...sizes.querySelectorAll('[role="radio"]')].map(radio => radio.textContent)).toEqual([
    'Small',
    'Default',
    'Large'
  ])
  expect(size().getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByRole('slider')).toBeNull()
  expect(
    [...screen.getByRole('radiogroup', { name: 'Appearance' }).querySelectorAll('[role="radio"]')].map(
      radio => radio.textContent
    )
  ).toEqual(['Automatic', 'Light', 'Dark'])
})

it('says the settings cannot load, with Try again, instead of controls that look on but do nothing', async () => {
  const retry = vi.fn(async () => {})
  const f = fixture(snapshot({ displayPreferences: undefined }))
  window.atumMatrix = { ...window.atumMatrix, retry } as unknown as MatrixUiBridge
  expect(screen.getByText('Can’t load these settings right now.')).toBeTruthy()
  expect(screen.queryByRole('radiogroup')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(retry).toHaveBeenCalledOnce()
  expect(f.command).not.toHaveBeenCalled()
})

it('has no model-picker visibility switch because the composer chip is always present', () => {
  fixture()
  expect(screen.queryByRole('switch', { name: /model choice|lựa chọn mô hình/iu })).toBeNull()
})

it('uses the board notification and sound copy', () => {
  window.atumMatrix = { command: vi.fn(async () => null) } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixNotificationSettings
        snapshot={
          snapshot({
            displayPreferences: {
              appearance: { value: 'system', writable: true },
              textSize: { value: 100, writable: true },
              notifications: { value: true, writable: true },
              sound: { value: true, writable: true }
            }
          })
        }
      />
    </I18nProvider>
  )

  expect(screen.getByText('Messages, and when Atum finishes something or needs you')).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'Notifications' })).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'Sounds' })).toBeTruthy()
})
