import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import QRCode from 'qrcode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { ELEMENT_X_DOWNLOAD, MatrixMobileSetup, mobileServer } from './mobile-setup'
import { bindMatrixHandleOwner, rememberMatrixHandle, resetMatrixHandlesForTest } from './person-handles'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }))

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@minh:identities.test', deviceId: 'DESKTOP' },
  homeserver: 'https://chat.example.test',
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

const qrImage = 'data:image/png;base64,ZmFrZQ=='
let bridge: Pick<MatrixUiBridge, 'openLink' | 'endDeviceSession'>
const clipboard = vi.fn(async (_value: string) => {})

beforeEach(() => {
  vi.mocked(QRCode.toDataURL)
    .mockReset()
    .mockImplementation(() => Promise.resolve(qrImage))
  clipboard.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } })
  bridge = { openLink: vi.fn(async () => {}), endDeviceSession: vi.fn(async () => {}) }
  // No sign-in, crypto, account creation or execution APIs: this journey cannot need them.
  window.atumMatrix = bridge as MatrixUiBridge
})
afterEach(() => {
  cleanup()
  resetMatrixHandlesForTest()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function fixture(value = snapshot, locale: Locale = 'en') {
  const onOpenChange = vi.fn()

  const view = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixMobileSetup onOpenChange={onOpenChange} open snapshot={value} />
    </I18nProvider>
  )

  return { view, onOpenChange }
}

describe('phone setup', () => {
  it('names the account by its @handle only, and leaves the line out without one', () => {
    fixture({ ...snapshot, identity: { userId: '@user-3f2a9c0d1e2b4a5f6c7d8e9f0a1b2c3d:identities.test', deviceId: 'D' } })
    expect(screen.queryByText(/Your account/)).toBeNull()
    expect(screen.queryByText(/user-3f2a/)).toBeNull()
  })

  it('takes two steps from the configured server, not the MXID domain, and only encodes the public download URL', async () => {
    bindMatrixHandleOwner(snapshot.identity!.userId)
    rememberMatrixHandle(snapshot.identity!.userId, 'minh')
    fixture()
    expect((await screen.findByRole('img', { name: 'Scan to download Element X' })).getAttribute('src')).toBe(qrImage)
    expect(QRCode.toDataURL).toHaveBeenCalledExactlyOnceWith(ELEMENT_X_DOWNLOAD, expect.objectContaining({ margin: 4 }))
    expect(screen.getByRole('heading', { name: '1. Get Element X' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '2. Sign in with your Atum account' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^3\./ })).toBeNull()
    expect(screen.getByText(snapshot.homeserver!)).toBeTruthy()
    // The raw ID never shows; the handle waits under More help.
    expect(screen.queryByText(snapshot.identity!.userId)).toBeNull()
    expect(screen.getByText('Your account: @minh')).toBeTruthy()
    expect(screen.getByText(/never signs you in/)).toBeTruthy()
    // Phone setup manages no sessions.
    expect(screen.queryByRole('button', { name: 'Manage account sessions' })).toBeNull()
    expect(bridge.openLink).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open download page' }))
    await waitFor(() => expect(bridge.openLink).toHaveBeenCalledExactlyOnceWith(ELEMENT_X_DOWNLOAD))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Copy server' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy server' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(snapshot.homeserver)
    expect(bridge.endDeviceSession).not.toHaveBeenCalled()
  })

  it('focuses the sheet itself, never the title, and Tab reaches Close first', async () => {
    fixture()
    await screen.findByRole('img')
    const sheet = screen.getByRole('dialog', { name: 'Use on phone' })
    expect(window.document.activeElement).toBe(sheet)

    // jsdom has no Tab: the first tabbable control in document order is where Tab lands.
    const tabbable = sheet.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )

    expect(tabbable).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('keeps usable download instructions when QR generation or an explicit action fails', async () => {
    vi.mocked(QRCode.toDataURL).mockRejectedValue(Error('canvas unavailable'))
    vi.mocked(bridge.openLink).mockRejectedValueOnce(Error('browser unavailable'))
    fixture()
    expect(await screen.findByText(/QR could not load/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open download page' }))
    expect((await screen.findByRole('alert')).textContent).toContain('That action did not complete')
    fireEvent.click(screen.getByRole('button', { name: 'Open download page' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(bridge.openLink).toHaveBeenCalledTimes(2)
  })

  it('never claims the server was copied on clipboard denial', async () => {
    clipboard.mockRejectedValue(Error('denied'))
    fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Copy server' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('replaces server-specific state without copying the previous server after a config change', async () => {
    const { view, onOpenChange } = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Copy server' }))
    await screen.findByRole('button', { name: 'Copied' })
    const nextServer = 'https://next.example.test:8448/matrix'
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixMobileSetup onOpenChange={onOpenChange} open snapshot={{ ...snapshot, homeserver: nextServer }} />
      </I18nProvider>
    )
    await screen.findByRole('img')
    expect(screen.queryByText(snapshot.homeserver!)).toBeNull()
    expect(screen.getByText(nextServer)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy server' }))
    await screen.findByRole('button', { name: 'Copied' })
    expect(clipboard).toHaveBeenLastCalledWith(nextServer)
  })

  it.each([undefined, 'https://user:password@chat.test', 'https://chat.test/?token=secret'])(
    'does not guess missing/unsafe server %s',
    async homeserver => {
      fixture({ ...snapshot, homeserver })
      expect(await screen.findByText(/has not provided its account server/)).toBeTruthy()
      await screen.findByRole('img')
      expect(screen.queryByRole('button', { name: 'Copy server' })).toBeNull()
      expect(screen.queryByText(homeserver ?? 'undefined')).toBeNull()
    }
  )

  it.each([
    'http://localhost:21880',
    'http://127.0.0.1:21880',
    'http://[::1]:21880',
    'http://0.0.0.0:21880',
    'https://matrix-proof.localhost',
    'https://localhost.'
  ])('explains why a phone cannot use %s', async homeserver => {
    fixture({ ...snapshot, homeserver })
    await screen.findByRole('img')
    expect(screen.getByText(/phone cannot connect/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy server' })).toBeNull()
  })

  it('discards an unfinished QR after the sheet unmounts', async () => {
    let resolve!: (value: string) => void
    vi.mocked(QRCode.toDataURL).mockImplementation(
      () =>
        new Promise<string>(done => {
          resolve = done
        })
    )
    const { view } = fixture()
    view.unmount()
    await act(async () => resolve(qrImage))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(bridge.openLink).not.toHaveBeenCalled()
  })

  it.each([
    ['vi', 'Dùng trên điện thoại'],
    ['ja', 'スマートフォンで使う'],
    ['zh', '在手机上使用'],
    ['zh-hant', '在手機上使用']
  ] as const)('has complete %s copy and an accessible dismiss action', async (locale, title) => {
    const { onOpenChange } = fixture(snapshot, locale)
    expect(screen.getByRole('dialog', { name: title })).toBeTruthy()
    await screen.findByRole('img')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('rejects non-web URLs and preserves an explicitly configured server prefix', () => {
    expect(mobileServer('javascript:alert(1)')).toBeNull()
    expect(mobileServer('http://insecure.test')).toBeNull()
    expect(mobileServer('::1')).toBeNull() // A hostname is not a configured web URL.
    expect(mobileServer('https://chat.test/prefix/')).toEqual({ url: 'https://chat.test/prefix', localOnly: false })
    expect(mobileServer(' https://chat.test:8448/prefix/ ')).toEqual({
      url: 'https://chat.test:8448/prefix',
      localOnly: false
    })
  })
})
