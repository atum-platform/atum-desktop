import { atom, computed } from 'nanostores'

import type { AtumUpdateStatus } from '../../shared/atum-update-flow'

import { $backgroundStatusBySession } from './composer-status'
import { $sessionStates } from './session-states'
import { $subagentsBySession } from './subagents'

export const $atumUpdate = atom<AtumUpdateStatus | null>(null)
export const $atumUpdateBusy = computed([$sessionStates, $backgroundStatusBySession, $subagentsBySession],
  (states, background, subagents) => Object.values(states).some(state => state.busy) ||
    Object.values(background).some(items => items.some(item => item.state === 'running')) ||
    Object.values(subagents).some(items => items.some(item => item.status === 'running' || item.status === 'queued')))

export function installAtumUpdates(): void {
  const bridge = window.hermesDesktop?.appUpdate

  if (!bridge) {return}
  bridge.onState?.(status => $atumUpdate.set(status))
  void bridge.status().then(status => $atumUpdate.set(status)).catch(() => undefined)
  $atumUpdateBusy.subscribe(busy => bridge.setBusy?.(busy))
}
