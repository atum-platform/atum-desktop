import { useEffect, useState } from 'react'

import { setWorkActive } from '@/app/work/store'
import { ProviderMark } from '@/matrix/model-picker-provider-mark'
import { SettingsRow } from '@/matrix/settings-row'

import type { MatrixWorkBridge } from '../../../shared/matrix-work'
import { WORK_LOCAL_PLANS, type WorkLocalPlan, type WorkLocalPlanStates } from '../../../shared/work-local-plans'

interface LocalPlanRowsProps {
  bridge?: Pick<MatrixWorkBridge, 'readLocalPlans' | 'localPlanAction'> & Partial<Pick<MatrixWorkBridge, 'subscribe'>>
  manageLabel: string
  onLeave?: () => void
}

export function LocalPlanRows({ bridge, manageLabel, onLeave }: LocalPlanRowsProps) {
  const [states, setStates] = useState<WorkLocalPlanStates>({})
  const [busy, setBusy] = useState<WorkLocalPlan>()
  const [failed, setFailed] = useState<WorkLocalPlan>()

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

  const setup = async (plan: WorkLocalPlan) => {
    if (busy || !bridge?.localPlanAction) {return}
    setBusy(plan)
    setFailed(undefined)
    try {
      await bridge.localPlanAction(plan, 'setup')
      setStates(await bridge.readLocalPlans?.() ?? {})
    } catch {
      setFailed(plan)
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
    const help = failed === plan ? 'Setup didn’t finish. Try again.'
      : state === 'ready' ? status?.allowance ?? 'Connected on this Mac'
        : state === 'installing' ? 'Follow the sign-in instructions in your browser.'
          : state === 'not_installed' ? 'Install to use in Work'
            : state === 'signed_out' ? 'Sign in to use in Work' : 'Checking availability…'
    const line = openRouter && state === 'signed_out'
      ? 'For a few chats a day. Use a workspace without upstream provider keys.'
      : openRouter && state === 'not_installed' ? 'OpenCode 2.3.2 is required' : help

    return (
      <SettingsRow
        control={
          <button
            className={ready ? 'ak-btn ak-btn--sm ak-btn--plain' : 'ak-btn ak-btn--sm'}
            disabled={busy !== undefined || (openRouter && state !== 'ready' && state !== 'signed_out')}
            onClick={() => {
              if (!ready) {void setup(plan); return}
              onLeave?.()
              setWorkActive(true)
              void bridge.localPlanAction?.(plan, 'manage').catch(() => undefined)
            }}
            type="button"
          >
            {ready ? manageLabel : state === 'installing' ? 'Setting up…' : openRouter ? 'Connect' : state === 'signed_out' ? 'Sign in' : 'Install & sign in'}
          </button>
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
