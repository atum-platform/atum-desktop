import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { AppDescriptor } from '../../../shared/app-catalog'
import { ACME, ACME_GUEST, botApp } from '../../../shared/app-catalog.test-support'
import type { MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixAppConnectionState } from '../../../shared/matrix-apps'

import { AppBotSetupCard } from './setup-card'

const moon = (disclosureVersion: number, hasHistory = false): AppDescriptor => ({
  app: 'moon', app_id: 'moon-id', app_version_id: 'moon-v1', name: { en: 'Moon' },
  subtitle: null, description: null, icon: null, accent: null, affiliation: 'first_party',
  verified: true, availability: 'available', roster_default: true, roster_order: 1,
  supported_modes: ['direct'], has_surface: true, has_history: hasHistory,
  link: { mode: 'external_account', state: 'never_linked' },
  bot: {
    v: 1, user_id: '@app-moon:atumplatform.com', handle: 'moon_bot', display_name: 'Moon',
    avatar: { url: 'data:image/png;base64,aA==', sha256: 'a'.repeat(64) }, device_generation: 1,
    device: { device_id: 'BOT', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) }, state: 'active',
    groups: true, consent: 'required', disclosure_version: disclosureVersion, open_route_id: 'chat',
    open_shared_memory: true, purchase_route_id: 'chat'
  }
})

const demoza = (): AppDescriptor => {
  const base = moon(1)

  return {
    ...base,
    app: 'demoza',
    app_id: 'demoza-id',
    app_version_id: 'demoza-v1',
    name: { en: 'Demoza' },
    link: { mode: 'external_account', state: 'never_linked' },
    bot: {
      ...base.bot!,
      user_id: '@app-demoza:atumplatform.com',
      handle: 'demoza_bot',
      display_name: 'Demoza',
      groups: false,
      open_shared_memory: false,
      guest_enabled: true,
      direct_profile: 'atum.turn-memory/2'
    }
  }
}

const snapshot = { state: 'ready', rooms: [] } as unknown as MatrixSnapshot

const status = (disclosureVersion: number, state = 'required') => ({
  profile: 'atum.app-bot-status/1',
  consent: { state, disclosure_version: disclosureVersion },
  link: { state: 'never_linked', ready: false, available: true }
})

const botStatus = vi.fn()
const botConsent = vi.fn()
const connection = vi.fn()
const refresh = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { atumMatrix: { apps: { botStatus, botConsent, connection, refresh } } })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const card = (app: AppDescriptor, locale: Locale = 'en', current = snapshot) => (
  <I18nProvider configClient={null} initialLocale={locale}>
    <AppBotSetupCard app={app} snapshot={current} />
  </I18nProvider>
)

/** What each language calls the two things the start dialog offers. */
const words = {
  en: { start: 'Start chat', more: 'Learn more', close: 'Close' },
  vi: { start: 'Bắt đầu', more: 'Tìm hiểu thêm', close: 'Đóng' },
  ja: { start: 'チャットを開始', more: '詳しく見る', close: '閉じる' },
  zh: { start: '开始聊天', more: '了解更多', close: '关闭' },
  'zh-hant': { start: '開始聊天', more: '瞭解更多', close: '關閉' }
} as const

/** The full terms the sheet shows. It is portalled out of the card, so it is read from the window.document. */
const points = () => [...window.document.querySelectorAll('[data-app-bot-disclosure] li')].map(item => item.textContent ?? '')

/** Opens Learn more and says what the sheet holds; closes it again so the dialog is reachable. */
async function readTerms(locale: Locale = 'en') {
  fireEvent.click(await screen.findByRole('button', { name: words[locale].more }))
  const sheet = await screen.findByRole('dialog')
  const items = [...sheet.querySelectorAll('li')].map(item => item.textContent ?? '')

  return {
    sheet,
    items,
    close: () => {
      const close = words[locale].close
      fireEvent.click(screen.getAllByRole('button', { name: close }).find(button => button.textContent === close)!)
    }
  }
}

it('records consent to the disclosure version it showed', async () => {
  botStatus.mockResolvedValue(status(1))
  botConsent.mockResolvedValue(status(1, 'accepted'))
  render(card(moon(1)))
  fireEvent.click(await screen.findByRole('button', { name: 'Start chat' }))
  await waitFor(() => expect(botConsent).toHaveBeenCalledExactlyOnceWith('moon-id', 1, 'en'))
})

