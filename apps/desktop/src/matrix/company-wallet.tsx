import { useEffect, useRef, useState } from 'react'

import { ProtonAmount } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { Loader } from '@/components/ui/loader'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'

import {
  companyDesktopAdapter,
  type CompanyProtonOrderV2,
  type CompanyProtonPackV2,
  type CompanyWalletV2
} from './company-desktop-adapter'
import { CompanyWalletFund } from './company-wallet-fund'

const MICRO_PROTONS = 1_000_000

function denied(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'denied')
}

/** `enabled` false reads nothing: a member is never sent to the wallet the server refuses them. */
export function useCompanyWallet(companyId: string, enabled = true): {
  wallet?: CompanyWalletV2
  loading: boolean
  denied: boolean
  failed: boolean
  reload(): void
} {
  const [wallet, setWallet] = useState<CompanyWalletV2>()
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const shown = useRef<string>(undefined)

  useEffect(() => {
    const adapter = companyDesktopAdapter()
    const request = ++generation.current
    setLoading(enabled)
    setFailed(false)
    setForbidden(false)

    // A reload keeps the balance on screen until the new one arrives; another company never shows it.
    if (shown.current !== companyId || !enabled) {
      setWallet(undefined)
    }

    shown.current = enabled ? companyId : undefined

    if (!enabled) {
      return
    }

    if (!adapter) {
      setLoading(false)
      setFailed(true)

      return
    }

    void adapter
      .readWallet(companyId)
      .then(next => {
        if (generation.current === request && next.companyId === companyId) {
          setWallet(next)
        }
      })
      .catch(error => {
        if (generation.current === request) {
          setForbidden(denied(error))
          setFailed(!denied(error))
        }
      })
      .finally(() => {
        if (generation.current === request) {
          setLoading(false)
        }
      })

    return () => {
      generation.current += 1
    }
  }, [attempt, companyId, enabled])

  return { wallet, loading, denied: forbidden, failed, reload: () => setAttempt(value => value + 1) }
}

export interface CompanyWalletPanelProps {
  companyId: string
  /** Whole Protons a refused purchase was short by: the fund form starts filled with it. */
  prefillProtons?: number
  initialWallet: CompanyWalletV2
  onClose(): void
  onWalletChange?(wallet: CompanyWalletV2): void
}

