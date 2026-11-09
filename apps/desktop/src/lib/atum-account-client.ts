import type { AtumAccountStatus } from './atum-account-facts'

export type {
  AtumAccountIdentity,
  AtumAccountState,
  AtumAccountStatus,
  AtumCurrentAccountFacts,
  AtumSyntheticIdentityFixture
} from './atum-account-facts'

export interface AtumAccountClient {
  status(): Promise<AtumAccountStatus>
  retryRestore(): Promise<AtumAccountStatus>
  signIn(): Promise<AtumAccountStatus>
  /** Credentials cross the narrow IPC seam once and are never persisted, logged, or returned. */
  signInWithPassword(credentials: { identifier: string; password: string }): Promise<AtumAccountStatus>
  cancel(): Promise<AtumAccountStatus>
  signOut(): Promise<AtumAccountStatus>
}

const UNCONFIGURED: AtumAccountStatus = {
  state: 'unconfigured',
  configured: false,
  account: null,
  current: null,
  errorCode: null,
  providers: { google: false, password: false }
}

/** Native-account renderer seam. Tokens and PKCE material stay in Electron main. */
export function atumAccountClient(): AtumAccountClient {
  return (
    window.hermesDesktop?.account ?? {
      status: async () => UNCONFIGURED,
      retryRestore: async () => UNCONFIGURED,
      signIn: async () => UNCONFIGURED,
      signInWithPassword: async () => UNCONFIGURED,
      cancel: async () => UNCONFIGURED,
      signOut: async () => UNCONFIGURED
    }
  )
}
