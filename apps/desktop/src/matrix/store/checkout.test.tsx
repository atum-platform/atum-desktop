import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROTON_PURCHASE_TERMS_URL } from '@/app/atum/purchase-qr-panel'
import { I18nProvider, type Locale } from '@/i18n'

import { ATUM_COMPANY, ATUM_MAILBOXES } from '../../../shared/atum-company'
import type { MatrixCheckoutSnapshot, MatrixTopUpPack } from '../../../shared/matrix-checkout'
import type { MatrixWalletState } from '../../../shared/matrix-wallet'
import { ATUM_LINKS } from '../atum-links'
import { matrixLegalCopy } from '../legal-copy'

import { type DiscoverCheckout, MatrixCheckoutPane } from './checkout'
import { matrixStoreCopy } from './store-copy'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const MICRO = 1_000_000

const pack = {
  id: 'protons-100k',
  amountVnd: 95_000,
  paidMicroProtons: 95_000_000_000,
  bonusMicroProtons: 5_000_000_000,
  totalMicroProtons: 100_000_000_000
}

const pendingOrder = {
  id: '00000000-0000-4000-8000-303617b97302',
  package_id: pack.id,
  amount_vnd: pack.amountVnd,
  paid_protons: pack.paidMicroProtons,
  bonus_protons: pack.bonusMicroProtons,
  total_protons: pack.totalMicroProtons,
  order_code: 9_000_000_000,
  status: 'pending' as const,
  checkout_url: 'https://pay.payos.vn/web/native-payos',
  created_at: '2026-10-03T00:00:00Z',
  paid_at: null,
  payment: {
    qr_code: 'server-generated-qr',
    bank_bin: '970422',
    account_number: '123',
    account_name: 'Atum',
    description: 'ATUM',
    expires_at: '2026-10-03T01:00:00Z'
  }
}

const wallet: MatrixWalletState = {
  state: 'ready',
  wallet: {
    unit: 'micro_proton',
    balances: { available: 125_400 * MICRO, paid: 125_400 * MICRO, earned: 0, promo: 0, held: 0 },
    allowance: null,
    checkoutOpen: true
  }
}

function snapshot(patch: Partial<MatrixCheckoutSnapshot> = {}): MatrixCheckoutSnapshot {
  return {
    state: 'ready',
    packs: [pack],
    checkoutOpen: true,
    order: null,
    reconciliationPending: false,
    intent: null,
    ...patch
  }
}

function renderCheckout(
  state: MatrixCheckoutSnapshot,
  patch: Partial<DiscoverCheckout> = {},
  extra: Partial<React.ComponentProps<typeof MatrixCheckoutPane>> = {}
) {
  const checkout: DiscoverCheckout = {
    snapshot: state,
    onRefresh: vi.fn(),
    onStart: vi.fn(async () => {}),
    onStatus: vi.fn(async () => {}),
    onResume: vi.fn(async () => {}),
    onOpenCheckout: vi.fn(async () => {}),
    onDismissTerminal: vi.fn(async () => {}),
    ...patch
  }

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixCheckoutPane checkout={checkout} copy={matrixStoreCopy('en')} {...extra} />
    </I18nProvider>
  )

  return checkout
}

