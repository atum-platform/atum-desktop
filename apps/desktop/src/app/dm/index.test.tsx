import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $atumAppCatalog, clearAtumAppCatalog } from '@/lib/atum-app-catalog'

vi.mock('@/store/atum-messaging', () => ({
  $atumAccountScopeId: atom('account-a'),
  $atumIsAuthenticated: atom(false),
  $atumAccountStatus: atom({
    state: 'expired',
    configured: true,
    account: { id: 'account-a' },
    errorCode: 'account_session_expired',
    providers: { google: false, password: true }
  }),
  $atumActiveMessages: atom([]),
  $atumConnectivity: atom('auth_expired'),
  $atumDrafts: atom({}),
  $atumMessages: atom({}),
  $atumReplyTo: atom({}),
  $atumOlderHistory: atom({}),
  $atumTyping: atom({}),
  $atumRemovedGroups: atom({}),
  refreshAtumRoster: vi.fn().mockResolvedValue([]),
  $atumRoster: atom([]),
  $atumSocialRelationships: atom([]),
  $atumStatus: atom({
    accountId: 'account-a',
    connectivity: 'auth_expired',
    synchronized: false,
    cursor: 'cursor-a',
    lastSuccessfulSyncAt: null,
    nextRetryAt: null,
    errorCode: 'account_session_expired'
  }),
  initializeAtumMessaging: vi.fn(),
  persistAtumDraft: vi.fn().mockResolvedValue(true),
  refreshAtumStatus: vi.fn(),
  retryAtumMessage: vi.fn(),
  editAtumMessage: vi.fn(),
  recallAtumMessage: vi.fn(),
  setAtumReplyTo: vi.fn(),
  toggleAtumReaction: vi.fn(),
  sendAtumMessage: vi.fn(),
  setAtumActiveConversation: vi.fn(),
  setAtumDraft: vi.fn(),
  sendAtumTyping: vi.fn(),
  signInToAtum: vi.fn()
}))

import {
  $atumAccountStatus,
  $atumConnectivity,
  $atumRoster,
  $atumSocialRelationships,
  $atumStatus,
  signInToAtum
} from '@/store/atum-messaging'

import { $groupCapabilities } from './group-state'

import { AtumDmView, canComposeAtum, canUseAppConnect } from './index'

const writableConnectivity = $atumConnectivity as unknown as {
  set(next: 'auth_expired' | 'online'): void
}

afterEach(() => {
  cleanup()
  clearAtumAppCatalog()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  $atumAppCatalog.set({ accountId: 'account-a', state: 'ready', apps: [{
    app: 'moon', app_id: '00000000-0000-4000-8000-e79acd97ac88',
    app_version_id: '00000000-0000-4000-8000-5ba39b7cfa53',
    name: { en: 'Moon', vi: 'Moon' },
    subtitle: { en: 'Astrology specialist', vi: 'Chuyên gia chiêm tinh' },
    icon: null, verified: true, availability: 'available',
    supported_modes: ['direct', 'private_group', 'shared_group'],
    link: { mode: 'external_account', state: 'linked' }
  }, {
    app: 'atlas', app_id: '00000000-0000-4000-8000-8cca3400b26b',
    app_version_id: '00000000-0000-4000-8000-96ce63971fcd',
    name: { en: 'Atlas Studio', vi: 'Atlas Studio' },
    subtitle: { en: 'Creative collaboration', vi: 'Cộng tác sáng tạo' },
    icon: null, verified: false, availability: 'available',
    supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' }
  }] })
  $atumAccountStatus.set({
    state: 'expired',
    configured: true,
    account: { id: 'account-a' },
    errorCode: 'account_session_expired',
    providers: { google: false, password: true }
  })
  writableConnectivity.set('auth_expired')
  $atumRoster.set([])
  $atumSocialRelationships.set([])
  $groupCapabilities.set(null)
  $atumStatus.set({
    accountId: 'account-a',
    connectivity: 'auth_expired',
    synchronized: false,
    cursor: 'cursor-a',
    lastSuccessfulSyncAt: null,
    nextRetryAt: null,
    errorCode: 'account_session_expired'
  })
})

