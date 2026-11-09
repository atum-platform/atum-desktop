// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixIdentity } from '../../shared/matrix'
import type {
  MatrixGoogleConnectionBridge,
  MatrixGoogleConnectionError,
  MatrixGoogleConnectionResult,
  MatrixGoogleConnectionStatus
} from '../../shared/matrix-google-connections'
import type { MatrixGoogleAssistantAccess } from '../../shared/matrix-google-tools'

import {
  MatrixGoogleConnectionSettings,
  MatrixGoogleConnectNudge,
  MatrixGoogleDisclosure,
  resetMatrixGoogleNudgeDismissals
} from './google-connection-settings'

const firstIdentity: MatrixIdentity = { userId: '@one:atum.test', deviceId: 'ONE' }
const secondIdentity: MatrixIdentity = { userId: '@two:atum.test', deviceId: 'TWO' }

const connected = (overrides: Partial<MatrixGoogleConnectionStatus> = {}): MatrixGoogleConnectionStatus => ({
  available: true,
  sources: [
    {
      id: 'mail-1',
      groupId: 'group-one',
      provider: 'google',
      kind: 'email',
      label: 'minh@example.com',
      state: 'connected',
      enabled: true,
      writable: true
    },
    {
      id: 'calendar-1',
      groupId: 'group-one',
      provider: 'google',
      kind: 'calendar',
      label: 'Work',
      primary: true,
      state: 'connected',
      enabled: true
    },
    {
      id: 'drive-1',
      groupId: 'group-one',
      provider: 'google',
      kind: 'drive',
      label: 'minh@example.com',
      state: 'connected',
      enabled: true
    },
    {
      id: 'drive-2',
      groupId: 'group-two',
      provider: 'google',
      kind: 'drive',
      label: 'work@example.com',
      state: 'reconnect',
      enabled: false
    }
  ],
  ...overrides
})

function result(
  status: MatrixGoogleConnectionStatus | null,
  error?: MatrixGoogleConnectionError
): MatrixGoogleConnectionResult {
  if (error) {
    return { status: null, error }
  }

  return { status: status as MatrixGoogleConnectionStatus }
}

function bridge(
  status = connected()
): MatrixGoogleConnectionBridge &
  Record<'status' | 'connect' | 'disconnect' | 'setSourcePreferences', ReturnType<typeof vi.fn>> {
  return {
    status: vi.fn().mockResolvedValue(result(status)),
    connect: vi.fn().mockResolvedValue(result(status)),
    disconnect: vi.fn().mockResolvedValue(result(connected({ sources: [] }))),
    setSourcePreferences: vi.fn().mockResolvedValue(result(status))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, reject, resolve }
}

function renderSettings(
  options: {
    active?: boolean
    bridge?: MatrixGoogleConnectionBridge
    identity?: MatrixIdentity
    locale?: Locale
    assistant?: MatrixGoogleAssistantAccess
  } = {}
) {
  const currentBridge = Object.hasOwn(options, 'bridge') ? options.bridge : bridge()
  const locale = options.locale ?? 'en'

  const content = (next: { active: boolean; bridge?: MatrixGoogleConnectionBridge; identity: MatrixIdentity }) => (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixGoogleConnectionSettings assistant={options.assistant} {...next} />
    </I18nProvider>
  )

  const view = render(
    content({ active: options.active ?? true, bridge: currentBridge, identity: options.identity ?? firstIdentity })
  )

  return {
    ...view,
    bridge: currentBridge,
    update: (next: { active: boolean; bridge?: MatrixGoogleConnectionBridge; identity: MatrixIdentity }) =>
      view.rerender(content(next))
  }
}

afterEach(() => {
  cleanup()
  resetMatrixGoogleNudgeDismissals()
})

