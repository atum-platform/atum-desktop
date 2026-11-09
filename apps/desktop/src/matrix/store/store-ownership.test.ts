import { describe, expect, it } from 'vitest'

import monthlyAgent from '../../../contracts/atum-store-v1/fixtures/catalog-monthly-agent.json'
import agentEntitlements from '../../../contracts/atum-store-v1/fixtures/entitlements-agent.json'
import available from '../../../contracts/atum-store-v1/fixtures/ownership-available.json'
import gift from '../../../contracts/atum-store-v1/fixtures/ownership-gift.json'
import ownedOverVisit from '../../../contracts/atum-store-v1/fixtures/ownership-owned-over-visit.json'
import purchased from '../../../contracts/atum-store-v1/fixtures/ownership-purchased.json'
import skillAssistant from '../../../contracts/atum-store-v1/fixtures/ownership-skill-assistant.json'
import visiting from '../../../contracts/atum-store-v1/fixtures/ownership-visiting.json'
import { storeEntitlement, storeItem } from '../../../electron/matrix/store-contract'
import type { MatrixStoreEntitlement } from '../../../shared/matrix-store'

import { itemOwnedForAssistant, itemStoreOwnership, legacyStoreOwnership } from './store-ownership'

const vectors = {
  gift,
  purchased,
  visiting,
  available,
  'skill-assistant': skillAssistant,
  'owned-over-visit': ownedOverVisit
}

describe('desktop ownership authority and legacy compatibility', () => {
  it.each(Object.entries(vectors))('consumes the frozen %s ownership vector', (name, vector) => {
    const item = storeItem(vector.item)
    const grants = vector.entitlements.map(storeEntitlement)
    const projected = storeItem({ ...vector.item, ownership: vector.expected })
    expect(itemStoreOwnership(projected, grants)).toEqual(vector.expected)

    if (name !== 'visiting') {
      expect(legacyStoreOwnership(item, grants)).toEqual(vector.expected)
    } else {
      expect(legacyStoreOwnership(item, grants).state).toBe('available')
    }
  })

  it('server available/visiting wins over a cached active gift', () => {
    const gift = vectors.gift
    const grants = gift.entitlements.map(storeEntitlement)

    for (const vector of [vectors.available, vectors.visiting]) {
      const item = storeItem({ ...gift.item, ownership: vector.expected })
      expect(itemStoreOwnership(item, grants)).toEqual(vector.expected)
      expect(itemOwnedForAssistant(item, grants)).toBe(false)
    }
  })

  it('keeps cancelled hires owned, excludes lapsed/revoked/wrong-target grants', () => {
    const hire = storeItem(monthlyAgent.items[0])
    const grant = storeEntitlement(agentEntitlements.entitlements[0])
    const matching = { ...grant, itemId: hire.itemId }
    expect(
      legacyStoreOwnership(hire, [{ ...matching, subscription: { ...matching.subscription!, state: 'cancelled' } }])
        .state
    ).toBe('owned')

    const unusable: MatrixStoreEntitlement[] = [
      { ...matching, subscription: { ...matching.subscription!, state: 'lapsed' } },
      { ...matching, state: 'revoked' },
      { ...matching, itemId: 'agent/other' },
      { ...matching, assistantId: null }
    ]

    expect(legacyStoreOwnership(hire, unusable).state).toBe('available')
  })

  it('prioritizes grant sources, defaults old grants to purchase and keeps assistant scope', () => {
    const vector = vectors['skill-assistant']
    const skill = storeItem(vector.item)
    const grant = storeEntitlement(vector.entitlements[0])
    const other = '00000000-0000-4000-8000-76a206b4b1ca'

    const grants: MatrixStoreEntitlement[] = [
      { ...grant, source: 'promo' },
      { ...grant, assistantId: other, source: 'compensation' },
      { ...grant, source: 'gift' }
    ]

    expect(legacyStoreOwnership(skill, grants)).toEqual({
      state: 'owned',
      source: 'gift',
      assistantIds: [grant.assistantId, other].sort(),
      until: null
    })
    expect(itemOwnedForAssistant(skill, grants, other)).toBe(true)
    expect(itemOwnedForAssistant(skill, grants, '00000000-0000-4000-8000-3cad5aaf3039')).toBe(false)
    const { source: _source, ...legacy } = grant
    expect(legacyStoreOwnership(skill, [...grants, legacy]).source).toBe('purchase')
  })
})
