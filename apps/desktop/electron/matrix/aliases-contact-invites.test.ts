import { describe, expect, it } from 'vitest'

import { MatrixAliasError, parseMatrixAliasRequest, parseMatrixAliasResponse } from './aliases'

const requestId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const token = 'b'.repeat(43)

describe('contact invitation alias actions (spec/public-handles/v1.2, 0550)', () => {
  it('accepts only the exact invite and accept shapes', () => {
    expect(parseMatrixAliasRequest({ action: 'invite', email: 'hello@example.com', locale: 'vi', requestId }))
      .toEqual({ action: 'invite', email: 'hello@example.com', locale: 'vi', requestId })
    expect(parseMatrixAliasRequest({ action: 'accept', token })).toEqual({ action: 'accept', token })
    for (const bad of [
      { action: 'invite', email: 'Hello@example.com', locale: 'en', requestId },
      { action: 'invite', email: 'hello@example.com', locale: 'fr', requestId },
      { action: 'invite', email: 'hello@example.com', locale: 'en', requestId: 'x' },
      { action: 'invite', email: 'hello@example.com', locale: 'en', requestId, assistantId: requestId },
      { action: 'accept', token: 'short' },
      { action: 'accept', token, extra: 1 }
    ]) {
      expect(() => parseMatrixAliasRequest(bad)).toThrow(MatrixAliasError)
    }
  })

  it('reads only the closed answers', () => {
    const invite = { action: 'invite', email: 'hello@example.com', locale: 'en', requestId } as const
    const accept = { action: 'accept', token } as const
    expect(parseMatrixAliasResponse({ state: 'invited', expiresAt: 5 }, invite)).toEqual({ kind: 'invite', state: 'invited', expiresAt: 5 })
    expect(parseMatrixAliasResponse({ state: 'limited', retryAfterSeconds: 60 }, invite))
      .toEqual({ kind: 'invite', state: 'limited', retryAfterSeconds: 60 })
    expect(parseMatrixAliasResponse({ state: 'accepted', inviterMatrixUser: '@ana:example.invalid' }, accept))
      .toEqual({ kind: 'accept', state: 'accepted', inviterMatrixUser: '@ana:example.invalid' })
    expect(parseMatrixAliasResponse({ state: 'self' }, accept)).toEqual({ kind: 'accept', state: 'self' })
    for (const [value, input] of [
      [{ state: 'invited' }, invite],
      [{ state: 'limited', retryAfterSeconds: 0 }, invite],
      [{ state: 'invited', expiresAt: 5, email: 'hello@example.com' }, invite],
      [{ state: 'accepted', inviterMatrixUser: 'minh' }, accept],
      [{ state: 'accepted' }, accept]
    ] as const) {
      expect(() => parseMatrixAliasResponse(value, input)).toThrow(MatrixAliasError)
    }
  })
})
