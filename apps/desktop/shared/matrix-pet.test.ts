import { describe, expect, it } from 'vitest'

import { type MatrixPetCatalog, matrixPetHatchQuoteMatches } from './matrix-pet'

const catalog: MatrixPetCatalog = {
  owner: 'owner',
  agent: 'agent',
  serverTime: '2026-10-03T00:00:00.000Z',
  items: [],
  personal: [],
  visit: { state: 'none', startedAt: null, endsAt: null },
  hatch: {
    offer: {
      id: '00000000-0000-4000-8000-bd7662a5eeb4',
      version: 1,
      priceMicroProtons: 65_000_000_000,
      scope: 'account',
      billingInterval: 'one_time',
      delivery: 'cloud'
    },
    creditEntitlementId: null,
    roundsLeft: 3
  }
}

describe('Matrix hatch quote', () => {
  it('accepts only the exact offer shown to the customer before work can start', () => {
    expect(
      matrixPetHatchQuoteMatches(catalog, {
        kind: 'offer',
        id: catalog.hatch.offer!.id,
        version: 1,
        priceMicroProtons: 65_000_000_000
      })
    ).toBe(true)
    expect(
      matrixPetHatchQuoteMatches(catalog, {
        kind: 'offer',
        id: catalog.hatch.offer!.id,
        version: 1,
        priceMicroProtons: 180_000_000_000
      })
    ).toBe(false)
    expect(
      matrixPetHatchQuoteMatches(
        { ...catalog, hatch: { ...catalog.hatch, offer: null } },
        { kind: 'offer', id: '00000000-0000-4000-8000-bd7662a5eeb4', version: 1, priceMicroProtons: 65_000_000_000 }
      )
    ).toBe(false)
  })

  it('accepts an exact unused credit and never substitutes an offer for it', () => {
    const withCredit = {
      ...catalog,
      hatch: { ...catalog.hatch, creditEntitlementId: '00000000-0000-4000-8000-b454f82c5857' }
    }
    expect(
      matrixPetHatchQuoteMatches(withCredit, { kind: 'credit', entitlementId: '00000000-0000-4000-8000-b454f82c5857' })
    ).toBe(true)
    expect(
      matrixPetHatchQuoteMatches(withCredit, {
        kind: 'offer',
        id: catalog.hatch.offer!.id,
        version: 1,
        priceMicroProtons: 65_000_000_000
      })
    ).toBe(false)
  })
})