// Preserve user-visible identity, state and recovery behavior across connection changes.
// button; the full terms are one tap away and nowhere else. Said for an app the client has no code for.
describe('the start dialog', () => {
  const dialogLine = () => window.document.querySelector('[data-app-bot-start-line]')?.textContent

  it.each([
    ['linked-only', () => botApp(ACME), () => status(1)],
    [
      'guest',
      () => botApp(ACME_GUEST),
      () => ({
        profile: 'atum.app-bot-status/1',
        consent: { state: 'required', disclosure_version: 1 },
        link: { state: 'never_linked', ready: false, available: true },
        guest: { enabled: true, state: 'start_required' }
      })
    ]
  ] as const)('asks a %s app with one short line and one button, never a wall of text', async (_kind, app, current) => {
    botStatus.mockResolvedValue(current())
    const view = render(card(app()))

    const start = await screen.findByRole('button', { name: 'Start chat' })
    const dialog = screen.getByRole('dialog', { name: 'Acme' })

    expect(dialog.getAttribute('aria-modal')).toBe('false')
    expect(dialogLine()).toBe('Chat with Acme right here in Atum.')
    expect(dialog.querySelector('[data-app-catalog-avatar]')).toBeTruthy()
    // The primary action, and a tiny Learn more: nothing else to press, nothing to read.
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['Start chat', 'Learn more'])
    expect(start.hasAttribute('disabled')).toBe(false)
    expect(view.container.querySelectorAll('li')).toHaveLength(0)
    expect(window.document.querySelectorAll('li')).toHaveLength(0)
    expect(dialog.textContent).not.toMatch(/runs on|servers|Protons|Settings|I agree|Connect/u)
    expect(dialog.textContent!.length).toBeLessThan(80)
    expect(botConsent).not.toHaveBeenCalled()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('says it with one line in %s, naming the app and no other', async locale => {
    botStatus.mockResolvedValue(status(1))
    render(card(botApp(ACME), locale))

    await screen.findByRole('button', { name: words[locale].start })
    const line = dialogLine()!

    expect(line).toContain('Acme')
    expect(line).not.toMatch(/Moon|Andy|Exa/u)
    expect(line.length).toBeLessThan(40)
    expect(screen.getByRole('button', { name: words[locale].more })).toBeTruthy()
  })

  it('records the consent once, whatever the second tap', async () => {
    let finish = (_value: unknown) => {}
    botStatus.mockResolvedValue(status(1))
    botConsent.mockReturnValue(new Promise(resolve => { finish = resolve }))
    connection.mockResolvedValue(undefined)
    render(card(botApp(ACME)))

    const start = await screen.findByRole('button', { name: 'Start chat' })
    fireEvent.click(start)
    fireEvent.click(start)
    await act(async () => finish(status(1, 'accepted')))

    expect(botConsent).toHaveBeenCalledExactlyOnceWith(ACME.appId, 1, 'en')
  })

  it('opens the full terms only on Learn more, and goes back to the one button when they are closed', async () => {
    botStatus.mockResolvedValue(status(1))
    render(card(botApp(ACME)))

    await screen.findByRole('button', { name: 'Start chat' })
    expect(points()).toEqual([])

    const terms = await readTerms()
    expect(terms.items.join(' ')).toContain('Acme runs on Atum')
    expect(points().join(' ')).toContain('Acme chats one-on-one only.')
    // This Radix reader portals to the window scope, where its own material and
    // ink already come from the same root palette rather than the branded chat.
    expect(terms.sheet.closest('[data-atum-chat]')).toBeNull()
    // Reading is not agreeing.
    expect(botConsent).not.toHaveBeenCalled()

    terms.close()
    await waitFor(() => expect(points()).toEqual([]))
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeTruthy()
    expect(botConsent).not.toHaveBeenCalled()
  })

  // The dock only reaches the foot of the chat column; the dialog goes to the middle of what is above it.
  it('is drawn in the middle of the chat panel, not in the composer dock that mounts it', async () => {
    botStatus.mockResolvedValue(status(1))

    const view = render(
      <div data-atum-chat data-testid="panel">
        <div data-testid="dock">
          <I18nProvider configClient={null} initialLocale="en">
            <AppBotSetupCard app={botApp(ACME)} snapshot={snapshot} />
          </I18nProvider>
        </div>
      </div>
    )

    const dialog = await screen.findByRole('dialog', { name: 'Acme' })
    const centre = dialog.closest('[data-app-start-center]')

    expect(centre?.parentElement).toBe(view.getByTestId('panel'))
    expect(view.getByTestId('dock').contains(dialog)).toBe(false)
    // Centred over everything above the composer, and out of the way of the rest of the panel.
    expect(centre?.className).toMatch(/pointer-events-none/u)
    expect(centre?.className).toMatch(/place-items-center/u)
    expect(centre?.className).toMatch(/bottom-\[var\(--atum-dock-height/u)
    expect(dialog.className).toMatch(/pointer-events-auto/u)
  })
})

describe('guest-first setup', () => {
  const guestStatus = (
    state: 'start_required' | 'ready' | 'linked' | 'unavailable',
    consent: 'accepted' | 'required' | 'revoked' = state === 'start_required' ? 'required' : 'accepted'
  ) => ({
    profile: 'atum.app-bot-status/1',
    consent: { state: consent, disclosure_version: 1 },
    link: {
      state: state === 'linked' ? 'linked' : 'never_linked',
      ready: state === 'linked',
      available: true
    },
    guest: { enabled: true, state }
  })

  it('starts guest chat without opening account connection and keeps connection optional', async () => {
    const onReadyChange = vi.fn()
    botStatus.mockResolvedValueOnce(guestStatus('start_required')).mockResolvedValueOnce(guestStatus('ready'))
    botConsent.mockResolvedValue(guestStatus('ready'))
    refresh.mockResolvedValue(undefined)

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <AppBotSetupCard app={demoza()} onReadyChange={onReadyChange} snapshot={snapshot} />
      </I18nProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Start chat' }))

    await waitFor(() => expect(botConsent).toHaveBeenCalledExactlyOnceWith('demoza-id', 1, 'en'))
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true))
    expect(connection).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Connect account' })).toBeTruthy()
  })

  it('opens the existing account-link flow only after the optional Connect tap', async () => {
    botStatus.mockResolvedValue(guestStatus('ready'))
    connection.mockResolvedValue(undefined)

    render(card(demoza()))

    fireEvent.click(await screen.findByRole('button', { name: 'Connect account' }))
    await waitFor(() => expect(connection).toHaveBeenCalledExactlyOnceWith('demoza-id', 'begin', { autoConfirm: true }))
    expect(botConsent).not.toHaveBeenCalled()
  })
})

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
  'keeps the contained Moon terms behind Learn more, and sends the exact %s locale',
  async locale => {
    botStatus.mockResolvedValue(status(3))
    botConsent.mockResolvedValue(status(3, 'accepted'))
    connection.mockResolvedValue(undefined)
    const view = render(card(moon(3, true), locale))

    await screen.findByRole('button', { name: words[locale].start })
    // Moon's one line is the same short line as any app's; its terms are not on the page.
    expect(window.document.querySelector('[data-app-bot-start-line]')?.textContent).toContain('Moon')
    expect(view.container.querySelectorAll('li')).toHaveLength(0)

    const terms = await readTerms(locale)
    expect(terms.sheet.querySelectorAll('[data-app-bot-terms] li')).toHaveLength(7)
    // The contained reader's own sentence about what Moon receives leads the terms.
    expect(terms.sheet.textContent).toContain('Moon')
    terms.close()
    fireEvent.click(screen.getByRole('button', { name: words[locale].start }))

    await waitFor(() => expect(botConsent).toHaveBeenCalledExactlyOnceWith('moon-id', 3, locale))
  }
)

