import { describe, expect, it } from 'vitest'

import { draftsCopy } from './drafts-copy'

describe('Team Space Drafts copy', () => {
  it('carries the complete Drafts surface in all five locales', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant']) {
      const copy = draftsCopy(locale)

      expect(copy.title).toBeTruthy()
      expect(copy.emptyTitle).toBeTruthy()
      expect(copy.emptyBody).toBeTruthy()
      expect(copy.roomDraft).toBeTruthy()
      expect(copy.threadDraft).toBeTruthy()
      expect(copy.updated('today')).toContain('today')
      expect(copy.open('launch')).toContain('launch')
      expect(copy.failed).toBeTruthy()
    }
  })
})
