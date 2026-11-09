import { describe, expect, it } from 'vitest'

import {
  matrixCompanySearchDateMatches,
  matrixCompanySearchNeedsLoadedHistory,
  matrixCompanySearchTermMatches,
  parseMatrixCompanySearchQuery
} from '../../shared/matrix-company-search-query'

describe('Team space company search query', () => {
  it('parses operators, Unicode names, phrases, and plain terms without losing display chips', () => {
    const parsed = parseMatrixCompanySearchQuery('kế hoạch "ra mắt Việt Nam" from:@nguyễn in:#sản-phẩm after:2026-10-01 before:2026-11-01')

    expect(parsed).toMatchObject({
      terms: [{ value: 'kế', quoted: false }, { value: 'hoạch', quoted: false }, { value: 'ra mắt Việt Nam', quoted: true }],
      from: '@nguyễn',
      in: '#sản-phẩm',
      after: '2026-10-01',
      before: '2026-11-01',
      errors: [],
      serverTerm: 'kế hoạch ra mắt Việt Nam'
    })
    expect(parsed.chips.map(chip => chip.operator)).toEqual(['phrase', 'from', 'in', 'after', 'before'])
  })

  it.each([
    ['before:2026-02-30 launch', 'invalid_date'],
    ['after:2026-13-01 launch', 'invalid_date'],
    ['before:2026-10-01 after:2026-10-02 launch', 'invalid_range'],
    ['from:me from:@lan launch', 'duplicate_operator'],
    ['in:general launch', 'invalid_operator'],
    ['"unfinished phrase', 'unterminated_quote']
  ] as const)('rejects invalid query %j as %s', (query, error) => {
    expect(parseMatrixCompanySearchQuery(query).errors).toContain(error)
  })

  it('folds accents for every term and applies local calendar date bounds', () => {
    const parsed = parseMatrixCompanySearchQuery('"Da Lat" kế hoạch after:2026-10-29 before:2026-10-31')
    expect(matrixCompanySearchTermMatches('Đà Lạt có KẾ HOẠCH mới', parsed)).toBe(true)
    expect(matrixCompanySearchTermMatches('Đà Lạt chưa có lịch', parsed)).toBe(false)
    expect(matrixCompanySearchDateMatches(new Date(2026, 9, 29, 12).getTime(), parsed)).toBe(true)
    expect(matrixCompanySearchDateMatches(new Date(2026, 9, 31, 0).getTime(), parsed)).toBe(false)
  })

  it('keeps terms, phrases and files server-side and uses loaded history only without a term', () => {
    expect(matrixCompanySearchNeedsLoadedHistory(parseMatrixCompanySearchQuery('launch from:me in:#general'), 'messages')).toBe(false)
    expect(matrixCompanySearchNeedsLoadedHistory(parseMatrixCompanySearchQuery('"exact launch"'), 'messages')).toBe(false)
    expect(matrixCompanySearchNeedsLoadedHistory(parseMatrixCompanySearchQuery('before:2026-10-30'), 'messages')).toBe(true)
    expect(matrixCompanySearchNeedsLoadedHistory(parseMatrixCompanySearchQuery('launch'), 'files')).toBe(false)
  })
})
