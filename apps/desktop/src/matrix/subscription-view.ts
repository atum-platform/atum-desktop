import type {
  MatrixSubscriptionProvider,
  MatrixSubscriptionProviderStatus,
  MatrixSubscriptionsStatus
} from '../../shared/matrix-subscriptions'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export type MatrixSubscriptionViewState =
  /** The first status read is still on its way; the row reads as not connected until it lands. */
  | 'loading'
  /** The status could not be read at all; nothing is known either way. */
  | 'unavailable'
  /** No plan is connected. */
  | 'not_connected'
  /** A saved ChatGPT sign-in stopped working (expired or revoked). */
  | 'needs_sign_in'
  /** Connected and reachable by every assistant, on this Mac and in the cloud. */
  | 'ready'
/** What one press of the row's single action does. Every connected state opens the plan's own
 * page (so Disconnect is always one click away); a state that can be fixed carries that one fix. */
export type MatrixSubscriptionAction = 'connect' | 'sign_in' | 'manage' | 'reload'

export interface MatrixSubscriptionView {
  state: MatrixSubscriptionViewState
  /** The plan the row is about: the connected one, else ChatGPT (the one offered first). */
  provider: MatrixSubscriptionProvider
  action?: MatrixSubscriptionAction
}

function providerOf(
  status: MatrixSubscriptionsStatus,
  id: MatrixSubscriptionProvider
): MatrixSubscriptionProviderStatus | undefined {
  return status.providers.find(provider => provider.id === id)
}

/** The one state Settings shows for the account's subscriptions. */
export function matrixSubscriptionView(input: {
  status: MatrixSubscriptionsStatus | null
  readFailed?: boolean
}): MatrixSubscriptionView {
  const { status } = input

  if (!status) {
    return input.readFailed
      ? { state: 'unavailable', provider: 'openai-codex', action: 'reload' }
      : { state: 'loading', provider: 'openai-codex', action: 'connect' }
  }

  const chatgpt = providerOf(status, 'openai-codex')

  const connected = chatgpt?.connected ? chatgpt : status.providers.find(provider => provider.connected)

  if (connected) {
    return { state: 'ready', provider: connected.id, action: 'manage' }
  }

  if (chatgpt?.needsSignIn === true) {
    return { state: 'needs_sign_in', provider: 'openai-codex', action: 'sign_in' }
  }

  return { state: 'not_connected', provider: 'openai-codex', action: 'connect' }
}
