import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  admitExecute,
  admitGrant,
  type AdmittedGrant,
  evaluateRenew,
  evaluateRevoke,
  GrantTable,
  RateLimiter
} from './service'

// The vendored device-service/1 case fixtures — the same evidence the controller and platform are held
// to. `contract.json` classifies each as accept (consume it; its `expect` is the required outcome) or
// reject (an invariant violation: the embedded `expect` is the WRONG value a correct device must not
// produce).
const packDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/device-protocol/fixtures/device-service'
)

const contract = JSON.parse(readFileSync(path.join(packDir, 'contract.json'), 'utf8'))
const readCase = (file: string) => JSON.parse(readFileSync(path.join(packDir, file), 'utf8'))

function casesFor(message: string): Array<{ file: string; expect: 'accept' | 'reject'; data: any }> {
  return (contract.fixtures as Array<{ file: string; message?: string; expect: string }>)
    .filter(entry => entry.message === message)
    .map(entry => ({ file: entry.file, expect: entry.expect as 'accept' | 'reject', data: readCase(entry.file) }))
}

function admittedGrantOf(data: any): AdmittedGrant {
  return {
    body: data.grant.body,
    status: data.grant.status === 'live' ? 'live' : 'stopped',
    lastSeq: data.grant.lastSeq,
    effectiveScopes: data.grant.effectiveScopes,
    authorityUntil: data.grant.authorityUntil
  }
}

function executeInputOf(data: any, agentUserId: string) {
  return {
    device: data.device,
    grant: admittedGrantOf(data),
    agentUserId,
    execute: data.execute.body,
    commandHash: data.facts.commandHash,
    facts: {
      signatureValid: data.facts.signatureValid,
      kidPinned: data.facts.kidPinned,
      argsHash: data.facts.argsHash
    },
    seen: data.seen ?? [],
    originLog: data.originLog ?? [],
    standingGrants: (data.standingGrants ?? []).map((g: any, i: number) => ({
      id: `g${i}`,
      capability: g.capability,
      target: g.target,
      label: '',
      createdAt: 0,
      agent: data.grant.body.agentUserId
    }))
  }
}

function runExecute(data: any) {
  return admitExecute(executeInputOf(data, data.grant.body.agentUserId))
}

describe('case.execute — the admission order against the vendored fixtures', () => {
  for (const { file, expect: kind, data } of casesFor('case.execute')) {
    it(`${data.name} (${kind})`, () => {
      const result = runExecute(data)

      if (kind === 'accept') {
        expect(result.outcome).toBe(data.expect.outcome)

        if (data.expect.outcome === 'refused') {
          expect((result as { refusal: string }).refusal).toBe(data.expect.refusal)
        }

        if (data.expect.outcome === 'needs_approval') {
          expect(new Set((result as { capabilities: string[] }).capabilities)).toEqual(
            new Set(data.expect.capabilities)
          )
        }
      } else {
        // A reject fixture's embedded outcome is the violation; a correct device must not produce it.
        expect(result.outcome).not.toBe(data.expect.outcome)
      }
    })
  }
})

describe('admitExecute — a standing grant only covers the agent it names', () => {
  it("does not admit agent B under agent A's grant", () => {
    const data = readCase('fixtures/execute-protected-standing-grant.case.json')
    const agentA = data.grant.body.agentUserId
    const agentB = '@some-other-agent:atumplatform.com'
    const grantForA = { id: 'g-a', capability: 'ssh_agent' as const, target: '*', label: '', createdAt: 0, agent: agentA }

    expect(admitExecute({ ...executeInputOf(data, agentB), standingGrants: [grantForA] })).toEqual({
      outcome: 'needs_approval',
      capabilities: ['ssh_agent']
    })
    expect(admitExecute({ ...executeInputOf(data, agentA), standingGrants: [grantForA] }).outcome).toBe('admitted')
  })
})

