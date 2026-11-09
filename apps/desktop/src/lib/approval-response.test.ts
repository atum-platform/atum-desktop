import { describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'

import { approvalChoicesFor, primaryApprovalChoice, respondToApprovalRequest } from './approval-response'

describe('approvalChoicesFor / primaryApprovalChoice', () => {
  it('defaults to the full Hermes set with Always allow primary', () => {
    expect(approvalChoicesFor({})).toEqual(['once', 'session', 'always', 'deny'])
    expect(primaryApprovalChoice({})).toBe('always')
  })

  it('keeps the gateway choice list authoritative and drops unknown entries', () => {
    expect(approvalChoicesFor({ choices: ['once', 'deny', 'bogus'] })).toEqual(['once', 'deny'])
    expect(primaryApprovalChoice({ choices: ['once', 'deny'] })).toBe('once')
    expect(primaryApprovalChoice({ choices: ['session', 'deny'] })).toBe('session')
    // No affirmative choice declared: never synthesize one.
    expect(primaryApprovalChoice({ choices: ['deny'] })).toBeNull()
    expect(primaryApprovalChoice({ allowPermanent: false, choices: ['always', 'deny'] })).toBeNull()
  })

  it('never offers Always when the backend refuses a permanent allow', () => {
    expect(approvalChoicesFor({ allowPermanent: false })).toEqual(['once', 'session', 'deny'])
    expect(primaryApprovalChoice({ allowPermanent: false })).toBe('once')
  })

  it('treats a Smart DENY override as an independent once/deny restriction', () => {
    expect(approvalChoicesFor({ smartDenied: true })).toEqual(['once', 'deny'])
    expect(approvalChoicesFor({ smartDenied: true, choices: ['once', 'always', 'deny'] })).toEqual(['once', 'deny'])
    expect(primaryApprovalChoice({ smartDenied: true, choices: ['once', 'session', 'always', 'deny'] })).toBe('once')
  })
})

describe('respondToApprovalRequest', () => {
  it('sends a plain, exact approval.respond and throws when nothing was pending', async () => {
    const request = vi.fn().mockResolvedValueOnce({ resolved: 1 }).mockResolvedValueOnce({ resolved: 0 })
    const gateway = { request } as unknown as HermesGateway

    await respondToApprovalRequest(
      gateway,
      { command: '<computer_use>', description: 'Observe', patternKey: 'plugin_rule:atum:k:computer.observe', sessionId: 's' },
      'always'
    )

    expect(request).toHaveBeenCalledWith('approval.respond', {
      choice: 'always',
      pattern_key: 'plugin_rule:atum:k:computer.observe',
      session_id: 's'
    })

    await expect(
      respondToApprovalRequest(gateway, { command: 'rm -rf x', description: 'dangerous', sessionId: null }, 'deny')
    ).rejects.toThrow(/no longer pending/u)
    expect(request).toHaveBeenLastCalledWith('approval.respond', { choice: 'deny', session_id: undefined })
  })
})
