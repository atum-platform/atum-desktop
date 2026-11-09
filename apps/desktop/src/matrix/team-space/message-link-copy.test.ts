import { describe, expect, it } from 'vitest'

import { messageLinkCopy } from './message-link-copy'

describe('Team space message-link copy', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('has complete, distinct %s copy', locale => {
    const copy = messageLinkCopy(locale)

    expect(copy.copyLink.trim()).toBeTruthy()
    expect(copy.notMember.trim()).toBeTruthy()
    expect(copy.unavailable.trim()).toBeTruthy()
    expect(copy.notMember).not.toBe(copy.unavailable)
  })
})
