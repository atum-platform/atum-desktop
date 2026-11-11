import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { DESKTOP_LOCALES, type DesktopLocale } from '../../../shared/desktop-locale'
import type { MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixCheckoutSnapshot, MatrixTopUpPack } from '../../../shared/matrix-checkout'
import { matrixFundsCopy } from '../../../shared/matrix-funds-copy'
import { $assistantCard } from '../assistant-card/store'
import { matrixStoreCopy } from '../store/store-copy'

import { FundsNoticeLine } from './funds-line'
import { $fundsTopUp, closeFundsTopUp, openFundsTopUp } from './top-up-request'
import { FundsTopUpHost } from './top-up-sheet'

const MICRO = 1_000_000

const pack = (id: string, total: number): MatrixTopUpPack => ({
  id,
  amountVnd: total,
  paidMicroProtons: total * MICRO,
  bonusMicroProtons: 0,
  totalMicroProtons: total * MICRO
})

const checkout: MatrixCheckoutSnapshot = {
  state: 'ready',
  packs: [pack('protons-50k', 50_000), pack('protons-100k', 100_000), pack('protons-500k', 500_000)],
  checkoutOpen: true,
  order: null,
  reconciliationPending: false,
  intent: null
}

const page = (children: React.ReactNode, locale: DesktopLocale = 'en') => (
  <I18nProvider configClient={null} initialLocale={locale}>
    {children}
  </I18nProvider>
)

function bridge(withCheckout: boolean) {
  const checkoutBridge = {
    refresh: vi.fn(async () => {}),
    start: vi.fn(async () => ({})),
    status: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
    openCheckout: vi.fn(async () => {}),
    dismissTerminal: vi.fn(async () => {})
  }

  const value = { openTopUp: vi.fn(async () => {}), checkout: checkoutBridge }
  Object.assign(window, {
    atumMatrix: (withCheckout ? value : { openTopUp: value.openTopUp }) as unknown as MatrixUiBridge
  })

  return value
}

afterEach(() => {
  act(() => closeFundsTopUp())
  $assistantCard.set(null)
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('a funds line in a chat', () => {
  it.each(DESKTOP_LOCALES)('says out of Protons in the reader’s language with one Add Protons button (%s)', locale => {
    const copy = matrixFundsCopy(locale)
    bridge(true)
    render(page(<><FundsNoticeLine kind="out_of_protons" /><FundsTopUpHost snapshot={{ checkout }} /></>, locale))

    expect(screen.getByText(copy.outOfProtons)).toBeTruthy()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect($fundsTopUp.get()).not.toBeNull()
  })

  it.each(['en', 'vi'] as const)('opens the assistant’s card from a daily limit (%s)', locale => {
    const copy = matrixFundsCopy(locale)
    render(page(<FundsNoticeLine agentPrincipal="agent-1" kind="daily_cap" />, locale))

    expect(screen.getByText(copy.dailyCap)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.raiseLimit }))
    expect($assistantCard.get()).toEqual({ kind: 'agent', principal: 'agent-1' })
    expect($fundsTopUp.get()).toBeNull()
  })

  it('offers no button for a daily limit it cannot place on an assistant', () => {
    render(page(<FundsNoticeLine kind="daily_cap" />))

    expect(screen.getByText(matrixFundsCopy('en').dailyCap)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('the in-place top-up', () => {
  it('opens the Store’s packs over the current view, the pack covering the need first, and closes after paying', async () => {
    const value = bridge(true)
    render(page(<FundsTopUpHost snapshot={{ checkout }} />))

    act(() => void openFundsTopUp(60_000))
    const sheet = within(await screen.findByRole('dialog', { name: matrixFundsCopy('en').addProtons }))

    await waitFor(() => expect(value.checkout.refresh).toHaveBeenCalledOnce())
    const suggested = window.document.querySelector('[data-matrix-topup-pack="protons-100k"] [data-matrix-topup-suggested]')
    expect(suggested).toBeTruthy()
    expect(window.document.querySelectorAll('[data-matrix-topup-suggested]')).toHaveLength(1)
    // Keyboard focus starts on the offered pack, the one primary action.
    await waitFor(() => expect(window.document.activeElement).toBe(suggested))
    // Buying is the Store's own order path: the same pack id reaches the same bridge.
    fireEvent.click(within(suggested!.closest('[data-matrix-topup-pack]') as HTMLElement).getByRole('button'))
    await waitFor(() => expect(value.checkout.start).toHaveBeenCalledWith('protons-100k'))
    expect(value.openTopUp).not.toHaveBeenCalled()
    expect(sheet.getAllByRole('button', { name: matrixStoreCopy('en').checkoutBuy }).length).toBe(3)
  })

  it('reads the packs again for each new ask and closes with Escape', async () => {
    const value = bridge(true)
    render(page(<FundsTopUpHost snapshot={{ checkout }} />, 'vi'))

    act(() => void openFundsTopUp())
    await screen.findByRole('dialog', { name: matrixFundsCopy('vi').addProtons })
    act(() => void openFundsTopUp(100_000))
    await waitFor(() => expect(value.checkout.refresh).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect($fundsTopUp.get()).toBeNull()
  })

  it('keeps the existing payments page in a build without the in-app checkout', async () => {
    const value = bridge(false)
    render(page(<FundsTopUpHost snapshot={{}} />))

    act(() => void openFundsTopUp(60_000))
    await waitFor(() => expect(value.openTopUp).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect($fundsTopUp.get()).toBeNull()
  })

  it('is not asked for before the window can show it', () => {
    expect(openFundsTopUp()).toBe(false)
    expect($fundsTopUp.get()).toBeNull()
  })
})
