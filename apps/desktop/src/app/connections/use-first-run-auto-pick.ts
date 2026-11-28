import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { $work } from '@/app/work/store'

import type { MatrixSnapshot } from '../../../shared/matrix'

import { $firstRunAutoEnabled, $firstRunRepick, bindFirstRunAccount, type FirstRunAgent, runFirstRunAutoPick } from './first-run-store'
import { $accountConnectProgress, loadAccountConnections } from './store'

/** At most one quiet re-check per this interval when the window regains focus (a sign-in done outside Atum). */
export const FIRST_RUN_FOCUS_RECHECK_MS = 5 * 60_000

export function firstRunAgents(snapshot: Pick<MatrixSnapshot, 'agents'>): FirstRunAgent[] {
  return (snapshot.agents ?? []).map(agent => ({
    principal: agent.principal,
    isDefault: agent.isDefault,
    cloud: agent.answering === 'cloud',
    ...(agent.cloudModel ? { cloudModel: agent.cloudModel } : {})
  }))
}

/**
 * Runs the automatic pick from app start, so it works while the launch screen still shows (the eclipse holds at least
 * `MATRIX_LAUNCH_HOLD_MS`): by the time the first chat appears its chip is on the chosen model. A slower read lands later and
 * the chip changes quietly between turns. Runs again when Work becomes ready, the roster changes, a Connect finishes, the
 * Settings switch turns on, or the window regains focus (throttled).
 */
export function useFirstRunAutoPick(snapshot: Pick<MatrixSnapshot, 'agents' | 'identity'>): void {
  const userId = snapshot.identity?.userId ?? null
  const work = useStore($work)
  const repick = useStore($firstRunRepick)
  const enabled = useStore($firstRunAutoEnabled)
  const progress = useStore($accountConnectProgress)
  const agents = firstRunAgents(snapshot)
  const rosterKey = agents.map(agent => `${agent.principal}:${agent.isDefault ? 1 : 0}:${agent.cloud ? 1 : 0}`).join(',')
  const latest = useRef(agents)
  const lastFocus = useRef(0)
  latest.current = agents

  // Bound before the pass below (effects run in order), so each account reads its own record.
  useEffect(() => {
    bindFirstRunAccount(userId)
  }, [userId])

  const connectDone = progress?.phase === 'done'
  const workView = work ? JSON.stringify(work.view) : ''
  const planStatusRevision = work?.planStatusRevision

  useEffect(() => {
    if (!userId || !rosterKey) {
      return
    }

    const bridge = typeof window === 'undefined' ? undefined : window.atumMatrix
    void runFirstRunAutoPick({
      work: bridge?.work,
      subscriptions: bridge?.subscriptions,
      writeSubscription: bridge?.modelDestinations?.writeSubscription,
      agents: latest.current
    }).catch(() => undefined)

    if (connectDone) {
      void loadAccountConnections()
    }
  }, [userId, rosterKey, workView, planStatusRevision, repick, enabled, connectDone])

  useEffect(() => {
    if (!userId) {
      return
    }

    const onFocus = () => {
      if (Date.now() - lastFocus.current < FIRST_RUN_FOCUS_RECHECK_MS) {
        return
      }

      lastFocus.current = Date.now()
      const bridge = window.atumMatrix
      void runFirstRunAutoPick({
        work: bridge?.work,
        subscriptions: bridge?.subscriptions,
        writeSubscription: bridge?.modelDestinations?.writeSubscription,
        agents: latest.current
      }).catch(() => undefined)
    }

    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [userId])
}
