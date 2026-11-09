import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'

describe('Atum’s model descriptors', () => {
  it('names each model’s place in the line-up in every locale', () => {
    expect(TRANSLATIONS.en.matrixShell.modelDefault).toBe('Good for everyday tasks')
    expect(TRANSLATIONS.en.matrixShell.modelHard).toBe('Good for hard tasks')
    expect(TRANSLATIONS.en.matrixShell.modelFlagship).toBe('The most powerful model')
    expect(TRANSLATIONS.vi.matrixShell.modelDefault).toBe('Phù hợp tác vụ hàng ngày')
    expect(TRANSLATIONS.vi.matrixShell.modelHard).toBe('Phù hợp với tác vụ khó khăn')
    expect(TRANSLATIONS.vi.matrixShell.modelFlagship).toBe('Mô hình quyền năng nhất')

    for (const locale of Object.values(TRANSLATIONS)) {
      const words = locale.matrixShell
      expect([words.modelDefault, words.modelHard, words.modelFlagship].every(word => word.trim().length > 0)).toBe(true)
      expect(new Set([words.modelDefault, words.modelHard, words.modelFlagship]).size).toBe(3)
    }
  })

  it('never states a Proton multiple for a model', () => {
    for (const [name, locale] of Object.entries(TRANSLATIONS)) {
      expect(JSON.stringify(locale), name).not.toMatch(/20\s*[×x]/u)
    }
  })
})