describe('the first read of the bot status', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is tried again by itself after a platform hiccup, so nobody has to tap Try again', async () => {
    vi.useFakeTimers()
    botStatus.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('503')).mockResolvedValue(status(1))
    render(card(moon(1)))
    await act(async () => {})
    expect(botStatus).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Setup could not be completed.')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(botStatus).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Setup could not be completed.')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(botStatus).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeTruthy()
    expect(screen.queryByText('Setup could not be completed.')).toBeNull()
  })

  it('says so, with Try again, once the looks run out', async () => {
    vi.useFakeTimers()
    botStatus.mockRejectedValue(new Error('offline'))
    render(card(moon(1)))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 10_000)
    })
    expect(botStatus).toHaveBeenCalledTimes(4)
    expect(screen.getByText('Setup could not be completed.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('stops looking when the card goes away', async () => {
    vi.useFakeTimers()
    botStatus.mockRejectedValue(new Error('offline'))
    const view = render(card(moon(1)))
    await act(async () => {})
    view.unmount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(botStatus).toHaveBeenCalledTimes(1)
  })
})

it('shows linked-account history terms and records the history disclosure version', async () => {
  botStatus.mockResolvedValue(status(2))
  botConsent.mockResolvedValue(status(2, 'accepted'))
  render(card(moon(2, true)))
  await screen.findByRole('button', { name: 'Start chat' })
  // Not on the page until asked for.
  expect(screen.queryByText(/loads earlier private messages from your linked Moon account/i)).toBeNull()

  const terms = await readTerms()
  expect(terms.items).toHaveLength(7)
  expect(await screen.findByText(/loads earlier private messages from your linked Moon account/i)).toBeTruthy()
  terms.close()
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
  await waitFor(() => expect(botConsent).toHaveBeenCalledExactlyOnceWith('moon-id', 2, 'en'))
})

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
  'keeps the linked-history disclosure in Atum product language (%s)',
  async locale => {
    botStatus.mockResolvedValue(status(2))
    render(card(moon(2, true), locale))

    await readTerms(locale)
    const disclosure = window.document.querySelector('[data-app-bot-disclosure]')?.textContent ?? ''

    expect(disclosure).toContain('Atum')
    expect(disclosure).not.toMatch(/Hermes|Matrix|candidate/u)
  }
)

