import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const $atumAccountScopeId = atom<null | string>('account-a')

vi.mock('@/store/atum-messaging', () => ({ $atumAccountScopeId }))

const { ProtonWalletSection } = await import('./proton-wallet')

const wallet = vi.fn()
const rewards = vi.fn()

/** A rendered Proton amount (the mark, the number, the hidden word) by the phrase it reads as. */
const amount = (phrase: string) => (_content: string, element: Element | null) =>
  Boolean(element?.hasAttribute('data-proton-amount') && element.textContent === phrase)

const read = (overrides: Record<string, unknown> = {}) => ({
  balance_protons: 12_345,
  available_protons: 12_300.125,
  held_protons: 44.875,
  trial_protons: 10_000,
  ai_protons_per_usd: 40_500,
  funded: true,
  spending_enabled: true,
  ...overrides
})

beforeEach(() => {
  // Cycling the account resets the wallet store's in-flight read and
  // generation, so no request left over from a previous test can land here.
  $atumAccountScopeId.set(null)
  $atumAccountScopeId.set('account-a')
  wallet.mockReset()
  rewards.mockReset().mockRejectedValue(new Error('offline'))
  Object.assign(window, { hermesDesktop: { protons: { rewards, wallet } } })
})

afterEach(() => cleanup())

describe('ProtonWalletSection (legacy, read-only)', () => {
  it('presents the server balance and held amount without deriving a charge', async () => {
    wallet.mockResolvedValue(read())
    render(<ProtonWalletSection />)

    expect(await screen.findByText(amount('12,300.125 Protons'))).toBeTruthy()
    expect(screen.queryByText(amount('12,345 Protons'))).toBeNull()
    expect(screen.getByText(amount('44.875 Protons'))).toBeTruthy()
    expect(window.document.body.textContent).not.toMatch(/USD|1 Proton =|provider cost|40,500/u)
  })

  it('offers no purchase even when the retired platform route still reports checkout', async () => {
    wallet.mockResolvedValue(read({
      checkout_enabled: true,
      orders: [{ id: '00000000-0000-4000-8000-11e594f48195', status: 'pending' }],
      packages: [{ amount_vnd: 95_000, bonus_protons: 5_000, id: 'protons-100k', paid_protons: 95_000, total_protons: 100_000 }]
    }))
    render(<ProtonWalletSection />)

    expect(await screen.findByText(amount('12,300.125 Protons'))).toBeTruthy()
    expect(window.document.querySelector('[data-atum-proton-pack], [data-atum-proton-packs], [data-atum-qr-panel]')).toBeNull()
    expect(screen.queryByRole('button', { name: /buy|checkout|top.?up/iu })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Proton purchase terms' })).toBeNull()
  })

  it('says the balance is unavailable when the wallet read fails', async () => {
    wallet.mockRejectedValue(new Error('offline'))
    render(<ProtonWalletSection />)

    await waitFor(() => expect(wallet).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(window.document.querySelector('[data-atum-proton-wallet]')?.textContent).toMatch(/unavailable/iu))
  })

  it('clears the outgoing balance while the incoming account is loading', async () => {
    wallet.mockResolvedValueOnce(read({ available_protons: 123_456 }))
    render(<ProtonWalletSection />)
    expect(await screen.findByText(amount('123,456 Protons'))).toBeTruthy()

    let resolveIncoming!: (value: unknown) => void
    wallet.mockImplementationOnce(() => new Promise(resolve => { resolveIncoming = resolve }))
    act(() => $atumAccountScopeId.set('account-b'))
    await waitFor(() => expect(wallet).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(amount('123,456 Protons'))).toBeNull()

    await act(async () => resolveIncoming(read({ available_protons: 0, held_protons: 0 })))
    expect(await screen.findByText(amount('0 Protons'))).toBeTruthy()
  })
})
