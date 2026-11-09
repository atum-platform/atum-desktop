import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { resetAppViewOverlayForTests } from '@/store/app-view-overlay'

import moonLookFixture from '../../../shared/__fixtures__/look-pack-v1/fixtures/moon.published.json'
import type { AppDescriptor } from '../../../shared/app-catalog'
import type { AppViewState } from '../../../shared/app-view/ipc'
import { decodeLookPack } from '../../../shared/look-pack'
import type { MatrixAppMenu, MatrixSnapshot } from '../../../shared/matrix'

import { directAppBot } from './direct-app'
import { AppBotPanel } from './panel'

const app: AppDescriptor = {
  app: 'moon', app_id: 'moon-id', app_version_id: 'moon-v1', name: { en: 'Moon' },
  subtitle: null, description: null, icon: null, accent: '#D8612F', affiliation: 'first_party',
  verified: true, availability: 'available', roster_default: true, roster_order: 1,
  supported_modes: ['direct'], has_surface: true, link: { mode: 'external_account', state: 'linked' },
  bot: {
    v: 1, user_id: '@moon:test', handle: 'moon', display_name: 'Moon',
    avatar: { url: 'data:image/png;base64,aA==', sha256: 'a'.repeat(64) }, device_generation: 1,
    device: { device_id: 'BOT', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) }, state: 'active',
    groups: true, consent: 'accepted', disclosure_version: 1, open_route_id: 'chat',
    open_shared_memory: true, purchase_route_id: 'top-up'
  }
}

const snapshot: MatrixSnapshot = {
  state: 'ready', identity: { userId: '@owner:test', deviceId: 'OWNER' }, roomId: '!dm:test',
  rooms: [{ id: '!dm:test', name: 'Moon', direct: true, encrypted: true, membership: 'join',
    participants: [{ userId: '@owner:test', membership: 'join' }, { userId: '@moon:test', membership: 'join' }] }],
  messages: [], error: null, apps: { state: 'ready', apps: [app], connections: {} }
}

const approvedMenu: MatrixAppMenu = {
  app, routes: [
    { id: 'chat', label: { en: 'Chat', vi: 'Trò chuyện' }, icon: 'chat', session: 'required' },
    { id: 'readings', label: { en: 'Readings', vi: 'Luận giải' }, icon: 'sparkles', session: 'required' }
  ],
  actions: [{ id: 'top-up', label: { en: 'Top up', vi: 'Nạp tin nhắn' }, icon: 'wallet', session: 'required' }]
}

const menu = vi.fn(async () => approvedMenu)
const open = vi.fn(async () => ({ viewId: 'native-moon' }))
const close = vi.fn(async () => ({ ok: true as const }))
const visibility = vi.fn(async () => ({ ok: true as const }))
const back = vi.fn()
const viewBack = vi.fn(async () => ({ ok: true as const }))
let listeners: ((state: AppViewState) => void)[] = []
const emit = (state: Omit<AppViewState, 'viewId'>) =>
  act(() => listeners.forEach(fn => fn({ viewId: 'native-moon', ...state } as AppViewState)))

