import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $matrixInviteJoinRequest,
  adoptMatrixInviteJoinPaste,
  bindMatrixInviteJoinAccount,
  initialInviteJoinState,
  inviteJoinReducer,
  openMatrixInviteJoinPaste,
  requestMatrixInviteJoinToken
} from './invite-join'

const token = 'A'.repeat(43)
const preview = {
  schemaVersion: 3 as const,
  company: { id: '00000000-0000-4000-8000-68ce1b921bf1', displayName: 'Atum Labs' },
  role: 'member' as const,
  inviter: { handle: 'minh', displayName: 'Minh' },
  expiresAt: 2_000,
  maxUses: 5,
  usesRemaining: 3
}

describe('invite-link preview and redeem state', () => {
  beforeEach(() => {
    $matrixInviteJoinRequest.set(null)
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '00000000-0000-4000-8000-576f18824476') })
  })

  it('holds a link delivered while signed out in memory only, for whichever account previews it first', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const delivered = requestMatrixInviteJoinToken(token)!

    // Signed out: no account yet, nothing written anywhere.
    expect(delivered.accountKey).toBeUndefined()
    expect(setItem).not.toHaveBeenCalled()

    // The first signed-in account to preview it owns it; a switch to another account cannot take it over.
    expect(bindMatrixInviteJoinAccount(delivered, 'account-a')?.accountKey).toBe('account-a')
    expect(bindMatrixInviteJoinAccount(delivered, 'account-b')).toBeNull()
    expect($matrixInviteJoinRequest.get()?.accountKey).toBe('account-a')
    setItem.mockRestore()
  })

  it('adopts a pasted HTTPS link once and keeps one replay id in memory', () => {
    const opened = openMatrixInviteJoinPaste()
    const adopted = adoptMatrixInviteJoinPaste(opened, `https://account.atumplatform.com/j/${token}`)!
    const rebound = bindMatrixInviteJoinAccount(adopted, 'account-a')!

    expect(adopted.token).toBe(token)
    expect(adopted.requestId).toBe('00000000-0000-4000-8000-576f18824476')
    expect(rebound.requestId).toBe(adopted.requestId)
    expect($matrixInviteJoinRequest.get()?.requestId).toBe(adopted.requestId)
  })

  it('refuses bad paste tokens and detects a different signed-in account', () => {
    const opened = openMatrixInviteJoinPaste()
    expect(adoptMatrixInviteJoinPaste(opened, 'https://account.atumplatform.com/j/short')).toBeNull()

    const request = requestMatrixInviteJoinToken(token)!
    expect(bindMatrixInviteJoinAccount(request, 'account-a')?.accountKey).toBe('account-a')
    expect(bindMatrixInviteJoinAccount(request, 'account-b')).toBeNull()
  })

  it('shows expiry and exhaustion before a Join can be sent', () => {
    const start = initialInviteJoinState(requestMatrixInviteJoinToken(token)!)
    expect(inviteJoinReducer(start, { type: 'previewed', preview, now: 2_000 })).toMatchObject({ failure: 'expired' })
    expect(inviteJoinReducer(start, {
      type: 'previewed', preview: { ...preview, usesRemaining: 0 }, now: 1_000
    })).toMatchObject({ failure: 'exhausted' })
  })

  it('classifies a link withdrawn after preview as revoked', () => {
    const shown = inviteJoinReducer({ stage: 'previewing' }, { type: 'previewed', preview, now: 1_000 })
    const joining = inviteJoinReducer(shown, { type: 'redeeming' })

    expect(inviteJoinReducer(joining, { type: 'redeem_failed', now: 1_001, unavailableLink: true }))
      .toMatchObject({ failure: 'revoked' })
  })

  it.each([
    [{ replayed: false, consumedNow: true }, 'joined'],
    [{ replayed: false, consumedNow: false }, 'already_member'],
    [{ replayed: true, consumedNow: false }, 'replayed']
  ] as const)('handles joined, already-member and replay receipts: %j', (link, completion) => {
    const joining = { stage: 'redeeming' as const, preview }
    const state = inviteJoinReducer(joining, { type: 'redeemed', value: {
      schemaVersion: 3,
      companyId: preview.company.id,
      memberRef: 'A'.repeat(43),
      role: 'member',
      state: 'active',
      link: { id: '00000000-0000-4000-8000-507f79cf6e24', maxUses: 5, usesRemaining: 2, ...link }
    } })

    expect(state).toMatchObject({ stage: 'complete', completion })
  })
})
