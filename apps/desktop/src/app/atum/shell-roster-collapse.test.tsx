import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'

/**
 * The roster must collapse on Discover at a wide window (review: #283's
 * defect, on atum-main). `shell-layout.ts` computes `sidebarShowing` with
 * `rosterSuppressed` in it; the roster slot's presence must read the same fact.
 *
 * jsdom never fires transitionend, so width and final presence lie — but
 * `useMotionPresence` flips the slot's `data-atum-motion` phase SYNCHRONOUSLY
 * when its flag flips, and that is truthful. That is what this asserts.
 */

// Spread the real module and pin only what the shell drives on mount: a
// hand-picked partial mock breaks each time the store chain grows.
vi.mock('@/store/atum-messaging', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { atom } = await import('nanostores')

  return {
    ...actual,
    $atumAccountScopeId: atom('a'),
    $atumAccountStatus: atom<AtumAccountStatus>({
      state: 'signed_in',
      configured: true,
      account: { id: 'a', displayName: 'Minh' },
      errorCode: null,
      providers: { google: true, password: true }
    } as AtumAccountStatus),
    $atumRoster: atom([]),
    $atumSortedRoster: atom([]),
    initializeAtumMessaging: vi.fn(async () => undefined),
    refreshAtumAccountStatus: vi.fn(),
    refreshAtumRoster: vi.fn(),
    signInToAtum: vi.fn(async () => undefined),
    signOutOfAtum: vi.fn()
  }
})

const { $previewTarget } = await import('@/store/preview')
const { resetManagedModelAccess } = await import('@/store/atum-managed-model')
const { $currentCwd } = await import('@/store/session')
const { $atumUpdate } = await import('@/store/atum-updates')
const { $notifications } = await import('@/store/notifications')
const { completeDesktopBoot } = await import('@/store/boot')
const { $railDestination, $sidebarOpen, resetAtumShellState } = await import('@/store/atum-shell')
const { $activeWorkbenchTabId, clearWorkbenchTabs } = await import('@/store/workbench-tabs')
const { AtumShellRoot } = await import('./shell')

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AtumShellRoot />
    </MemoryRouter>
  )
}

beforeEach(() => {
  completeDesktopBoot()
  $atumUpdate.set(null)
  $notifications.set([])
  Object.assign(window, {
    hermesDesktop: {
      ...window.hermesDesktop,
      appUpdate: { relaunch: vi.fn(async () => ({ accepted: true })) }
    }
  })
  window.localStorage.setItem('hermes.desktop.atum.welcomeSeen', 'true')
  resetManagedModelAccess()
  resetAtumShellState()
  clearWorkbenchTabs()
  $activeWorkbenchTabId.set(null)
  // The wide window: at or above the 1024px compact breakpoint.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  $previewTarget.set(null)
  $currentCwd.set('')
})

afterEach(cleanup)

describe('the roster on Discover (wide window)', () => {
  it('animates the roster slot away and leaves exactly one live sidebar toggle, labelled for the state on screen', async () => {
    const { container } = renderShell()

    const slot = () => container.querySelector<HTMLElement>('[data-atum-roster-slot]')

    const liveToggles = () =>
      Array.from(container.querySelectorAll('[data-atum-sidebar-toggle]')).filter(node => !node.closest('[inert]'))

    // On chat: the roster shows and its header owns the one toggle.
    expect(slot()).toBeTruthy()
    expect(liveToggles()).toHaveLength(1)
    expect(liveToggles()[0]!.getAttribute('aria-label')).toBe('Hide sidebar')

    act(() => $railDestination.set('discover'))

    expect(container.querySelector('[data-atum-discover]')).toBeTruthy()
    // The decision is synchronous even though the animation never completes in
    // jsdom: the slot is exiting (and inert) or already gone — never still
    // 'open' at full width beside the storefront.
    const during = slot()
    expect(during === null || during.getAttribute('data-atum-motion') === 'exiting').toBe(true)
    expect(during === null || during.hasAttribute('inert')).toBe(true)

    // One toggle, owned by the main column now, and it reads correctly for a
    // sidebar that is NOT showing — never two, never "Show sidebar" twice.
    expect(liveToggles()).toHaveLength(1)
    expect(liveToggles()[0]!.getAttribute('aria-label')).toBe('Show sidebar')

    // The exit settles (the presence timeout fires even without transitionend).
    await waitFor(() => expect(slot()?.style.display).toBe('none'))
    expect(slot()?.hasAttribute('inert')).toBe(true)
    expect(liveToggles()).toHaveLength(1)

    // Asking for the roster on Discover brings it back (a default, not a lock)…
    fireEvent.click(liveToggles()[0]!)
    expect(slot()).toBeTruthy()

    // …and leaving Discover restores exactly what chat had.
    act(() => $railDestination.set('chat'))
    expect(slot()).toBeTruthy()
    expect($sidebarOpen.get()).toBe(true)
    expect(liveToggles()).toHaveLength(1)
    expect(liveToggles()[0]!.getAttribute('aria-label')).toBe('Hide sidebar')
  })
})
