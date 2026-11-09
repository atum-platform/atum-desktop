import { describe, expect, it } from 'vitest'

import {
  isMatrixInviteDeepLinkCandidate,
  parseMatrixInviteDeepLink,
  parseMatrixInviteLinkPaste
} from './matrix-invite-link'

const token = 'A'.repeat(43)

describe('Team Space invite-link parsing', () => {
  it.each([
    `https://account.atumplatform.com/j/${token}`,
    `https://atumplatform.com/j/${token}`,
    `https://staging.example.test/j/${token}`
  ])('accepts an HTTPS host ending in /j/<token>: %s', value => {
    expect(parseMatrixInviteLinkPaste(value)).toBe(token)
  })

  it.each([
    `http://account.atumplatform.com/j/${token}`,
    `https://account.atumplatform.com/else/${token}`,
    `https://account.atumplatform.com/j/${'A'.repeat(42)}`,
    `https://account.atumplatform.com/j/${token}/extra`,
    `https://account.atumplatform.com/j/${token}?forward=${token}`,
    `https://user@account.atumplatform.com/j/${token}`,
    `https://account.atumplatform.com:444/j/${token}`
  ])('rejects a malformed or widened pasted link: %s', value => {
    expect(parseMatrixInviteLinkPaste(value)).toBeNull()
  })

  it('accepts only the exact atum://join/<token> deep-link route', () => {
    expect(parseMatrixInviteDeepLink(`atum://join/${token}`)).toBe(token)
    expect(parseMatrixInviteDeepLink(`atum://message/${token}`)).toBeNull()
    expect(parseMatrixInviteDeepLink(`atum://join/${token}?account=other`)).toBeNull()
    expect(parseMatrixInviteDeepLink(`atum://join/${'A'.repeat(129)}`)).toBeNull()
  })

  it('claims malformed join routes without claiming other Atum routes', () => {
    expect(isMatrixInviteDeepLinkCandidate('atum://join/not-a-token')).toBe(true)
    expect(isMatrixInviteDeepLinkCandidate('ATUM://join/not-a-token')).toBe(true)
    expect(isMatrixInviteDeepLinkCandidate('atum://message/v1/value')).toBe(false)
  })
})
