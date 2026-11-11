import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'

import { ATUM_LINKS } from './atum-links'
import { openFundsTopUp } from './funds/top-up-request'
import type { MatrixReadinessAction } from './readiness-copy'
import { primaryAgent } from './room-agent'
import { openMatrixTopUp } from './store/top-up'

/**
 * What a launch action does, in one place for the launch screen and the assistant's chat
 * (launch-notice.tsx). Signing in again: without an account on this Mac (`signed_out`) it
 * is an ordinary sign-in; when Atum's AI no longer accepts the account (`sign_in_required`)
 * it is the Atum account confirmation in the browser, then the checks run again.
 */
export function runMatrixReadinessAction(
  action: MatrixReadinessAction,
  snapshot: MatrixSnapshot,
  selectedAgent?: MatrixAgentView
): Promise<unknown> {
  const bridge = window.atumMatrix

  switch (action) {
    case 'connect':
      return bridge.setupAssistant()

    case 'top_up':
      // In place over the chat when the window's top-up is there; before it (the launch screen),
      // the same top-up as the Store and Settings.
      return openFundsTopUp() ? Promise.resolve() : openMatrixTopUp(snapshot)

    case 'download':
      return bridge.openLink(ATUM_LINKS.download)

    case 'sign_in':
      return snapshot.readiness?.code === 'signed_out'
        ? bridge.signIn()
        : bridge.readDomain().then(() => bridge.retryReadiness())
    // One agent's executor replaced on this Mac (agent-reenroll.ts): the agent this view is of.
    case 'reconnect': {
      const agent =
        selectedAgent ??
        snapshot.agents?.find(each => each.userId === snapshot.assistant?.userId) ??
        primaryAgent(snapshot)

      return agent && bridge.reconnectAgent ? bridge.reconnectAgent(agent.principal) : bridge.retryReadiness()
    }

    // This Mac's own device lost its keys: a new sign-in gives it a new one, and the recovery key
    // kept here (owner-keys.ts) unlocks it by itself.
    case 'sign_in_again':
      return snapshot.deviceDamaged || snapshot.ownerDeviceRepair
        ? bridge.repairOwnerDevice()
        : bridge.signOut().then(() => bridge.signIn())

    // The renderer-owned compact account dialog handles this action (`onPlanSignIn`). Rechecking
    // the same assistant backend cannot repair expired provider auth, so a missing surface is a
    // no-op rather than a retry loop.
    case 'plan_sign_in':
      return Promise.resolve()

    default:
      return snapshot.readiness ? bridge.retryReadiness() : bridge.setupAssistant()
  }
}
