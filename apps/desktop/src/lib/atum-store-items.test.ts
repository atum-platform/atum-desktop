import { describe, expect, it } from 'vitest'

import {
  type AtumStoreCatalogWire,
  type AtumStoreItemWire,
  isStoreItemFulfillable,
  isStoreItemOwned,
  ownedStoreKeys,
  priceForOffer,
  projectOffer,
  projectSkillEntry,
  storeCopy,
  storeSkillLockName
} from './atum-store-items'

const item = (overrides: Partial<AtumStoreItemWire> = {}): AtumStoreItemWire => ({
  accent: 'var(--atum-sunk)',
  detail: { description: { en: 'Draw diagrams', vi: 'Vẽ sơ đồ' }, needs: ['internet'], try_prompt: { en: 'Draw the water cycle', vi: 'Vẽ vòng tuần hoàn' } },
  featured: true,
  glyph: '🔷',
  hashes: [],
  id: 'concept-diagrams',
  kind: 'skill',
  offer: { id: '00000000-0000-4000-8000-11e594f48195', price_protons: 0, version: 1 },
  sort_order: 1,
  source: { identifier: 'official/creative/concept-diagrams', type: 'hermes_optional' },
  summary: { en: 'Diagrams', vi: 'Sơ đồ' },
  title: { en: 'Concept diagrams', vi: 'Sơ đồ giải thích' },
  ...overrides
})

describe('storeCopy', () => {
  it("renders the viewer's locale, then falls back to en, then vi", () => {
    expect(storeCopy({ en: 'Name', vi: 'Tên', zh: '名' }, 'zh')).toBe('名')
    // ja / zh / zh-hant readers get English — the app's own fallback — never
    // Vietnamese out from under them.
    expect(storeCopy({ en: 'Name', vi: 'Tên' }, 'zh')).toBe('Name')
    expect(storeCopy({ en: 'Name', vi: 'Tên' }, 'zh-hant')).toBe('Name')
    expect(storeCopy({ en: 'Name', vi: 'Tên' }, 'ja')).toBe('Name')
    // vi is the guaranteed FINAL fallback: no English row still resolves.
    expect(storeCopy({ vi: 'Tên' }, 'ja')).toBe('Tên')
    expect(storeCopy({ en: 'Name' }, 'vi')).toBe('Name')
    expect(storeCopy({}, 'vi')).toBe('')
  })
})

describe('priceForOffer', () => {
  it('reads a missing offer as unavailable — never free', () => {
    expect(priceForOffer(null)).toEqual({ kind: 'unavailable' })
  })

  it('reads an offer at 0 as free — an acquisition that still writes an entitlement', () => {
    expect(priceForOffer({ id: 'o', priceProtons: 0, version: 1 })).toEqual({ kind: 'free' })
  })

  it('reads a priced offer as integer Protons', () => {
    expect(priceForOffer({ id: 'o', priceProtons: 5000, version: 3 })).toEqual({ amount: 5000, kind: 'protons' })
  })

  it('projects the wire offer without renaming what the person confirmed', () => {
    expect(projectOffer({ id: 'o', price_protons: 40, version: 2 })).toEqual({ id: 'o', priceProtons: 40, version: 2 })
    expect(projectOffer(null)).toBeNull()
  })
})

describe('ownership', () => {
  const catalog = (entitlements: AtumStoreCatalogWire['entitlements']): AtumStoreCatalogWire => ({
    available_protons: 1200,
    entitlements,
    items: []
  })

  it('counts only active entitlements as owned', () => {
    const view = catalog([
      { assistant_id: 'employee-a', assistant_identity_id: 'identity-a', granted_at: '2026-09-10T00:00:00Z', id: 'a', kind: 'skill', state: 'active' },
      { assistant_id: null, assistant_identity_id: null, granted_at: '2026-09-09T00:00:00Z', id: 'b', kind: 'pet', state: 'revoked' }
    ])

    expect(ownedStoreKeys(view)).toEqual(new Set())
    expect(isStoreItemOwned(view, 'skill', 'a', 'employee-a')).toBe(true)
    expect(isStoreItemOwned(view, 'skill', 'a', 'employee-b')).toBe(false)
    expect(isStoreItemOwned(view, 'skill', 'a')).toBe(false)
    expect(isStoreItemOwned(view, 'pet', 'b')).toBe(false)
    expect(isStoreItemOwned(null, 'skill', 'a')).toBe(false)
  })
})

describe('fulfilment is a local check (decision 11)', () => {
  const caps = { bundledPetSlugs: new Set(['gigi']), skillIdentifiers: new Set(['official/creative/concept-diagrams']) }

  it('lists an official skill the bundled Hermes has', () => {
    expect(isStoreItemFulfillable(item(), caps)).toBe(true)
  })

  it('hides an official skill the bundled Hermes does not have, once probed', () => {
    expect(isStoreItemFulfillable(item({ source: { identifier: 'official/finance/stocks', type: 'hermes_optional' } }), caps)).toBe(false)
  })

  it('keeps rows visible while the probe has not answered', () => {
    const unknown = { bundledPetSlugs: null, skillIdentifiers: null }

    expect(isStoreItemFulfillable(item(), unknown)).toBe(true)
  })

  it('hides a source type this build cannot deliver', () => {
    expect(
      isStoreItemFulfillable(
        item({ source: { sha256: 'a'.repeat(64), type: 'catalog_bundle' } }),
        caps
      )
    ).toBe(false)
    expect(
      isStoreItemFulfillable(
        item({ kind: 'pet', source: { sha256: 'a'.repeat(64), type: 'catalog_asset' } }),
        caps
      )
    ).toBe(false)
  })

  it('hides a kind:source pairing it does not understand, and the reserved agent kind', () => {
    expect(isStoreItemFulfillable(item({ kind: 'agent', source: null }), caps)).toBe(false)
    expect(
      isStoreItemFulfillable(item({ kind: 'pet', source: { identifier: 'official/x/y', type: 'hermes_optional' } }), caps)
    ).toBe(false)
  })

  it('checks bundled pets against the slugs this build ships', () => {
    const pet = item({ kind: 'pet', source: { slug: 'gigi', type: 'bundled' } })

    expect(isStoreItemFulfillable(pet, caps)).toBe(true)
    expect(isStoreItemFulfillable(item({ kind: 'pet', source: { slug: 'nova', type: 'bundled' } }), caps)).toBe(false)
  })
})

describe('projectSkillEntry', () => {
  it('carries the shelf fields from the catalog row, with localized copy as records', () => {
    const entry = projectSkillEntry(item(), true)

    expect(entry).toMatchObject({
      featured: true,
      id: 'concept-diagrams',
      identifier: 'official/creative/concept-diagrams',
      needs: ['internet'],
      order: 1,
      owned: true,
      price: { kind: 'free' }
    })
    expect(entry?.name).toEqual({ en: 'Concept diagrams', vi: 'Sơ đồ giải thích' })
    expect(entry?.tryPrompt.vi).toBe('Vẽ vòng tuần hoàn')
  })

  it('refuses rows that are not official optional skills', () => {
    expect(projectSkillEntry(item({ kind: 'pet' }), false)).toBeNull()
    expect(projectSkillEntry(item({ source: { sha256: 'a'.repeat(64), type: 'catalog_bundle' } }), false)).toBeNull()
  })

  it('derives the hub install name from the identifier', () => {
    expect(storeSkillLockName('official/creative/concept-diagrams')).toBe('concept-diagrams')
    expect(storeSkillLockName('concept-diagrams')).toBe('concept-diagrams')
  })
})
