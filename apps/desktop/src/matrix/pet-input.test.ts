import { describe, expect, it } from 'vitest'

import { canGenerateMatrixPet, matrixPetRoundsResetAt } from './pet-input'

describe('Matrix pet draft input', () => {
  it('allows text-only and photo-only drafts without requiring the other input', () => {
    expect(canGenerateMatrixPet('a small fox', false)).toBe(true)
    expect(canGenerateMatrixPet('', true)).toBe(true)
    expect(canGenerateMatrixPet('   ', false)).toBe(false)
  })
  it('keeps the renderer in the same 300-character contract as main', () => {
    expect(canGenerateMatrixPet('x'.repeat(300), false)).toBe(true)
    expect(canGenerateMatrixPet('x'.repeat(301), true)).toBe(false)
  })
  it("names the next UTC midnight in the person's own time zone", () => {
    // 23:30 UTC on 5 Oct resets at 00:00 UTC on 6 Oct, which is 07:00 in Vietnam.
    expect(matrixPetRoundsResetAt('2026-10-05T23:30:00.000Z', 'en-GB', 'Asia/Ho_Chi_Minh')).toBe('07:00')
    expect(matrixPetRoundsResetAt('2026-10-06T00:00:00.000Z', 'en-GB', 'UTC')).toBe('00:00')
    expect(matrixPetRoundsResetAt('not a time', 'en-GB', 'UTC')).toBe('00:00')
  })
})
