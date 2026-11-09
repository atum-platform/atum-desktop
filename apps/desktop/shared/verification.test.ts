import { describe, expect, it } from 'vitest'

import type { MatrixOfficialAccount } from './matrix-founder'
import { accountVerificationTier, appVerificationTier, parseVerificationTier } from './verification'

describe('verification tiers', () => {
  it('knows the two tiers and nothing else', () => {
    expect(parseVerificationTier('official')).toBe('official')
    expect(parseVerificationTier('verified')).toBe('verified')

    for (const value of ['unverified', 'Official', '', null, undefined, true, 1, { tier: 'official' }]) {
      expect(parseVerificationTier(value)).toBeNull()
    }
  })

  it("takes an app's tier from its descriptor only, never from the legacy flag", () => {
    expect(appVerificationTier({ verification: 'official' })).toBe('official')
    expect(appVerificationTier({ verification: 'verified' })).toBe('verified')
    expect(appVerificationTier({ verification: null })).toBeNull()
    expect(appVerificationTier({})).toBeNull()
    expect(appVerificationTier(undefined)).toBeNull()
    // A descriptor from an older platform: `verified: true` and no tier draws nothing.
    expect(appVerificationTier({ verified: true } as never)).toBeNull()
  })

  it("takes an account's tier by its exact id, and an unavailable list marks nobody", () => {
    const accounts: MatrixOfficialAccount[] = [
      { userId: '@user-0f:example.invalid', tier: 'official', role: 'founder', handle: 'founder' },
      { userId: '@partner:example.invalid', tier: 'verified' }
    ]

    expect(accountVerificationTier(accounts, '@user-0f:example.invalid')).toBe('official')
    expect(accountVerificationTier(accounts, '@partner:example.invalid')).toBe('verified')
    // A look-alike is another account: no mark.
    expect(accountVerificationTier(accounts, '@User-0f:example.invalid')).toBeNull()
    expect(accountVerificationTier(accounts, '@user-0f:other.server')).toBeNull()
    expect(accountVerificationTier(accounts, undefined)).toBeNull()
    expect(accountVerificationTier(undefined, '@user-0f:example.invalid')).toBeNull()
  })
})
