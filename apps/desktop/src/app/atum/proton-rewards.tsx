// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { ProtonAmount } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $atumProtonRewards, claimAtumConnectionReward, refreshAtumProtonRewards } from '@/store/atum-proton-rewards'

export function ProtonRewardsSection() {
  const { t, locale } = useI18n()
  const accountId = useStore($atumAccountScopeId)
  const view = useStore($atumProtonRewards)
  const copy = t.atum.protons.rewards

  useEffect(() => { void refreshAtumProtonRewards() }, [accountId])

  if (!accountId || view.accountId !== accountId) { return null }

  const rewards = view.rewards


  return (
    <div aria-label={copy.title} className="mt-4 border-t border-(--atum-line) pt-3">
      <h4 className="text-(length:--atum-t-ui) font-medium text-(--atum-ink)">{copy.title}</h4>
      {view.state === 'loading' || view.state === 'idle' ? <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)">{t.common.loading}</p> : null}
      {view.state === 'unavailable' ? <div className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)">
        <p>{copy.unavailable}</p>
        <Button onClick={() => void refreshAtumProtonRewards()} size="sm" variant="outline">{t.common.retry}</Button>
      </div> : null}
      {rewards ? <>
        <p className="mt-1 text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.hint}</p>
        {rewards.state === 'paused' ? <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.paused}</p> : null}
        <ul className="mt-3 space-y-3">
          {(['email', 'calendar'] as const).map(kind => {
            const task = rewards.tasks.find(task => task.kind === kind)!

            return <li className="flex items-center justify-between gap-3 text-(length:--atum-t-body)" key={kind}>
              <div><p className="text-(--atum-ink)">{kind === 'email' ? copy.email : copy.calendar}</p>
                <p className="mt-0.5 text-(--atum-ink-muted)">{task.earned_at
                  ? `${copy.earned} · ${new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(task.earned_at))}`
                  : <ProtonAmount amount={new Intl.NumberFormat(locale).format(task.amount_protons)} spoken={t.atum.protons.balance(new Intl.NumberFormat(locale).format(task.amount_protons))} />}</p></div>
              {!task.earned_at ? <Button disabled={Boolean(view.claiming) || rewards.state !== 'available'} onClick={() => void claimAtumConnectionReward(kind)} size="sm"
                variant="outline">{view.claiming === kind ? copy.verifying : copy.verify}</Button> : null}
            </li>
          })}
        </ul>
      </> : null}
      {view.notice ? <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">{view.notice === 'already_used' ? copy.alreadyUsed : copy.failed}</p> : null}
    </div>
  )
}
