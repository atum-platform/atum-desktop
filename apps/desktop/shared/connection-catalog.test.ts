
import { describe, expect, it } from 'vitest'

import { CONNECTION_CATALOG, connectionCatalogEntry, connectionReviewFresh, connectionVisible, planStartDecision } from './connection-catalog'

const today = '2026-10-27'
const acknowledgment = { provider: 'openai-codex', policyVersion: today, acknowledgedAt: today }

describe('connection catalog policy', () => {
  it.each(['anthropic','claude-code','copilot','copilot-acp','qwen-oauth','xai-oauth','minimax-oauth','unknown','__proto__','toString'])('refuses a fresh explicit plan start for %s even with renderer-shaped acceptance', provider => {
    expect(planStartDecision({ provider, surface: 'advanced', trustedAcknowledgment: { ...acknowledgment, provider }, today })).toBe('provider_terms_blocked')
  })

  it('requires Settings Connections and the matching dated main-owned acknowledgment for the pending exception', () => {
    expect(planStartDecision({ provider: 'openai-codex', surface: 'connections', trustedAcknowledgment: acknowledgment, today })).toBe('allowed')
    expect(planStartDecision({ provider: 'openai-codex', surface: 'advanced', trustedAcknowledgment: acknowledgment, today })).toBe('provider_terms_blocked')
    expect(planStartDecision({ provider: 'openai-codex', surface: 'connections', today })).toBe('provider_terms_blocked')

    for (const wrong of [{ ...acknowledgment, provider: 'other' }, { ...acknowledgment, policyVersion: '2026-10-05' }, { ...acknowledgment, acknowledgedAt: '2026-10-05' }, { ...acknowledgment, acknowledgedAt: '2026-10-07' }, { ...acknowledgment, acknowledgedAt: '2026-02-30' }]) {
      expect(planStartDecision({ provider: 'openai-codex', surface: 'connections', trustedAcknowledgment: wrong, today })).toBe('provider_terms_blocked')
    }
  })

  it('fails stale, invalid and future reviews without blocking API-key/local inventory', () => {
    const value = connectionCatalogEntry('openai-codex', 'plan')!
    expect(connectionReviewFresh(value, '2026-12-11')).toBe(true)
    expect(connectionReviewFresh(value, '2026-12-12')).toBe(false)
    expect(connectionReviewFresh(value, '2026-10-26')).toBe(false)
    expect(connectionReviewFresh({ reviewedAt: '2026-02-30' }, today)).toBe(false)
    expect(planStartDecision({ provider: value.provider, surface: 'connections', trustedAcknowledgment: acknowledgment, today: '2026-12-12' })).toBe('provider_terms_blocked')

    for (const kind of ['apiKey','local'] as const) {
      expect(CONNECTION_CATALOG.filter(item => item.kind === kind).every(item => item.planSignIn === null && connectionVisible(item, false))).toBe(true)
    }
  })

  it('keeps a blocked existing connection visible for cleanup without permitting a new start', () => {
    for (const value of CONNECTION_CATALOG.filter(item => item.surface === 'hidden')) {
      expect(connectionVisible(value, false)).toBe(false)
      expect(connectionVisible(value, true)).toBe(true)
      expect(planStartDecision({ provider: value.provider, surface: 'advanced', trustedAcknowledgment: acknowledgment, today })).toBe('provider_terms_blocked')
    }
  })

  it('distinguishes the Anthropic API key from its blocked subscription path and freezes policy evidence', () => {
    expect(connectionCatalogEntry('anthropic', 'apiKey')?.planSignIn).toBeNull()
    expect(connectionCatalogEntry('anthropic', 'plan')?.planSignIn).toBe('prohibited')
    expect(new Set(CONNECTION_CATALOG.map(value => `${value.kind}:${value.provider}`)).size).toBe(CONNECTION_CATALOG.length)
    const value = connectionCatalogEntry('openai-codex', 'plan')!
    expect(Object.isFrozen(CONNECTION_CATALOG) && Object.isFrozen(value) && Object.isFrozen(value.ownerAcceptance)).toBe(true)
    expect(value.ownerAcceptance?.acceptedAt).toBe(today)
    expect(value.planSignIn).toBe('pending_approval')
    expect(value.surface).toBe('connections')
    expect(connectionCatalogEntry('opencode-go', 'apiKey')).toMatchObject({ surface: 'connections', planSignIn: null })
  })
})
