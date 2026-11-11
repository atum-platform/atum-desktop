import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixSubscriptionFallback } from '../../shared/matrix-subscription-fallback'

import { SubscriptionFallbackLine } from './subscription-fallback-line'

afterEach(cleanup)

function draw(fallback: MatrixSubscriptionFallback, locale: Locale) {
  const { container } = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <TooltipProvider>
        <SubscriptionFallbackLine fallback={fallback} />
      </TooltipProvider>
    </I18nProvider>
  )

  return container.querySelector<HTMLElement>('[data-matrix-subscription-fallback]')!
}

const offline: MatrixSubscriptionFallback = { plan: 'chatgpt', reason: 'offline', servedBy: 'nguyet-thuc' }

describe('the line under an answer a fallback gave', () => {
  it.each([
    ['en', 'Answered with a fallback', 'ChatGPT was offline'],
    ['vi', 'Đã trả lời bằng mô hình dự phòng', 'Lúc đó ChatGPT không kết nối được'],
    ['ja', '代替モデルで回答しました', 'ChatGPT がオフラインでした'],
    ['zh', '由备用模型回答', 'ChatGPT 当时离线'],
    ['zh-hant', '由備用模型回答', 'ChatGPT 當時離線']
  ] as const)('says only that, in %s, and names the plan in its tip', async (locale, line, why) => {
    const shown = draw(offline, locale)

    expect(shown.textContent).toBe(line)
    fireEvent.pointerMove(shown, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toContain(why)
  })

  it.each([
    [{ plan: 'opencode_go', reason: 'rate_limited', servedBy: 'nhat-thuc' }, 'OpenCode Go reached its limit'],
    [{ plan: 'chatgpt', reason: 'timeout', servedBy: 'nguyet-thuc' }, 'ChatGPT didn’t answer in time'],
    [{ plan: 'chatgpt', reason: 'grant_invalid', servedBy: 'nguyet-thuc' }, 'ChatGPT was unavailable']
  ] as const)('gives one short reason, never a cost (%o)', async (fallback, why) => {
    const shown = draw(fallback, 'en')

    fireEvent.pointerMove(shown, { pointerType: 'mouse' })
    const tip = (await screen.findByRole('tooltip')).textContent ?? ''

    expect(tip).toContain(why)
    expect(`${shown.textContent} ${tip}`).not.toMatch(/Proton|cost|price|\d/iu)
  })
})
