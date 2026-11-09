import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  classifyMatrixSyncState,
  createMatrixSyncHealth,
  MATRIX_SYNC_GRACE_MS,
  matrixSyncApplied,
  matrixSyncedAfter,
  type MatrixSyncHealth,
  matrixSyncTokenRefused
} from './matrix-sync-health'

describe('classifyMatrixSyncState', () => {
  // [state, context, health]
  const table: Array<[string | null | undefined, Parameters<typeof classifyMatrixSyncState>[1], MatrixSyncHealth]> = [
    ['PREPARED', undefined, 'alive'],
    ['SYNCING', undefined, 'alive'],
    // The first response after a blip is applied while the state is still CATCHUP.
    ['CATCHUP', undefined, 'alive'],
    ['CATCHUP', { sinceGoodMs: null }, 'alive'],
    ['RECONNECTING', undefined, 'degraded'],
    ['RECONNECTING', { sinceGoodMs: 5_000 }, 'degraded'],
    ['ERROR', undefined, 'degraded'],
    ['ERROR', { sinceGoodMs: MATRIX_SYNC_GRACE_MS - 1 }, 'degraded'],
    // The grace is counted from the last good state, and it bounds RECONNECTING too.
    ['ERROR', { sinceGoodMs: MATRIX_SYNC_GRACE_MS }, 'offline'],
    ['RECONNECTING', { sinceGoodMs: MATRIX_SYNC_GRACE_MS + 1 }, 'offline'],
    ['ERROR', { sinceGoodMs: 1_000, graceMs: 500 }, 'offline'],
    // Nothing good yet: nothing to carry through a blip.
    ['RECONNECTING', { sinceGoodMs: null }, 'offline'],
    ['ERROR', { sinceGoodMs: null }, 'offline'],
    // A refused token is never a blip.
    ['ERROR', { sinceGoodMs: 0, tokenRefused: true }, 'offline'],
    ['RECONNECTING', { tokenRefused: true }, 'offline'],
    // ...and no state revives it, not even the CATCHUP that follows a blip.
    ['CATCHUP', { tokenRefused: true }, 'offline'],
    ['SYNCING', { sinceGoodMs: 0, tokenRefused: true }, 'offline'],
    ['STOPPED', undefined, 'offline'],
    ['STOPPED', { sinceGoodMs: 0 }, 'offline'],
    ['SOMETHING_NEW', undefined, 'offline'],
    ['', undefined, 'offline'],
    [null, undefined, 'offline'],
    [undefined, undefined, 'offline']
  ]

  it.each(table)('%s with %j reads %s', (state, context, health) => {
    expect(classifyMatrixSyncState(state, context)).toBe(health)
  })

  it('reads a token refusal from the sync event data and nothing else', () => {
    expect(matrixSyncTokenRefused({ error: { errcode: 'M_UNKNOWN_TOKEN', httpStatus: 401 } })).toBe(true)
    expect(matrixSyncTokenRefused({ error: { errcode: 'M_LIMIT_EXCEEDED' } })).toBe(false)
    expect(matrixSyncTokenRefused({ error: new Error('network') })).toBe(false)
    expect(matrixSyncTokenRefused({ catchingUp: true })).toBe(false)
    expect(matrixSyncTokenRefused(null)).toBe(false)
    expect(matrixSyncTokenRefused(undefined)).toBe(false)
  })

  it('says a sync response was applied only for PREPARED and SYNCING', () => {
    expect(['PREPARED', 'SYNCING', 'CATCHUP', 'RECONNECTING', 'ERROR', 'STOPPED', null].map(matrixSyncApplied)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false
    ])
  })
})

describe('matrixSyncedAfter', () => {
  it('becomes synced on a real sync and survives a blip', () => {
    let synced = false

    for (const [state, health, expected] of [
      ['PREPARED', 'alive', false],
      ['SYNCING', 'alive', true],
      ['RECONNECTING', 'degraded', true],
      ['ERROR', 'degraded', true],
      ['CATCHUP', 'alive', true],
      ['SYNCING', 'alive', true]
    ] as const) {
      synced = matrixSyncedAfter(synced, state, health)
      expect(synced, state).toBe(expected)
    }
  })

  it('is lost when the sync is offline, and not gained from a blip', () => {
    expect(matrixSyncedAfter(true, 'ERROR', 'offline')).toBe(false)
    expect(matrixSyncedAfter(true, 'STOPPED', 'offline')).toBe(false)
    expect(matrixSyncedAfter(false, 'RECONNECTING', 'degraded')).toBe(false)
    expect(matrixSyncedAfter(false, 'CATCHUP', 'alive')).toBe(false)
  })

  it('trusts the saved sync only for a reader that says so', () => {
    expect(matrixSyncedAfter(false, 'PREPARED', 'alive')).toBe(false)
    expect(matrixSyncedAfter(false, 'PREPARED', 'alive', { prepared: true })).toBe(true)
  })
})

