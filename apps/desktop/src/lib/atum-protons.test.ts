import { describe, expect, it } from 'vitest'

import { protonBankName } from '../../shared/matrix-checkout'

import { parseProtonWallet } from './atum-protons'

const wallet = {
  balance_protons: 12_345,
  available_protons: 12_300.125,
  held_protons: 44.875,
  trial_protons: 10_000,
  ai_protons_per_usd: 40_500,
  funded: true,
  spending_enabled: false
}

describe('legacy Protons wallet parser', () => {
  it('accepts the read-only wallet with decimal display values', () => {
    expect(parseProtonWallet(wallet)).toEqual(wallet)
  })

  it('projects no checkout state even when the retired platform route still sends it', () => {
    const parsed = parseProtonWallet({
      ...wallet,
      checkout_enabled: true,
      orders: [{ id: '00000000-0000-4000-8000-11e594f48195', status: 'pending' }],
      packages: [{ id: 'protons-100k' }]
    })

    expect(parsed).toEqual(wallet)

    for (const key of ['checkout_enabled', 'orders', 'packages']) {expect(parsed).not.toHaveProperty(key)}
  })

  it('rejects an incomplete or non-finite projection', () => {
    expect(parseProtonWallet({ ...wallet, held_protons: Infinity })).toBeNull()
    expect(parseProtonWallet({ ...wallet, trial_protons: undefined })).toBeNull()
    expect(parseProtonWallet({ ...wallet, spending_enabled: 'no' })).toBeNull()
    expect(parseProtonWallet({ ...wallet, balance_protons: 1.5 })).toBeNull()
  })
})

describe('Matrix QR bank names', () => {
  it('names the bank Moon names and otherwise shows the BIN', () => {
    expect(protonBankName('970422')).toBe('MB Bank')
    expect(protonBankName('970999')).toBe('970999')
  })
})