describe('MatrixGoogleDisclosure', () => {
  it.each([
    ['en', 'Connect Google', 'If Google warns you, choose Advanced → Continue.'],
    ['vi', 'Kết nối Google', 'Nếu Google cảnh báo, chọn Nâng cao → Tiếp tục.'],
    ['zh', '连接 Google', '如果 Google 发出警告，请选择“高级”→“继续”。'],
    ['zh-hant', '連接 Google', '如果 Google 顯示警告，請選擇「進階」→「繼續」。'],
    ['ja', 'Google に接続', 'Google の警告が出たら、「詳細」→「続行」を選んでください。']
  ] as const)('shows one direct action and one warning line in %s', (locale, action, warning) => {
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixGoogleDisclosure busy={false} onContinue={vi.fn()} />
      </I18nProvider>
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: action })).toBeTruthy()
    expect(screen.getByText(warning)).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('MatrixGoogleConnectNudge', () => {
  it('starts Google directly from one enabled action', async () => {
    const google = bridge(connected({ sources: [] }))
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixGoogleConnectNudge access={{ state: 'connect' }} bridge={google} />
      </I18nProvider>
    )

    const button = screen.getByRole('button', { name: 'Connect Google' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(google.connect).toHaveBeenCalledExactlyOnceWith('google'))
  })

  it.each([
    ['vi', 'Kết nối Google', 'Nếu Google cảnh báo, chọn Nâng cao → Tiếp tục.'],
    ['en', 'Connect Google', 'If Google warns you, choose Advanced → Continue.']
  ] as const)('keeps the %s nudge to one action with its warning in a tooltip', async (locale, connect, warning) => {
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixGoogleConnectNudge access={{ state: 'connect' }} bridge={bridge()} />
      </I18nProvider>
    )

    const action = screen.getByRole('button', { name: connect })
    expect(action).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByText(warning)).toBeNull()
    fireEvent.pointerMove(action, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toContain(warning)
  })

  it('dismisses without starting Google and disappears immediately after a connection', async () => {
    const google = bridge(connected({ sources: [] }))
    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixGoogleConnectNudge access={{ state: 'connect' }} bridge={google} scope="dismissed" />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(view.container.querySelector('[data-matrix-google-nudge]')).toBeNull()
    expect(google.connect).not.toHaveBeenCalled()

    cleanup()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixGoogleConnectNudge access={{ state: 'connect' }} bridge={google} scope="dismissed" />
      </I18nProvider>
    )
    expect(screen.queryByRole('button', { name: 'Connect Google' })).toBeNull()

    cleanup()
    google.connect.mockResolvedValueOnce(result(connected()))
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixGoogleConnectNudge access={{ state: 'connect' }} bridge={google} scope="connected" />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Connect Google' })).toBeNull())
  })

  it.each([undefined, { state: 'ready' as const }, { state: 'unavailable' as const }])(
    'stays out of the way when Google is not connectable (%j)',
    access => {
      const { container } = render(
        <I18nProvider configClient={null} initialLocale="en">
          <MatrixGoogleConnectNudge access={access} bridge={bridge()} />
        </I18nProvider>
      )

      expect(screen.queryByRole('button', { name: /Connect Google/ })).toBeNull()
      expect(screen.queryAllByRole('img')).toHaveLength(0)
      expect(container.querySelector('[data-matrix-google-nudge]')).toBeNull()
    }
  )
})

