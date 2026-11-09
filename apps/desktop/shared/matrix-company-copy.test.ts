import { describe, expect, it } from 'vitest'

import { matrixCompanyCopy } from './matrix-company-copy'

describe('company project reader copy', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('covers every reader state and safe gap in %s', locale => {
    const copy = matrixCompanyCopy(locale)

    for (const state of ['empty', 'pending', 'live', 'paused', 'attention'] as const) {
      expect(copy.readerCoverage(state).trim().length).toBeGreaterThan(0)
    }

    for (const gap of ['assignment_unavailable', 'lease_contention', 'roster_unresolved', 'backfill_pending',
      'history_gap', 'join_changed', 'file_unavailable', 'receipt_pending', 'reader_unavailable']) {
      expect(copy.readerGap(gap).trim().length).toBeGreaterThan(0)
    }

    expect(copy.lastIngested('10:02').trim().length).toBeGreaterThan(5)
  })
})

describe('company copy completeness', () => {
  const english = matrixCompanyCopy('en') as unknown as Record<string, unknown>

  it.each(['vi', 'ja', 'zh', 'zh-hant'])('%s has every key English has, and no empty string', locale => {
    const copy = matrixCompanyCopy(locale) as unknown as Record<string, unknown>
    expect(Object.keys(copy).sort()).toEqual(Object.keys(english).sort())

    for (const [key, value] of Object.entries(copy)) {
      expect(typeof value, key).toBe(typeof english[key])

      if (typeof value === 'string') {expect(value.trim().length, key).toBeGreaterThan(0)}
    }
  })
})