describe('MatrixCheckoutPane', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('keeps checkout and renewal consent vocabulary for %s', locale => {
    const copy = matrixStoreCopy(locale)
    expect(copy.checkoutUnavailable).not.toBe('')
    expect(copy.hireRenewalConsent('1 Proton')).not.toBe('')
    expect(copy.hireInitialPrice('1 Proton')).not.toBe('')
    expect(copy.hireRenewalPrice('1 Proton')).not.toBe('')
    expect(copy.hireConsentRequired).not.toBe('')
    // The currency note names the currency, never a locale code.
    expect(copy.checkoutCurrency).toContain('VND')
    expect(copy.checkoutCurrency).not.toMatch(/\((en|vi|ja|zh|zh-hant)\)/i)
  })

  it('renders only server-issued pack values, never the bonus split, and starts by server pack id', () => {
    const checkout = renderCheckout(snapshot())
    expect(screen.getByText('₫95,000')).toBeTruthy()
    const card = window.document.querySelector('[data-matrix-topup-pack="protons-100k"]')!
    expect(card.textContent).toContain('100,000 Protons')
    // The 5,000 bonus inside the pack is internal economics; only "₫95,000" may contain those digits.
    expect(card.textContent).not.toMatch(/(?<![\d,])5,000/)
    expect(card.textContent?.toLowerCase()).not.toContain('bonus')
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))
    expect(checkout.onStart).toHaveBeenCalledWith('protons-100k')
  })

  it('renders multiple packs exactly as the server issued them, without calculating savings or coverage', () => {
    const small: MatrixTopUpPack = {
      id: 'small',
      amountVnd: 50_000,
      paidMicroProtons: 50_000 * MICRO,
      bonusMicroProtons: 0,
      totalMicroProtons: 50_000 * MICRO
    }

    const big: MatrixTopUpPack = {
      id: 'big',
      amountVnd: 200_000,
      paidMicroProtons: 200_000 * MICRO,
      bonusMicroProtons: 20_000 * MICRO,
      totalMicroProtons: 220_000 * MICRO
    }

    renderCheckout(snapshot({ packs: [small, big] }))
    expect(window.document.querySelector('[data-matrix-topup-pack="small"]')?.textContent).toContain('50,000 Protons')
    expect(window.document.querySelector('[data-matrix-topup-pack="big"]')?.textContent).toContain('220,000 Protons')
    expect(window.document.querySelector('[data-matrix-checkout]')?.textContent).not.toContain('Save')
  })

  it('watches a pending payment by itself while visible, with no refresh button, and says how to change pack', () => {
    vi.useFakeTimers()

    const checkout = renderCheckout(
      snapshot({
        intent: { packId: pack.id, idempotencyKey: pendingOrder.id, orderId: pendingOrder.id },
        order: pendingOrder
      })
    )

    expect(screen.getByText('ATUM')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull()
    expect(screen.getByText(matrixStoreCopy('en').checkoutChangePack)).toBeTruthy()
    vi.advanceTimersByTime(3000)
    expect(checkout.onStatus).toHaveBeenCalledOnce()
  })

  it('keeps one watch across re-renders of its owner', () => {
    vi.useFakeTimers()
    const onStatus = vi.fn(async () => {})

    const state = snapshot({
      intent: { packId: pack.id, idempotencyKey: pendingOrder.id, orderId: pendingOrder.id },
      order: pendingOrder
    })

    const pane = () => (
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCheckoutPane
          checkout={{
            snapshot: state,
            onRefresh: () => {},
            onStart: async () => {},
            onStatus,
            onResume: async () => {},
            onOpenCheckout: async () => {},
            onDismissTerminal: async () => {}
          }}
          copy={matrixStoreCopy('en')}
        />
      </I18nProvider>
    )

    const { rerender } = render(pane())
    vi.advanceTimersByTime(2000)
    // The window re-renders with a fresh checkout object (every snapshot does).
    rerender(pane())
    vi.advanceTimersByTime(1000)
    expect(onStatus).toHaveBeenCalledOnce()
  })

  it('watches an order still being created, too', () => {
    vi.useFakeTimers()

    const checkout = renderCheckout(
      snapshot({
        intent: { packId: pack.id, idempotencyKey: pendingOrder.id, orderId: pendingOrder.id },
        order: { ...pendingOrder, status: 'creating', payment: null }
      })
    )

    expect(screen.getAllByText(matrixStoreCopy('en').checkoutCreating).length).toBeGreaterThan(0)
    vi.advanceTimersByTime(3000)
    expect(checkout.onStatus).toHaveBeenCalledOnce()
  })

  it('offers durable recovery when an intent survived without an order', () => {
    const checkout = renderCheckout(
      snapshot({ intent: { packId: pack.id, idempotencyKey: pendingOrder.id, orderId: null } })
    )

    fireEvent.click(screen.getByRole('button', { name: matrixStoreCopy('en').checkoutResume }))
    expect(checkout.onResume).toHaveBeenCalledOnce()
  })

  it('says once what a paid top-up added, the new balance, and goes back to the store', async () => {
    const onDone = vi.fn()

    const checkout = renderCheckout(
      snapshot({ order: { ...pendingOrder, payment: null, paid_at: '2026-10-03T00:01:00Z', status: 'paid' } }),
      {},
      { onDone, wallet }
    )

    expect(screen.getAllByText('Top-up complete: 100,000 Protons added.')).toHaveLength(1)
    expect(screen.getByText('Balance: 125,400 Protons')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the store' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(checkout.onDismissTerminal).toHaveBeenCalledOnce()
  })

  it('does not claim a balance while the payment is still being credited', () => {
    renderCheckout(
      snapshot({
        order: { ...pendingOrder, payment: null, paid_at: '2026-10-03T00:01:00Z', status: 'paid' },
        reconciliationPending: true
      }),
      {},
      { wallet }
    )

    expect(screen.getByText(matrixStoreCopy('en').checkoutReceived)).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-checkout-balance]')).toBeNull()
  })

  it.each(['expired', 'cancelled'] as const)('lets a %s order choose another pack', status => {
    const checkout = renderCheckout(snapshot({ order: { ...pendingOrder, payment: null, status } }))

    fireEvent.click(screen.getByRole('button', { name: 'Choose another pack' }))
    expect(checkout.onDismissTerminal).toHaveBeenCalledOnce()
  })

  it('offers a retry, not a red band, when top-ups cannot load', () => {
    const checkout = renderCheckout(snapshot({ state: 'unavailable' }))

    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: matrixStoreCopy('en').retry }))
    expect(checkout.onRefresh).toHaveBeenCalledOnce()
  })
})

describe('the policy and seller lines under a QR', () => {
  afterEach(() => Reflect.deleteProperty(window, 'atumMatrix'))

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'name who sells in %s and open both policies in the browser through the window',
    (locale: Locale) => {
      const openLink = vi.fn(async () => {})
      Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { openLink } })

      render(
        <I18nProvider configClient={null} initialLocale={locale}>
          <MatrixCheckoutPane
            checkout={{
              snapshot: snapshot({ order: pendingOrder }),
              onRefresh: () => {},
              onStart: async () => {},
              onStatus: async () => {},
              onResume: async () => {},
              onOpenCheckout: async () => {},
              onDismissTerminal: async () => {}
            }}
            copy={matrixStoreCopy(locale)}
          />
        </I18nProvider>
      )

      // The seller, as its registration names it: Vietnamese reads the registered name.
      const seller = window.document.querySelector('[data-atum-qr-seller]')?.textContent ?? ''
      expect(seller).toContain(locale === 'vi' ? ATUM_COMPANY.legalName : ATUM_COMPANY.englishName)
      expect(seller).toContain(ATUM_COMPANY.enterpriseCode)
      expect(seller).toContain(ATUM_MAILBOXES.support)

      const policy = within(window.document.querySelector<HTMLElement>('[data-atum-qr-policy]')!)
      const [purchaseTerms, terms] = policy.getAllByRole('link')
      expect(terms.textContent).toBe(matrixLegalCopy(locale).terms)
      fireEvent.click(purchaseTerms)
      fireEvent.click(terms)
      expect(openLink.mock.calls).toEqual([[PROTON_PURCHASE_TERMS_URL], [ATUM_LINKS.terms]])
    }
  )
})