describe('MatrixGoogleConnectionSettings', () => {
  it('offers one enabled Connect Google that opens OAuth directly', async () => {
    const google = bridge(connected({ sources: [] }))
    renderSettings({ bridge: google, assistant: { state: 'connect' } })

    await screen.findByRole('button', { name: 'Connect Google' })
    expect(screen.queryByText('Connect Google for calendar, email and files.')).toBeNull()
    expect(screen.getByText('If Google warns you, choose Advanced → Continue.')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Connect Google' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(google.connect).toHaveBeenCalledWith('google'))
    expect(google.connect).toHaveBeenCalledTimes(1)
  })

  it('names each account, renders its sources, reports reconnect, and offers only what was not shared', async () => {
    const google = bridge()
    renderSettings({
      bridge: google,
      assistant: { state: 'ready', services: { gmail: true, send: true, calendar: true, drive: true } }
    })

    expect(await screen.findByText('Your assistant uses shared Google data with approval.')).toBeTruthy()
    expect(screen.getAllByTestId('matrix-google-group')).toHaveLength(2)
    expect(screen.getByText('This connection needs to be connected again.')).toBeTruthy()

    const [first, second] = screen.getAllByTestId('matrix-google-group')
    expect(first.textContent).toContain('minh@example.com')
    expect(first.querySelector('[data-matrix-google-missing]')).toBeNull()
    // Gmail, Calendar, Drive, in the order the consent names them; a named calendar keeps its name.
    expect([...first.querySelectorAll('label')].map(row => row.textContent)).toEqual([
      'Gmail',
      'CalendarWork',
      'Google Drive'
    ])
    // The second account shared only Drive: the rest is offered quietly, never asked for.
    expect(second.textContent).toContain('Not shared: Gmail, Calendar')

    fireEvent.click(screen.getByRole('switch', { name: 'Gmail: minh@example.com' }))
    await waitFor(() => expect(google.setSourcePreferences).toHaveBeenCalledWith([{ id: 'mail-1', enabled: false }]))

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(google.connect).toHaveBeenCalledWith('google'))
    expect(screen.getByRole('button', { name: /Add another Google account|Waiting for Google…/ })).toBeTruthy()
  })

  it.each([
    [{ state: 'unavailable', reason: 'own_model' }, 'Google needs Atum’s AI, not your current model.'],
    [{ state: 'paused', reason: 'route' }, 'Waiting for Atum’s Google AI.'],
    [{ state: 'paused', reason: 'own_model' }, 'Switch to Atum’s AI to use Google.']
  ] as const)('says what the assistant can do: %o', async (assistant, line) => {
    renderSettings({ bridge: bridge(), assistant })

    expect(await screen.findByText(line)).toBeTruthy()
  })

  it('keeps Google discoverable when the assistant cannot use it and keeps accounts manageable', async () => {
    renderSettings({ bridge: bridge(connected({ sources: [] })), assistant: { state: 'unavailable', reason: 'route' } })
    expect(await screen.findByText('Google works when Atum’s Google AI is ready.')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-google-connections]')).not.toBeNull()

    cleanup()
    renderSettings({ bridge: bridge(), assistant: { state: 'unavailable', reason: 'route' } })
    expect(await screen.findByText('Google works when Atum’s Google AI is ready.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Disconnect' }).length).toBeGreaterThan(0)
    // Nothing to offer: connecting would not help the assistant yet.
    expect(screen.queryByRole('button', { name: /Connect Google|Add another Google account|Allow/ })).toBeNull()

    // On a model the person brought, Google can't be used either: say why, offer nothing.
    cleanup()
    renderSettings({
      bridge: bridge(connected({ sources: [] })),
      assistant: { state: 'unavailable', reason: 'own_model' }
    })
    expect(await screen.findByText('Google needs Atum’s AI, not your current model.')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-google-connections]')).not.toBeNull()
  })

  it('asks before disconnecting an exact connection group', async () => {
    const google = bridge()
    renderSettings({ bridge: google })
    await screen.findAllByTestId('matrix-google-group')
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0])
    expect(screen.getByText('Disconnect this Google account?')).toBeTruthy()
    expect(google.disconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1)!)
    await waitFor(() => expect(google.disconnect).toHaveBeenCalledWith('group-one'))
  })

  it('invalidates old identity reads and hides safely while inactive', async () => {
    const oldRead = deferred<MatrixGoogleConnectionResult>()
    const google = bridge()
    google.status.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(
      result(
        connected({
          sources: [
            {
              id: 'fresh',
              groupId: 'new',
              provider: 'google',
              kind: 'drive',
              label: 'Fresh Drive',
              state: 'connected',
              enabled: true
            }
          ]
        })
      )
    )
    const view = renderSettings({ bridge: google, identity: firstIdentity })
    view.update({ active: true, bridge: google, identity: secondIdentity })
    expect(await screen.findByText('Fresh Drive')).toBeTruthy()
    await act(async () =>
      oldRead.resolve(
        result(
          connected({
            sources: [
              {
                id: 'old',
                groupId: 'old',
                provider: 'google',
                kind: 'email',
                label: 'Old Gmail',
                state: 'connected',
                enabled: true
              }
            ]
          })
        )
      )
    )
    expect(screen.queryByText('Old Gmail')).toBeNull()

    view.update({ active: false, bridge: google, identity: secondIdentity })
    expect(screen.queryByTestId('matrix-google-connections')).toBeNull()
  })

  it('does not publish an old request failure after its bridge is replaced', async () => {
    const oldRead = deferred<MatrixGoogleConnectionResult>()
    const oldBridge = bridge()
    oldBridge.status.mockReturnValueOnce(oldRead.promise)
    const freshBridge = bridge(
      connected({
        sources: [
          {
            id: 'new',
            groupId: 'new',
            provider: 'google',
            kind: 'drive',
            label: 'Current Drive',
            state: 'connected',
            enabled: true
          }
        ]
      })
    )
    const view = renderSettings({ bridge: oldBridge })
    view.update({ active: true, bridge: freshBridge, identity: firstIdentity })
    expect(await screen.findByText('Current Drive')).toBeTruthy()
    await act(async () => oldRead.reject(new Error('old private failure')))
    expect(screen.getByText('Current Drive')).toBeTruthy()
    expect(screen.queryByText(/Couldn’t check Google connections/)).toBeNull()
  })

  it('shows loading, unavailable configuration, and safe failures', async () => {
    const pending = deferred<MatrixGoogleConnectionResult>()
    const google = bridge()
    google.status.mockReturnValueOnce(pending.promise)
    renderSettings({ bridge: google })
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeTruthy()
    await act(async () => pending.resolve({ status: null, error: 'unavailable' }))
    // Not configured in this build: the integration remains findable and says why.
    expect(await screen.findByText('Google connections are not available in this build.')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-google-connections]')).not.toBeNull()

    cleanup()
    const failing = bridge()
    failing.status.mockRejectedValueOnce(new Error('private auth detail'))
    renderSettings({ bridge: failing })
    expect(await screen.findByText(/Couldn’t check Google connections/)).toBeTruthy()
    expect(screen.queryByText(/private auth detail/)).toBeNull()
  })

  it.each(['busy', 'fence'] as const)(
    'keeps a current identity’s groups and recovers through Refresh after %s',
    async error => {
      const google = bridge()
      google.status
        .mockResolvedValueOnce(result(connected()))
        .mockResolvedValueOnce(result(null, error))
        .mockResolvedValueOnce(
          result(
            connected({
              sources: [
                {
                  id: 'recovered',
                  groupId: 'recovered',
                  provider: 'google',
                  kind: 'drive',
                  label: 'Recovered Drive',
                  state: 'connected',
                  enabled: true
                }
              ]
            })
          )
        )
      renderSettings({ bridge: google })
      await screen.findAllByTestId('matrix-google-group')

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      expect(await screen.findByText('Couldn’t update this Google connection. Try again.')).toBeTruthy()
      expect(screen.getAllByTestId('matrix-google-group')).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      expect(await screen.findByText('Recovered Drive')).toBeTruthy()
    }
  )

  it.each(['cancelled', 'denied'] as const)('keeps connected groups after %s consent', async error => {
    const google = bridge()
    google.connect.mockResolvedValueOnce(result(null, error))
    renderSettings({ bridge: google })
    await screen.findAllByTestId('matrix-google-group')

    fireEvent.click(screen.getByRole('button', { name: 'Add another Google account' }))
    expect(await screen.findByText('Couldn’t update this Google connection. Try again.')).toBeTruthy()
    expect(screen.getAllByTestId('matrix-google-group')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Add another Google account' })).toBeTruthy()
  })

  it('rolls back an optimistic source preference when the bridge returns an error result', async () => {
    const pendingPreference = deferred<MatrixGoogleConnectionResult>()
    const google = bridge()
    google.setSourcePreferences.mockReturnValueOnce(pendingPreference.promise)
    renderSettings({ bridge: google })
    const source = () => screen.getByRole('switch', { name: 'Gmail: minh@example.com' })
    await screen.findByRole('switch', { name: 'Gmail: minh@example.com' })
    expect(source().getAttribute('aria-checked')).toBe('true')

    fireEvent.click(source())
    await waitFor(() => expect(google.setSourcePreferences).toHaveBeenCalledWith([{ id: 'mail-1', enabled: false }]))
    expect(source().getAttribute('aria-checked')).toBe('false')
    await act(async () => pendingPreference.resolve(result(null, 'network')))

    expect(await screen.findByText('Couldn’t update this Google connection. Try again.')).toBeTruthy()
    expect(source().getAttribute('aria-checked')).toBe('true')
  })

  it('turns a failed read into one quiet row whose Refresh reads again', async () => {
    const google = bridge()
    google.status.mockRejectedValueOnce(new Error('private detail'))
    renderSettings({ bridge: google })
    expect(await screen.findByText(/Couldn’t check Google connections/)).toBeTruthy()
    // One action, in the row that says what went wrong.
    expect(screen.getAllByRole('button', { name: 'Refresh' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('minh@example.com')).toBeTruthy()
    expect(screen.queryByText(/Couldn’t check Google connections/)).toBeNull()
    expect(google.status).toHaveBeenCalledTimes(2)
  })

  it('names each Google account by its address, and numbers one only when it has none', async () => {
    renderSettings({
      bridge: bridge(
        connected({
          sources: [
            {
              id: 'mail',
              groupId: 'one',
              provider: 'google',
              kind: 'email',
              label: 'one@gmail.test',
              state: 'connected',
              enabled: true
            },
            {
              id: 'cal',
              groupId: 'two',
              provider: 'google',
              kind: 'calendar',
              label: 'Team calendar',
              state: 'connected',
              enabled: true
            }
          ]
        })
      )
    })
    const groups = await screen.findAllByTestId('matrix-google-group')
    expect(groups[0]!.textContent).toContain('one@gmail.test')
    expect(groups[1]!.textContent).toContain('Google account 2')
    // What each account shares is a switch named by the source, never a raw checkbox.
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Calendar: Team calendar' })).toBeTruthy()
  })

  it('uses localized copy when a disconnect IPC call rejects', async () => {
    const google = bridge()
    google.disconnect.mockRejectedValueOnce(new Error('Error invoking remote method matrix:google-connections:request'))
    renderSettings({ bridge: google })
    await screen.findAllByTestId('matrix-google-group')

    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1)!)

    await waitFor(() =>
      expect(screen.getAllByText('Couldn’t update this Google connection. Try again.')).toHaveLength(2)
    )
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
  })

  it.each(['en', 'vi', 'zh', 'zh-hant', 'ja'] as const)(
    'renders the localized settings and warning in %s',
    async locale => {
      renderSettings({ bridge: bridge(connected({ sources: [] })), locale, assistant: { state: 'connect' } })
      await screen.findByRole('heading')
      expect(window.document.querySelector('[data-matrix-google-warning]')?.textContent).toMatch(/\S/)
    }
  )

  it('tells Vietnamese speakers how to pass Google’s warning in their language', async () => {
    renderSettings({ bridge: bridge(connected({ sources: [] })), locale: 'vi', assistant: { state: 'connect' } })
    expect(await screen.findByText('Nếu Google cảnh báo, chọn Nâng cao → Tiếp tục.')).toBeTruthy()
  })
})

