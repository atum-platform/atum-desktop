import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixWalletState } from '../../../shared/matrix-wallet'
import { matrixWalletCopy } from '../wallet-copy'

import { MatrixProtonsPane } from './protons-pane'

afterEach(cleanup)

const wallet: MatrixWalletState = {
  state: 'ready',
  wallet: {
    unit: 'micro_proton',
    balances: {
      available: 25_400_500_000,
      paid: 20_000_000_000,
      earned: 0,
      promo: 5_400_500_000,
      held: 120_000_000
    },
    allowance: { kind: 'founding', state: 'granted', amount: 50_000_000_000, grantedAt: '2026-09-28T00:00:00Z' },
    checkoutOpen: true
  }
}

function pane(props: Partial<React.ComponentProps<typeof MatrixProtonsPane>> = {}, locale: 'en' | 'vi' = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixProtonsPane data={wallet} {...props} />
    </I18nProvider>
  )
}

describe('Settings → Protons', () => {
  it('labels assistant hire and renewal activity in every desktop locale', () => {
    expect(matrixWalletCopy('en').activityEntry('agent_hire', 'completed', -1).label).toBe('Assistant hire')
    expect(matrixWalletCopy('vi').activityEntry('agent_hire_renewal', 'completed', -1).label).toBe('Gia hạn trợ lý')
    expect(matrixWalletCopy('ja').activityEntry('agent_hire', 'completed', -1).label).toBe('アシスタント雇用')
    expect(matrixWalletCopy('zh').activityEntry('agent_hire_renewal', 'completed', -1).label).toBe('助手续期')
    expect(matrixWalletCopy('zh-Hant').activityEntry('agent_hire_renewal', 'completed', -1).label).toBe('助理續期')
  })

  it('labels a transfer to a company in every desktop locale, never as a bare debit', () => {
    const expected: Record<string, string> = {
      en: 'Sent to company',
      vi: 'Nạp cho công ty',
      ja: '会社へ移動',
      zh: '转给公司',
      'zh-Hant': '轉給公司'
    }

    for (const [locale, label] of Object.entries(expected)) {
      const entry = matrixWalletCopy(locale).activityEntry('company_transfer', 'completed', -40_000_000)
      expect(entry.label, locale).toBe(label)
      expect(entry.label, locale).not.toBe(matrixWalletCopy(locale).activityEntry('unknown_kind', 'completed', -1).label)
    }
  })

  it('leads with the top-up and keeps About Protons as a quiet link', () => {
    const onTopUp = vi.fn()
    const onAbout = vi.fn()
    pane({ onAbout, onTopUp })

    fireEvent.click(screen.getByRole('button', { name: matrixWalletCopy('en').topUp }))
    expect(onTopUp).toHaveBeenCalledOnce()
    expect(onAbout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: matrixWalletCopy('en').about }))
    expect(onAbout).toHaveBeenCalledOnce()
  })

  it('keeps where the Protons came from behind Details, in whole Protons', () => {
    const { container } = pane()
    const details = container.querySelector('[data-matrix-protons-details]') as HTMLDetailsElement

    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe(matrixWalletCopy('en').details)
    // 5,400.5 bonus Protons read as 5,400: whole numbers, rounded down like the balance.
    expect(details.textContent).toContain('5,400')
    expect(container.textContent).not.toMatch(/5,400\.5/)
    expect(details.textContent).toContain(matrixWalletCopy('en').held)
  })

  it('writes Proton without an s in Vietnamese', () => {
    const { container } = pane({ onAbout: () => {}, onTopUp: () => {} }, 'vi')
    expect(container.textContent).not.toMatch(/Protons/)
  })

  it('reads an activity sliver as under one Proton, not zero', () => {
    pane({
      history: {
        entries: [
          {
            id: 'turn',
            at: '2026-10-02T00:00:00Z',
            kind: 'usage',
            status: 'charged',
            amount: -4_200,
            reference: null,
            closedAt: null
          }
        ],
        error: false,
        loading: false,
        next: null
      }
    })

    const row = screen.getByText('AI usage').closest('.atum-settings-row')
    expect(row?.textContent).toContain('<1')
    expect(row?.textContent).not.toMatch(/0\.0042/)
  })
})
