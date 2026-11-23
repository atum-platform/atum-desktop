import { useStore } from '@nanostores/react'

import { $work } from '@/app/work/store'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { Check } from '@/lib/icons'
import { ProviderMark } from '@/matrix/model-picker-provider-mark'

import type { AccountPlan } from '../../../shared/account-connections'

import { ACCOUNT_PLAN_NAMES, connectionsCopy } from './copy'
import {
  $accountConnect,
  $accountConnectProgress,
  closeAccountConnect,
  type ConnectionsBridge,
  continueAccountConnect,
  dismissAccountConnectProgress,
  openAccountConnect
} from './store'
import { ACCOUNT_PLAN_PICKER_PROVIDER } from './view'

/** A plan's own mark, a squircle (services and apps are squircles; people and assistants are circles). */
export function AccountPlanMark({ plan, size = 'md' }: { plan: AccountPlan; size?: 'sm' | 'md' }) {
  return <ProviderMark provider={{ id: ACCOUNT_PLAN_PICKER_PROVIDER[plan], label: ACCOUNT_PLAN_NAMES[plan] }} size={size} />
}

/**
 * The one connect sheet (Work UI spec §3.1, owner Q1). Every Connect opens it. Ask: the plan's mark, "Connect {Plan}", one line, and
 * the one sentence that is the consent (no checkbox). Continue shows Work on T3's own sign-in screen for the plan; the Work title band
 * then says "Finish signing in…" and "… is connected". On a device without Work it says where to connect instead.
 *
 * `onLeave` closes whatever covers Work (Settings, the assistant card) so the owner lands on the sign-in screen.
 */
export function AccountConnectSheet({
  bridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.work,
  onLeave
}: {
  bridge?: ConnectionsBridge
  onLeave?: () => void
}) {
  const { locale } = useI18n()
  const copy = connectionsCopy(locale)
  const request = useStore($accountConnect)
  const work = useStore($work)

  if (!request) {
    return null
  }

  const here = Boolean(bridge && work)
  const words = copy.sheet

  return (
    <Dialog onOpenChange={open => !open && closeAccountConnect()} open>
      <DialogContent
        className="max-w-sm gap-0 p-0"
        data-atum-connect-mode={request.mode ?? 'connect'}
        data-atum-connect-sheet={request.plan}
        showCloseButton={false}
      >
        <div className="ak-state gap-(--ak-s2) px-(--ak-s6) pt-(--ak-s6) pb-(--ak-s4)">
          <span className="mb-(--ak-s2)">
            <AccountPlanMark plan={request.plan} />
          </span>
          <DialogTitle className="ak-state-title">{words.title(request.plan)}</DialogTitle>
          <DialogDescription className="ak-state-body">
            {here ? `${words.line(request.plan)} ${words.consent}` : words.needsMac}
          </DialogDescription>
        </div>
        <div className="flex items-center justify-end gap-(--ak-s2) px-(--ak-s4) pb-(--ak-s4)">
          {here ? (
            <>
              <button className="ak-btn ak-btn--sm ak-btn--plain" onClick={closeAccountConnect} type="button">
                {words.notNow}
              </button>
              <button
                className="ak-btn ak-btn--sm ak-btn--primary"
                data-atum-connect-continue
                onClick={() => {
                  onLeave?.()
                  void continueAccountConnect(request, bridge)
                }}
                type="button"
              >
                {words.continue}
              </button>
            </>
          ) : (
            <button className="ak-btn ak-btn--sm" onClick={closeAccountConnect} type="button">
              {words.close}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The sheet's second and third states, in the Work title band (DOM above the native view, so they never cover T3's sign-in):
 * a spinner and "Finish signing in to Claude", then a check and "Claude is connected", which leaves after a beat. A sign-in that
 * never lands says so once, with Try again.
 */
export function AccountConnectProgress() {
  const { locale } = useI18n()
  const copy = connectionsCopy(locale).progress
  const progress = useStore($accountConnectProgress)

  if (!progress) {
    return null
  }

  const { phase, plan } = progress

  return (
    <span
      className="flex min-w-0 items-center gap-(--ak-s2) [font:var(--ak-t-callout)] text-(--ak-ink-2)"
      data-atum-connect-progress={phase}
      role="status"
    >
      {phase === 'signing_in' && <span aria-hidden className="ak-spinner" />}
      {phase === 'done' && <Check aria-hidden className="size-4 text-(--ak-ink)" />}
      <span className="truncate">
        {phase === 'signing_in' ? copy.signingIn(plan) : phase === 'done' ? copy.done(plan) : copy.failed(plan)}
      </span>
      {phase === 'failed' && (
        <button
          className="ak-btn ak-btn--sm ak-btn--plain"
          onClick={() => {
            dismissAccountConnectProgress()
            openAccountConnect(plan)
          }}
          type="button"
        >
          {copy.tryAgain}
        </button>
      )}
    </span>
  )
}

/** The picker's list for a plan with nothing to pick yet: the plan's mark, one line, one Connect (Work UI spec §2.1). */
export function AccountPlanConnectState({ plan, onConnect }: { plan: AccountPlan; onConnect: () => void }) {
  const { locale } = useI18n()
  const copy = connectionsCopy(locale)

  return (
    <div className="ak-state justify-center py-(--ak-s8)" data-atum-picker-connect={plan}>
      <span className="mb-(--ak-s2)">
        <AccountPlanMark plan={plan} />
      </span>
      <div className="ak-state-body">{copy.picker.use(plan)}</div>
      <button className="ak-btn ak-btn--sm" data-atum-picker-connect-action onClick={onConnect} type="button">
        {copy.connect}
      </button>
    </div>
  )
}
