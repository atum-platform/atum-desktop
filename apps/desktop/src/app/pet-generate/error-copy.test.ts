import { describe, expect, it } from 'vitest'

import { petGenErrorCopy } from './error-copy'

const copy = { errorUnsupportedAnimal: 'not-yet', errorTimeout: 'slow', errorUnreachable: 'down', errorNoPet: 'none', errorBadInput: 'bad', errorBilling: 'pay', genericError: 'generic' }

describe('pet-hatch error copy', () => {
  it('speaks the code, and falls back to the message, then the generic line', () => {
    expect(petGenErrorCopy(4405, 'no plan for spiders', copy)).toBe('not-yet')
    expect(petGenErrorCopy(5032, null, copy)).toBe('slow')
    expect(petGenErrorCopy(5033, null, copy)).toBe('down')
    expect(petGenErrorCopy(5034, null, copy)).toBe('none')
    expect(petGenErrorCopy(4004, null, copy)).toBe('bad')
    expect(petGenErrorCopy(4402, null, copy)).toBe('pay')
    expect(petGenErrorCopy(null, 'the image path said this', copy)).toBe('the image path said this')
    expect(petGenErrorCopy(5031, null, copy)).toBe('generic')
  })
})
