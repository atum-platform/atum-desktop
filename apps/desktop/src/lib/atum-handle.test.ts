import { describe, expect, it } from 'vitest'

import { isValidHandle, normalizeHandleInput, suggestHandle } from './atum-handle'

describe('suggestHandle', () => {
  it('folds a Vietnamese display name to the handle alphabet', () => {
    expect(suggestHandle('Nguyễn An Anh')).toBe('nguyen-an-anh')
    expect(suggestHandle('Đặng Văn Đức')).toBe('dang-van-duc')
  })

  it('uses only the local part of an email and never the domain', () => {
    expect(suggestHandle('person@example.com')).toBe('person')
  })

  it('returns nothing rather than inventing a handle from unusable input', () => {
    expect(suggestHandle('李')).toBe('')
    expect(suggestHandle('ab')).toBe('')
    expect(suggestHandle(null)).toBe('')
    expect(suggestHandle('   ')).toBe('')
  })

  it('never exceeds 32 characters or ends in a hyphen', () => {
    const long = suggestHandle('a very long name that keeps going and going forever')

    expect(long.length).toBeLessThanOrEqual(32)
    expect(long.endsWith('-')).toBe(false)
    expect(isValidHandle(long)).toBe(true)
  })
})

describe('normalizeHandleInput', () => {
  it('strips the @ and case so the plane receives exactly what it validates', () => {
    expect(normalizeHandleInput('  @Minh-Anh ')).toBe('minh-anh')
    expect(isValidHandle(normalizeHandleInput('@Minh-Anh'))).toBe(true)
    expect(isValidHandle('Minh')).toBe(false)
    expect(isValidHandle('-minh')).toBe(false)
  })
})
