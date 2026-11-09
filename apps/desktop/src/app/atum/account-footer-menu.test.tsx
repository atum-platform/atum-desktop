import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'

/**
 * The account menu's Pet submenu acts on the *gateway* profile — the one whose
 * backend is connected — which lags the chat in front while a profile's
 * backend is still starting. Acting inside that window pops out, or hides, the
 * previous assistant's pet. Seen for real on a packaged run: Gamma in front,
 * still connecting, and "Pop out to desktop" popped out Beta.
 */

// Spread the real module and override only what this test pins: a hand-picked
// partial mock breaks each time the store chain reaches one more export.
vi.mock('@/store/atum-messaging', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { atom } = await import('nanostores')

  return {
    ...actual,
    $atumAccountScopeId: atom('account-1'),
    $atumAccountStatus: atom<AtumAccountStatus>({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-1', displayName: 'An Example', handle: 'minh' },
      errorCode: null,
      providers: { google: true, password: false }
    } as AtumAccountStatus),
    refreshAtumAccountStatus: vi.fn(),
    signInToAtum: vi.fn(async () => undefined),
    signOutOfAtum: vi.fn()
  }
})

const { I18nProvider } = await import('@/i18n')
const { $discoverShelf, $railDestination, resetAtumShellState } = await import('@/store/atum-shell')
const { $petInfoByAgent, syncActivePetViews } = await import('@/store/pet')
const { $activeGatewayProfile, $gatewaySwapTarget } = await import('@/store/profile')
const { AtumAccountMenu } = await import('./account-footer-menu')

function openPetSubmenu() {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <AtumAccountMenu>
          <button>Account menu</button>
        </AtumAccountMenu>
      </MemoryRouter>
    </I18nProvider>
  )
  // Radix opens on keyboard in jsdom (no pointer events); ArrowRight opens a
  // submenu from its trigger, the same way usage-meter.test.tsx drives it.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Account menu' }), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByRole('menuitem', { name: /^Pet$/u }), { key: 'ArrowRight' })
}

const item = (name: RegExp) => screen.getByRole('menuitem', { name })

const isDisabled = (el: HTMLElement) =>
  el.getAttribute('data-disabled') !== null || el.getAttribute('aria-disabled') === 'true'

beforeEach(() => {
  resetAtumShellState()
  $activeGatewayProfile.set('default')
  $petInfoByAgent.set({ default: { displayName: 'Gigi', enabled: true, slug: 'gigi' } })
  syncActivePetViews()
  $gatewaySwapTarget.set(null)
})

afterEach(() => {
  $gatewaySwapTarget.set(null)
  cleanup()
})

describe('the account menu’s pet rows', () => {
  it('offer to hide and pop out when the gateway profile is settled', () => {
    openPetSubmenu()

    expect(isDisabled(item(/Hide pet/u))).toBe(false)
    expect(isDisabled(item(/Pop out to desktop/u))).toBe(false)
  })

  it('wait out a profile swap instead of acting on the previous assistant', () => {
    $gatewaySwapTarget.set('gamma')
    openPetSubmenu()

    expect(isDisabled(item(/Hide pet/u))).toBe(true)
    expect(isDisabled(item(/Pop out to desktop/u))).toBe(true)
  })

  it('cannot place a pet that does not exist', () => {
    $petInfoByAgent.set({ default: { enabled: false } })
    syncActivePetViews()
    openPetSubmenu()

    expect(isDisabled(item(/Show pet/u))).toBe(false)
    expect(isDisabled(item(/Pop out to desktop/u))).toBe(true)
  })
})

function LocationProbe() {
  return <output data-testid="destination">{useLocation().search}</output>
}

it('opens the Protons settings destination from the account menu', () => {
  render(
    <MemoryRouter>
      <AtumAccountMenu>
        <button>Account menu</button>
      </AtumAccountMenu>
      <LocationProbe />
    </MemoryRouter>
  )
  fireEvent.keyDown(screen.getByRole('button', { name: 'Account menu' }), { key: 'ArrowDown' })
  const row = screen.getByRole('menuitem', { name: /^Protons/ })
  // The Proton mark is the row's icon, not a generic chart, and the row never
  // turns into a running balance.
  expect(row.querySelector('svg[data-proton-mark]')).toBeTruthy()
  expect(row.querySelector('[data-proton-amount]')).toBeNull()
  expect(row.textContent).not.toMatch(/\d/)
  fireEvent.click(row)
  expect(screen.getByTestId('destination').textContent).toBe('?tab=atum:protons')
  expect(screen.queryByRole('dialog', { name: 'Your account' })).toBeNull()
})

it('keeps the account-sheet entry first and never adds an ambient balance', () => {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <AtumAccountMenu>
          <button>Account menu</button>
        </AtumAccountMenu>
      </MemoryRouter>
    </I18nProvider>
  )
  fireEvent.keyDown(screen.getByRole('button', { name: 'Account menu' }), { key: 'ArrowDown' })

  const menu = screen.getByRole('menu')
  const entries = within(menu).getAllByRole('menuitem')

  expect(entries[0]?.hasAttribute('data-atum-account-profile')).toBe(true)
  expect(entries[0]?.textContent).toContain('An Example')
  expect(menu.querySelector('[data-proton-amount], [data-atum-balance]')).toBeNull()
})

describe('the account menu as a storefront entry point', () => {
  it('opens the storefront on the Pets shelf from "Pet Store…" — no more silent /pets navigation', () => {
    openPetSubmenu()

    fireEvent.click(item(/^Pet Store…$/u))

    // The store is Discover's shelf now: the rail lights up and the shelf
    // intent is seeded. From chat there is no URL to change.
    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
  })

  it('opens the storefront on the People shelf from "Invite a friend"', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MemoryRouter>
          <AtumAccountMenu>
            <button>Account menu</button>
          </AtumAccountMenu>
        </MemoryRouter>
      </I18nProvider>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Account menu' }), { key: 'ArrowDown' })

    fireEvent.click(item(/^Invite a friend$/u))

    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('people')
  })
})
