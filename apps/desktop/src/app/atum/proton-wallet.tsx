// RETIRED legacy wallet (pre-Matrix app); see atum-platform docs/archive/legacy-desktop-checkout.
import { useStore } from '@nanostores/react'
import { useEffect, useMemo } from 'react'

import { ProtonAmount } from '@/components/brand/proton-mark'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $atumProtonWallet, refreshAtumProtonWallet } from '@/store/atum-proton-wallet'

import { ProtonRewardsSection } from './proton-rewards'

/**
 * Settings → Protons in the legacy app: the read-only balance. The legacy
 * desktop checkout was retired on 2026-10-05, so there is nothing to buy
 * here; balance remains server truth.
 */
export function ProtonWalletSection() {
  const { locale, t } = useI18n()
  const accountId = useStore($atumAccountScopeId)
  const walletView = useStore($atumProtonWallet)
  const copy = t.atum.protons
  const protonDecimalFormat = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }), [locale])
  const ownView = walletView.accountId === accountId ? walletView : null
  const wallet = ownView?.state === 'resolved' ? ownView.wallet : null
  const loading = ownView?.state === 'loading'

  useEffect(() => { void refreshAtumProtonWallet() }, [accountId])

  return (
    <ConsentBoundary><section aria-label={copy.title} className="mt-8" data-atum-proton-wallet>
      <div aria-live="polite" className="mb-8">
        <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.available}</p>
        {loading && !wallet ? <Spinner className="mt-3 size-5 animate-spin text-(--atum-ink-muted)" label={t.common.loading} /> : (
          <p className="mt-2 text-[1.75rem] font-semibold tracking-tight text-(--atum-ink) [font-variant-numeric:tabular-nums]">
            {wallet ? (() => {
              const amount = protonDecimalFormat.format(wallet.available_protons)

              return <ProtonAmount amount={amount} spoken={copy.balance(amount)} variant="regular" />
            })() : copy.balanceUnavailable}
          </p>
        )}
        {wallet && wallet.held_protons > 0 && (
          <p className="mt-1 text-(length:--atum-t-body) text-(--atum-ink-muted)">
            {copy.held}: <ProtonAmount amount={protonDecimalFormat.format(wallet.held_protons)} spoken={copy.balance(protonDecimalFormat.format(wallet.held_protons))} />
          </p>
        )}
      </div>
      {ownView?.state === 'unavailable' && (
        <p className="mt-3 text-(length:--atum-t-body) text-(--atum-ink-faint)">{copy.unavailable}</p>
      )}
      <ProtonRewardsSection />
    </section></ConsentBoundary>
  )
}
