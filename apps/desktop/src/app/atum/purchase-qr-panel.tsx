import QRCode from 'qrcode'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'

import { writeClipboardText } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import { ExternalLink } from '@/lib/external-link'
import { cn } from '@/lib/utils'

import { protonBankName, type ProtonOrderPayment } from '../../../shared/matrix-checkout'
import { ATUM_LINKS } from '../../matrix/atum-links'
import { useMatrixLegalCopy } from '../../matrix/legal-copy'

/** Atum's purchase terms, the policy line under every QR card. */
export const PROTON_PURCHASE_TERMS_URL = 'https://account.atumplatform.com/payments/protons'

const COPIED_RESET_MS = 1_800

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Milliseconds until the QR expires, ticking once a second; null without an expiry. */
export function useQrRemaining(expiresAt: null | string | undefined): null | number {
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!Number.isFinite(expiry)) {return}
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)

    return () => window.clearInterval(timer)
  }, [expiry])

  return Number.isFinite(expiry) ? expiry - now : null
}

/**
 * One transfer line. The whole row is the copy button, as on Moon's card:
 * label over value on the left, a "Chép" pill on the right that reads
 * "Đã chép" (or "Chép tay" when the clipboard refuses) for 1.8 seconds.
 */
function CopyDetailRow({ copyValue, label, value }: { copyValue?: string; label: string; value: string }) {
  const { t } = useI18n()
  const copy = t.atum.protons.checkout
  const [state, setState] = useState<'copied' | 'failed' | 'idle'>('idle')
  const reset = useRef<null | number>(null)

  useEffect(() => () => {
    if (reset.current !== null) {window.clearTimeout(reset.current)}
  }, [])

  if (!value) {return null}

  const onCopy = () => {
    void writeClipboardText(copyValue || value).then(() => true, () => false).then(ok => {
      setState(ok ? 'copied' : 'failed')

      if (reset.current !== null) {window.clearTimeout(reset.current)}
      reset.current = window.setTimeout(() => setState('idle'), COPIED_RESET_MS)
    })
  }

  return (
    <button
      aria-label={copy.copyDetail(label)}
      aria-live="polite"
      className="flex w-full items-center justify-between gap-3 rounded-[var(--atum-r-row)] border border-(--atum-line) bg-(--atum-sunk) px-3 py-2.5 text-left transition-colors hover:border-(--atum-line-strong) hover:bg-(--atum-hover)"
      data-atum-qr-copy={label}
      onClick={onCopy}
      type="button"
    >
      <span className="min-w-0">
        <span className="block text-[0.625rem] font-medium tracking-[0.14em] text-(--atum-ink-faint) uppercase">{label}</span>
        <span className="mt-0.5 block text-[0.78125rem] leading-snug font-semibold break-words text-(--atum-ink)">{value}</span>
      </span>
      <span className="shrink-0 rounded-full border border-(--atum-line-strong) px-2.5 py-1 text-[0.6875rem] font-semibold text-(--atum-ink-soft)">
        {state === 'copied' ? copy.copied : state === 'failed' ? copy.copyManual : copy.copy}
      </span>
    </button>
  )
}

/** The VietQR image on a white frame, with "Tải QR" under it. */
function PaymentQrImage({ downloadName, payload }: { downloadName: string; payload: string }) {
  const { t } = useI18n()
  const copy = t.atum.protons.checkout
  const [dataUrl, setDataUrl] = useState<null | string>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    setDataUrl(null)
    setFailed(false)
    QRCode.toDataURL(payload, { width: 360, margin: 1, errorCorrectionLevel: 'M' }).then(
      url => {
        if (current) {setDataUrl(url)}
      },
      () => {
        if (current) {setFailed(true)}
      }
    )

    return () => {
      current = false
    }
  }, [payload])

  if (failed) {return null}

  return (
    <div className="mx-auto shrink-0 @[26rem]:mx-0" data-atum-qr-image>
      <div className="rounded-[0.75rem] bg-(--atum-page) p-2">
        {dataUrl
          ? <img alt={copy.qrAlt} className="size-40 rounded-[0.5rem]" draggable={false} src={dataUrl} />
          : <div aria-hidden className="size-40 rounded-[0.5rem] bg-(--atum-sunk)" />}
      </div>
      {dataUrl && (
        <a
          className="mt-2 inline-flex w-full items-center justify-center rounded-full border border-(--atum-line-strong) px-3 py-1.5 text-(length:--atum-t-caption) font-semibold text-(--atum-ink-soft) transition-colors hover:bg-(--atum-hover)"
          download={downloadName}
          href={dataUrl}
        >
          {copy.downloadQr}
        </a>
      )}
    </div>
  )
}

/**
 * A policy page under the QR, opened in the browser. A window with its own way to open links
 * passes it (the Matrix window has no `hermesDesktop` bridge, so the link would do nothing).
 */
function PolicyLink({ children, href, onOpenLink }: { children: ReactNode; href: string; onOpenLink?: (url: string) => void }) {
  return (
    <ExternalLink
      className="font-normal text-(--atum-ink-faint) no-underline hover:text-(--atum-ink-muted) hover:underline"
      href={href}
      onClick={
        onOpenLink
          ? event => {
              event.preventDefault()
              onOpenLink(href)
            }
          : undefined
      }
      showExternalIcon={false}
    >
      {children}
    </ExternalLink>
  )
}

