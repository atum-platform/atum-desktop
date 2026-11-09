import { useEffect, useRef, useState } from 'react'

import { PurchaseQrPanel } from '@/app/atum/purchase-qr-panel'
import { ProtonAmount } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { Check } from '@/lib/icons'

import type { MatrixCheckoutSnapshot, MatrixTopUpPack } from '../../../shared/matrix-checkout'
import type { MatrixWalletState } from '../../../shared/matrix-wallet'
import { wholeProtons } from '../wallet-ui'

import type { MatrixStoreCopy } from './store-copy'

export interface DiscoverCheckout {
  snapshot: MatrixCheckoutSnapshot
  onRefresh(): void
  onStart(packId: string): Promise<unknown>
  onStatus(): Promise<unknown>
  onResume(): Promise<unknown>
  onOpenCheckout(): Promise<void>
  onDismissTerminal(): Promise<void>
}

type Order = NonNullable<MatrixCheckoutSnapshot['order']>

function terminalOrder(order: Order) {
  return order.status === 'paid' || order.status === 'cancelled' || order.status === 'expired'
}

function formatWhole(microProtons: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(wholeProtons(microProtons))
}

/** A quiet, centred state for a whole surface that cannot load, with the one thing to do. */
export function StoreQuietState({
  action,
  children,
  onAction
}: {
  action?: string
  children: string
  onAction?: () => void
}) {
  return (
    <div className="atum-store-quiet" data-store-quiet role="status">
      <p>{children}</p>
      {action && onAction && (
        <Button onClick={onAction} size="sm" variant="secondary">
          {action}
        </Button>
      )}
    </div>
  )
}

function PackCard({
  copy,
  disabled,
  pack,
  start
}: {
  copy: MatrixStoreCopy
  disabled: boolean
  pack: MatrixTopUpPack
  start(packId: string): void
}) {
  const { locale, t } = useI18n()
  const amount = formatWhole(pack.totalMicroProtons, locale)

  return (
    <article className="atum-store-pack" data-matrix-topup-pack={pack.id}>
      <div className="min-w-0">
        <p className="text-[1.0625rem] leading-tight font-semibold text-(--atum-ink)">
          <ProtonAmount amount={amount} spoken={t.atum.protons.balance(amount)} />
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-[0.9375rem] font-semibold text-(--atum-ink) tabular-nums">
          {new Intl.NumberFormat(locale, { currency: 'VND', maximumFractionDigits: 0, style: 'currency' }).format(
            pack.amountVnd
          )}
        </span>
        <Button className="atum-store-action" disabled={disabled} onClick={() => start(pack.id)} size="sm">
          {copy.checkoutBuy}
        </Button>
      </div>
    </article>
  )
}

/**
 * The Store's top-up: server packs, then the order's QR in place. A live order is watched
 * while this is on screen (3 s, backing off to 30 s; the Electron controller never idles in
 * the background), so a transfer lands without a click. One order is open per account and
 * there is no cancel, so a pending QR says how to pick a different pack instead of offering
 * a button that cannot.
 */
