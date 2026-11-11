import type { MatrixSubscriptionsBridge } from '../../../shared/matrix'
import type { MatrixSubscriptionProviderStatus, MatrixSubscriptionsStatus } from '../../../shared/matrix-subscriptions'

/**
 * Settings › Connections and the model picker's ChatGPT states, on fixture data
 * (`?subscriptions=`). Each mode is one real account state (src/matrix/subscription-view.ts):
 *
 * - `none` — nothing connected; the picker offers "Use your ChatGPT subscription".
 * - `connecting` — nothing connected, and a ChatGPT sign-in waits for its code.
 * - `ready` — ChatGPT reaches every assistant (relay enabled on this Mac).
 * - `cloud-setup` — ChatGPT works on this Mac; cloud setup is still in flight.
 * - `cloud-failed` — ChatGPT works on this Mac; the cloud setup attempt did not succeed.
 * - `signed-out` — a saved ChatGPT sign-in stopped working.
 * - `unavailable` — the status read itself fails.
 * - `relay-offline` — ChatGPT's relay Mac is registered but offline (owner 2026-11-11).
 */
export type PlaygroundSubscriptionsMode =
  | 'none'
  | 'connecting'
  | 'ready'
  | 'cloud-setup'
  | 'cloud-failed'
  | 'signed-out'
  | 'unavailable'
  | 'relay-offline'

const MODES: readonly PlaygroundSubscriptionsMode[] = [
  'none',
  'connecting',
  'ready',
  'cloud-setup',
  'cloud-failed',
  'signed-out',
  'unavailable',
  'relay-offline'
]

const CHATGPT_MODELS = [
  { id: 'gpt-6-luna', displayName: 'GPT-6 Luna', efforts: ['low', 'medium', 'high'] as const, defaultEffort: 'medium' as const },
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'] as const, defaultEffort: 'medium' as const }
]

export function playgroundSubscriptionsMode(params: URLSearchParams): PlaygroundSubscriptionsMode | undefined {
  const mode = params.get('subscriptions')

  return MODES.find(each => each === mode)
}

function chatgpt(mode: PlaygroundSubscriptionsMode): MatrixSubscriptionProviderStatus {
  switch (mode) {
    case 'ready':
      return {
        id: 'openai-codex',
        connected: true,
        localConnected: true,
        models: CHATGPT_MODELS.map(model => model.id),
        modelDetails: CHATGPT_MODELS,
        relay: { state: 'enabled', thisMac: true, revision: 2 },
        source: 'platform'
      }

    case 'cloud-setup':

    case 'cloud-failed':
      // Main reports the models this Mac last read for its plan while the relay is not up.
      return {
        id: 'openai-codex',
        connected: true,
        localConnected: true,
        models: CHATGPT_MODELS.map(model => model.id),
        modelDetails: CHATGPT_MODELS,
        relay: { state: 'disabled', thisMac: false, revision: 1 },
        source: 'platform'
      }

    case 'relay-offline':
      return {
        id: 'openai-codex',
        connected: true,
        localConnected: false,
        models: CHATGPT_MODELS.map(model => model.id),
        modelDetails: CHATGPT_MODELS,
        relay: { state: 'enabled', thisMac: false, revision: 3, presence: 'offline' },
        source: 'platform'
      }

    case 'signed-out':
      return { id: 'openai-codex', connected: false, needsSignIn: true }

    default:
      return { id: 'openai-codex', connected: false }
  }
}

export function playgroundSubscriptions(mode: PlaygroundSubscriptionsMode): MatrixSubscriptionsBridge {
  const status = (): MatrixSubscriptionsStatus => ({
    scope: 'account',
    providers: [chatgpt(mode), { id: 'opencode-go', connected: false }]
  })

  const ready = chatgpt('ready')

  return {
    status: async () => {
      if (mode === 'unavailable') {
        throw new Error('matrix_subscriptions_unavailable')
      }

      return status()
    },
    // A Mac-hosted assistant's own view of the account plan: the models its Hermes lists.
    catalog: async () => ({
      destination: 'this_mac',
      providers: [
        mode === 'ready' || mode === 'cloud-setup' || mode === 'cloud-failed'
          ? { id: 'openai-codex', connected: true, models: ready.models }
          : chatgpt(mode),
        { id: 'opencode-go', connected: false }
      ]
    }),
    startChatGpt: async () => ({
      status: 'pending',
      session: 'playground-session',
      provider: 'openai-codex',
      userCode: 'K7QF-2MXD',
      url: 'https://auth.openai.com/codex/device',
      expiresIn: 900,
      pollInterval: 3600
    }),
    pollChatGpt: async () => ({ status: 'pending' }),
    cancelChatGpt: async () => undefined,
    disconnectChatGpt: async () => undefined,
    // Cloud setup: in flight forever for `cloud-setup`, refused for `cloud-failed`.
    useThisMacForChatGpt: enabled =>
      mode === 'cloud-setup' && enabled
        ? new Promise(() => undefined)
        : Promise.resolve({ status: mode === 'cloud-failed' ? 'unavailable' : 'applied' }),
    connectOpenCode: async () => ({ status: 'applied' }),
    disconnectOpenCode: async () => undefined
  }
}
