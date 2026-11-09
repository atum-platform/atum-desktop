import { describe, expect, it } from 'vitest'

import { matrixAccountLogLine, matrixClosedCode, matrixOAuthRefusal, matrixRefreshFailureCause } from './account-events'

describe('account events in main.log', () => {
  it('writes one tagged line with closed fields, in the order given', () => {
    expect(
      matrixAccountLogLine({ event: 'session_ended', client: 'matrix', cause: 'refresh_rejected:invalid_grant' })
    ).toBe('[Matrix] account session_ended client=matrix cause=refresh_rejected:invalid_grant')
    expect(
      matrixAccountLogLine({ event: 'credential_save_failed', client: 'domain', code: 'auth_storage_write_failed' })
    ).toBe('[Matrix] account credential_save_failed client=domain code=auth_storage_write_failed')
    expect(matrixAccountLogLine({ event: 'grant_revoked', client: 'matrix', reason: 'user_sign_out' })).toBe(
      '[Matrix] account grant_revoked client=matrix reason=user_sign_out'
    )
    expect(matrixAccountLogLine({ event: 'user_sign_out', result: 'completed' })).toBe(
      '[Matrix] account user_sign_out result=completed'
    )
    expect(matrixAccountLogLine({ event: 'domain_refused' })).toBe('[Matrix] account domain_refused')
  })

  it('keeps only our own codes from an error, so a server’s words or a token never reach the log', () => {
    expect(matrixClosedCode(new Error('matrix_local_cleanup_pending'))).toBe('matrix_local_cleanup_pending')
    expect(matrixClosedCode(new Error('auth_storage_write_failed'))).toBe('auth_storage_write_failed')
    expect(matrixClosedCode(new Error('network down: syt_secret_token'))).toBe('unexpected')
    expect(matrixClosedCode('matrix_signed_out')).toBe('unexpected')
  })
})

describe("a refusal's OAuth code", () => {
  it('is named only from the closed RFC 6749 set, never in the server’s own words', () => {
    expect(matrixOAuthRefusal({ error: 'invalid_client' })).toBe('invalid_client')
    expect(matrixOAuthRefusal({ error: 'temporarily_unavailable', error_description: 'syt_secret' })).toBe(
      'temporarily_unavailable'
    )
    expect(matrixOAuthRefusal({ error: 'custom: syt_secret_token' })).toBe('other')
    expect(matrixOAuthRefusal(new TypeError('fetch failed'))).toBeUndefined()
    expect(matrixOAuthRefusal(undefined)).toBeUndefined()
    expect(
      matrixAccountLogLine({ event: 'refresh_unavailable', client: 'matrix', cause: 'refused', oauth: 'invalid_client' })
    ).toBe('[Matrix] account refresh_unavailable client=matrix cause=refused oauth=invalid_client')
    expect(matrixAccountLogLine({ event: 'refresh_unavailable', client: 'domain', cause: 'transport' })).toBe(
      '[Matrix] account refresh_unavailable client=domain cause=transport'
    )
  })
})

describe('why a refresh settled nothing', () => {
  it('reads openid-client’s errors by their shape', () => {
    expect(matrixRefreshFailureCause(new Error('matrix_identity_unavailable'))).toBe('discovery')
    expect(matrixRefreshFailureCause(new Error('matrix_vault_unavailable'))).toBe('vault')
    expect(matrixRefreshFailureCause(new TypeError('fetch failed'))).toBe('transport')
    expect(matrixRefreshFailureCause(Object.assign(new Error('operation timed out'), { code: 'OAUTH_TIMEOUT' }))).toBe(
      'transport'
    )
    expect(matrixRefreshFailureCause(new DOMException('aborted', 'AbortError'))).toBe('transport')
    expect(
      matrixRefreshFailureCause(
        Object.assign(new Error('unexpected HTTP response status code'), {
          code: 'OAUTH_RESPONSE_IS_NOT_CONFORM',
          cause: new Response('', { status: 502 })
        })
      )
    ).toBe('5xx')
    // An OAuth error answer with a 5xx status, and one without.
    expect(matrixRefreshFailureCause({ error: 'server_error', status: 500 })).toBe('5xx')
    expect(matrixRefreshFailureCause({ error: 'temporarily_unavailable', status: 400 })).toBe('refused')
    expect(matrixRefreshFailureCause(new Error('something else'))).toBe('unexpected')
    expect(matrixRefreshFailureCause(undefined)).toBe('unexpected')
  })
})
