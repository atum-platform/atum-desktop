import { describe, expect, it } from 'vitest'

import { matrixComputerUseGrantConfirmationCopy } from './matrix-computer-use-grant-copy'

describe('native CuaDriver permission intent', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('identifies the selected agent and driver identity in %s', locale => {
    const copy = matrixComputerUseGrantConfirmationCopy(locale, 'Ada')

    expect(copy.title).toContain('CuaDriver')
    expect(copy.detail).toContain('Ada')
    expect(copy.detail).toContain('CuaDriver')
    expect(copy.cancel).toBeTruthy()
    expect(copy.request).toBeTruthy()
    expect(copy.cancel).not.toBe(copy.request)
  })

  it('falls back safely for unsupported locales and does not let agent controls reshape the fixed warning', () => {
    const copy = matrixComputerUseGrantConfirmationCopy('__proto__', 'Ada\n\u0000Bea')

    expect(copy.title).toBe(matrixComputerUseGrantConfirmationCopy('en', '').title)
    expect(copy.detail).toContain('Ada  Bea')
    expect(copy.detail).toContain('see your screen and control this Mac')
  })
})
