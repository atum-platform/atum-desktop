import { describe, expect, it } from 'vitest'

import { ATUM_SIGNED_OUT_IDENTITY_FIXTURE, atumSignedInIdentityFixture } from './atum-account-facts'

describe('S2 typed identity fixtures', () => {
  it('publishes one canonical subject and no credential-shaped field', () => {
    const fixture = atumSignedInIdentityFixture()
    expect(fixture.canonicalSubject).toBe(fixture.status.account?.id)
    expect(fixture.status.current?.accountId).toBe(fixture.canonicalSubject)
    expect(JSON.stringify(fixture)).not.toMatch(/access_token|refresh_token|code_verifier|anon_key/i)
  })

  it('represents signed out as no account, session fact, or subject', () => {
    expect(ATUM_SIGNED_OUT_IDENTITY_FIXTURE.status.account).toBeNull()
    expect(ATUM_SIGNED_OUT_IDENTITY_FIXTURE.status.current).toBeNull()
    expect(ATUM_SIGNED_OUT_IDENTITY_FIXTURE.canonicalSubject).toBeNull()
  })
})