describe('createMatrixSyncHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T02:37:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts offline and follows a blip without ever reading offline inside the grace', () => {
    const health = createMatrixSyncHealth()
    expect(health.current()).toBe('offline')

    expect(health.observe('PREPARED')).toBe('alive')
    expect(health.observe('SYNCING')).toBe('alive')

    vi.advanceTimersByTime(35_000)
    // The router dropped: the long-poll fails, then the keep-alive finds the network back.
    expect(health.observe('RECONNECTING', { error: new Error('ECONNRESET') })).toBe('degraded')
    vi.advanceTimersByTime(16_000)
    expect(health.current()).toBe('degraded')
    expect(health.observe('CATCHUP', { catchingUp: true })).toBe('alive')
    expect(health.observe('SYNCING')).toBe('alive')
  })

  it('reads ERROR as degraded for the grace after the last good state, then offline', () => {
    const health = createMatrixSyncHealth()
    health.observe('SYNCING')

    vi.advanceTimersByTime(10_000)
    expect(health.observe('ERROR', { error: new Error('502') })).toBe('degraded')

    vi.advanceTimersByTime(MATRIX_SYNC_GRACE_MS - 10_001)
    expect(health.current()).toBe('degraded')

    vi.advanceTimersByTime(1)
    expect(health.current()).toBe('offline')
  })

  it('does not extend the grace when ERROR repeats', () => {
    const health = createMatrixSyncHealth()
    health.observe('SYNCING')

    for (let at = 0; at < 4; at++) {
      vi.advanceTimersByTime(25_000)
      health.observe('ERROR')
    }

    // 100 s since the last good state and still degraded; 20 s more crosses the grace.
    expect(health.current()).toBe('degraded')
    vi.advanceTimersByTime(20_000)
    expect(health.observe('ERROR')).toBe('offline')
  })

  it('is offline at once for a refused token, and again alive after a good state', () => {
    const health = createMatrixSyncHealth()
    health.observe('SYNCING')

    expect(health.observe('ERROR', { error: { errcode: 'M_UNKNOWN_TOKEN' } })).toBe('offline')
    // Still refused until a good state says otherwise.
    expect(health.observe('RECONNECTING')).toBe('offline')
    // CATCHUP only says the network answers; it is not a sync response under a working token.
    expect(health.observe('CATCHUP')).toBe('offline')
    expect(health.observe('SYNCING')).toBe('alive')
    expect(health.observe('RECONNECTING')).toBe('degraded')
  })

  it('is offline for STOPPED and for a blip with no good state before it', () => {
    const health = createMatrixSyncHealth()
    expect(health.observe('RECONNECTING')).toBe('offline')

    health.observe('SYNCING')
    expect(health.observe('STOPPED')).toBe('offline')
  })

  it('tells onChange about the move to offline by itself when the grace runs out', () => {
    const changes: Array<[MatrixSyncHealth, MatrixSyncHealth]> = []

    const health = createMatrixSyncHealth({
      onChange: (next, previous) => {
        changes.push([next, previous])
      }
    })

    health.observe('SYNCING')
    expect(changes).toEqual([['alive', 'offline']])

    vi.advanceTimersByTime(30_000)
    health.observe('RECONNECTING')
    expect(changes.at(-1)).toEqual(['degraded', 'alive'])

    // No further sync event arrives (the keep-alive polls a dead network): the timer still fires.
    vi.advanceTimersByTime(MATRIX_SYNC_GRACE_MS - 30_000 - 1)
    expect(changes.at(-1)).toEqual(['degraded', 'alive'])
    vi.advanceTimersByTime(1)
    expect(changes.at(-1)).toEqual(['offline', 'degraded'])
    expect(changes).toHaveLength(3)
  })

  it('cancels the pending offline when the network returns, and after dispose', () => {
    const changes: MatrixSyncHealth[] = []
    const health = createMatrixSyncHealth({ onChange: next => changes.push(next) })

    health.observe('SYNCING')
    vi.advanceTimersByTime(20_000)
    health.observe('RECONNECTING')
    vi.advanceTimersByTime(60_000)
    health.observe('CATCHUP')
    vi.advanceTimersByTime(MATRIX_SYNC_GRACE_MS * 2)
    expect(changes).toEqual(['alive', 'degraded', 'alive'])

    health.observe('SYNCING')
    health.observe('RECONNECTING')
    expect(changes).toEqual(['alive', 'degraded', 'alive', 'degraded'])
    health.dispose()
    vi.advanceTimersByTime(MATRIX_SYNC_GRACE_MS * 2)
    expect(changes).toEqual(['alive', 'degraded', 'alive', 'degraded'])
  })

  it('arms no timer unless something listens for the change', () => {
    const health = createMatrixSyncHealth()
    health.observe('SYNCING')
    health.observe('RECONNECTING')

    expect(vi.getTimerCount()).toBe(0)
  })
})