// A disclosure this Atum does not have the words for cannot be agreed to here: the person
// would accept terms they were never shown. The honest answer is to update Atum.
it.each([
  ['en', "Update Atum to set up Moon. This version can't show Moon's current terms."],
  ['vi', 'Bạn cần cập nhật Atum để bắt đầu với Moon. Phiên bản này chưa hiển thị được điều khoản mới nhất của Moon.']
] as const)('asks to update Atum for a newer disclosure instead of offering to agree (%s)', async (locale, sentence) => {
  botStatus.mockResolvedValue(status(2))
  const view = render(card(moon(2), locale))
  expect(await screen.findByText(sentence)).toBeTruthy()
  await waitFor(() => expect(botStatus).toHaveBeenCalled())
  expect(view.container.querySelector('[data-app-bot-disclosure]')).toBeNull()
  expect(screen.queryAllByRole('button')).toHaveLength(0)
  expect(botConsent).not.toHaveBeenCalled()
})

const linkedAppBase = moon(1)
const linkedApp: AppDescriptor = {
  ...linkedAppBase,
  link: { mode: 'external_account', state: 'linked' },
  bot: { ...linkedAppBase.bot!, consent: 'accepted' }
}
const linkedSnapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'OWNER' },
  roomId: '!moon:test',
  rooms: [
    {
      id: '!moon:test',
      name: 'Moon',
      membership: 'join',
      encrypted: true,
      direct: true,
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: '@app-moon:atumplatform.com', membership: 'join' }
      ]
    }
  ],
  messages: [],
  error: null,
  apps: { state: 'ready', apps: [linkedApp], connections: {} }
}

it.each([
  ['completed intake', { complete: true, fields: [] }],
  ['an absent legacy intake capability', { error: 'app_surface_absent' }]
])('keeps a healthy canonical DM ready without refreshing for %s', async (_label, intake) => {
  const refresh = vi.fn(async () => {})
  const onReadyChange = vi.fn()
  const botIntakeStatus = vi.fn(async () => intake)

  window.atumMatrix = {
    apps: {
      botStatus: vi.fn(async () => ({
        profile: 'atum.app-bot-status/1',
        consent: { state: 'accepted', disclosure_version: 1 },
        link: { state: 'linked', ready: true, available: true }
      })),
      botIntakeStatus,
      refresh
    } as unknown as MatrixUiBridge['apps']
  } as MatrixUiBridge

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <AppBotSetupCard app={linkedApp} onReadyChange={onReadyChange} snapshot={linkedSnapshot} />
    </I18nProvider>
  )

  await waitFor(() => expect(botIntakeStatus).toHaveBeenCalledWith(linkedApp.app_id))
  await waitFor(() => expect(view.queryByText('Chat with Moon')).toBeNull())
  expect(refresh).not.toHaveBeenCalled()
  expect(onReadyChange).toHaveBeenLastCalledWith(true)
})

it('keeps a transient intake failure visible and the composer blocked', async () => {
  const onReadyChange = vi.fn()

  window.atumMatrix = {
    apps: {
      botStatus: vi.fn(async () => ({
        profile: 'atum.app-bot-status/1',
        consent: { state: 'accepted', disclosure_version: 1 },
        link: { state: 'linked', ready: true, available: true }
      })),
      botIntakeStatus: vi.fn(async () => ({ error: 'app_surface_unavailable' })),
      refresh: vi.fn(async () => {})
    } as unknown as MatrixUiBridge['apps']
  } as MatrixUiBridge

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <AppBotSetupCard app={linkedApp} onReadyChange={onReadyChange} snapshot={linkedSnapshot} />
    </I18nProvider>
  )

  await waitFor(() => expect(view.getByText('Setup could not be completed.')).toBeTruthy())
  expect(onReadyChange).toHaveBeenLastCalledWith(false)
})

it('settles intake once when the catalog becomes ready during the bounded refresh', async () => {
  let finishRefresh = () => {}
  const refresh = vi.fn(() => new Promise<void>(resolve => { finishRefresh = resolve }))
  const botIntakeStatus = vi.fn(async () => ({ complete: true, fields: [] }))
  const onReadyChange = vi.fn()
  const joiningSnapshot: MatrixSnapshot = {
    ...linkedSnapshot,
    rooms: linkedSnapshot.rooms.map(room => ({
      ...room,
      participants: room.participants?.map(member => member.userId === linkedApp.bot!.user_id
        ? { ...member, membership: 'invite' as const }
        : member)
    }))
  }

  window.atumMatrix = {
    apps: {
      botStatus: vi.fn(async () => ({
        profile: 'atum.app-bot-status/1',
        consent: { state: 'accepted', disclosure_version: 1 },
        link: { state: 'linked', ready: true, available: true }
      })),
      botIntakeStatus,
      refresh
    } as unknown as MatrixUiBridge['apps']
  } as MatrixUiBridge

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <AppBotSetupCard app={linkedApp} onReadyChange={onReadyChange} snapshot={joiningSnapshot} />
    </I18nProvider>
  )

  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  view.rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <AppBotSetupCard app={linkedApp} onReadyChange={onReadyChange} snapshot={linkedSnapshot} />
    </I18nProvider>
  )
  await act(async () => finishRefresh())
  await waitFor(() => expect(view.queryByText('Chat with Moon')).toBeNull())
  expect(botIntakeStatus).toHaveBeenCalledTimes(1)
  expect(onReadyChange).toHaveBeenLastCalledWith(true)
})