function renderView() {
  return render(
    <I18nProvider configClient={null} initialLocale="vi">
      <MemoryRouter initialEntries={['/dm/conversation-1']}>
        <input aria-label="Account identifier" id="atum-identifier" />
        <Routes>
          <Route element={<AtumDmView />} path="/dm/:conversationId" />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  )
}

function SearchNavigation() {
  const navigate = useNavigate()

  return <button onClick={() => navigate('/dm/conversation-2')}>Open second conversation</button>
}

function renderSearchView() {
  return render(
    <I18nProvider configClient={null} initialLocale="vi">
      <MemoryRouter initialEntries={['/dm/conversation-1']}>
        <SearchNavigation />
        <Routes>
          <Route element={<AtumDmView />} path="/dm/:conversationId" />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

describe('AtumDmView auth recovery', () => {
  it('treats a refreshing same-account session as compose-capable', () => {
    expect(canComposeAtum('refreshing', 'online')).toBe(true)
    expect(canComposeAtum('refreshing', 'offline_cached')).toBe(true)
    expect(canComposeAtum('refreshing', 'reconnecting')).toBe(true)
    expect(canComposeAtum('refreshing', 'auth_expired')).toBe(false)
  })

  it.each([
    ['signed_in', true],
    ['refreshing', true],
    ['error', true],
    ['signing_in', false],
    ['expired', false],
    ['signed_out', false]
  ])('makes app-connect availability explicit for the %s account state', (state, expected) => {
    expect(canUseAppConnect('account-a', state)).toBe(expected)
  })

  it('never enables app connect without a stable account identity', () => {
    expect(canUseAppConnect('', 'signed_in')).toBe(false)
  })

  it('focuses password reauthentication when Google is unavailable', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập lại' }))
    expect(globalThis.document.activeElement).toBe(screen.getByRole('textbox', { name: 'Account identifier' }))
    expect(signInToAtum).not.toHaveBeenCalled()
  })

  it('starts Google reauthentication when that provider is available', () => {
    $atumAccountStatus.set({
      state: 'expired',
      configured: true,
      account: { id: 'account-a' },
      errorCode: 'account_session_expired',
      providers: { google: true, password: true }
    })
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập lại' }))
    expect(signInToAtum).toHaveBeenCalledOnce()
  })
})

describe('AtumDmView conversation presentation', () => {
  it.each([
    ['specialist', 'Moon', 'Bắt đầu trò chuyện với Moon', 'Chuyên gia chiêm tinh', 'moon'],
    ['specialist', 'Atlas Studio', 'Bắt đầu trò chuyện với Atlas Studio', 'Cộng tác sáng tạo', 'atlas'],
    ['direct', 'Lan', 'Bắt đầu trò chuyện với Lan', null, undefined]
  ])('uses the same quiet Atum canvas for a %s conversation', (kind, title, emptyHeading, role, appSlug) => {
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: false, password: true }
    })
    writableConnectivity.set('online')
    $atumRoster.set([
      {
        id: 'conversation-1',
        title,
        kind,
        participantIds: kind === 'specialist' ? [appSlug!] : ['person-lan'],
        updatedAt: '2026-08-12T14:48:48.895781+00:00',
        lastMessageAt: null,
        unreadCount: 0,
        payload: kind === 'specialist' ? { specialist: appSlug } : {}
      }
    ])
    $atumStatus.set({
      accountId: 'account-a',
      connectivity: 'online',
      synchronized: true,
      cursor: 'cursor-a',
      lastSuccessfulSyncAt: '2026-08-13T00:00:00.000Z',
      nextRetryAt: null,
      errorCode: null
    })

    const { container } = renderView()

    expect(screen.getByRole('heading', { name: emptyHeading })).toBeTruthy()
    expect(screen.queryByText(title, { exact: true })).toBeNull()
    expect(container.querySelector('header')).toBeNull()
    expect(container.querySelectorAll('[data-atum-reconnect]')).toHaveLength(0)

    if (role) {
      expect(screen.getByText(role)).toBeTruthy()
    }
  })

  it('keeps the connected direct conversation open when the mention bridge is unavailable', async () => {
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: false, password: true }
    })
    writableConnectivity.set('online')
    $atumRoster.set([
      {
        id: 'conversation-1',
        title: 'Lan',
        kind: 'direct',
        participantIds: ['account-a', 'person-lan'],
        updatedAt: '2026-08-12T14:48:48.895781+00:00',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {}
      }
    ])
    $atumSocialRelationships.set([
      {
        availability: 'available',
        profile: { profileId: 'person-lan', displayName: 'Lan', handle: 'lan-demo', verified: false, avatar: null },
        state: 'connected',
        version: 1,
        canMessage: true,
        directThreadId: 'conversation-1'
      }
    ])

    const { container } = renderView()

    expect(screen.getByText(/Atum chỉ tham gia/)).toBeTruthy()
    expect(container.querySelector('[data-dm-assistant-presence="explicit-mention"]')).toBeTruthy()
    expect(await screen.findByText('Chưa thể tải trợ lý để nhắc đến. Kiểm tra kết nối rồi thử lại.')).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('hides the composer for a retired group instead of presenting a loading placeholder', () => {
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: false, password: true }
    })
    writableConnectivity.set('online')
    $groupCapabilities.set({ available: true, creationEnabled: false, humanMemberLimit: 32 })
    $atumRoster.set([
      {
        id: 'conversation-1',
        title: 'Planning',
        kind: 'group',
        participantIds: ['account-a', 'lan'],
        updatedAt: '2026-09-06T00:00:00.000Z',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {},
        group: {
          conversationId: 'conversation-1',
          title: 'Planning',
          revision: 2,
          retiredAt: '2026-09-06T00:00:00.000Z',
          membershipEpoch: 1,
          members: [
            { userId: 'account-a', displayName: 'Minh', handle: 'minh', role: 'owner', membershipEpoch: 1 },
            { userId: 'lan', displayName: 'Lan', handle: 'lan', role: 'member', membershipEpoch: 1 }
          ],
          updatedAt: '2026-09-06T00:00:00.000Z'
        }
      }
    ])

    renderView()

    expect(screen.getByText('Nhóm này chỉ đọc. Bạn vẫn có thể rời nhóm hoặc báo cáo.')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Soạn tin nhắn' })).toBeNull()
  })

  it('keeps a previous room search from replacing results in the current room', async () => {
    const first = deferred<Array<{ message: { id: string; content: string }; conversationTitle: string | null }>>()
    const second = deferred<Array<{ message: { id: string; content: string }; conversationTitle: string | null }>>()
    const searchMessages = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal(
      'window',
      Object.assign(globalThis.window, {
        hermesDesktop: {
          messaging: {
            groupCapabilities: vi
              .fn()
              .mockResolvedValue({ available: false, creationEnabled: false, humanMemberLimit: 32 }),
            groupOperations: vi.fn().mockResolvedValue([]),
            searchMessages
          }
        }
      })
    )
    $atumRoster.set([
      {
        id: 'conversation-1',
        title: 'Lan',
        kind: 'direct',
        participantIds: ['account-a', 'lan'],
        updatedAt: '2026-09-06T00:00:00.000Z',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {}
      },
      {
        id: 'conversation-2',
        title: 'Mai',
        kind: 'direct',
        participantIds: ['account-a', 'mai'],
        updatedAt: '2026-09-06T00:00:00.000Z',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {}
      }
    ])

    renderSearchView()
    fireEvent.click(screen.getByRole('button', { name: 'Tìm tin nhắn' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Tìm tin nhắn' }), { target: { value: 'old' } })
    expect(searchMessages).toHaveBeenCalledWith('old', 'conversation-1')
    fireEvent.click(screen.getByRole('button', { name: 'Open second conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tìm tin nhắn' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Tìm tin nhắn' }), { target: { value: 'new' } })
    expect(searchMessages).toHaveBeenCalledWith('new', 'conversation-2')

    second.resolve([{ message: { id: 'new-result', content: 'new room match' }, conversationTitle: 'Mai' }])
    await screen.findByText('new room match')
    first.resolve([{ message: { id: 'old-result', content: 'old room match' }, conversationTitle: 'Lan' }])

    await waitFor(() => expect(screen.queryByText('old room match')).toBeNull())
    expect(screen.getByText('new room match')).toBeTruthy()
  })
})