export function CompanyWalletPanel({ companyId, initialWallet, onClose, onWalletChange, prefillProtons }: CompanyWalletPanelProps) {
  const { locale, t } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const [wallet, setWallet] = useState(initialWallet)
  const [packs, setPacks] = useState<CompanyProtonPackV2[]>()
  const [order, setOrder] = useState<CompanyProtonOrderV2>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const adapter = companyDesktopAdapter()

    if (!adapter) {
      setLoading(false)
      setFailed(true)

      return
    }

    let live = true
    void adapter
      .readPacks(companyId)
      .then(catalog => {
        if (live && catalog.companyId === companyId) {
          setPacks(catalog.packs)
        }
      })
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoading(false))

    return () => {
      live = false
    }
  }, [companyId])

  useEffect(() => {
    if (!order || !['creating', 'pending'].includes(order.state)) {
      return
    }

    const adapter = companyDesktopAdapter()

    if (!adapter) {
      return
    }

    let live = true

    const check = () =>
      void adapter
        .readOrder(companyId, order.orderId)
        .then(next => {
          if (!live || next.companyId !== companyId) {
            return
          }

          setOrder(next)

          if (next.credited) {
            void adapter
              .readWallet(companyId)
              .then(updated => {
                if (live && updated.companyId === companyId) {
                  setWallet(updated)
                  onWalletChange?.(updated)
                }
              })
              .catch(() => {})
          }
        })
        .catch(() => {})

    const timer = window.setInterval(check, 3_000)

    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [companyId, onWalletChange, order])

  const formatProtons = (micro: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(micro / MICRO_PROTONS)

  const formatVnd = (amount: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount)

  const createOrder = async (packId: string) => {
    const adapter = companyDesktopAdapter()

    if (!adapter || busy) {
      return
    }

    setBusy(true)
    setFailed(false)

    try {
      setOrder(
        await adapter.createOrder(companyId, {
          schemaVersion: 2,
          requestId: globalThis.crypto.randomUUID(),
          packId
        })
      )
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const orderText =
    order &&
    {
      creating: copy.orderCreating,
      pending: copy.orderPending,
      paid: copy.orderPaid,
      cancelled: copy.orderCancelled,
      expired: copy.orderExpired
    }[order.state]

  return (
    <ConsentBoundary><aside
      aria-label={copy.wallet}
      className="absolute inset-y-0 end-0 z-20 flex w-[min(27rem,100%)] flex-col border-s border-(--atum-panel-line) bg-(--atum-main-bg) shadow-nous"
      data-company-wallet
    >
      <header className="flex h-(--atum-l-header) shrink-0 items-center justify-between gap-3 border-b border-(--atum-panel-line) px-5">
        <h2 className="text-sm font-semibold text-(--atum-ink)">{copy.wallet}</h2>
        <Button onClick={onClose} size="sm" variant="text">
          {copy.close}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div
          className="grid gap-1"
          data-company-wallet-balances
          data-company-wallet-held={formatProtons(wallet.balances.held)}
        >
          <p className="text-xs text-(--atum-ink-muted)">{copy.availableBalance}</p>
          <p className="text-lg font-semibold text-(--atum-ink)">
            <Tip label={`${copy.heldBalance}: ${formatProtons(wallet.balances.held)}`}>
              <span className="cursor-default" tabIndex={0}>
                <ProtonAmount
                  amount={formatProtons(wallet.balances.available)}
                  spoken={t.atum.protons.balance(formatProtons(wallet.balances.available))}
                />
              </span>
            </Tip>
          </p>
        </div>
        <CompanyWalletFund
          companyId={companyId}
          onFunded={updated => {
            setWallet(updated)
            onWalletChange?.(updated)
          }}
          prefillProtons={prefillProtons}
        />
        <section aria-label={copy.choosePack} className="mt-7 grid gap-3">
          <h3 className="text-xs font-semibold text-(--atum-ink-muted)">{copy.choosePack}</h3>
          {loading && <Loader className="size-5" label={copy.walletLoading} size="sm" />}
          {packs?.map(pack => (
            <div
              className="flex items-center justify-between gap-4 py-1"
              data-company-pack={pack.packId}
              key={pack.packId}
            >
              <span>
                <span className="block text-sm font-semibold text-(--atum-ink)">
                  {new Intl.NumberFormat(locale).format(pack.protons)} Proton
                </span>
                <span className="block text-xs text-(--atum-ink-muted)">{formatVnd(pack.amountVnd)}</span>
              </span>
              <Button
                disabled={busy || !wallet.canTopUp}
                onClick={() => void createOrder(pack.packId)}
                size="sm"
                variant="secondary"
              >
                {copy.topUp}
              </Button>
            </div>
          ))}
        </section>
        {order && (
          <div
            className="mt-6 flex items-center justify-between gap-3 border-t border-(--atum-panel-line) pt-4"
            data-company-order={order.state}
          >
            <p className="text-sm text-(--atum-ink-muted)" role="status">
              {orderText}
            </p>
            {order.state === 'pending' && (
              <Button onClick={() => void companyDesktopAdapter()?.openOrder(companyId, order.orderId).catch(() => {})} size="sm">
                {copy.openCheckout}
              </Button>
            )}
          </div>
        )}
        {failed && (
          <p className="mt-4 text-sm text-(--atum-danger)" role="alert">
            {copy.walletUnavailable}
          </p>
        )}
      </div>
    </aside></ConsentBoundary>
  )
}

/**
 * The company wallet is a company-menu destination, never a board action: the
 * menu offers it to owners and admins only, and a member's read is refused.
 */
export function CompanyWalletDrawer({
  companyId,
  onClose,
  onWalletChange,
  prefillProtons
}: {
  companyId: string
  onClose(): void
  onWalletChange?(wallet: CompanyWalletV2): void
  prefillProtons?: number
}) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const { denied, failed, reload, wallet } = useCompanyWallet(companyId)

  if (wallet) {
    return (
      <ConsentBoundary><CompanyWalletPanel
        companyId={companyId}
        initialWallet={wallet}
        onClose={onClose}
        onWalletChange={onWalletChange}
        prefillProtons={prefillProtons}
      /></ConsentBoundary>
    )
  }

  return (
    <ConsentBoundary><aside
      aria-label={copy.wallet}
      className="absolute inset-y-0 end-0 z-20 flex w-[min(27rem,100%)] flex-col border-s border-(--atum-panel-line) bg-(--atum-main-bg) shadow-nous"
      data-company-wallet
    >
      <header className="flex h-(--atum-l-header) shrink-0 items-center justify-between gap-3 border-b border-(--atum-panel-line) px-5">
        <h2 className="text-sm font-semibold text-(--atum-ink)">{copy.wallet}</h2>
        <Button onClick={onClose} size="sm" variant="text">
          {copy.close}
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 content-start gap-3 px-5 py-5">
        {denied ? (
          <p className="text-sm text-(--atum-ink-muted)">{copy.walletDenied}</p>
        ) : failed ? (
          <>
            <p className="text-sm text-(--atum-ink-muted)">{copy.walletUnavailable}</p>
            <Button onClick={reload} size="sm" variant="secondary">
              {copy.retry}
            </Button>
          </>
        ) : (
          <Loader className="size-5" label={copy.walletLoading} size="sm" />
        )}
      </div>
    </aside></ConsentBoundary>
  )
}
