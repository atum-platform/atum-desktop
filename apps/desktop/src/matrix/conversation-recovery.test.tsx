import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { agentConversationCopy, earlierConversationNotice } from '../../shared/agent-conversation/copy'
import type { MatrixConversationView } from '../../shared/agent-conversation/view'

import { conversationNeedsRetry, ConversationRetryLine } from './conversation-recovery'

afterEach(cleanup)

function draw(child: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      {child}
    </I18nProvider>
  )
}

const stopped: MatrixConversationView = {
  state: 'retry',
  candidates: ['!main:test', '!earlier:test'],
  earlier: [],
  skipped: [],
  jobs: null,
  reason: 'failed'
}

describe('conversation recovery', () => {
  it('asks once, with one Try again, only after an automatic move stopped for good', () => {
    expect(conversationNeedsRetry(undefined)).toBe(false)
    expect(conversationNeedsRetry({ ...stopped, reason: 'effects_pending' })).toBe(false)
    expect(conversationNeedsRetry({ ...stopped, state: 'legacy' })).toBe(false)
    expect(conversationNeedsRetry({ ...stopped, reason: 'rollback_pending' })).toBe(true)
    expect(conversationNeedsRetry(stopped)).toBe(true)

    const retry = vi.fn()

    const { rerender } = draw(
      <ConversationRetryLine onRetry={retry} view={{ ...stopped, reason: 'effects_pending' }} />
    )

    // A move still settling in the background says nothing.
    expect(screen.queryByText(agentConversationCopy('en').stuck)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()

    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <ConversationRetryLine onRetry={retry} view={stopped} />
      </I18nProvider>
    )

    expect(screen.getByText(agentConversationCopy('en').stuck)).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('says the one line in the window language', () => {
    draw(
      <I18nProvider configClient={null} initialLocale="vi">
        <ConversationRetryLine onRetry={vi.fn()} view={stopped} />
      </I18nProvider>
    )

    expect(screen.getByText(agentConversationCopy('vi').stuck)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy()
  })

  it('keeps the native notice static and localized without a React renderer', () => {
    expect(earlierConversationNotice('vi', 'Linh')).toBe(
      'Cuộc trò chuyện này đã đóng. Hãy tiếp tục trong cuộc trò chuyện chính với Linh.'
    )

    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
      expect(agentConversationCopy(locale).earlierNotice('Linh')).toContain('Linh')
    }
  })

  it('uses the localized assistant-card notice when the main conversation has no name', () => {
    const cardNotices = {
      en: 'This conversation is closed. Continue from your assistant card.',
      vi: 'Cuộc trò chuyện này đã đóng. Hãy tiếp tục từ thẻ trợ lý của bạn.',
      ja: 'この会話は終了しています。アシスタントカードから続けてください。',
      zh: '此会话已关闭。请从你的助手卡片继续。',
      'zh-hant': '此對話已關閉。請從你的助理卡片繼續。'
    } as const

    for (const locale of Object.keys(cardNotices) as (keyof typeof cardNotices)[]) {
      expect(earlierConversationNotice(locale, '  ')).toBe(cardNotices[locale])
      expect(agentConversationCopy(locale).earlierCardNotice).toBe(cardNotices[locale])
    }
  })
})
