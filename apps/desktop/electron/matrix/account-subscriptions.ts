import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { MatrixSubscriptionsStatus } from '../../shared/matrix-subscriptions'
import type { EncryptedStore } from '../encrypted-store'

import type { MatrixHermesRuntimeConfig } from './hermes-runtime'
import { forgetMatrixCodexSignIn } from './hermes-runtime'

/**
 * Account-level subscription custody (2026-10-27 owner ask: "connecting subs should be account
 * wide - so once I connect, all my agents have access to models from that sub").
 *
 * ChatGPT's sign-in lives in the account's sign-in host home (account-subscription-flow.ts
 * `matrixSubscriptionHostHome`), the Hermes home where the device-code sign-in runs. Hermes keeps it
 * in that home's own `auth.json`; every Mac-hosted assistant launch names that home as its auth
 * root (`ATUM_ACCOUNT_AUTH_HOME`), so Hermes's native profile -> root fallback lends the grant to
 * every assistant and a refresh rotates the one account chain (hermes_cli/auth.py
 * `_global_auth_file_path`). Before 2026-11-06 Atum's own Hermes patch read a separate
 * `codex_auth.json`; the 11-04 Hermes update removed that reader, so a file there means nothing.
 * OpenCode Go is an API key Hermes reads as `OPENCODE_GO_API_KEY`; Atum keeps it in the
 * account's encrypted credential store and injects it into every Mac-hosted assistant's Hermes
 * launch, so no second copy is written to a profile `.env` and no key ever reaches the window
 * after the person presses Save.
 *
 * Nothing here logs a value. `has` reads the encrypted index only; `read` is called only while
 * building one launch environment.
 */
export const MATRIX_SUBSCRIPTION_KEY = 'opencode-go.api-key'
export const MATRIX_SUBSCRIPTION_ENV = 'OPENCODE_GO_API_KEY'
/** Internal bridge, not a setting: the account sign-in home every assistant borrows grants from. */
export const MATRIX_ACCOUNT_AUTH_HOME_ENV = 'ATUM_ACCOUNT_AUTH_HOME'

export interface MatrixSubscriptionKeyStore {
  has(): boolean
  read(): string | null
  save(value: string): void
  clear(): void
}

/** The signed-in account's view of the credential file (the same file as auth credentials). */
export function matrixSubscriptionKeyStore(root: EncryptedStore, accountKey: string): MatrixSubscriptionKeyStore {
  const store = root.scope(`subscriptions:${accountKey}:`)

  return {
    has: () => store.keys(MATRIX_SUBSCRIPTION_KEY).includes(MATRIX_SUBSCRIPTION_KEY),
    read: () => store.getItem(MATRIX_SUBSCRIPTION_KEY),
    save: value => store.setItem(MATRIX_SUBSCRIPTION_KEY, value),
    clear: () => store.removeItem(MATRIX_SUBSCRIPTION_KEY)
  }
}

/** What every Mac-hosted assistant's Hermes launch gets: the account's auth home and the OpenCode
 * Go key. A broken store gives no key, never a crash: that assistant simply offers no OpenCode Go
 * models until the person connects again. */
export function matrixSubscriptionEnvironment(
  store: MatrixSubscriptionKeyStore | undefined,
  accountAuthHome?: string
): NodeJS.ProcessEnv {
  const home = accountAuthHome ? { [MATRIX_ACCOUNT_AUTH_HOME_ENV]: accountAuthHome } : {}

  if (!store) {
    return home
  }

  try {
    const key = store.read()

    return key ? { ...home, [MATRIX_SUBSCRIPTION_ENV]: key } : home
  } catch {
    return home
  }
}

/** The ChatGPT grant Hermes keeps in the account home: none, usable, or dead (Hermes quarantined
 * it after a terminal refresh failure and the person must sign in again). Reads booleans only. */
export type MatrixChatGptGrant = 'none' | 'saved' | 'needs_sign_in'

const CODEX = 'openai-codex'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function present(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function readAccountStore(accountAuthHome: string): Record<string, unknown> | undefined {
  try {
    const store: unknown = JSON.parse(readFileSync(path.join(accountAuthHome, 'auth.json'), 'utf8'))

    return record(store) ? store : undefined
  } catch {
    return undefined
  }
}

export function matrixChatGptGrant(accountAuthHome: string | undefined): MatrixChatGptGrant {
  const store = accountAuthHome ? readAccountStore(accountAuthHome) : undefined

  if (!store) {
    return 'none'
  }

  const providers = record(store.providers) ? store.providers : {}
  const state = record(providers[CODEX]) ? providers[CODEX] : undefined
  const tokens = state && record(state.tokens) ? state.tokens : undefined
  const pool = record(store.credential_pool) ? store.credential_pool[CODEX] : undefined
  const rows = Array.isArray(pool) ? pool.filter(record) : []

  // Hermes reads the pool first, then the singleton: either live pair answers.
  if (
    (tokens && present(tokens.access_token) && present(tokens.refresh_token)) ||
    rows.some(row => present(row.access_token) && present(row.refresh_token) && row.last_status !== 'dead')
  ) {
    return 'saved'
  }

  const quarantined = state && record(state.last_auth_error) && state.last_auth_error.relogin_required === true

  return quarantined || rows.length > 0 ? 'needs_sign_in' : 'none'
}

/** The account-level read Settings and the picker share: booleans and safe model names only. */
export function matrixSubscriptionsStatus(input: {
  /** The account sign-in home (`matrixSubscriptionHostHome`); absent: no account here yet. */
  accountAuthHome: string | undefined
  keys: MatrixSubscriptionKeyStore | undefined
}): MatrixSubscriptionsStatus {
  const grant = matrixChatGptGrant(input.accountAuthHome)

  let opencodeGo = false

  try {
    opencodeGo = input.keys?.has() === true
  } catch {
    opencodeGo = false
  }

  return {
    scope: 'account',
    providers: [
      { id: 'openai-codex', connected: grant === 'saved', ...(grant === 'needs_sign_in' ? { needsSignIn: true } : {}) },
      { id: 'opencode-go', connected: opencodeGo }
    ]
  }
}

/** Disconnect ChatGPT: remove the retired pre-11-04 `codex_auth.json` (no Hermes reads it now).
 * The account sign-in home is cleared by Hermes itself under its store lock
 * (`clearMatrixAccountChatGpt`), never by a read/replace here: that would race another
 * provider's token rotation in the same file. */
export function forgetSubscriptionChatGpt(input: {
  config: Pick<MatrixHermesRuntimeConfig, 'profiles' | 'bundled'>
  owner: string
  sharedCodex: boolean
  env?: NodeJS.ProcessEnv
  homeDir?: string
}): void {
  forgetMatrixCodexSignIn(input.config, input.owner, input.sharedCodex, input.env, input.homeDir)
}
