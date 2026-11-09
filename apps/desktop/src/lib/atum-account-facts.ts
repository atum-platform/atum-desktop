export type AtumAccountState =
  | 'unconfigured'
  | 'signed_out'
  | 'signing_in'
  | 'signed_in'
  | 'refreshing'
  | 'expired'
  | 'error'

export interface AtumAccountIdentity {
  id: string
  displayName?: string | null
  handle?: string | null
  /** Hosted avatar URL when the plane projects one. */
  avatarUrl?: string | null
  /** `false` until the person chose a username; `null` when the plane did not say. */
  handleCustomized?: boolean | null
  /** ISO time the next username change is allowed; `null` when unknown or allowed now. */
  nextHandleChangeAt?: string | null
}

/** Tokens and provider material are intentionally absent from this projection. */
export interface AtumCurrentAccountFacts {
  authority: 'supabase'
  accountId: string
  sessionGeneration: number
  expiresAt: number | null
  /** `plugin_rule:atum:<accountKey>:` — prefix of this account's durable consents in Hermes's allowlist. */
  consentRulePrefix?: string
}

export interface AtumAccountStatus {
  state: AtumAccountState
  configured: boolean
  account: AtumAccountIdentity | null
  /** Present on the official main-process seam; optional for legacy/synthetic callers. */
  current?: AtumCurrentAccountFacts | null
  errorCode: string | null
  providers: { google: boolean; password: boolean }
}

export interface AtumSyntheticIdentityFixture {
  status: AtumAccountStatus
  /** Stable hosted/Supabase subject consumed by account-bound contracts. */
  canonicalSubject: string | null
}

export const ATUM_SIGNED_OUT_IDENTITY_FIXTURE: AtumSyntheticIdentityFixture = {
  status: {
    state: 'signed_out',
    configured: true,
    account: null,
    current: null,
    errorCode: null,
    providers: { google: true, password: true }
  },
  canonicalSubject: null
}

export function atumSignedInIdentityFixture(
  accountId = '00000000-0000-4000-8000-000000000001'
): AtumSyntheticIdentityFixture {
  return {
    status: {
      state: 'signed_in',
      configured: true,
      account: { id: accountId, displayName: 'Synthetic Atum User', handle: 'synthetic-user' },
      current: { authority: 'supabase', accountId, sessionGeneration: 1, expiresAt: 4_102_444_800 },
      errorCode: null,
      providers: { google: true, password: true }
    },
    canonicalSubject: accountId
  }
}