describe('account-wide Google authority', () => {
  it('shows remote ready with an empty Mac vault even for an unavailable assistant', async () => {
    renderSettings({ bridge: bridge({ available: true, sources: [], accountState: 'ready' }), assistant: { state: 'unavailable', reason: 'not_configured' } })
    expect(await screen.findByText('Connected to your Atum account')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect Google' })).toBeNull()
  })
  it('names the connected Google account in one short line, in every language', async () => {
    const expected = {
      en: 'Connected as owner@example.com',
      vi: 'Đã kết nối với owner@example.com',
      zh: '已连接为 owner@example.com',
      'zh-hant': '已連接為 owner@example.com',
      ja: 'owner@example.com として接続済み'
    } as const

    for (const [locale, line] of Object.entries(expected)) {
      const view = renderSettings({
        bridge: bridge({ available: true, sources: [], accountState: 'ready', accountEmail: 'owner@example.com' }),
        locale: locale as Locale
      })

      expect(await screen.findByText(line)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Connect Google|連接 Google|连接 Google|Google に接続|Kết nối Google/ })).toBeNull()
      view.unmount()
    }
  })
  it('keeps the old line for a connection made before the account was pinned', async () => {
    renderSettings({ bridge: bridge({ available: true, sources: [], accountState: 'ready' }) })
    expect(await screen.findByText('Connected to your Atum account')).toBeTruthy()
    expect(screen.queryByText(/isn.t the one connected/)).toBeNull()
  })
  it('says a different Google account was refused in one short line and adds no screen or button', async () => {
    const expected = {
      en: 'This Google account isn’t the one connected to Atum.',
      vi: 'Đây không phải tài khoản Google đã kết nối với Atum.',
      zh: '这不是已连接到 Atum 的 Google 帐号。',
      'zh-hant': '這不是已連接到 Atum 的 Google 帳號。',
      ja: 'この Google アカウントは Atum に接続されているものではありません。'
    } as const

    for (const [locale, line] of Object.entries(expected)) {
      const view = renderSettings({
        bridge: bridge({
          available: true,
          sources: [],
          accountState: 'ready',
          accountEmail: 'owner@example.com',
          accountNotice: 'google_account_mismatch'
        }),
        locale: locale as Locale
      })

      const notice = await screen.findByText(line)
      expect(notice.textContent?.length).toBeLessThan(80)
      expect(notice.getAttribute('role')).toBe('status')
      expect(window.document.querySelectorAll('[role="dialog"]').length).toBe(0)
      view.unmount()
    }
  })
  it('shows no refusal when none is reported', async () => {
    renderSettings({ bridge: bridge({ available: true, sources: [], accountState: 'ready', accountEmail: 'owner@example.com' }) })
    await screen.findByText('Connected as owner@example.com')
    expect(screen.queryByText(/isn.t the one connected/)).toBeNull()
  })
  it('offers Connect for a confirmed disconnected account independently of assistant access', async () => {
    renderSettings({ bridge: bridge({ available: true, sources: [], accountState: 'disconnected' }), assistant: { state: 'unavailable', reason: 'not_configured' } })
    expect(await screen.findByRole('button', { name: 'Connect Google' })).toBeTruthy()
  })
  it('does not offer Connect from a stale disconnected snapshot after Refresh fails', async () => {
    const current = bridge({ available: true, sources: [], accountState: 'disconnected' })
    renderSettings({ bridge: current })
    await screen.findByRole('button', { name: 'Connect Google' })
    current.status.mockResolvedValue({ status: null, error: 'network' })
    fireEvent(window, new Event('focus'))
    await screen.findByText('Couldn’t check Google connections. Try Refresh.')
    expect(screen.queryByRole('button', { name: 'Connect Google' })).toBeNull()
  })
})
