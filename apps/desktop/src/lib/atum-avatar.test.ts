import { describe, expect, it } from 'vitest'

import { atumAvatarInitial } from './atum-avatar'

describe('atumAvatarInitial', () => {
  it('keeps the first grapheme instead of splitting combined or emoji names', () => {
    expect(atumAvatarInitial('  👩🏽‍💻 Atum')).toBe('👩🏽‍💻')
    expect(atumAvatarInitial('  A\u0301nh')).toBe('A\u0301')
    expect(atumAvatarInitial('')).toBe('')
  })
})
