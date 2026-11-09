import { describe, expect, it } from 'vitest'

import {
  formatManagedModelUsd,
  isManagedModelSelection,
  isManagedModelTemporarilyUnavailable,
  managedModelAccessAliasForExplicitSelection,
  managedModelAccessAliasForSelection,
  managedModelAccessFailure,
  parseManagedModelAccessAuthority,
  parseManagedModelUsageHistory,
  parseManagedModelUsageTurn
} from './atum-managed-model-access'

const ready = {
  state: 'ready',
  billing_currency: 'protons',
  access_alias: 'binh-minh',
  alias_version: 'binh-minh-v1',
  available_protons: 12_300.125,
  held_protons: 44.875,
  next_quote_protons: 3.25
}

describe('managed model access boundary', () => {
  it('accepts the Proton authority without any legacy allowance record', () => {
    expect(parseManagedModelAccessAuthority(ready)).toEqual(ready)
  })

  it.each(['ready', 'insufficient_funds', 'service_paused', 'denied', 'model_unavailable'] as const)('accepts the explicit %s eligibility answer', state => {
    const value = { state, access_alias: 'binh-minh', billing_currency: 'protons' }
    expect(parseManagedModelAccessAuthority({ ...value, private_detail: 'hidden' })).toEqual(value)
  })

  it.each(['funding_required', 'model_reserved'] as const)('keeps the server-owned %s reason', reason => {
    const value = { state: 'denied', access_alias: 'nguyet-thuc', billing_currency: 'protons', reason }
    expect(parseManagedModelAccessAuthority(value)).toEqual(value)
  })

  it('rejects legacy authority and invalid money rather than presenting paid eligibility', () => {
    for (const state of ['warning', 'urgent', 'exhausted', 'no_grant', 'kill_switch', 'future_state']) {
      expect(parseManagedModelAccessAuthority({ ...ready, state })).toBeNull()
    }

    for (const amount of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12']) {
      expect(parseManagedModelAccessAuthority({ ...ready, available_protons: amount })).toBeNull()
    }

    expect(parseManagedModelAccessAuthority({ ...ready, billing_currency: 'microcredits' })).toBeNull()
    expect(parseManagedModelAccessAuthority({ ...ready, reason: 'daily_grant_limit' })).toBeNull()
    expect(parseManagedModelAccessAuthority({ state: 'ready', access_alias: 'binh-minh' })).toBeNull()
  })

  it('keeps authentication expiry distinct and collapses raw hosted failures', () => {
    expect(managedModelAccessFailure(401, { error: 'anything' })).toEqual({ state: 'authentication_expired' })
    expect(managedModelAccessFailure(503, { error: 'database host leaked detail' })).toEqual({ state: 'unavailable' })
  })

  it('recognizes the managed provider or pinned alias without matching substrings', () => {
    expect(isManagedModelSelection('atum-managed', 'binh-minh')).toBe(true)
    expect(isManagedModelSelection('', 'binh-minh')).toBe(true)
    expect(isManagedModelSelection('', 'nguyet-thuc')).toBe(true)
    expect(isManagedModelSelection('', 'nhat-thuc')).toBe(true)
    expect(isManagedModelSelection('openai', 'binh-minh-preview')).toBe(false)
  })

  it('treats an unhydrated fresh Atum selection as the packaged managed default', () => {
    expect(managedModelAccessAliasForSelection('', '')).toBe('binh-minh')
    expect(managedModelAccessAliasForSelection('atum-managed', '')).toBe('binh-minh')
    expect(managedModelAccessAliasForSelection('atum-managed', 'nguyet-thuc')).toBe('nguyet-thuc')
    expect(managedModelAccessAliasForSelection('openai', 'gpt-5')).toBeNull()
  })

  it('keeps Nhật Thực visible but unavailable until its hosted credential is ready', () => {
    expect(isManagedModelTemporarilyUnavailable('atum-managed', 'nhat-thuc')).toBe(true)
    expect(isManagedModelTemporarilyUnavailable('atum-managed', 'binh-minh')).toBe(false)
    expect(isManagedModelTemporarilyUnavailable('atum-managed', 'nguyet-thuc')).toBe(false)
    expect(isManagedModelTemporarilyUnavailable('openai', 'nhat-thuc')).toBe(false)
  })
})

const settledTurn = {
  reservation_id: '00000000-0000-4000-8000-760ea72ca9df',
  access_alias: 'binh-minh',
  display_name: 'Bình Minh',
  status: 'settled',
  actual_microcredits: 1_176,
  quoted_microcredits: 6_774,
  provider_calls: 7,
  prompt_tokens: 7_000,
  cache_hit_tokens: 0,
  completion_tokens: 700,
  started_at: '2026-09-02T12:58:00+00:00',
  settled_at: '2026-09-02T13:00:00+00:00'
}

describe('managed model usage boundary (0076)', () => {
  it('parses the usage history body and drops anything malformed', () => {
    expect(parseManagedModelUsageHistory({ turns: [settledTurn] })).toEqual([settledTurn])
    expect(parseManagedModelUsageHistory({ turns: [] })).toEqual([])
    expect(
      parseManagedModelUsageTurn({ ...settledTurn, status: 'dispatched', actual_microcredits: null, settled_at: null })
    ).toEqual({ ...settledTurn, status: 'dispatched', actual_microcredits: null, settled_at: null })
    expect(parseManagedModelUsageTurn({ ...settledTurn, access_alias: 'deepseek-v4-flash' })).toBeNull()
    expect(parseManagedModelUsageTurn({ ...settledTurn, status: 'billing_internal' })).toBeNull()
    expect(parseManagedModelUsageTurn({ ...settledTurn, provider_calls: -1 })).toBeNull()
    expect(parseManagedModelUsageHistory({ turns: [settledTurn, { broken: true }] })).toBeNull()
    expect(parseManagedModelUsageHistory([settledTurn])).toBeNull()
  })

  it('never treats a blank selection as the default alias for turn side effects', () => {
    expect(managedModelAccessAliasForExplicitSelection('', '')).toBeNull()
    expect(managedModelAccessAliasForExplicitSelection('openai', 'gpt-5')).toBeNull()
    expect(managedModelAccessAliasForExplicitSelection('atum-managed', '')).toBe('binh-minh')
    expect(managedModelAccessAliasForExplicitSelection('atum-managed', 'nguyet-thuc')).toBe('nguyet-thuc')
    expect(managedModelAccessAliasForExplicitSelection('', 'nhat-thuc')).toBe('nhat-thuc')
  })

  it('formats microcredits as wholesale USD with finer precision under a cent', () => {
    expect(formatManagedModelUsd(2_000_000, 'en-US')).toBe('$2.00')
    expect(formatManagedModelUsd(1_176, 'en-US')).toBe('$0.0012')
    expect(formatManagedModelUsd(0, 'en-US')).toBe('$0.00')
  })
})
