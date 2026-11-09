import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { $atumAccountStatus } from '@/store/atum-messaging'

vi.mock('@/store/atum-messaging', async () => {
  const { atom } = await import('nanostores')

  return {
    $atumAccountScopeId: atom('a'),
    $atumAccountStatus: atom({
      state: 'signed_in',
      configured: true,
      account: { id: 'a', displayName: 'Minh' },
      errorCode: null,
      providers: { google: true, password: true }
    }),
    $atumConnectivity: atom('online'),
    $atumSortedRoster: atom([
      {
        id: 'conversation-1',
        title: 'Moon',
        kind: 'direct',
        participantIds: ['moon'],
        updatedAt: '2026-08-12T00:00:00.000Z',
        lastMessageAt: '2026-08-12T00:00:00.000Z',
        unreadCount: 2,
        payload: { preview: 'Chào Minh' }
      }
    ]),
    initializeAtumMessaging: vi.fn(),
    refreshAtumRoster: vi.fn(),
    signOutOfAtum: vi.fn()
  }
})

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      dm: {
        sectionTitle: 'Tin nhắn',
        offline: 'Ngoại tuyến',
        reconnecting: 'Đang kết nối lại...',
        authExpired: 'Hết phiên đăng nhập',
        errorGeneric: 'Lỗi kết nối',
        unavailable: 'Chưa cấu hình',
        notSignedIn: 'Chưa đăng nhập',
        authExpiredAction: 'Đăng nhập lại',
        signIn: 'Đăng nhập',
        signedInAs: (name: string) => `Đã đăng nhập: ${name}`,
        signOut: 'Đăng xuất',
        unreadCount: (count: number) => `${count} tin chưa đọc`,
        noConversations: 'Chưa có cuộc trò chuyện'
      }
    }
  })
}))

import { AtumSection } from './atum-section'

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

function renderSection(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SidebarProvider>
        <Routes>
          <Route
            element={
              <>
                <AtumSection />
                <LocationProbe />
              </>
            }
            path="*"
          />
        </Routes>
      </SidebarProvider>
    </MemoryRouter>
  )
}

afterEach(cleanup)

beforeEach(() => {
  $atumAccountStatus.set({
    state: 'signed_in',
    configured: true,
    account: { id: 'a', displayName: 'Minh' },
    errorCode: null,
    providers: { google: true, password: true }
  })
})

describe('AtumSection', () => {
  it('renders roster/unread state and highlights the routed conversation', () => {
    renderSection('/dm/conversation-1')

    expect(screen.getByText('Tin nhắn')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Moon, 2 tin chưa đọc' }).getAttribute('aria-current')).toBe('page')
  })

  it('navigates within the existing router instead of opening a second mode', () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Moon, 2 tin chưa đọc' }))

    expect(screen.getByTestId('location').textContent).toBe('/dm/conversation-1')
  })

  // The inline sidebar sign-in is gone for good: credentials are never
  // collected in a 274px rail. The section offers a door to the full-window
  // gate (src/app/atum/auth-view.tsx) and nothing else.
  it('never renders credential fields when signed out', () => {
    $atumAccountStatus.set({
      state: 'signed_out',
      configured: true,
      account: null,
      errorCode: null,
      providers: { google: true, password: true }
    })
    renderSection()

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Google/ })).toBeNull()
  })

  it('sends a signed-out user to the full-window auth route', () => {
    $atumAccountStatus.set({
      state: 'signed_out',
      configured: true,
      account: null,
      errorCode: null,
      providers: { google: true, password: true }
    })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }))

    expect(screen.getByTestId('location').textContent).toBe('/sign-in')
  })

  it('uses the reauthentication label when the session expired', () => {
    $atumAccountStatus.set({
      state: 'expired',
      configured: true,
      account: null,
      errorCode: null,
      providers: { google: true, password: true }
    })
    renderSection()

    expect(screen.getByRole('button', { name: 'Đăng nhập lại' })).toBeTruthy()
  })

  it('offers no sign-in door at all when the build cannot sign in', () => {
    $atumAccountStatus.set({
      state: 'unconfigured',
      configured: false,
      account: null,
      errorCode: null,
      providers: { google: false, password: false }
    })
    renderSection()

    expect(screen.getByText('Chưa cấu hình')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Đăng nhập' })).toBeNull()
  })
})
