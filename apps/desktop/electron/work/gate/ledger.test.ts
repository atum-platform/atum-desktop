import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { type AdmitInput, GateLedger } from './ledger'
import { ACCOUNT, EVENT_A, EVENT_B, LUNA, NOVA, REQ_1, REQ_2, REQ_3 } from './test-support'

const dirs: string[] = []

const open = (dir = mkdtempSync(join(tmpdir(), 'wl-'))) => {
  dirs.push(dir)

  return { dir, ledger: new GateLedger(join(dir, 'l.sqlite'), ACCOUNT, () => 1000) }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const input = (principal: string, requestId: string, eventId: string): AdmitInput => ({
  principal,
  requestId,
  paramsHash: 'h',
  callJson: '{}',
  fingerprint: 'f',
  sessionId: 's',
  threadId: `t-${requestId}`,
  eventId,
  notAfter: 5000,
  epoch: 1,
  generation: 1
})

describe('the gate ledger', () => {
  it('the claim on an event and the receipt are one write: a second id on the same event writes nothing', () => {
    const { ledger } = open()

    expect(ledger.admit(input(LUNA, REQ_1, EVENT_A))).toEqual({ ok: true })
    expect(ledger.admit(input(LUNA, REQ_2, EVENT_A))).toEqual({ ok: false, reason: 'event_already_used' })
    expect(ledger.receipt(LUNA, REQ_2)).toBeUndefined()
    expect(ledger.admit(input(LUNA, REQ_1, EVENT_B))).toEqual({ ok: false, reason: 'request_exists' })
    expect(ledger.eventClaimed(EVENT_B)).toBe(false)
  })

  it('survives a restart: receipts, claims, counters and owed stops come back as they were', () => {
    const first = open()

    first.ledger.admit(input(LUNA, REQ_1, EVENT_A))
    first.ledger.markForwarded(LUNA, REQ_1, 'inc-1')
    first.ledger.cutoff({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    first.ledger.close()

    const second = open(first.dir).ledger

    expect(second.receipt(LUNA, REQ_1)).toMatchObject({ forwarded: true, incarnation: 'inc-1', stopScope: 'agent', settled: null })
    expect(second.agent(LUNA)?.generation).toBe(2)
    expect(second.eventClaimed(EVENT_A)).toBe(true)
    expect(second.scopeBlocked(LUNA)).toBe(true)
    expect(second.scopeBlocked(NOVA)).toBe(false)
  })

  it('a route-wide cutoff widens an agent\'s owed stop and holds back every agent', () => {
    const { ledger } = open()

    ledger.admit(input(LUNA, REQ_1, EVENT_A))
    ledger.cutoff({ scope: 'agent', principal: LUNA, reason: 'a' })
    expect(ledger.receipt(LUNA, REQ_1)?.stopScope).toBe('agent')
    expect(ledger.scopeBlocked(NOVA)).toBe(false)

    ledger.cutoff({ scope: 'route', reason: 'b' })
    expect(ledger.receipt(LUNA, REQ_1)?.stopScope).toBe('route')
    expect(ledger.scopeBlocked(NOVA)).toBe(true)
    expect(ledger.routeEpoch()).toBe(2)
  })

  it('a finished row owes nothing; an unfinished one does; hasUnfinished tells the session issuer', () => {
    const { ledger } = open()

    ledger.admit(input(LUNA, REQ_1, EVENT_A))
    expect(ledger.hasUnfinished(LUNA)).toBe(true)
    expect(ledger.hasUnfinished(NOVA)).toBe(false)
    ledger.update(LUNA, REQ_1, { finished: 1 })
    expect(ledger.hasUnfinished(LUNA)).toBe(false)
    expect(ledger.cutoff({ scope: 'route', reason: 'x' }).owed).toBe(0)
  })

  it('settledSeq never passes applied and waits for an open platform revocation', () => {
    const { ledger } = open()

    ledger.setAppliedSeq(5)
    expect(ledger.settledSeq()).toBe(5)
    const result = ledger.cutoff({ scope: 'agent', principal: LUNA, reason: 'r', sourceSeq: 4 })

    expect(ledger.settledSeq()).toBe(3)
    ledger.ackRevocation(result.revocationId)
    expect(ledger.settledSeq()).toBe(5)
    ledger.setAppliedSeq(2)
    expect(ledger.appliedSeq()).toBe(5)
  })

  it('a transaction that throws rolls back every write in it', () => {
    const { ledger } = open()

    expect(() =>
      ledger.tx(() => {
        ledger.setMeta('route_open', '1')
        ledger.void(LUNA, REQ_3)
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(ledger.meta('route_open')).toBeUndefined()
    expect(ledger.receipt(LUNA, REQ_3)).toBeUndefined()
  })

  it('stores only the hash of a grant; a replaced grant is dead, not unknown', () => {
    const { ledger } = open()

    ledger.insertGrant({ hash: 'h1', principal: LUNA, routeEpoch: 1, generation: 1, mintedAt: 1, expiresAt: 9 })
    ledger.insertGrant({ hash: 'h2', principal: LUNA, routeEpoch: 1, generation: 1, mintedAt: 2, expiresAt: 9 })
    expect(ledger.grantByHash('h1')).toMatchObject({ dead: true })
    expect(ledger.grantByHash('h2')).toMatchObject({ dead: false })
    expect(ledger.liveGrant(LUNA)?.hash).toBe('h2')
  })
})