export function MatrixCheckoutPane({
  checkout,
  copy,
  doneLabel,
  onDone,
  wallet
}: {
  checkout: DiscoverCheckout
  copy: MatrixStoreCopy
  /** After a paid order: where the person goes next (the store, or back to the item they wanted). */
  doneLabel?: string
  onDone?: () => void
  wallet?: MatrixWalletState
}) {
  const { locale } = useI18n()
  const snapshot = checkout.snapshot
  const [working, setWorking] = useState(false)
  const [error, setError] = useState(false)
  const order = snapshot.order
  const live = order !== null && !terminalOrder(order)
  // The latest status read, so a parent re-render (a new checkout object) never restarts the backoff.
  const readStatus = useRef(checkout.onStatus)
  readStatus.current = checkout.onStatus

  useEffect(() => {
    if (!live) {
      return
    }

    let cancelled = false
    let delay = 3000
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = () => {
      timer = setTimeout(() => {
        void readStatus
          .current()
          .catch(() => {})
          .finally(() => {
            if (!cancelled) {
              delay = Math.min(delay * 2, 30_000)
              poll()
            }
          })
      }, delay)
    }

    poll()

    return () => {
      cancelled = true

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [live, order?.id])

  const act = (work: () => Promise<unknown>) => {
    setWorking(true)
    setError(false)
    void work()
      .catch(() => setError(true))
      .finally(() => setWorking(false))
  }

  if (snapshot.state === 'loading') {
    return <Loader className="mx-auto my-6 size-8" label={copy.checkoutLoading} />
  }

  if (snapshot.state === 'unavailable') {
    return (
      <StoreQuietState action={copy.retry} onAction={checkout.onRefresh}>
        {copy.checkoutUnavailable}
      </StoreQuietState>
    )
  }

  const balance = wallet?.state === 'ready' ? wallet.wallet.balances.available : null

  return (
    <section aria-label={copy.topUp} className="grid gap-3" data-matrix-checkout>
      {!snapshot.checkoutOpen && !order && <StoreQuietState>{copy.checkoutUnavailable}</StoreQuietState>}
      {snapshot.checkoutOpen &&
        !order &&
        !snapshot.intent &&
        snapshot.packs.map(pack => (
          <PackCard
            copy={copy}
            disabled={working}
            key={pack.id}
            pack={pack}
            start={packId => act(() => checkout.onStart(packId))}
          />
        ))}
      {snapshot.intent && !order && (
        <NoticeBand role="status" tone="notice">
          <span>{copy.checkoutRecover} </span>
          <button
            className="underline underline-offset-2"
            disabled={working}
            onClick={() => act(checkout.onResume)}
            type="button"
          >
            {copy.checkoutResume}
          </button>
        </NoticeBand>
      )}
      {order?.status === 'creating' && (
        <div aria-live="polite" className="flex items-center gap-3 py-2" data-matrix-checkout-order="creating">
          <Loader className="size-5" label={copy.checkoutCreating} size="sm" />
          <p className="text-(length:--atum-t-control) text-(--atum-ink-muted)">{copy.checkoutCreating}</p>
        </div>
      )}
      {order?.status === 'pending' && (
        <div className="grid gap-3" data-matrix-checkout-order="pending">
          <p aria-live="polite" className="text-(length:--atum-t-control) text-(--atum-ink-muted)">
            {copy.checkoutPending}
          </p>
          <PurchaseQrPanel
            amountVnd={order.amount_vnd}
            onOpenCheckout={() => act(checkout.onOpenCheckout)}
            // The purchase terms and the Terms of Service open in the browser, as every link here does.
            onOpenLink={url => void window.atumMatrix?.openLink(url).catch(() => {})}
            orderCode={order.order_code}
            payment={order.payment}
          />
          <p className="text-(length:--atum-t-caption) text-(--atum-ink-faint)">{copy.checkoutChangePack}</p>
        </div>
      )}
      {order?.status === 'paid' && (
        <div className="atum-store-paid" data-matrix-checkout-order="paid">
          <span aria-hidden className="atum-store-paid-mark">
            <Check className="size-4" strokeWidth={2.4} />
          </span>
          <div aria-live="polite" className="min-w-0 flex-1">
            <p className="font-semibold text-(--atum-ink)">
              {snapshot.reconciliationPending
                ? copy.checkoutReceived
                : copy.checkoutPaid(formatWhole(order.total_protons, locale))}
            </p>
            {!snapshot.reconciliationPending && balance !== null && (
              <p className="mt-0.5 text-(length:--atum-t-control) text-(--atum-ink-muted)" data-matrix-checkout-balance>
                {copy.checkoutPaidBalance(formatWhole(balance, locale))}
              </p>
            )}
          </div>
          <Button
            className="atum-store-action"
            disabled={working}
            onClick={() =>
              act(async () => {
                // The receipt is acknowledged so the next top-up starts at the packs.
                await checkout.onDismissTerminal().catch(() => {})
                onDone?.()
              })
            }
            size="sm"
          >
            {doneLabel ?? copy.checkoutBackToStore}
          </Button>
        </div>
      )}
      {(order?.status === 'expired' || order?.status === 'cancelled') && (
        <div className="atum-store-quiet" data-matrix-checkout-order={order.status} role="status">
          <p>{order.status === 'expired' ? copy.checkoutExpired : copy.checkoutCancelled}</p>
          <Button
            className="atum-store-action"
            disabled={working}
            onClick={() => act(checkout.onDismissTerminal)}
            size="sm"
          >
            {copy.checkoutChooseAnother}
          </Button>
        </div>
      )}
      {error && (
        <NoticeBand role="alert" tone="failure">
          {copy.checkoutFailed}
        </NoticeBand>
      )}
      <p className="text-(length:--atum-t-caption) text-(--atum-ink-faint)">{copy.checkoutCurrency}</p>
    </section>
  )
}
