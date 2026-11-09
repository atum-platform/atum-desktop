import { describe, expect, it } from 'vitest'

import { localizedStoreCopy } from './matrix-store-contract'

describe('localizedStoreCopy', () => {
  const copy = { vi: 'vi', en: 'en', ja: 'ja', zh: 'zh', 'zh-TW': 'zh-TW' }

  it('finds the exact locale, then Traditional Chinese under the key the Store accepts', () => {
    expect(localizedStoreCopy(copy, 'ja')).toBe('ja')
    expect(localizedStoreCopy(copy, 'zh')).toBe('zh')
    expect(localizedStoreCopy(copy, 'zh-hant')).toBe('zh-TW')
    expect(localizedStoreCopy(copy, 'zh-Hant')).toBe('zh-TW')
  })

  it('falls back to English, then Vietnamese, never to another Chinese script', () => {
    const noTraditional = { vi: 'vi', en: 'en', zh: 'zh' }

    expect(localizedStoreCopy(noTraditional, 'zh-hant')).toBe('en')
    expect(localizedStoreCopy({ vi: 'vi' }, 'fr')).toBe('vi')
    expect(localizedStoreCopy({}, 'en')).toBe('')
  })
})

