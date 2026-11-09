import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixLoginStartupBridge, MatrixLoginStartupStatus } from '../../shared/matrix-login-startup'

import { MatrixLoginStartupMention, MatrixLoginStartupSettings } from './login-startup-settings'

// macOS 13+ readings: a ServiceManagement status, so the Login Items pane exists.
const disabled: MatrixLoginStartupStatus = { state: 'disabled', wasOpenedAtLogin: false, loginItemsPane: true }
const enabled: MatrixLoginStartupStatus = { state: 'enabled', wasOpenedAtLogin: false, loginItemsPane: true }
const approval: MatrixLoginStartupStatus = { state: 'requires_approval', wasOpenedAtLogin: false, loginItemsPane: true }

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumLoginStartup')
})

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

function fixture(initial: MatrixLoginStartupStatus = disabled, locale: Locale = 'en') {
  let actual = initial
  const status = vi.fn(async () => actual)

  const setEnabled = vi.fn(async (value: boolean): Promise<MatrixLoginStartupStatus> => {
    actual = value ? enabled : disabled

    return actual
  })

  const openSettings = vi.fn(async () => {})
  const acknowledge = vi.fn(async () => {})
  const bridge: MatrixLoginStartupBridge = { status, setEnabled, openSettings, acknowledge }

  const view = render(
    <StrictMode>
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixLoginStartupSettings bridge={bridge} />
      </I18nProvider>
    </StrictMode>
  )

  return { status, setEnabled, openSettings, view, externalChange: (next: MatrixLoginStartupStatus) => (actual = next) }
}

const control = () => screen.getByRole('switch') as HTMLButtonElement

async function loaded() {
  await waitFor(() => expect(control().disabled).toBe(false))
}

it('reads actual OS state, labels its current-Mac scope and never enables on mount', async () => {
  const f = fixture()
  await loaded()
  expect(control().getAttribute('aria-checked')).toBe('false')
  expect(screen.getByText('So Atum can follow up on things while you work')).toBeTruthy()
  // One plain sentence: no listening or quitting jargon.
  expect(screen.queryByText(/Listening/)).toBeNull()
  expect(f.setEnabled).not.toHaveBeenCalled()
  fireEvent.click(control())
  await waitFor(() => expect(f.setEnabled).toHaveBeenCalledExactlyOnceWith(true))
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(control())
  await waitFor(() => expect(f.setEnabled).toHaveBeenLastCalledWith(false))
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('false'))
})

it('refreshes an externally removed OS registration when the app regains focus', async () => {
  const f = fixture(enabled)
  await loaded()
  expect(control().getAttribute('aria-checked')).toBe('true')
  f.externalChange(disabled)
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('false'))
  expect(f.setEnabled).not.toHaveBeenCalled()
})

it('serializes an explicit pending change and rolls back a silently ignored OS write', async () => {
  const f = fixture()
  await loaded()
  const pending = deferred<MatrixLoginStartupStatus>()
  f.setEnabled.mockReturnValueOnce(pending.promise)
  fireEvent.click(control())
  expect(control().disabled).toBe(true)
  expect(control().getAttribute('aria-checked')).toBe('true')
  fireEvent.click(control())
  fireEvent(window, new Event('focus'))
  expect(f.setEnabled).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(disabled))
  expect(control().getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('status').textContent).toContain('could not change')
  expect(control().disabled).toBe(false)
})

it('explains genuine OS approval as pending registration, not active startup, and allows removal', async () => {
  const f = fixture(approval)
  await loaded()
  expect(control().getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText(/Atum will not start at login yet/)).toBeTruthy()
  expect(
    control()
      .getAttribute('aria-describedby')
      ?.split(' ')
      .every(id => window.document.getElementById(id))
  ).toBe(true)
  expect(screen.getByText('So Atum can follow up on things while you work')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open Login Items' }))
  await waitFor(() => expect(f.openSettings).toHaveBeenCalledOnce())
  expect(f.setEnabled).not.toHaveBeenCalled()
  fireEvent.click(control())
  await waitFor(() => expect(f.setEnabled).toHaveBeenCalledExactlyOnceWith(false))
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('false'))
  expect(screen.queryByRole('button', { name: 'Open Login Items' })).toBeNull()
})

it('lets a never-registered Mac turn it on: the switch is live, with no Login Items detour', async () => {
  // The installed app reads macOS's first-run `not-found` as off (see loginStartupStatusFrom).
  const f = fixture(disabled, 'vi')
  await loaded()
  expect(screen.queryByText('Chưa đọc được thiết lập đăng nhập trên máy Mac này.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Mở Mục đăng nhập' })).toBeNull()
  fireEvent.click(control())
  await waitFor(() => expect(f.setEnabled).toHaveBeenCalledExactlyOnceWith(true))
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'))
})

it('offers Login Items when macOS refuses an explicit change, and never on a read-only row', async () => {
  const f = fixture()
  await loaded()
  f.setEnabled.mockResolvedValueOnce(disabled)
  fireEvent.click(control())
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('could not change'))
  fireEvent.click(screen.getByRole('button', { name: 'Open Login Items' }))
  await waitFor(() => expect(f.openSettings).toHaveBeenCalledOnce())
  f.view.unmount()
  fixture({ state: 'unavailable', reason: 'os_error' })
  await waitFor(() => expect(screen.getByText('Could not read the login setting on this Mac.')).toBeTruthy())
  expect(screen.queryByRole('button', { name: 'Open Login Items' })).toBeNull()
})

