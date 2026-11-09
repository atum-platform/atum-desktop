import { describe, expect, it } from 'vitest'

import { MATRIX_PAGE_IDS } from '../../shared/matrix-pages'

import { isDeveloperWorkplacePage, WORKPLACE_DEVELOPER_PAGES, WORKPLACE_SURFACES } from './workplace-nav'

describe('the Workplace nav table', () => {
  it('lists every assistant page except account Connections under For developers, exactly once', () => {
    expect([...WORKPLACE_DEVELOPER_PAGES].sort()).toEqual(MATRIX_PAGE_IDS.filter(page => page !== 'connections').sort())
    expect(new Set(WORKPLACE_DEVELOPER_PAGES).size).toBe(WORKPLACE_DEVELOPER_PAGES.length)
  })

  it('keeps the pages that Atum does better still reachable under For developers', () => {
    for (const surface of WORKPLACE_SURFACES) {
      expect(WORKPLACE_DEVELOPER_PAGES, surface.id).toContain(surface.replaces)
    }
  })

  it('shows one Atum place per duplicated page, and never a place for a page it does not replace', () => {
    expect(new Set(WORKPLACE_SURFACES.map(surface => surface.id)).size).toBe(WORKPLACE_SURFACES.length)
    expect(new Set(WORKPLACE_SURFACES.map(surface => surface.replaces)).size).toBe(WORKPLACE_SURFACES.length)
    expect(WORKPLACE_SURFACES.map(surface => surface.id)).toEqual(['routines', 'drive', 'store'])
    expect(Object.fromEntries(WORKPLACE_SURFACES.map(surface => [surface.id, surface.replaces]))).toEqual({
      routines: 'scheduled',
      drive: 'artifacts',
      store: 'skills'
    })
  })

  it('opens For developers for a page reached from somewhere else, and for nothing else', () => {
    for (const page of MATRIX_PAGE_IDS) {
      expect(isDeveloperWorkplacePage(page), page).toBe(page !== 'connections')
    }

    expect(isDeveloperWorkplacePage(undefined)).toBe(false)
  })
})
