import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'

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
const { resetManagedModelAccess } = await import('@/store/atum-managed-model')
const { $atumProtonWallet } = await import('@/store/atum-proton-wallet')
const { UsageMeterPopover } = await import('./usage-meter')
const { AtumAccountMenu } = await import('./account-footer-menu')

/** A rendered Proton amount (mark, number, hidden word) by the phrase it reads as. */
const protonAmount = (phrase: string) => (_content: string, element: Element | null) =>
  Boolean(element?.hasAttribute('data-proton-amount') && element.textContent === phrase)

const access = vi.fn(async () => ({ state: 'ready', billing_currency: 'protons', access_alias: 'binh-minh' }))
const wallet = vi.fn()

const pausedWallet = {
  spending_enabled: false,
  available_protons: 0,
  held_protons: 0,
  trial_protons: 0,
  ai_protons_per_usd: 40_500,
  balance_protons: 0,
  funded: false
}

function renderMeter() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter><UsageMeterPopover buttonClassName="rail-button" /></MemoryRouter>
    </I18nProvider>
  )
}

beforeEach(() => {
  resetManagedModelAccess()
  $atumProtonWallet.set({ state: 'idle', accountId: 'account-1', knownSpendingEnabled: false })
  access.mockClear()
  wallet.mockReset()
  wallet.mockResolvedValue(pausedWallet)
  vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { managedModel: { access }, protons: { wallet } } }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(async () => {
  cleanup()
  // Radix FocusScope dispatches its deferred unmount event before jsdom teardown.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('rail wallet', () => {
  it('never puts what is left to spend in the popover', async () => {
    wallet.mockResolvedValue({ ...pausedWallet, balance_protons: 25, available_protons: 25, spending_enabled: true })
    renderMeter()
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))

    expect(await screen.findByRole('button', { name: 'Usage details and recent turns' })).not.toBeNull()
    expect(globalThis.document.body.textContent).not.toMatch(/25|Available to spend|Held/)
    expect(access).not.toHaveBeenCalled()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('says a paused account is paused without a figure', async () => {
    wallet.mockResolvedValue({ ...pausedWallet, balance_protons: 25, available_protons: 25, spending_enabled: false })
    renderMeter()
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))

    expect(await screen.findByText('Atum is temporarily paused. Your work is saved.')).not.toBeNull()
    expect(globalThis.document.body.textContent).not.toMatch(/25|Available to spend|Held/)
    expect(access).not.toHaveBeenCalled()
  })

  it('offers a quiet wallet recovery on demand when its read fails', async () => {
    wallet.mockRejectedValue(new Error('offline'))
    renderMeter()
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    expect(await screen.findByRole('button', { name: 'Retry' })).not.toBeNull()
    expect(globalThis.document.body.textContent).not.toMatch(/Balance unavailable|Available to spend/)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(access).not.toHaveBeenCalled()
  })

  it('keeps the ledger amount out even when cloud spending is enabled', async () => {
    wallet.mockResolvedValue({
      balance_protons: 12_345,
      available_protons: 12_300.125,
      held_protons: 44.875,
      trial_protons: 10_000,
      ai_protons_per_usd: 40_500,
      funded: true,
      spending_enabled: true
    })
    renderMeter()

    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))

    expect(await screen.findByRole('button', { name: 'Usage details and recent turns' })).not.toBeNull()
    expect(globalThis.document.body.textContent).not.toMatch(/12,300|12,345|44.875|10,000|Available to spend|Held/)
    expect(globalThis.document.body.textContent).not.toMatch(/USD|AI provider cost|40,500/)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText('25% used')).toBeNull()
  })

  it('keeps the legacy allowance hidden when a known wallet refresh fails', async () => {
    $atumProtonWallet.set({
      state: 'resolved',
      accountId: 'account-1',
      knownSpendingEnabled: true,
      wallet: {
        balance_protons: 12_345,
        available_protons: 12_300.125,
        held_protons: 44.875,
        trial_protons: 10_000,
        ai_protons_per_usd: 40_500,
        funded: true,
        spending_enabled: true
      }
    })
    wallet.mockRejectedValue(new Error('offline'))
    renderMeter()

    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))

    expect(await screen.findByRole('button', { name: 'Retry' })).not.toBeNull()
    expect(globalThis.document.body.textContent).not.toMatch(/12,300|Available to spend|Held/)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText('25% used')).toBeNull()
  })
})

describe('account footer wallet', () => {
  function renderFooter() {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MemoryRouter>
          <AtumAccountMenu><button>Account menu</button></AtumAccountMenu>
        </MemoryRouter>
      </I18nProvider>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Account menu' }), { key: 'ArrowDown' })
  }

  it('never renders or reads a balance in the menu', async () => {
    wallet.mockResolvedValue({
      ...pausedWallet,
      balance_protons: 12_345,
      available_protons: 12_300.125,
      held_protons: 44.875,
      trial_protons: 10_000,
      ai_protons_per_usd: 40_500,
      spending_enabled: true
    })
    renderFooter()

    expect(screen.getByRole('menuitem', { name: /^Protons/ })).not.toBeNull()
    expect(screen.queryByText(protonAmount('12,300.125 Protons'))).toBeNull()
    expect(globalThis.document.body.textContent).not.toMatch(/12,300|12,345|Available to spend/)
    expect(wallet).not.toHaveBeenCalled()
  })
})
