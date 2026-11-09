import { describe, expect, it } from 'vitest'

import { ATUM_AUTH_FAILURE_CODES, authFailureKind } from './atum-auth'

describe('authFailureKind', () => {
  it('has no opinion without an error code', () => {
    expect(authFailureKind(null)).toBeNull()
    expect(authFailureKind('')).toBeNull()
  })

  it.each(['invalid_credentials', 'INVALID_GRANT', 'password_sign_in_rejected:400', 'password_sign_in_rejected:401'])(
    'classifies %s as a credential problem the user can fix',
    code => {
      expect(authFailureKind(code)).toBe('credentials')
    }
  )

  it.each(['password_sign_in_timeout', 'hosted_session_unavailable', 'token_exchange_timeout'])(
    'classifies %s as connectivity',
    code => {
      expect(authFailureKind(code)).toBe('network')
    }
  )

  it.each(['authorization_callback_denied', 'AUTHORIZATION_CALLBACK_DENIED'])(
    'classifies %s as a decision, not a fault',
    code => {
      expect(authFailureKind(code)).toBe('declined')
    }
  )

  it.each(['authorization_timeout', 'authorization_superseded', 'authorization_browser_unavailable'])(
    'classifies %s as an unfinished browser round trip',
    code => {
      // Regression pin: a naive substring ladder reads "timeout" and
      // "unavailable" as connectivity and tells the user to check their network
      // after they simply closed the Google tab.
      expect(authFailureKind(code)).toBe('browser')
    }
  )

  it('still classifies the password lane timeout as connectivity', () => {
    expect(authFailureKind('password_sign_in_timeout')).toBe('network')
    expect(authFailureKind('token_exchange_timeout')).toBe('network')
  })

  it('treats a 5xx rejection as provider-side, not as bad credentials', () => {
    expect(authFailureKind('password_sign_in_rejected:500')).toBe('provider')
  })

  it('classifies explicit storage, platform, and local failures honestly', () => {
    expect(authFailureKind('account_storage_encrypt_failed')).toBe('storage')
    expect(authFailureKind('account_open_timeout')).toBe('platform')
    expect(authFailureKind('account_local_failure')).toBe('local')
  })

  it('exhaustively maps every closed code and fails unknown strings into sanitized local copy', () => {
    for (const [code, kind] of Object.entries(ATUM_AUTH_FAILURE_CODES)) {
      expect(authFailureKind(code), code).toBe(kind)
    }

    expect(authFailureKind('provider_not_configured')).toBe('provider')
    expect(authFailureKind('upstream leaked a private raw exception')).toBe('local')
  })
})
