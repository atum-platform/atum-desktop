import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ATUM_LINKS } from '../../matrix/atum-links'

import { PROTON_PURCHASE_TERMS_URL, PurchaseQrPanel } from './purchase-qr-panel'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('the QR card’s policy line', () => {
  it('opens the purchase terms and the Terms through the old window’s bridge when no opener is passed', () => {
    const openExternal = vi.fn(async () => {})
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { openExternal } })

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <PurchaseQrPanel amountVnd={95_000} orderCode={1} payment={null} />
      </I18nProvider>
    )

    const [purchaseTerms, terms] = within(
      window.document.querySelector<HTMLElement>('[data-atum-qr-policy]')!
    ).getAllByRole('link')

    fireEvent.click(purchaseTerms)
    fireEvent.click(terms)
    expect(openExternal.mock.calls).toEqual([[PROTON_PURCHASE_TERMS_URL], [ATUM_LINKS.terms]])
  })
})
