import { describe, expect, it } from 'vitest'

import { discoverAtumStore, parseAtumStoreDiscoveryRequest, queryStoreCatalog } from './atum-discovery'
import type { MatrixStoreItem, MatrixStoreSnapshot } from './matrix-store'

function item(itemId: string, sortOrder: number, extra: Partial<MatrixStoreItem> = {}): MatrixStoreItem {
  const value: MatrixStoreItem = {
    itemId,
    kind: 'skill',
    title: { en: 'Focus planning', vi: 'Lập kế hoạch' },
    summary: { en: 'Keep work on track' },
    description: { en: 'A catalog skill with deep research notes.' },
    tryPrompt: { en: 'Plan my day' },
    needs: ['internet'],
    glyph: '✦',
    accent: '#3a62c9',
    featured: false,
    sortOrder,
    offer: {
      id: '00000000-0000-4000-8000-11e594f48195',
      version: 2,
      priceMicroProtons: 4_001,
      renewalPriceMicroProtons: 5_002,
      scope: 'agent',
      billingInterval: 'month',
      delivery: 'cloud'
    },
    ownership: { state: 'owned', source: 'purchase', assistantIds: ['00000000-0000-4000-8000-e79acd97ac88'], until: null },
    deliverable: true,
    ...extra
  }
  const copy = (text: Record<string, string>) => ({ vi: text.vi ?? text.en ?? 'Copy', ...text })
  return { ...value, title: copy(value.title), summary: copy(value.summary), description: copy(value.description),
    tryPrompt: copy(value.tryPrompt), ...(value.kind === 'pet' ? { ownership: { state: 'owned', source: 'purchase', assistantIds: [], until: null } } : {}) }
}

function catalog(items: MatrixStoreItem[], state: MatrixStoreSnapshot['state'] = 'ready'): MatrixStoreSnapshot {
  return { state, items, entitlements: [], purchases: [], pending: [] }
}

describe('Atum Store discovery projection', () => {
  it('searches localized public text including descriptions, then retains canonical order and bounded pagination', () => {
    const later = item('skill/later', 20, { title: { en: 'Later' }, description: { en: 'A later catalog item.' } })
    const first = item('skill/first', 10, { summary: { en: 'Deep work companion' } })
    const descriptionMatch = item('skill/research', 15, { description: { en: 'Deep research organizer' } })

    const result = discoverAtumStore(catalog([later, first, descriptionMatch]), { query: 'DEEP', limit: 2 })

    expect(result).toMatchObject({ outcome: 'ok', totalMatches: 2, hasMore: false })
    if (result.outcome === 'ok') {
      expect(result.items.map(entry => entry.itemId)).toEqual(['skill/first', 'skill/research'])
    }
  })

  it('returns only public listing fields plus a truthful Discover destination, without mutating catalog data', () => {
    const source = item('agent/researcher', 1, {
      kind: 'agent'
    })
    const snapshot = catalog([source])

    const result = discoverAtumStore(snapshot, { itemId: 'agent/researcher' })

    expect(result).toMatchObject({ outcome: 'ok', totalMatches: 1, hasMore: false })
    if (result.outcome !== 'ok') {
      throw new Error('expected a projected Store item')
    }
    const [projected] = result.items
    expect(projected).toMatchObject({
      itemId: 'agent/researcher',
      kind: 'agent',
      needs: ['internet'],
      offer: { renewalPriceMicroProtons: 5_002, scope: 'agent', delivery: 'cloud' },
      ownership: { state: 'owned', assistantIds: ['00000000-0000-4000-8000-e79acd97ac88'] },
      deliverable: true,
      destination: { surface: 'discover', shelf: 'agents', itemId: 'agent/researcher' }
    })
    expect(projected).not.toHaveProperty('tryPrompt')
    expect(projected).not.toHaveProperty('glyph')

    projected!.needs.push('changed')
    projected!.ownership?.assistantIds.push('other')
    expect(source.needs).toEqual(['internet'])
    expect(source.ownership?.assistantIds).toEqual(['00000000-0000-4000-8000-e79acd97ac88'])
    expect(queryStoreCatalog([item('skill/official/research/reader', 1, { offer: null,
      install: { source: 'hermes_hub', id: 'official/research/reader' } })])).toMatchObject({
      outcome: 'ok', items: [{ install: { source: 'hermes_hub' } }]
    })
  })

  it('accepts a kind filter and reports the full match count when a page is truncated', () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      item(`${index === 0 ? 'pet' : 'skill'}/${String(index).padStart(2, '0')}`, index, { kind: index === 0 ? 'pet' : 'skill' })
    )

    const result = queryStoreCatalog(entries, { kind: 'skill', limit: 3 })

    expect(result).toMatchObject({ outcome: 'ok', totalMatches: 11, hasMore: true })
    if (result.outcome === 'ok') {
      expect(result.items).toHaveLength(3)
      expect(result.items.every(entry => entry.kind === 'skill')).toBe(true)
    }
  })

  it('uses the Storefront’s Vietnamese accent- and whitespace-insensitive query normalization', () => {
    const result = queryStoreCatalog(
      [item('skill/vietnamese', 1, { title: { vi: 'Kỹ năng tập trung' } })],
      { query: ' ky nang ' },
      'vi'
    )

    expect(result).toMatchObject({ outcome: 'ok', totalMatches: 1 })
    expect(queryStoreCatalog([item('skill/bilingual', 1)], { query: 'lap ke hoach' })).toMatchObject({
      outcome: 'ok', totalMatches: 1
    })
  })

  it('returns explicit failures for malformed input, malformed catalog, and an unavailable catalog', () => {
    const valid = catalog([item('skill/focus', 1)])

    expect(discoverAtumStore(valid, { query: 'x'.repeat(201) })).toMatchObject({
      outcome: 'error',
      code: 'invalid_request'
    })
    expect(discoverAtumStore(valid, { limit: 0 })).toMatchObject({ outcome: 'error', code: 'invalid_request' })
    expect(discoverAtumStore({ state: 'ready', items: [{ itemId: 'skill/bad' }] })).toMatchObject({
      outcome: 'error',
      code: 'invalid_catalog'
    })
    expect(discoverAtumStore(catalog([], 'loading'))).toMatchObject({ outcome: 'error', code: 'catalog_unavailable' })
    expect(parseAtumStoreDiscoveryRequest({ itemId: '   ' })).toMatchObject({
      outcome: 'error',
      code: 'invalid_request'
    })
  })
})
