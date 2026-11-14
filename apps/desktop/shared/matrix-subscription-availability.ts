import type { MatrixCloudModelChoiceView } from './matrix-models'
import type {
  MatrixRelayPresence,
  MatrixSubscriptionProvider,
  MatrixSubscriptionProviderStatus
} from './matrix-subscriptions'

/**
 * Whether an account subscription can answer a cloud assistant right now: the one place that
 * decides it, for the model picker's rows, the composer's model chip and the phone.
 *
 * A ChatGPT plan reaches cloud assistants only through the owner's relay Mac
 * (`atum.model-choice/1.5`, `atum.cloud-execution/1.14`). The relay's presence
 * (`atum.chatgpt-relay` `relayPresence`: online / offline / unregistered) decides when the
 * platform sends it. Until then the only fact is the relay registration main already reads
 * (`electron/matrix/chatgpt-relay-client.ts` `MatrixChatGptRelaySnapshot.state`, projected as
 * `relay.state` by `matrixSubscriptionsWithChatGptRelay` and as `subscriptionState` by main's
 * `cloudModelView`): an enabled relay counts as reachable, anything else as no Mac.
 *
 * On S2 the plan's sign-in is carried to cloud custody (`relay.state: carried`) and the cloud serves
 * it natively, so no Mac is in the path and the plan answers.
 *
 * OpenCode Go is account-wide (no Mac in the path): its one fact is whether the key still works.
 * Pure and dependency-free. Presentation only: the platform still refuses a pick it cannot serve.
 */

export type MatrixPlanUnavailableReason =
  /** The relay Mac is registered but offline. */
  | 'mac_offline'
  /** No Mac serves the plan to cloud assistants (none registered, or the relay is off). */
  | 'no_mac'
  /** The plan's connection lapsed (an OpenCode Go key revoked or removed). */
  | 'reconnect'

export type MatrixPlanAvailability = { available: true } | { available: false; reason: MatrixPlanUnavailableReason }

const AVAILABLE: MatrixPlanAvailability = { available: true }

function unavailable(reason: MatrixPlanUnavailableReason): MatrixPlanAvailability {
  return { available: false, reason }
}

/** The relay rule: a plan carried to cloud custody (S2) needs no Mac; otherwise presence when known,
 * else the registration state. */
function relayAvailability(
  state: 'enabled' | 'disabled' | 'carried' | undefined,
  presence: MatrixRelayPresence | undefined
) {
  if (state === 'carried') {
    return AVAILABLE
  }

  if (presence === 'offline') {
    return unavailable('mac_offline')
  }

  if (presence === 'none') {
    return unavailable('no_mac')
  }

  return state === 'enabled' ? AVAILABLE : unavailable('no_mac')
}

/** One account subscription row (the picker's account read). */
export function matrixAccountPlanAvailability(
  provider: MatrixSubscriptionProviderStatus | undefined
): MatrixPlanAvailability | undefined {
  if (!provider) {
    return undefined
  }

  if (provider.id === 'openai-codex') {
    return relayAvailability(provider.relay?.state, provider.relay?.presence)
  }

  return provider.connected ? AVAILABLE : unavailable('reconnect')
}

/** The plan a cloud assistant's saved choice names, from the snapshot (no read needed). */
export function matrixCloudPlanAvailability(
  choice: MatrixCloudModelChoiceView | undefined
): MatrixPlanAvailability | undefined {
  const plan = choice?.subscription

  if (!plan) {
    return undefined
  }

  if (plan.source === 'chatgpt_plan') {
    return relayAvailability(choice.subscriptionState === 'connected' ? 'enabled' : 'disabled', choice.relayPresence)
  }

  return choice.subscriptionState === 'connected' ? AVAILABLE : unavailable('reconnect')
}

/** The account provider a saved cloud choice names. */
export function matrixCloudPlanProvider(source: 'chatgpt_plan' | 'opencode_go'): MatrixSubscriptionProvider {
  return source === 'chatgpt_plan' ? 'openai-codex' : 'opencode-go'
}

/**
 * The current pick's availability for the composer chip: the account read when the picker has
 * one (fresher), else the snapshot's cloud choice. Undefined when the pick is not a plan.
 */
export function matrixCurrentPlanAvailability(input: {
  choice: MatrixCloudModelChoiceView | undefined
  account?: readonly MatrixSubscriptionProviderStatus[] | null
}): MatrixPlanAvailability | undefined {
  const plan = input.choice?.subscription

  if (!plan) {
    return undefined
  }

  const provider = input.account?.find(each => each.id === matrixCloudPlanProvider(plan.source))

  return matrixAccountPlanAvailability(provider) ?? matrixCloudPlanAvailability(input.choice)
}
