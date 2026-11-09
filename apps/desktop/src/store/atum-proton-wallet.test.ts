import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const $atumAccountScopeId = atom<null | string>('account-a')

vi.mock('./atum-messaging', () => ({ $atumAccountScopeId }))

const { $atumProtonWallet, refreshAtumProtonWallet } = await import('./atum-proton-wallet')

const pausedWallet = {
  spending_enabled: false,
  available_protons: 0,
  held_protons: 0,
  trial_protons: 0,
  ai_protons_per_usd: 40_500,
  balance_protons: 0,
  funded: false
}

const wallet = vi.fn()

beforeEach(() => {
  $atumAccountScopeId.set('account-a')
  $atumProtonWallet.set({ state: 'idle', accountId: 'account-a', knownSpendingEnabled: false })
  wallet.mockReset()
  vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { protons: { wallet } } }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Atum Proton wallet cache', () => {
  it('does not publish an outgoing account wallet after a scope switch', async () => {
    let resolveFirst!: (value: unknown) => void
    wallet.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))

    const first = refreshAtumProtonWallet()
    $atumAccountScopeId.set('account-b')
    resolveFirst({ ...pausedWallet, balance_protons: 99 })
    await first

    expect($atumProtonWallet.get()).toEqual({ state: 'idle', accountId: 'account-b', knownSpendingEnabled: false })
  })

  it('adopts only the current account response', async () => {
    $atumAccountScopeId.set('account-b')
    wallet.mockResolvedValue({ ...pausedWallet, balance_protons: 12 })

    await refreshAtumProtonWallet()

    expect($atumProtonWallet.get()).toEqual({
      state: 'resolved',
      accountId: 'account-b',
      knownSpendingEnabled: false,
      wallet: { ...pausedWallet, balance_protons: 12, spending_enabled: false }
    })
  })

  it('retains only the known cloud-spending mode while a refresh fails', async () => {
    wallet.mockResolvedValueOnce({
      ...pausedWallet,
      spending_enabled: true,
      available_protons: 12.3456,
      held_protons: 0,
      trial_protons: 10_000,
      ai_protons_per_usd: 40_500
    })
    await refreshAtumProtonWallet()
    wallet.mockRejectedValueOnce(new Error('offline'))

    const refresh = refreshAtumProtonWallet()
    expect($atumProtonWallet.get()).toMatchObject({ state: 'loading', knownSpendingEnabled: true })
    await refresh

    expect($atumProtonWallet.get()).toEqual({ state: 'unavailable', accountId: 'account-a', knownSpendingEnabled: true })
  })
})
