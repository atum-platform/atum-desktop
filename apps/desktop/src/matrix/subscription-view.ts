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
  /** ChatGPT works on this Mac; cloud access is being set up right now. */
  | 'cloud_setting_up'
  /** ChatGPT works on this Mac; this window's last cloud setup attempt did not succeed. */
  | 'cloud_failed'

/** What one press of the row's single action does. Every connected state opens the plan's own
 * page (so Disconnect is always one click away); a state that can be fixed carries that one fix. */
export type MatrixSubscriptionAction = 'connect' | 'sign_in' | 'manage' | 'reload'

/** This window's own cloud setup attempt for the current relay revision. */
export type MatrixSubscriptionCloudSetup = 'idle' | 'working' | 'failed'

export interface MatrixSubscriptionView {
  state: MatrixSubscriptionViewState
  /** The plan the row is about: the connected one, else ChatGPT (the one offered first). */
  provider: MatrixSubscriptionProvider
  action?: MatrixSubscriptionAction
  /** The plan page's one act for a state the person can fix (cloud setup that did not finish). */
  fix?: 'retry_cloud'
}

function providerOf(
  status: MatrixSubscriptionsStatus,
  id: MatrixSubscriptionProvider
): MatrixSubscriptionProviderStatus | undefined {
  return status.providers.find(provider => provider.id === id)
}

/** Whether this Mac holds a working ChatGPT sign-in that cloud assistants cannot reach yet. */
export function matrixChatGptNeedsCloudSetup(provider: MatrixSubscriptionProviderStatus | undefined): boolean {
  return provider?.id === 'openai-codex' && provider.localConnected === true && provider.relay?.state !== 'enabled'
}

/** The one state Settings shows for the account's subscriptions. */
export function matrixSubscriptionView(input: {
  status: MatrixSubscriptionsStatus | null
  readFailed?: boolean
  cloudSetup?: MatrixSubscriptionCloudSetup
}): MatrixSubscriptionView {
  const { status } = input

  if (!status) {
    return input.readFailed
      ? { state: 'unavailable', provider: 'openai-codex', action: 'reload' }
      : { state: 'loading', provider: 'openai-codex', action: 'connect' }
  }

  const chatgpt = providerOf(status, 'openai-codex')

  // A ChatGPT sign-in saved on this Mac outranks everything else: it is the plan the person
  // connected, and it already works for the assistants on this Mac.
  if (matrixChatGptNeedsCloudSetup(chatgpt)) {
    return input.cloudSetup === 'failed'
      ? { state: 'cloud_failed', provider: 'openai-codex', action: 'manage', fix: 'retry_cloud' }
      : { state: 'cloud_setting_up', provider: 'openai-codex', action: 'manage' }
  }

  const connected = status.providers.find(provider => provider.connected)

  if (connected) {
    return { state: 'ready', provider: connected.id, action: 'manage' }
  }

  if (chatgpt?.needsSignIn === true) {
    return { state: 'needs_sign_in', provider: 'openai-codex', action: 'sign_in' }
  }

  return { state: 'not_connected', provider: 'openai-codex', action: 'connect' }
}