// 0.19.4: "Kết nối ứng dụng" started the browser sign-in in main, but the card never read
// the flow's progress: nothing changed while waiting, a failure was silent, and the last
// step (Finish connecting, after the browser came back) was nowhere in the chat.
describe('Connect app in the bot chat', () => {
  const accepted = {
    profile: 'atum.app-bot-status/1',
    consent: { state: 'accepted', disclosure_version: 1 },
    link: { state: 'never_linked', ready: false, available: true }
  }

  const linked = { ...accepted, link: { state: 'linked', ready: true, available: true } }
  const app = moon(1)
  const connectionState = { state: 'never_linked' as const, connectionRequired: true, available: true, readiness: 'not_linked' as const }

  const withLink = (link?: MatrixAppConnectionState): MatrixSnapshot =>
    ({
      state: 'ready',
      rooms: [],
      apps: { state: 'ready', apps: [app], connections: link ? { moon: link } : {} }
    }) as unknown as MatrixSnapshot

  const mount = (current: MatrixSnapshot, locale: Locale = 'vi') =>
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <AppBotSetupCard app={app} snapshot={current} />
      </I18nProvider>
    )

  const remount = (view: ReturnType<typeof render>, current: MatrixSnapshot, locale: Locale = 'vi') =>
    view.rerender(
      <I18nProvider configClient={null} initialLocale={locale}>
        <AppBotSetupCard app={app} snapshot={current} />
      </I18nProvider>
    )

  // 2026-10-10: the return confirms by itself (main's gate); the "Còn một bước nữa:
  // [Hoàn tất kết nối]" tap is gone. Connect, the browser wait, then Đang kết nối…. No Hủy
  // there: the confirm is already on its way and a cancel could not call it back.
  it('walks Connect, the browser wait and Đang kết nối… with no finishing tap', async () => {
    botStatus.mockResolvedValue(accepted)
    connection.mockResolvedValue(undefined)
    const view = mount(withLink())

    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối ứng dụng' }))
    await waitFor(() => expect(connection).toHaveBeenCalledWith('moon-id', 'begin', { autoConfirm: true }))

    remount(view, withLink({ phase: 'waiting', connection: connectionState }))
    expect(await screen.findByText('Đăng nhập Moon trên trình duyệt, rồi quay lại đây.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()

    expect(screen.getByRole('button', { name: 'Hủy' })).toBeTruthy()

    remount(view, withLink({ phase: 'confirming', connection: connectionState }))
    expect(await screen.findByText('Đang kết nối…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Hủy' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hoàn tất kết nối' })).toBeNull()
    expect(screen.queryByText(/Còn một bước nữa/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()

    // The link lands: the card reads the bot again and waits while Moon gets ready.
    const reads = botStatus.mock.calls.length
    botStatus.mockResolvedValue({ ...accepted, link: { state: 'linked', ready: false, available: true } })
    remount(view, withLink({ phase: 'idle', connection: { ...connectionState, state: 'linked', readiness: 'pending' } }))
    await waitFor(() => expect(botStatus.mock.calls.length).toBeGreaterThan(reads))
    expect(await screen.findByText('Moon đang chuẩn bị. Bạn chờ một chút nhé.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
    expect(connection).not.toHaveBeenCalledWith('moon-id', 'confirm')
  })

  // Main refuses a self-confirming link whose consent no longer stands (revoked on another
  // device during the wait): the card reads the bot again and asks for consent, instead of
  // offering a Connect that would fail the same way.
  it('reads the bot again when connecting fails, and asks for consent again if it is gone', async () => {
    botStatus.mockResolvedValue(accepted)
    const view = mount(withLink({ phase: 'confirming', connection: connectionState }))
    expect(await screen.findByText('Đang kết nối…')).toBeTruthy()
    const reads = botStatus.mock.calls.length

    botStatus.mockResolvedValue({ ...accepted, consent: { state: 'revoked', disclosure_version: 1 } })
    remount(view, withLink({ phase: 'failed', connection: connectionState, error: 'unavailable' }))
    await waitFor(() => expect(botStatus.mock.calls.length).toBeGreaterThan(reads))
    expect(await screen.findByRole('button', { name: 'Bắt đầu' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
  })

  it('leaves a sign-in started on the Apps page to its own tap there', async () => {
    botStatus.mockResolvedValue(accepted)
    mount(withLink({ phase: 'confirm', connection: connectionState }))
    expect(await screen.findByText('Hoàn tất kết nối ở nơi bạn đã bắt đầu, hoặc hủy rồi kết nối tại đây.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hủy' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Hoàn tất kết nối' })).toBeNull()
  })

  it('agreeing starts a self-confirming link, but not a second one while a link gets ready', async () => {
    botStatus.mockResolvedValue({ ...accepted, consent: { state: 'required', disclosure_version: 1 } })
    botConsent.mockResolvedValue(accepted)
    connection.mockResolvedValue(undefined)
    mount(withLink())
    fireEvent.click(await screen.findByRole('button', { name: 'Bắt đầu' }))
    await waitFor(() => expect(connection).toHaveBeenCalledWith('moon-id', 'begin', { autoConfirm: true }))

    cleanup()
    vi.clearAllMocks()
    botStatus.mockResolvedValue({ ...accepted, consent: { state: 'required', disclosure_version: 1 } })
    botConsent.mockResolvedValue({ ...accepted, link: { state: 'linked', ready: false, available: true } })
    mount(withLink())
    fireEvent.click(await screen.findByRole('button', { name: 'Bắt đầu' }))
    await waitFor(() => expect(botConsent).toHaveBeenCalled())
    await waitFor(() => expect(botStatus).toHaveBeenCalledTimes(2))
    expect(connection).not.toHaveBeenCalledWith('moon-id', 'begin', expect.anything())
  })

  it('says a failed start instead of staying silent, and offers Connect again', async () => {
    botStatus.mockResolvedValue(accepted)
    mount(withLink({ phase: 'failed', connection: connectionState, error: 'unavailable' }))
    expect(await screen.findByText('Không thể hoàn tất thiết lập.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Kết nối ứng dụng' })).toBeTruthy()
  })

  it('cancels a sign-in the person abandons', async () => {
    botStatus.mockResolvedValue(accepted)
    connection.mockResolvedValue(undefined)
    mount(withLink({ phase: 'waiting', connection: connectionState }), 'en')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(connection).toHaveBeenCalledWith('moon-id', 'cancel'))
  })

  it('re-reads the bot once a link finished elsewhere, and waits while the app gets ready', async () => {
    botStatus.mockResolvedValue({ ...accepted, link: { state: 'linked', ready: false, available: true } })
    const view = mount(withLink({ phase: 'confirming', connection: connectionState }), 'en')
    expect(await screen.findByText('Moon is getting ready. This takes a moment.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect app' })).toBeNull()

    const reads = botStatus.mock.calls.length
    remount(view, withLink({ phase: 'idle', connection: { ...connectionState, state: 'linked', readiness: 'pending' } }), 'en')
    await waitFor(() => expect(botStatus.mock.calls.length).toBeGreaterThan(reads))
  })

  const elapse = async (milliseconds: number) => {
    for (let spent = 0; spent < milliseconds; spent += 5_000) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
    }
  }

  const notReadyLink = { ...accepted, link: { state: 'linked', ready: false, available: true } }
  const pendingLink = { phase: 'idle' as const, connection: { ...connectionState, state: 'linked' as const, readiness: 'pending' as const } }

  // 0.19.4: the card gave up after ~20 s and offered Connect again while the platform still
  // said pending (the claim.redeemed delivery). Pending is waited out, never re-linked.
  it('waits out a pending link for minutes without offering Connect again, then a quiet Check again', async () => {
    vi.useFakeTimers()

    try {
      botStatus.mockResolvedValue(notReadyLink)
      connection.mockResolvedValue(undefined)
      mount(withLink(pendingLink))
      await elapse(30_000)
      expect(screen.getByText('Moon đang chuẩn bị. Bạn chờ một chút nhé.')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
      // Each look has main read the link again, so readiness stays current.
      expect(connection).toHaveBeenCalledWith('moon-id', 'read')

      await elapse(3 * 60_000)
      expect(screen.getByText('Moon đang chuẩn bị. Bạn chờ một chút nhé.')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
      const looks = connection.mock.calls.filter(call => call[1] === 'read').length
      // Backoff: far fewer looks than one every 2.5 s.
      expect(looks).toBeLessThan(20)

      await elapse(4 * 60_000)
      expect(screen.getByText('Moon vẫn đang chuẩn bị. Bạn kiểm tra lại sau ít phút nhé.')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Kiểm tra lại' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
      const settled = connection.mock.calls.length
      await elapse(60_000)
      expect(connection.mock.calls.length).toBe(settled)

      // Check again looks once more and keeps waiting; still no Connect.
      fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại' }))
      await elapse(5_000)
      expect(connection.mock.calls.length).toBeGreaterThan(settled)
      expect(screen.getByText('Moon đang chuẩn bị. Bạn chờ một chút nhé.')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a failed look at a pending link without linking a second time', async () => {
    botStatus.mockResolvedValueOnce(notReadyLink).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(notReadyLink)
    connection.mockResolvedValue(undefined)
    const view = mount(withLink({ phase: 'confirming', connection: connectionState }))
    await screen.findByText('Moon đang chuẩn bị. Bạn chờ một chút nhé.')
    remount(view, withLink(pendingLink))
    fireEvent.click(await screen.findByRole('button', { name: 'Thử lại' }))
    await waitFor(() => expect(botStatus).toHaveBeenCalledTimes(3))
    expect(connection).toHaveBeenCalledWith('moon-id', 'read')
    expect(connection).not.toHaveBeenCalledWith('moon-id', 'begin', expect.anything())
    expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
  })

  it('moves on by itself once the pending link becomes ready', async () => {
    vi.useFakeTimers()

    try {
      botStatus.mockResolvedValue(notReadyLink)
      connection.mockResolvedValue(undefined)
      const view = mount(withLink(pendingLink))
      await elapse(5_000)
      expect(screen.getByText('Moon đang chuẩn bị. Bạn chờ một chút nhé.')).toBeTruthy()
      botStatus.mockResolvedValue(linked)
      await elapse(15_000)
      expect(screen.queryByText('Moon đang chuẩn bị. Bạn chờ một chút nhé.')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  // Unavailable is not pending: the delivery is missing or dead-lettered and will not settle
  // by itself. A fresh link is how it recovers, so Connect is offered at once.
  it('offers Connect right away when the platform says the link will not settle', async () => {
    botStatus.mockResolvedValue(notReadyLink)
    connection.mockResolvedValue(undefined)
    mount(withLink({ ...pendingLink, connection: { ...pendingLink.connection, readiness: 'unavailable' } }))
    expect(await screen.findByRole('button', { name: 'Kết nối ứng dụng' })).toBeTruthy()
    expect(screen.getByText('Moon chưa sẵn sàng. Bạn kết nối lại, hoặc kiểm tra sau nhé.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Kiểm tra lại' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Kết nối ứng dụng' }))
    await waitFor(() => expect(connection).toHaveBeenCalledWith('moon-id', 'begin', { autoConfirm: true }))
  })

  // When the card cannot learn the readiness at all (every read fails), it offers Connect after
  // the wait rather than hiding it for good.
  it('offers Connect after the wait when the readiness stays unknown', async () => {
    vi.useFakeTimers()

    try {
      botStatus.mockResolvedValue(notReadyLink)
      connection.mockRejectedValue(new Error('matrix_app_unavailable'))
      mount(withLink())
      await elapse(30_000)
      expect(screen.queryByRole('button', { name: 'Kết nối ứng dụng' })).toBeNull()
      await elapse(6 * 60_000)
      expect(screen.getByText('Moon chưa sẵn sàng. Bạn kết nối lại, hoặc kiểm tra sau nhé.')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Kiểm tra lại' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Kết nối ứng dụng' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers Connect right away when the linked app is not available', async () => {
    botStatus.mockResolvedValue({ ...accepted, link: { state: 'linked', ready: false, available: false } })
    mount(withLink(), 'en')
    expect(await screen.findByRole('button', { name: 'Connect app' })).toBeTruthy()
    expect(screen.getByText("Moon isn't ready yet. Connect again, or check later.")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })
})

describe('an app the client has no code for', () => {
  const guestStatus = (state: 'start_required' | 'ready') => ({
    profile: 'atum.app-bot-status/1',
    consent: { state: state === 'ready' ? 'accepted' : 'required', disclosure_version: 1 },
    link: { state: 'never_linked', ready: false, available: true },
    guest: { enabled: true, state }
  })

  it('offers a guest-enabled bot Start chat, and records consent to the terms behind Learn more', async () => {
    const acme = botApp(ACME_GUEST)
    botStatus.mockResolvedValueOnce(guestStatus('start_required')).mockResolvedValue(guestStatus('ready'))
    botConsent.mockResolvedValue(guestStatus('ready'))
    refresh.mockResolvedValue(undefined)
    const onReadyChange = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <AppBotSetupCard app={acme} onReadyChange={onReadyChange} snapshot={snapshot} />
      </I18nProvider>
    )

    expect(await screen.findByText('Chat with Acme right here in Atum.')).toBeTruthy()
    const terms = await readTerms()
    expect(points().join(' ')).toContain('Acme runs on its own service, not on Atum.')
    expect(points().join(' ')).not.toMatch(/Moon|Andy/u)
    expect(terms.items.length).toBeGreaterThan(0)
    terms.close()
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))

    await waitFor(() => expect(botConsent).toHaveBeenCalledExactlyOnceWith(ACME.appId, 1, 'en'))
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true))
    expect(connection).not.toHaveBeenCalled()
    // The dialog is gone; connecting an account stays one quiet, optional line.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect account' })).toBeTruthy()
  })

  it('shows a linked-only bot the shared terms and its own generic memory line', async () => {
    const acme = botApp(ACME)
    botStatus.mockResolvedValue(status(1))
    botConsent.mockResolvedValue(status(1, 'accepted'))
    connection.mockResolvedValue(undefined)

    render(card(acme))
    const terms = await readTerms()

    expect(points().join(' ')).toContain('Acme runs on Atum')
    expect(points().join(' ')).toContain('Acme chats one-on-one only.')
    expect(points().join(' ')).toContain(
      'In this private chat Acme remembers your conversation so it can answer you better.'
    )
    expect(points().join(' ')).not.toMatch(/Moon|Andy/u)
    expect(terms.items.length).toBeGreaterThan(0)
    terms.close()
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(botConsent).toHaveBeenCalledExactlyOnceWith(ACME.appId, 1, 'en'))
    await waitFor(() => expect(connection).toHaveBeenCalledExactlyOnceWith(ACME.appId, 'begin', { autoConfirm: true }))
  })

  it('says the same generic memory line for Moon, Andy and an app it has no code for', async () => {
    botStatus.mockResolvedValue(status(1))
    const sentence = (name: string) =>
      `In this private chat ${name} remembers your conversation so it can answer you better.`

    render(card(moon(1)))
    ;(await readTerms()).items
    expect(points().join(' ')).toContain(sentence('Moon'))
    expect(points().join(' ')).not.toContain('Andy remembers')
    cleanup()

    const base = moon(1)

    const andy: AppDescriptor = {
      ...base,
      app: 'andy',
      app_id: 'andy-id',
      bot: { ...base.bot!, user_id: '@app-andy:atumplatform.com', handle: 'andy_bot', display_name: 'Andy', groups: false }
    }

    render(card(andy))
    await readTerms()
    expect(points().join(' ')).toContain(sentence('Andy'))
    expect(points().join(' ')).not.toContain('Moon remembers')
    cleanup()

    render(card(botApp(ACME)))
    await readTerms()
    expect(points().join(' ')).toContain(sentence('Acme'))
    expect(points().join(' ')).not.toMatch(/Moon|Andy/u)
  })

  it('says it in every language without naming another app', async () => {
    botStatus.mockResolvedValue(status(1))

    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
      render(card(botApp(ACME), locale))
      await readTerms(locale)
      await waitFor(() => expect(points().length).toBeGreaterThan(0))

      expect(points().join(' '), locale).toContain('Acme')
      expect(points().join(' '), locale).not.toMatch(/Moon|Andy/u)
      cleanup()
    }
  })
})

// The title-only band that used to flash above the composer on every open of a chat that was already set
// up is gone: nothing is drawn until there is something to ask, and never for a ready chat.
describe('no flash before there is something to ask', () => {
  const dialogs = () => window.document.querySelectorAll('[data-app-bot-setup]')

  it('draws nothing while the first read of the bot is out', async () => {
    let answer = (_value: unknown) => {}
    botStatus.mockReturnValue(new Promise(resolve => { answer = resolve }))
    render(card(botApp(ACME)))

    await act(async () => {})
    expect(botStatus).toHaveBeenCalledOnce()
    expect(dialogs()).toHaveLength(0)

    await act(async () => answer(status(1)))
    await screen.findByRole('button', { name: 'Start chat' })
    expect(dialogs()).toHaveLength(1)
  })

  it('draws nothing, at any moment, for a chat the catalog says is set up', async () => {
    let finishIntake = (_value: unknown) => {}
    const onReadyChange = vi.fn()
    const seen: number[] = []
    const observer = new MutationObserver(() => seen.push(dialogs().length))
    observer.observe(window.document.body, { childList: true, subtree: true })

    window.atumMatrix = {
      apps: {
        botStatus: vi.fn(async () => ({
          profile: 'atum.app-bot-status/1',
          consent: { state: 'accepted', disclosure_version: 1 },
          link: { state: 'linked', ready: true, available: true }
        })),
        botIntakeStatus: vi.fn(() => new Promise(resolve => { finishIntake = resolve })),
        refresh: vi.fn(async () => {})
      } as unknown as MatrixUiBridge['apps']
    } as MatrixUiBridge

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <AppBotSetupCard app={linkedApp} onReadyChange={onReadyChange} snapshot={linkedSnapshot} />
      </I18nProvider>
    )

    // The status has come and the intake read is still out: the verification is under way, not a step.
    await waitFor(() => expect(window.atumMatrix.apps!.botIntakeStatus).toHaveBeenCalled())
    expect(dialogs()).toHaveLength(0)

    await act(async () => finishIntake({ complete: true, fields: [] }))
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true))
    observer.disconnect()

    expect(dialogs()).toHaveLength(0)
    expect(seen.every(count => count === 0)).toBe(true)
  })
})
