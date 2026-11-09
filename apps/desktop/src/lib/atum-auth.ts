/** Total classification for the closed main-process auth vocabulary. */
export type AtumAuthFailureKind =
  | 'browser'
  | 'credentials'
  | 'declined'
  | 'local'
  | 'network'
  | 'platform'
  | 'provider'
  | 'storage'
  | null

export const ATUM_AUTH_FAILURE_CODES = {
  account_activation_failed: 'local',
  account_already_active: 'local',
  account_capability_open_timeout: 'platform',
  account_capability_quiescence_failed: 'platform',
  account_capability_quiescence_timeout: 'platform',
  account_context_unavailable: 'platform',
  account_credentials_invalid: 'credentials',
  account_local_failure: 'local',
  account_workspace_unavailable: 'local',
  account_logout_failed: 'provider',
  account_open_timeout: 'platform',
  account_quiescence_failed: 'platform',
  account_quiescence_timeout: 'platform',
  account_refresh_failed: 'network',
  account_refresh_timeout: 'network',
  account_restore_failed: 'local',
  account_restore_rejected: 'provider',
  account_session_expired: 'provider',
  account_session_projection_failed: 'local',
  account_sign_in_failed: 'local',
  account_storage_corrupt: 'storage',
  account_storage_decrypt_failed: 'storage',
  account_storage_disk_full: 'storage',
  account_storage_encrypt_failed: 'storage',
  account_storage_failed: 'storage',
  account_storage_read_failed: 'storage',
  account_storage_unavailable: 'storage',
  account_storage_write_failed: 'storage',
  activation_account_mismatch: 'local',
  atum_account_unconfigured: 'local',
  auth_lifecycle_blocked: 'platform',
  auth_response_too_large: 'provider',
  authorization_browser_unavailable: 'browser',
  authorization_callback_denied: 'declined',
  authorization_callback_failed: 'provider',
  authorization_cancelled: 'browser',
  authorization_superseded: 'browser',
  authorization_timeout: 'browser',
  google_provider_unavailable: 'provider',
  hosted_account_mismatch: 'provider',
  hosted_session_timeout: 'network',
  hosted_session_unavailable: 'network',
  invalid_credentials: 'credentials',
  invalid_grant: 'credentials',
  invalid_token_response: 'provider',
  password_provider_unavailable: 'provider',
  password_sign_in_timeout: 'network',
  password_sign_in_unavailable: 'network',
  provider_not_configured: 'provider',
  refresh_account_mismatch: 'provider',
  token_exchange_timeout: 'network'
} as const satisfies Record<string, Exclude<AtumAuthFailureKind, null>>

export function authFailureKind(errorCode: null | string): AtumAuthFailureKind {
  if (!errorCode) {
    return null
  }

  const code = errorCode.toLowerCase()
  const exact = ATUM_AUTH_FAILURE_CODES[code as keyof typeof ATUM_AUTH_FAILURE_CODES]

  if (exact) {
    return exact
  }

  if (/^password_sign_in_rejected:4\d\d$/u.test(code)) {
    return 'credentials'
  }

  if (
    /^(?:account_activation|account_refresh|account_restore|account_storage|authorization|password_sign_in|token_exchange)_failed:\d{3}$/u.test(
      code
    ) ||
    /^hosted_session_rejected:\d{3}$/u.test(code) ||
    /^password_sign_in_rejected:5\d\d$/u.test(code)
  ) {
    return 'provider'
  }

  return 'local'
}