it('never offers the Login Items pane on a macOS that has none (no ServiceManagement status)', async () => {
  // macOS 12: the reading has no status, so there is no Login Items pane to open.
  const f = fixture({ state: 'disabled', wasOpenedAtLogin: false })
  await loaded()
  f.setEnabled.mockResolvedValueOnce({ state: 'disabled', wasOpenedAtLogin: false })
  fireEvent.click(control())
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('could not change'))
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Open Login Items' })).toBeNull()
  expect(f.openSettings).not.toHaveBeenCalled()
})

it('accepts the authoritative OS reread when a native write reply is lost', async () => {
  const f = fixture()
  await loaded()
  f.setEnabled.mockImplementationOnce(async () => {
    f.externalChange(enabled)
    throw new Error('matrix_login_startup_failed')
  })
  fireEvent.click(control())
  await waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'))
  expect(screen.queryByRole('status')).toBeNull()
  expect(control().getAttribute('aria-checked')).toBe('true')
  expect(control().disabled).toBe(false)
})

it('contains OS read failures and offers an explicit read retry without mutating startup', async () => {
  const f = fixture({ state: 'unavailable', reason: 'os_error' })
  await waitFor(() => expect(screen.getByText('Could not read the login setting on this Mac.')).toBeTruthy())
  expect(control().disabled).toBe(true)
  f.externalChange(disabled)
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  await loaded()
  expect(f.setEnabled).not.toHaveBeenCalled()
})

it('does not paint an OS read exception as a disabled login item', async () => {
  const f = fixture(enabled)
  await loaded()
  f.status.mockRejectedValueOnce(new Error('native status unavailable'))
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('could not change'))
  expect(control().getAttribute('aria-checked')).toBe('true')
  expect(f.setEnabled).not.toHaveBeenCalled()
})

it('ignores an old external read that completes after a confirmed explicit write', async () => {
  const f = fixture()
  await loaded()
  const stale = deferred<MatrixLoginStartupStatus>()
  f.status.mockReturnValueOnce(stale.promise)
  fireEvent(window, new Event('focus'))
  fireEvent.click(control())
  await waitFor(() => expect(f.setEnabled).toHaveBeenCalledExactlyOnceWith(true))
  await act(async () => stale.resolve(disabled))
  expect(control().getAttribute('aria-checked')).toBe('true')
  expect(control().disabled).toBe(false)
})

it('does not publish a late native result after Settings unmounts', async () => {
  const f = fixture()
  await loaded()
  const late = deferred<MatrixLoginStartupStatus>()
  f.setEnabled.mockReturnValueOnce(late.promise)
  fireEvent.click(control())
  f.view.unmount()
  await act(async () => late.resolve(enabled))
  expect(screen.queryByRole('switch')).toBeNull()
})

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
  'has localized opt-in, device scope and OS approval presentation in %s',
  async locale => {
    fixture(approval, locale)
    await loaded()
    expect(control().getAttribute('aria-label')).toBeTruthy()
    // "Check again" and "Open Login Items", both named in the locale.
    expect(screen.getAllByRole('button', { name: /.+/ })).toHaveLength(2)
    expect(screen.getByText(/macOS/)).toBeTruthy()
  }
)

it('keeps an absent native bridge read-only without a shell error', async () => {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixLoginStartupSettings />
    </I18nProvider>
  )
  await waitFor(() => expect(screen.getByText('Could not read the login setting on this Mac.')).toBeTruthy())
  expect(control().disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
})

/** The window's one line after Atum turned open at login on by itself. */
function mention(status: MatrixLoginStartupStatus, locale: Locale = 'en') {
  const bridge: MatrixLoginStartupBridge = {
    status: vi.fn(async () => status),
    setEnabled: vi.fn(),
    openSettings: vi.fn(),
    acknowledge: vi.fn(async () => {})
  }

  const view = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixLoginStartupMention bridge={bridge} />
    </I18nProvider>
  )

  return { bridge, view }
}

it('says once, in the person’s language, that Atum turned open at login on, until they acknowledge it', async () => {
  const f = mention({ ...enabled, announce: true }, 'vi')
  const line = await screen.findByRole('status')
  expect(line.textContent).toContain(
    'Giờ Atum sẽ tự mở khi bạn đăng nhập vào máy Mac này. Bạn có thể tắt trong Cài đặt.'
  )

  fireEvent.click(screen.getByRole('button', { name: 'Đã hiểu' }))
  expect(f.bridge.acknowledge).toHaveBeenCalledOnce()
  expect(screen.queryByRole('status')).toBeNull()
})

it.each([
  ['nothing to announce', enabled],
  ['turned off meanwhile', disabled],
  ['waiting for macOS approval', approval],
  ['not a packaged Mac', { state: 'unavailable', reason: 'development' } as MatrixLoginStartupStatus]
])('says nothing when there is %s', async (_case, status) => {
  const f = mention(status)
  await waitFor(() => expect(f.bridge.status).toHaveBeenCalled())
  await act(async () => {})
  expect(f.view.container.querySelector('[data-matrix-login-startup-mention]')).toBeNull()
})