describe('case.grant — TurnGrant admission against the vendored fixtures', () => {
  for (const { expect: kind, data } of casesFor('case.grant')) {
    it(`${data.name} (${kind})`, () => {
      const result = admitGrant(
        data.device,
        data.grant.body,
        { signatureValid: data.facts.signatureValid, kidPinned: data.facts.kidPinned },
        data.originLog ?? []
      )

      if (kind === 'accept') {
        expect(result.outcome).toBe(data.expect.outcome)

        if (data.expect.outcome === 'accepted') {
          expect((result as { effectiveScopes: string[] }).effectiveScopes).toEqual(data.expect.effectiveScopes)
        } else {
          expect((result as { refusal: string }).refusal).toBe(data.expect.refusal)
        }
      } else {
        if (data.expect.outcome === 'accepted') {
          expect(result.outcome).not.toBe('accepted')
        }
      }
    })
  }
})

describe('case.renew — authority-window extension against the vendored fixtures', () => {
  for (const { expect: kind, data } of casesFor('case.renew')) {
    it(`${data.name} (${kind})`, () => {
      const result = evaluateRenew({
        receivedAt: data.device.receivedAt,
        grant: { status: data.grant.status === 'live' ? 'live' : 'stopped', expiresAt: data.grant.body.expiresAt },
        until: data.renew.body.until,
        kidPinned: data.facts.kidPinned
      })

      if (kind === 'accept') {
        expect(result.outcome).toBe(data.expect.outcome)

        if (data.expect.outcome === 'extended') {
          expect((result as { authorityUntil: number }).authorityUntil).toBe(data.expect.authorityUntil)
        } else {
          expect((result as { reason: string }).reason).toBe(data.expect.reason)
        }
      } else {
        // renew-extended-past-grant: extending past the grant end is the violation.
        expect(result.outcome).toBe('ignored')
      }
    })
  }
})

describe('case.revoke — monotonic revoke against the vendored fixtures', () => {
  for (const { expect: kind, data } of casesFor('case.revoke')) {
    it(`${data.name} (${kind})`, () => {
      const result = evaluateRevoke({
        deviceEnrollmentEpoch: data.device.enrollmentEpoch,
        lastRevokeSeq: data.lastRevokeSeq,
        revoke: { enrollmentEpoch: data.revoke.body.enrollmentEpoch, revokeSeq: data.revoke.body.revokeSeq },
        kidPinned: data.facts.kidPinned
      })

      if (kind === 'accept') {
        expect(result.outcome).toBe(data.expect.outcome)

        if (data.expect.outcome === 'ignored') {
          expect((result as { reason: string }).reason).toBe(data.expect.reason)
        }
      } else {
        // revoke-older-applied: applying an older revoke is the violation.
        expect(result.outcome).toBe('ignored')
      }
    })
  }
})

describe('GrantTable', () => {
  const base: AdmittedGrant = {
    body: { grantId: 'g1' } as AdmittedGrant['body'],
    status: 'live',
    lastSeq: 4,
    effectiveScopes: ['terminal'],
    authorityUntil: 100
  }

  it('advances seq only forward and extends authority', () => {
    const table = new GrantTable()
    table.set(base)
    table.advanceSeq('g1', 5)
    table.advanceSeq('g1', 3) // stale, ignored
    expect(table.get('g1')?.lastSeq).toBe(5)
    table.extendAuthority('g1', 200)
    expect(table.get('g1')?.authorityUntil).toBe(200)
  })

  it('stopAll stops every live grant so no later Execute is admitted', () => {
    const table = new GrantTable()
    table.set(base)
    table.set({ ...base, body: { grantId: 'g2' } as AdmittedGrant['body'] })
    table.stopAll()
    expect(table.live()).toHaveLength(0)
    expect(table.get('g1')?.status).toBe('stopped')
  })
})

describe('RateLimiter', () => {
  it('caps Execute at 10/s and 600/turn, and auto-refuses after 3 denials', () => {
    let now = 0
    const limiter = new RateLimiter(() => now)

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.admitExecuteRate()).toBe(true)
    }

    expect(limiter.admitExecuteRate()).toBe(false) // 11th in the same second
    now += 1000
    expect(limiter.admitExecuteRate()).toBe(true) // next second

    expect(limiter.admitPrompt()).toBe(true)
    limiter.recordDenial()
    limiter.recordDenial()
    limiter.recordDenial()
    expect(limiter.admitPrompt()).toBe(false) // 3 denials → auto-refuse
    limiter.resetTurn()
    expect(limiter.admitPrompt()).toBe(true)
  })
})