beforeEach(() => {
  vi.clearAllMocks()
  listeners = []
  menu.mockResolvedValue(approvedMenu)
  resetAppViewOverlayForTests()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.assign(window, { atumMatrix: { apps: {
    menu, onReturn: () => () => {}, view: {
      open, close, back: viewBack, setVisibility: visibility, setBounds: async () => ({ ok: true }),
      focus: async () => ({ ok: true }), reload: async () => ({ ok: true }),
      onState: (fn: (state: AppViewState) => void) => {
        listeners.push(fn)

        return () => { listeners = listeners.filter(item => item !== fn) }
      }
    }
  } } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'atumMatrix') })

const frame = (hidden = false, descriptor = app, request?: { appId: string; routeId: string; scope: string; serial: number },
  onRequestConsumed?: (serial: number) => void, botApiRoom = false, appearance?: 'light' | 'dark') => <I18nProvider configClient={null} initialLocale="en">
  <AppBotPanel app={descriptor} botApiRoom={botApiRoom} hidden={hidden} onBackToChat={back}
    onRequestConsumed={onRequestConsumed} request={request}
    snapshot={appearance ? { ...snapshot, displayPreferences: {
      appearance: { value: appearance, writable: true },
      textSize: { value: 100, writable: true }
    } } as MatrixSnapshot : snapshot} />
</I18nProvider>

it('keeps composer-only actions out of the panel while an explicit action opens its native route', async () => {
  const consumed = vi.fn()
  const request = { appId: app.app_id, routeId: 'top-up', scope: '!dm:test', serial: 1 }
  const view = render(frame(false, app, request, consumed))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ app: 'moon', panelNavigation: true, route_id: 'top-up' }))
  expect(consumed).toHaveBeenCalledWith(1)
  expect(JSON.stringify(open.mock.calls)).not.toContain('http')
  // The page opens under Atum's bar, named for the page.
  expect(screen.getByRole('heading', { name: 'Top up' })).toBeTruthy()
  view.rerender(frame(true, app, request, consumed))
  await waitFor(() => expect(visibility).toHaveBeenLastCalledWith({ viewId: 'native-moon', visible: false, overlayActive: false }))
  expect(close).not.toHaveBeenCalled()
  view.rerender(frame(false, app, request, consumed))
  await waitFor(() => expect(visibility).toHaveBeenLastCalledWith({ viewId: 'native-moon', visible: true, overlayActive: false }))
  expect(open).toHaveBeenCalledOnce()

  // Back returns to the app's pages; the chat route and composer-only actions are not among them.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(close).toHaveBeenCalledWith('native-moon')
  expect(screen.getByRole('button', { name: 'Readings' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Top up' })).toBeNull()
  view.unmount()
})

it('keeps the catalog chat route launchable for an explicit request without duplicating it in navigation', async () => {
  const consumed = vi.fn()
  render(frame(false, app, { appId: app.app_id, routeId: 'chat', scope: '!dm:test', serial: 2 }, consumed))

  await waitFor(() => expect(open).toHaveBeenCalledWith({ app: 'moon', panelNavigation: true, route_id: 'chat' }))
  expect(consumed).toHaveBeenCalledWith(2)
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByRole('button', { name: 'Readings' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull()
})

it('rejects a menu belonging to another app version and makes no native launch', async () => {
  menu.mockResolvedValue({ ...approvedMenu, app: { ...app, app_version_id: 'other-version' } })
  render(frame())
  await screen.findByText('This app is unavailable.')
  expect(screen.queryByRole('button', { name: 'Readings' })).toBeNull()
  expect(open).not.toHaveBeenCalled()
})

it('takes an unlinked app back to its existing chat setup without launching or duplicating consent', () => {
  render(frame(false, { ...app, link: { ...app.link, state: 'never_linked' } }))
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(back).toHaveBeenCalledOnce()
  expect(menu).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(window.document.querySelector('[data-app-bot-disclosure]')).toBeNull()
})

it('shows and launches declared routes for an unlinked Bot API room without offering Connect', async () => {
  const unlinked = { ...app, link: { ...app.link, state: 'never_linked' as const } }
  render(frame(false, unlinked, undefined, undefined, true))

  fireEvent.click(await screen.findByRole('button', { name: 'Readings' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ app: 'moon', panelNavigation: true, route_id: 'readings' }))
  expect(menu).toHaveBeenCalledWith(app.app_id)
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
})

it('offers no Connect in the panel for an account the catalog says is already linked', async () => {
  render(frame())
  expect(await screen.findByRole('button', { name: 'Readings' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
})

it('keeps shared and non-member rooms from taking the app identity', () => {
  expect(directAppBot(snapshot)).toBe(app)
  const room = snapshot.rooms[0]!
  // 0.20: the bot's chat is a plain room; its members, not encryption, make it the bot's.
  expect(directAppBot({ ...snapshot, rooms: [{ ...room, encrypted: false, plainAgent: true }] })).toBe(app)

  for (const change of [{ direct: false }, { membership: 'invite' as const },
    { participants: [{ userId: '@moon:test', membership: 'join' as const }] },
    { participants: [...room.participants!, { userId: '@another:test', membership: 'invite' as const }] }]) {
    expect(directAppBot({ ...snapshot, rooms: [{ ...room, ...change }] })).toBeUndefined()
  }
})

it('keeps an inactive bot identity but does not offer or launch functions', () => {
  render(frame(false, { ...app, bot: { ...app.bot!, state: 'paused' } }))
  expect(screen.getByText('This app is unavailable.')).toBeTruthy()
  expect(menu).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it('keeps the menu it already holds when a refresh cannot be read', async () => {
  const view = render(frame())
  expect(await screen.findByRole('button', { name: 'Readings' })).toBeTruthy()

  menu.mockRejectedValueOnce(new Error('rate_limited'))
  view.rerender(frame(true))
  view.rerender(frame(false))

  await waitFor(() => expect(menu).toHaveBeenCalledTimes(2))
  await act(async () => {})
  expect(screen.getByRole('button', { name: 'Readings' })).toBeTruthy()
  expect(screen.queryByText('This app is unavailable.')).toBeNull()
  expect(screen.queryByText('Loading apps…')).toBeNull()
})

it('says the app is unavailable when its bot pauses while a menu is held', async () => {
  const view = render(frame())
  expect(await screen.findByRole('button', { name: 'Readings' })).toBeTruthy()

  view.rerender(frame(false, { ...app, bot: { ...app.bot!, state: 'paused' } }))
  expect(screen.getByText('This app is unavailable.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Readings' })).toBeNull()
})

const panelNode = () => window.document.querySelector<HTMLElement>('[data-app-bot-panel]')!

it('lays every app out the same: identity, then its declared pages as one centred column', async () => {
  render(frame())
  expect(screen.getByRole('heading', { name: 'Moon' })).toBeTruthy()
  const pages = screen.getByRole('region', { name: 'Open in Moon' })
  expect(await within(pages).findByRole('button', { name: 'Readings' })).toBeTruthy()
  // Home is the panel: no page opens until one is chosen, and there is no persistent navigation.
  expect(open).not.toHaveBeenCalled()
  expect(screen.queryByRole('navigation')).toBeNull()
  // Every page is a Kit capsule.
  expect(within(pages).getByRole('button', { name: 'Readings' }).classList.contains('ak-btn')).toBe(true)
  // No look declared: the default Kit panel, no ground or app colour on it.
  expect(panelNode().dataset.atumLook).toBeUndefined()
  expect(panelNode().getAttribute('style')).toBeNull()
})

it('dresses the panel in the declared look pack and nothing app-specific', async () => {
  const decoded = decodeLookPack(moonLookFixture)!
  const look = { ...decoded, panel: { background: decoded.chat!.background, derived: decoded.derived } }
  render(frame(false, { ...app, look }))
  await screen.findByRole('button', { name: 'Readings' })
  const node = panelNode()
  const ground = look.panel.background!.light

  expect(node.dataset.atumLook).toBe('pack')
  expect(node.dataset.atumLookTone).toBe(ground.tone)
  expect(node.classList.contains(ground.tone === 'dark' ? 'ak-dark' : 'ak-light')).toBe(true)
  expect(node.style.getPropertyValue('--look-base')).toBe(ground.base)
  expect(node.style.getPropertyValue('--look-tile')).toBe('')
  expect(node.style.getPropertyValue('--look-l1-image')).toContain('atum-look://')
})

it('gives an app this client has never heard of the same panel, from its declared data alone', async () => {
  const unknown: AppDescriptor = {
    ...app, app: 'zz-never-seen', app_id: 'zz-id', app_version_id: 'zz-v1', name: { en: 'Zed' }, accent: null,
    subtitle: { en: 'Anything at all' }, verification: null,
    bot: { ...app.bot!, user_id: '@zz:test', display_name: 'Zed', avatar: { url: '', sha256: 'a'.repeat(64) } }
  }

  menu.mockResolvedValue({
    app: unknown,
    routes: [
      { id: 'chat', label: { en: 'Chat', vi: 'Trò chuyện' }, icon: 'chat', session: 'required' },
      { id: 'board', label: { en: 'Board', vi: 'Bảng' }, icon: 'zz-unknown-glyph', session: 'none' }
    ]
  })
  render(frame(false, unknown))

  expect(screen.getByRole('heading', { name: 'Zed' })).toBeTruthy()
  expect(screen.getByText('Anything at all')).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: 'Board' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ app: 'zz-never-seen', panelNavigation: true, route_id: 'board' }))
  expect(screen.getByRole('heading', { name: 'Board' })).toBeTruthy()
  expect(panelNode().dataset.atumLook).toBeUndefined()

  // A pack on the unknown app dresses it exactly as it would Moon.
  cleanup()
  const decoded = decodeLookPack(moonLookFixture)!
  const look = { ...decoded, panel: { background: decoded.chat!.background, derived: decoded.derived } }
  render(frame(false, { ...unknown, look }))
  expect(panelNode().dataset.atumLook).toBe('pack')
  expect(panelNode().style.getPropertyValue('--look-base')).toBe(look.chat!.background!.light.base)
})

it('says so in one line when the app declares no pages', async () => {
  menu.mockResolvedValue({ app, routes: [{ id: 'chat', label: { en: 'Chat', vi: 'Trò chuyện' }, icon: 'chat', session: 'required' }] })
  render(frame())
  expect(await screen.findByText('This app has no screens yet.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull()
})

it('shows quiet placeholder capsules while the pages load', () => {
  menu.mockReturnValue(new Promise(() => {}))
  render(frame())
  expect(screen.getByRole('status').textContent).toBe('Loading apps…')
  expect(window.document.querySelectorAll('[data-app-panel-loading] .ak-skeleton')).toHaveLength(4)
  expect(window.document.querySelector('[data-app-panel-loading]')?.getAttribute('aria-busy')).toBe('true')
})

it('offers Connect as the one primary action, in the accent its pack declares', () => {
  const decoded = decodeLookPack(moonLookFixture)!
  const look = { ...decoded, panel: { background: decoded.chat!.background, derived: decoded.derived } }
  render(frame(false, { ...app, look, link: { ...app.link, state: 'never_linked' } }))
  const connect = screen.getByRole('button', { name: 'Connect' })
  expect(connect.classList.contains('ak-btn--primary')).toBe(true)
  expect(panelNode().dataset.appPanelAccent).toBe('true')
  expect(panelNode().style.getPropertyValue('--look-accent')).toBe(look.accent!.light)
})

it('a link-none unknown app offers pages and never platform Connect', async () => {
  const unknown: AppDescriptor = { ...app, app: 'orchid-unknown', link: { mode: 'none', state: 'never_linked' } }
  render(frame(false, unknown))
  expect(await screen.findByRole('button', { name: 'Readings' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
})

it('paints a light ground the app declares as paper with the Kit light theme, and its art', async () => {
  const decoded = decodeLookPack(moonLookFixture)!
  const art = decoded.chat!.background!.light.layers[0]!
  const look = {
    ...decoded,
    panel: {
      background: { light: { tone: 'light' as const, base: '#F7F6F2', layers: [{ ...art, opacity: 0.3 }] }, dark: null },
      derived: {}
    }
  }

  for (const appearance of ['light', 'dark'] as const) {
    cleanup()
    render(frame(false, { ...app, look }, undefined, undefined, false, appearance))
    await screen.findByRole('button', { name: 'Readings' })
    // No dark variant declared: the paper ground serves both appearances.
    expect(panelNode().dataset.atumLookTone).toBe('light')
    expect(panelNode().classList.contains('ak-light')).toBe(true)
    expect(panelNode().style.getPropertyValue('--look-base')).toBe('#F7F6F2')
    expect(panelNode().style.getPropertyValue('--look-l1-image')).toContain('atum-look://')
  }
})

it('takes declared pages in their declared order and glyphs, and keeps undeclared routes launchable', async () => {
  menu.mockResolvedValue({
    ...approvedMenu,
    routes: [...approvedMenu.routes, { id: 'tarot', label: { en: 'Tarot', vi: 'Tarot' }, icon: 'cards', session: 'required' }],
    pages: [{ routeId: 'tarot', glyph: 'heart' }, { routeId: 'readings', glyph: 'article' }],
    defaultPage: 'readings'
  })
  const consumed = vi.fn()
  render(frame(false, app, { appId: app.app_id, routeId: 'top-up', scope: '!dm:test', serial: 3 }, consumed))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ app: 'moon', panelNavigation: true, route_id: 'top-up' }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  const pages = screen.getByRole('region', { name: 'Open in Moon' })
  expect(within(pages).getAllByRole('button').map(button => button.textContent)).toEqual(['Tarot', 'Readings'])
  expect(pages.querySelector('.atum-icon-article')).toBeTruthy()
})

it('walks the page’s own history with Back, then returns to the app’s pages at its root', async () => {
  render(frame())
  fireEvent.click(await screen.findByRole('button', { name: 'Readings' }))
  await waitFor(() => expect(open).toHaveBeenCalledOnce())
  emit({ status: 'ready', canGoBack: true, matchedRouteId: 'readings', atRouteRoot: false })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(viewBack).toHaveBeenCalledWith('native-moon')
  expect(screen.getByRole('heading', { name: 'Readings' })).toBeTruthy()

  emit({ status: 'ready', canGoBack: true, matchedRouteId: 'readings', atRouteRoot: true })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(viewBack).toHaveBeenCalledOnce()
  expect(await screen.findByRole('region', { name: 'Open in Moon' })).toBeTruthy()
})

it('keeps the page’s title on an undeclared sub-page that only the chat route’s root matches', async () => {
  render(frame())
  fireEvent.click(await screen.findByRole('button', { name: 'Readings' }))
  await waitFor(() => expect(open).toHaveBeenCalled())
  emit({ status: 'ready', canGoBack: true, matchedRouteId: 'chat', atRouteRoot: false })
  expect(screen.getByRole('heading', { name: 'Readings' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Chat' })).toBeNull()
})

it('offers only the way back to chat when a page reports the account is not linked', async () => {
  const unknown: AppDescriptor = { ...app, app: 'orchid-unknown', link: { mode: 'none', state: 'linked' } as AppDescriptor['link'] }
  render(frame(false, unknown))
  fireEvent.click(await screen.findByRole('button', { name: 'Readings' }))
  await waitFor(() => expect(open).toHaveBeenCalled())
  emit({ status: 'error', error: 'not_linked' })
  const alert = await screen.findByRole('alert')
  expect(within(alert).getAllByRole('button').map(button => button.textContent)).toEqual(['Back to chat'])
})

it('shows offline on an open page and reopens it when the connection returns', async () => {
  render(frame())
  fireEvent.click(await screen.findByRole('button', { name: 'Readings' }))
  await waitFor(() => expect(open).toHaveBeenCalledOnce())
  fireEvent(window, new Event('offline'))
  expect(screen.getByText('You’re offline. This page will reopen when you’re online.')).toBeTruthy()
  fireEvent(window, new Event('online'))
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
})

it('turns a menu that never answers into the recoverable unavailable notice after fifteen seconds', async () => {
  vi.useFakeTimers()

  try {
    menu.mockReturnValue(new Promise(() => {}))
    render(frame())
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
    expect(screen.getByText('This app is unavailable.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  } finally { vi.useRealTimers() }
})
