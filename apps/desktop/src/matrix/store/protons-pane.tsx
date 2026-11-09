import { ProtonAmount } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'

import type { MatrixWalletState } from '../../../shared/matrix-wallet'
import { matrixWalletCopy } from '../wallet-copy'
import { activityProtons, type MatrixWalletHistoryView, wholeProtons } from '../wallet-ui'

/** Main's owner-bound ledger projection. Values remain micro-Protons until display. */
export type ProtonsWalletData = MatrixWalletState

function useAmount() {
  const { locale, t } = useI18n()

  /** A balance: whole Protons, rounded down, so spendable value is never overstated. */
  const whole = (value: number, variant: 'regular' | 'small' = 'small') => {
    const amount = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(wholeProtons(value))

    return <ProtonAmount amount={amount} spoken={t.atum.protons.balance(amount)} variant={variant} />
  }

  /** A movement in the activity list: whole Protons, "<1" for a sliver. */
  const movement = (value: number) => {
    const amount = activityProtons(value, locale)

    return <ProtonAmount amount={amount} spoken={t.atum.protons.balance(amount)} />
  }

  return { movement, whole }
}

const EMPTY_HISTORY: MatrixWalletHistoryView = { entries: [], error: false, loading: false, next: null }

/**
 * Settings → Protons: what the person can spend, one button to add more (the Store's
 * own top-up, the same one the Store header and the account menu open), and the rest —
 * where the Protons came from, what is held — behind Details. Numbers are whole Protons.
 */
export function MatrixProtonsPane({
  data,
  history = EMPTY_HISTORY,
  onAbout,
  onLoadMore = () => {},
  onTopUp
}: {
  data: ProtonsWalletData
  history?: MatrixWalletHistoryView
  /** Atum's page about Protons and their purchase terms. */
  onAbout?: () => void
  onLoadMore?(): void
  /** The top-up: the Store's checkout, or Atum's payments page in a build without one. */
  onTopUp?: () => void
}) {
  const { locale, t } = useI18n()
  const copy = matrixWalletCopy(locale)
  const amount = useAmount()
  const wallet = data.state === 'ready' ? data.wallet : null
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })

  return (
    <div data-matrix-protons>
      <div aria-live="polite" className="atum-settings-group p-5">
        <p className="text-(length:--atum-t-control) text-(--atum-ink-muted)">{t.atum.protons.available}</p>
        <p className="mt-1.5 text-[2rem] font-semibold tracking-tight text-(--atum-ink)">
          {data.state === 'loading'
            ? t.atum.protons.checking
            : wallet
              ? amount.whole(wallet.balances.available, 'regular')
              : t.atum.protons.balanceUnavailable}
        </p>
        {data.state === 'unavailable' && (
          <p className="mt-3 text-(length:--atum-t-control) text-(--atum-ink-faint)">{t.atum.protons.unavailable}</p>
        )}
        {(onTopUp || onAbout) && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            {onTopUp && (
              <Button className="atum-store-action" data-matrix-protons-topup onClick={onTopUp}>
                {copy.topUp}
              </Button>
            )}
            {onAbout && (
              <Button data-matrix-protons-about onClick={onAbout} size="sm" variant="text">
                {copy.about}
              </Button>
            )}
          </div>
        )}
        {wallet && (
          // Wrapped: a bare disclosure in a settings group draws as a full row; this one is a quiet link.
          <div className="mt-4">
            <details className="atum-protons-details" data-matrix-protons-details>
              <summary>{copy.details}</summary>
              <dl className="mt-2 grid gap-1.5 text-(length:--atum-t-control) text-(--atum-ink-muted) tabular-nums">
                {[
                  [copy.paid, wallet.balances.paid],
                  [copy.earned, wallet.balances.earned],
                  [copy.promo, wallet.balances.promo],
                  [copy.held, wallet.balances.held]
                ].map(([label, value]) => (
                  <div className="flex items-center justify-between gap-4" key={label}>
                    <dt>{label}</dt>
                    <dd>{amount.whole(value as number)}</dd>
                  </div>
                ))}
              </dl>
              {wallet.allowance && (
                <p className="mt-2 text-(length:--atum-t-control) text-(--atum-ink-soft)" data-matrix-wallet-allowance>
                  {copy.allowance(
                    wallet.allowance.kind,
                    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
                      wholeProtons(wallet.allowance.amount)
                    ),
                    wallet.allowance.state
                  )}
                </p>
              )}
            </details>
          </div>
        )}
      </div>

      {(history.entries.length > 0 || history.loading || history.error) && (
        <section className="atum-settings-section">
          <div className="atum-settings-section-head">
            <h3 className="atum-settings-section-title">{copy.activity}</h3>
          </div>
          <div className="atum-settings-group" data-matrix-protons-activity>
            {history.entries.map(entry => {
              const activity = copy.activityEntry(entry.kind, entry.status, entry.amount)

              return (
                <div className="atum-settings-row" key={entry.id}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{activity.label}</span>
                    <span className="block text-(length:--atum-t-caption) text-(--atum-ink-faint)">
                      {date.format(new Date(entry.at))} · {activity.status}
                    </span>
                  </span>
                  <span className="shrink-0 text-(--atum-ink-soft) tabular-nums">
                    {entry.amount > 0 ? '+' : entry.amount < 0 ? '−' : ''}
                    {amount.movement(entry.amount)}
                  </span>
                </div>
              )
            })}
            {history.loading && (
              <div className="px-4 py-3">
                <Loader className="size-5" label={t.common.loading} size="sm" />
              </div>
            )}
            {history.error && (
              <p className="px-4 py-3 text-(length:--atum-t-control) text-(--atum-ink-faint)">
                {copy.historyUnavailable}
              </p>
            )}
          </div>
          {history.next && !history.error && (
            <Button className="mt-3" disabled={history.loading} onClick={onLoadMore} size="sm" variant="secondary">
              {copy.loadMore}
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