export interface PurchaseQrPanelProps {
  amountVnd: number
  onOpenCheckout?: () => void
  /** Opens the policy pages in the browser; without it they open through `hermesDesktop`. */
  onOpenLink?: (url: string) => void
  orderCode: number
  payment: null | ProtonOrderPayment
}

/**
 * The in-place payment card — Moon's `PurchaseQrPanel`, element for element:
 * QR (or the "Không tải được QR" box) beside a heading, a note, the five copy
 * rows (Số tiền · Ngân hàng · Số tài khoản · Chủ tài khoản · Nội dung CK), the
 * expiry countdown, the checkout-page link, the policy line (the purchase terms
 * and the Terms of Service) and the seller line under it: the company, its
 * enterprise code, its head office and support. Two columns once the card is
 * wide enough; stacked inside a dialog.
 *
 * Every value is PayOS's signed answer relayed by the platform; the renderer
 * formats, never computes, a payment instruction.
 */
export function PurchaseQrPanel({ amountVnd, onOpenCheckout, onOpenLink, orderCode, payment }: PurchaseQrPanelProps) {
  const { locale, t } = useI18n()
  const copy = t.atum.protons.checkout
  const legal = useMatrixLegalCopy()
  const remaining = useQrRemaining(payment?.expires_at)
  const amount = new Intl.NumberFormat(locale).format(amountVnd)

  return (
    <div className="@container" data-atum-qr-panel>
      <div className="grid min-w-0 gap-4 rounded-[var(--atum-r-card)] border border-(--atum-line) bg-(--atum-card) p-4 @[26rem]:grid-cols-[auto_minmax(0,1fr)]">
        {payment ? (
          <PaymentQrImage downloadName={`atum-qr-${orderCode}.png`} payload={payment.qr_code} />
        ) : (
          <div className="mx-auto flex min-h-40 w-40 shrink-0 flex-col items-center justify-center rounded-[0.75rem] border border-dashed border-(--atum-line-strong) bg-(--atum-sunk) p-4 text-center @[26rem]:mx-0" data-atum-qr-fallback>
            <p className="text-(length:--atum-t-caption) font-semibold tracking-[0.14em] text-(--atum-ink-soft) uppercase">{copy.qrUnavailable}</p>
            <p className="mt-2 text-(length:--atum-t-caption) leading-relaxed text-(--atum-ink-muted)">{copy.qrUnavailableCheckout}</p>
            {onOpenCheckout && (
              <button
                className="mt-3 inline-flex items-center justify-center rounded-full border border-(--atum-line-strong) px-3 py-1.5 text-(length:--atum-t-caption) font-semibold text-(--atum-ink-soft) transition-colors hover:bg-(--atum-hover)"
                onClick={onOpenCheckout}
                type="button"
              >
                {copy.openCheckoutPage}
              </button>
            )}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-(length:--atum-t-caption) font-semibold tracking-[0.16em] text-(--atum-ink-soft) uppercase">{copy.qrHeading}</p>
          <p className="mt-2 text-(length:--atum-t-body) leading-relaxed text-(--atum-ink-muted)">{copy.qrNote}</p>
          <div className="mt-3 space-y-2">
            <CopyDetailRow copyValue={String(amountVnd)} label={copy.amount} value={copy.vndInline(amount)} />
            {payment && (
              <>
                <CopyDetailRow label={copy.bank} value={protonBankName(payment.bank_bin)} />
                <CopyDetailRow label={copy.accountNumber} value={payment.account_number} />
                <CopyDetailRow label={copy.accountName} value={payment.account_name} />
                <CopyDetailRow label={copy.transferNote} value={payment.description} />
              </>
            )}
            {remaining !== null && remaining > 0 && (
              <div className="flex justify-between gap-3 px-1 text-(length:--atum-t-caption) leading-relaxed text-(--atum-ink-muted)" data-atum-qr-countdown>
                <span>{copy.expiresIn}</span>
                <span className={cn('font-semibold tabular-nums', remaining < 2 * 60_000 ? 'text-(--atum-danger)' : 'text-(--atum-ink)')}>
                  {formatRemaining(remaining)}
                </span>
              </div>
            )}
          </div>
          {payment && onOpenCheckout && (
            <div className="mt-4 text-center @[26rem]:text-left">
              <button
                className="text-(length:--atum-t-caption) font-medium text-(--atum-ink-muted) underline underline-offset-4 transition-colors hover:text-(--atum-ink)"
                onClick={onOpenCheckout}
                type="button"
              >
                {copy.openCheckoutPage}
              </button>
            </div>
          )}
          <div className="mt-4 text-center text-[0.6875rem] leading-relaxed text-(--atum-ink-faint)" data-atum-qr-policy>
            <p>
              <PolicyLink href={PROTON_PURCHASE_TERMS_URL} onOpenLink={onOpenLink}>{t.atum.protons.purchaseTerms}</PolicyLink>
              <span aria-hidden="true"> · </span>
              <PolicyLink href={ATUM_LINKS.terms} onOpenLink={onOpenLink}>{legal.terms}</PolicyLink>
            </p>
            {/* Each part keeps to one line, so a wrap falls between parts, never inside the address. */}
            <p className="mt-1 text-balance select-text" data-atum-qr-seller>
              {legal.seller.split(' · ').map((part, index) => (
                <Fragment key={part}>
                  {index > 0 && ' · '}
                  <span className="whitespace-nowrap">{part}</span>
                </Fragment>
              ))}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
