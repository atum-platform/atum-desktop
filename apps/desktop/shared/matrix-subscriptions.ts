import type { MatrixModelRoute } from './matrix-models'

/**
 * The two subscriptions Settings › Connections offers (2026-10-27 owner ask). A subscription
 * belongs to the Atum account on this Mac, not to one agent: ChatGPT's sign-in lives in the
 * account's Codex store (codex-accounts.ts) and OpenCode Go's key in the account's encrypted
 * key store, both injected into every Mac-hosted agent's Hermes launch.
 *
 * Nothing here carries a credential. A status has a boolean and safe model names; a sign-in
 * handle is opaque to the window, and a key is write-only.
 */
export const MATRIX_SUBSCRIPTION_PROVIDERS = ['openai-codex', 'opencode-go'] as const

export type MatrixSubscriptionProvider = (typeof MATRIX_SUBSCRIPTION_PROVIDERS)[number]

/** The fixed device-code page native main validated before opening it. Settings shows the same
 * link so the person can reopen it without a second browser hand-off. */
export const MATRIX_CHATGPT_SIGN_IN_URL = 'https://auth.openai.com/codex/device'

/** Service names, never translated (the Connections page's rule). */
export function matrixSubscriptionProviderLabel(provider: MatrixSubscriptionProvider): string {
  return provider === 'openai-codex' ? 'ChatGPT' : 'OpenCode Go'
}

export function parseMatrixSubscriptionProvider(value: unknown): MatrixSubscriptionProvider | undefined {
  return MATRIX_SUBSCRIPTION_PROVIDERS.find(provider => provider === value)
}

/**
 * One model the OpenCode Go account connection serves, exactly as the platform's
 * `atum.provider-connections/1` status names it. No credential-shaped field is ever read.
 */
export interface MatrixSubscriptionModel {
  id: string
  displayName: string
  efforts: readonly ('low' | 'medium' | 'high')[]
  defaultEffort: 'low' | 'medium' | 'high'
}

/** One provider's account-level status. Models are present only for a connected provider. */
export interface MatrixSubscriptionProviderStatus {
  id: MatrixSubscriptionProvider
  connected: boolean
  /** ChatGPT only: whether this Mac holds the saved account OAuth, independently of relay state. */
  localConnected?: boolean
  /** ChatGPT only: a sign-in is saved but no longer works (expired or revoked); one Reconnect fixes it. */
  needsSignIn?: boolean
  models?: readonly string[]
  /** Platform/relay model descriptors; safe to show, never a key or OAuth material. */
  modelDetails?: readonly MatrixSubscriptionModel[]
  /** The connection revision a disconnect is fenced by (OpenCode Go only). */
  revision?: number
  /** Whether this row came from the account-wide platform or the pre-R1 local key. */
  source?: 'platform' | 'local'
  /** ChatGPT only: the account's selected relay Mac. No credential or network address. */
  relay?: { state: 'disabled' | 'enabled'; thisMac: boolean; revision: number }
}

/** The account's subscriptions, read once for every assistant of that account. */
export interface MatrixSubscriptionsStatus {
  scope: 'account'
  providers: readonly MatrixSubscriptionProviderStatus[]
}

/** The picker's account catalog for the room's Mac-hosted agent. */
export interface MatrixSubscriptionCatalog {
  destination: 'this_mac'
  providers: readonly MatrixSubscriptionProviderStatus[]
}

/** The one device-code session Settings' compact dialog shows. */
export interface MatrixSubscriptionSignIn {
  status: 'pending'
  /** Opaque native handle; the window only passes it back. */
  session: string
  provider: MatrixSubscriptionProvider
  userCode: string
  /** The provider's fixed verification page, already validated by native main. */
  url: string
  expiresIn: number
  pollInterval: number
}

export type MatrixSubscriptionStart =
  | MatrixSubscriptionSignIn
  | { status: 'connected' }
  | { status: 'cancelled' }

export type MatrixSubscriptionPoll =
  | { status: 'pending' }
  | { status: 'connected' }
  | { status: 'cancelled' }
  | { status: 'failed' }

export type MatrixSubscriptionKeyResult = { status: 'applied' | 'cancelled' }
export type MatrixSubscriptionRelayResult = { status: 'applied' | 'unavailable' }

/** One subscription model row, before the picker adds its own presentation. */
export interface MatrixSubscriptionRoute extends MatrixModelRoute {
  /** Both subscription kinds wear the small "Plan" badge. */
  subscription: true
}
