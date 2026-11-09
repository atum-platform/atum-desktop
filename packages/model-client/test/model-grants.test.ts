import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_OUTPUT_TOKENS, ModelGrantRegistry } from '../src/model-grants'
import { newOpaqueToken, OPAQUE_TOKEN, tokenHandle } from '../src/opaque-token'

function registry(start = 1_000_000) {
  let now = start
  const grants = new ModelGrantRegistry(() => now)

  return { grants, advance: (ms: number) => (now += ms), now: () => now }
}

const input = (now: number, extra: Record<string, unknown> = {}) => ({
  taskId: 'task-0001abcd',
  aliases: ['nguyet-thuc'],
  expiresAt: now + 60_000,
  ...extra
})

describe('model grants', () => {
  it('mints the contract’s opaque token and keeps only its digest', () => {
    const { grants, now } = registry()
    const { token, grant } = grants.mint(input(now()))

    expect(token).toMatch(OPAQUE_TOKEN)
    expect(grant.handle).toBe(tokenHandle(token))
    expect(JSON.stringify(grant)).not.toContain(token)
    grants.bindSource('task-0001abcd', '10.231.0.7')
    expect(grants.check(token, '10.231.0.7')).toMatchObject({ ok: true })
  })

  it('refuses an unknown, expired or revoked grant with a closed code', () => {
    const { grants, advance, now } = registry()
    const { token } = grants.mint(input(now()))

    expect(grants.check(newOpaqueToken())).toEqual({ ok: false, reason: 'unknown_grant' })
    expect(grants.check(null)).toEqual({ ok: false, reason: 'unknown_grant' })
    advance(60_000)
    expect(grants.check(token)).toEqual({ ok: false, reason: 'expired' })

    const second = grants.mint(input(now(), { taskId: 'task-0002abcd' }))
    grants.revokeTask('task-0002abcd')
    expect(grants.check(second.token)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('bounds the request count and the concurrency', () => {
    const { grants, now } = registry()
    const { token } = grants.mint(input(now(), { maxRequests: 3, maxConcurrent: 2 }))
    grants.bindSource('task-0001abcd', '10.231.0.7')

    const first = grants.begin(token, '10.231.0.7')
    const second = grants.begin(token, '10.231.0.7')
    expect(first.ok && second.ok).toBe(true)
    expect(grants.begin(token, '10.231.0.7')).toEqual({ ok: false, reason: 'busy' })

    if (first.ok) {
      first.admission.end()
      first.admission.end() // idempotent
    }

    const third = grants.begin(token, '10.231.0.7')
    expect(third.ok).toBe(true)
    expect(grants.begin(token, '10.231.0.7')).toEqual({ ok: false, reason: 'exhausted' })
    expect(grants.stats('task-0001abcd')).toEqual({ requests: 3, inflight: 2 })
  })

  it('a grant with the turn defaults fits a delegation-heavy Hermes turn', () => {
    // What Hermes's own defaults can ask of one turn: 90 parent iterations, three children of
    // 50 each (delegation.max_iterations, max_concurrent_children), plus compression and
    // auxiliary calls; in flight at once, the parent, its three children and one auxiliary call.
    const turnRequests = 90 + 3 * 50 + 60
    const inFlight = 1 + 3 + 1
    const { grants, now } = registry()
    const { token, grant } = grants.mint(input(now()))
    expect(grant.maxOutputTokens).toBe(65_536)
    expect(grant.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
    grants.bindSource('task-0001abcd', '10.231.0.7')

    const held = Array.from({ length: inFlight }, () => grants.begin(token, '10.231.0.7'))
    expect(held.every(admitted => admitted.ok)).toBe(true)
    for (const admitted of held) if (admitted.ok) admitted.admission.end()
    for (let call = inFlight; call < turnRequests; call++) {
      const admitted = grants.begin(token, '10.231.0.7')
      expect(admitted.ok).toBe(true)
      if (admitted.ok) admitted.admission.end()
    }
  })

  it('aborts every request in flight when the task is revoked', () => {
    const { grants, now } = registry()
    const { token } = grants.mint(input(now()))
    grants.bindSource('task-0001abcd', '10.231.0.7')
    const a = grants.begin(token, '10.231.0.7')
    const b = grants.begin(token, '10.231.0.7')

    expect(grants.revokeTask('task-0001abcd', 'lease_lost')).toBe(2)
    expect(a.ok && a.admission.signal.aborted).toBe(true)
    expect(b.ok && b.admission.signal.aborted).toBe(true)
    expect(grants.revokeTask('task-0001abcd')).toBe(0)
  })

  it('a closed task refuses new requests but lets one in flight finish; a revoke then cuts what is left', () => {
    const { grants, now } = registry()
    const { token } = grants.mint(input(now()))
    grants.bindSource('task-0001abcd', '10.231.0.7')
    const finishing = grants.begin(token, '10.231.0.7')
    const lingering = grants.begin(token, '10.231.0.7')

    grants.closeTask('task-0001abcd')
    expect(grants.begin(token, '10.231.0.7')).toEqual({ ok: false, reason: 'revoked' })
    expect(finishing.ok && !finishing.admission.signal.aborted && lingering.ok && !lingering.admission.signal.aborted).toBe(true)
    if (finishing.ok) finishing.admission.end()
    expect(grants.stats('task-0001abcd').inflight).toBe(1)

    expect(grants.revokeTask('task-0001abcd')).toBe(1)
    expect(lingering.ok && lingering.admission.signal.aborted).toBe(true)
    expect(grants.stats('task-0001abcd').inflight).toBe(0)
  })

  it('is unusable before binding and then worthless from any other address', () => {
    const { grants, now } = registry()
    const { token } = grants.mint(input(now()))

    expect(grants.check(token, '10.231.0.7')).toEqual({ ok: false, reason: 'wrong_source' })
    expect(grants.begin(token, '10.231.0.7')).toEqual({ ok: false, reason: 'wrong_source' })
    expect(grants.stats('task-0001abcd')).toEqual({ requests: 0, inflight: 0 })
    grants.bindSource('task-0001abcd', '10.231.0.7')
    expect(grants.check(token, '10.231.0.8')).toEqual({ ok: false, reason: 'wrong_source' })
    expect(grants.check(token, undefined)).toEqual({ ok: false, reason: 'wrong_source' })
    expect(grants.check(token, '::ffff:10.231.0.7').ok).toBe(true)
  })

  it('refuses a malformed grant', () => {
    const { grants, now } = registry()

    expect(() => grants.admit('short', input(now()))).toThrow('model_grant_invalid:token')
    expect(() => grants.mint({ ...input(now()), taskId: 'BAD' })).toThrow('task_id')
    expect(() => grants.mint({ ...input(now()), aliases: [] })).toThrow('aliases')
    expect(() => grants.mint({ ...input(now()), aliases: ['a', 'a'] })).toThrow('aliases')
    expect(() => grants.mint({ ...input(now()), aliases: ['Upper'] })).toThrow('aliases')
    expect(() => grants.mint({ ...input(now()), expiresAt: now() })).toThrow('expires_at')
    expect(() => grants.mint({ ...input(now()), maxRequests: 0 })).toThrow('max_requests')

    const token = newOpaqueToken()
    grants.admit(token, input(now()))
    expect(() => grants.admit(token, input(now()))).toThrow('duplicate')
  })

  it('forgets grants long expired', () => {
    const { grants, advance, now } = registry()
    const { token } = grants.mint(input(now()))

    advance(10 * 60_000)
    grants.prune()
    expect(grants.check(token)).toEqual({ ok: false, reason: 'unknown_grant' })
  })
})

it('reserves the cumulative roundup ceiling across concurrent calls and restores durable usage after restart', () => {
  let used = { inputTokens: 0, outputTokens: 0 }
  const registry = new ModelGrantRegistry()
  const budget = { inputTokens: 300000, outputTokens: 12000, persist: (value: typeof used) => { used = value } }
  const { token } = registry.mint({ taskId: 'roundup-0001', aliases: ['default'], expiresAt: Date.now()+60000, runBudget: budget })
  const a = registry.reserveTokens(token, 100000, 8000)!
  const b = registry.reserveTokens(token, 100000, 8000)!
  expect(a.output).toBe(8000)
  expect(b.output).toBe(4000)
  expect(registry.reserveTokens(token, 1, 1)).toBeNull()
  a.settle(80000, 3000)
  b.settle(90000, 4000)
  expect(used).toEqual({ inputTokens: 170000, outputTokens: 7000 })
  const restarted = new ModelGrantRegistry()
  const next = restarted.mint({ taskId: 'roundup-0001', aliases: ['default'], expiresAt: Date.now()+60000,
    runBudget: { ...budget, used } })
  expect(restarted.reserveTokens(next.token, 130001, 1)).toBeNull()
  const last = restarted.reserveTokens(next.token, 130000, 9000)!
  expect(last.output).toBe(5000)
  last.settle(null, null)
  expect(used).toEqual({ inputTokens: 300000, outputTokens: 12000 })
  expect(restarted.reserveTokens(next.token, 1, 1)).toBeNull()
})
