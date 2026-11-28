import { useEffect, useState } from 'react'

import { setWorkActive } from '@/app/work/store'
import { ProviderMark } from '@/matrix/model-picker-provider-mark'
import { SettingsRow } from '@/matrix/settings-row'

import type { MatrixWorkBridge } from '../../../shared/matrix-work'
import { WORK_LOCAL_PLANS, type WorkLocalPlan, type WorkLocalPlanAuthAction, type WorkLocalPlanStates } from '../../../shared/work-local-plans'

interface LocalPlanRowsProps {
  bridge?: Pick<MatrixWorkBridge, 'readLocalPlans' | 'localPlanAction'> & Partial<Pick<MatrixWorkBridge, 'subscribe'>>
  manageLabel: string
  onLeave?: () => void
}

export function LocalPlanRows({ bridge, manageLabel, onLeave }: LocalPlanRowsProps) {
  const [states, setStates] = useState<WorkLocalPlanStates>({})
  const [busy, setBusy] = useState<WorkLocalPlan>()
  const [failed, setFailed] = useState<{ plan: WorkLocalPlan; detail: string }>()

  useEffect(() => {
    let active = true
    const refresh = () => void bridge?.readLocalPlans?.().then(
      next => { if (active) {setStates(next)} },
      () => undefined
    )

    refresh()
    const unwatch = bridge?.subscribe?.(projection => {
      if (projection?.view === 'ready') {refresh()}
    })

    window.addEventListener('focus', refresh)

    return () => {
      active = false
      unwatch?.()
      window.removeEventListener('focus', refresh)
    }
  }, [bridge])

  const runAuth = async (plan: WorkLocalPlan, action: WorkLocalPlanAuthAction) => {
    if (busy || !bridge?.localPlanAction) {return}
    setBusy(plan)
    setFailed(undefined)
    try {
      const detail = await bridge.localPlanAction(plan, action)

      if (detail) {setFailed({ plan, detail })}
      else {setStates(await bridge.readLocalPlans?.() ?? {})}
    } catch {
      setFailed({ plan, detail: action === 'logout' ? 'Couldn’t sign out. Try again.' : 'Setup didn’t finish. Try again.' })
    } finally {
      setBusy(undefined)
    }
  }

  if (!bridge?.localPlanAction) {return null}

  return (Object.keys(WORK_LOCAL_PLANS) as WorkLocalPlan[]).map(plan => {
    const { title } = WORK_LOCAL_PLANS[plan]
    const status = states[plan]
    const state = busy === plan ? 'installing' : status?.state
    const openRouter = plan === 'openrouter-free'
    const ready = state === 'ready'
    const line = failed?.plan === plan ? failed.detail
      : state === 'ready' ? status?.allowance ?? 'Connected on this Mac'
        : state === 'installing' ? 'Working on your connection…'
          : openRouter && state === 'signed_out' ? 'For a few chats a day. Use a workspace without upstream provider keys.'
            : state === 'not_installed' ? 'Install to use in Work'
              : state === 'signed_out' ? 'Sign in to use in Work' : 'Checking availability…'

    return (
      <SettingsRow
        control={
          <div className="flex flex-wrap justify-end gap-2">
            {plan === 'kiro' && !ready && state !== 'installing' ? (
              <>
                <button className="ak-btn ak-btn--sm" disabled={busy !== undefined} onClick={() => void runAuth(plan, 'setup-google')} type="button">
                  Sign in with Google
                </button>
                <button className="ak-btn ak-btn--sm" disabled={busy !== undefined} onClick={() => void runAuth(plan, 'setup-github')} type="button">
                  Sign in with GitHub
                </button>
              </>
            ) : (
              <button
                className={ready ? 'ak-btn ak-btn--sm ak-btn--plain' : 'ak-btn ak-btn--sm'}
                disabled={busy !== undefined || (openRouter && state === undefined)}
                onClick={() => {
                  if (!ready) {void runAuth(plan, 'setup'); return}
                  onLeave?.()
                  setWorkActive(true)
                  void bridge.localPlanAction?.(plan, 'manage').catch(() => undefined)
                }}
                type="button"
              >
                {ready ? manageLabel : state === 'installing' ? 'Setting up…'
                  : state === 'not_installed' ? 'Install & sign in' : openRouter ? 'Connect' : 'Sign in'}
              </button>
            )}
            {plan === 'copilot' && ready ? (
              <button className="ak-btn ak-btn--sm ak-btn--plain" disabled={busy !== undefined} onClick={() => void runAuth(plan, 'logout')} type="button">
                Sign out
              </button>
            ) : null}
          </div>
        }
        data-atum-connection={plan}
        data-atum-connection-state={state ?? 'unknown'}
        help={line}
        key={plan}
        lead={<ProviderMark provider={{ id: plan, label: title }} size="sm" />}
        title={title}
      />
    )
  })
}
