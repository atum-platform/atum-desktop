import { describe, expect, it } from 'vitest'

import { appChatCopy } from '../../shared/matrix-app-chat-copy'
import { TRANSLATIONS } from '../i18n'

import { appBotOutcomeText } from './app-bots/outcomes'
import { mobileChatCopy } from './mobile-copy'
import { matrixStoreCopy } from './store/store-copy'

// Preserve the recovery and user-visible behavior covered by this path.
// happened, whether anything was charged (or that it is not known yet) and where to look, in every language.
const LOCALES = ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const
const META = /chưa xác nhận|couldn[’']t confirm|could not confirm|can[’']t confirm|確認できな|[没沒]能(确认|確認)|无法确认|無法確認|未能确认/i

function find(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') {return undefined}

  for (const [name, child] of Object.entries(value)) {
    if (name === key && typeof child === 'string') {return child}
    const found = find(child, key)

    if (found) {return found}
  }

  return undefined
}

describe.each(LOCALES)('app and purchase outcome copy in %s', locale => {
  it('never closes an app turn with a "couldn’t confirm" notice: it says who may have answered and where to ask', () => {
    for (const text of [appBotOutcomeText(locale, 'outcome_unknown', 'Moon'), mobileChatCopy[locale].appBot.notice.outcome_unknown('Moon')]) {
      expect(text).not.toMatch(META)
      expect(text).toContain('Moon')
      expect(text).toContain('support@atumplatform.com')
      expect(text.length).toBeGreaterThan(60)
    }
  })

  it('says a purchase it could not settle has no answer yet, and exactly what that means for the money', () => {
    const texts = [matrixStoreCopy(locale).purchaseUncertain, find(TRANSLATIONS[locale], 'purchaseUncertain')!]

    for (const text of texts) {
      expect(text).not.toMatch(META)
      expect(text).toMatch(/Proton/)
      expect(text.length).toBeGreaterThan(60)
    }
  })
})

describe('Vietnamese app-chat status lines', () => {
  it('say what happened to the reply or the message, not that something was "not confirmed"', () => {
    const { pending, unknown } = appChatCopy('vi')

    expect(pending).not.toMatch(META)
    expect(unknown).not.toMatch(META)
    expect(pending).toContain(`“${appChatCopy('vi').retry}”`) // names the button that sends it again
    expect(unknown).toMatch(/không tự gửi lại/)
  })
})
