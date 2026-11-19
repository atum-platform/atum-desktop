import { afterEach, describe, expect, it } from 'vitest'

import { PlanFact } from './plan-fact'
import { createDeviceServicePlatform } from './platform'
import type { WorkPlatform } from './ports'
import { ACCOUNT, DEVICE, type Harness, makeHarness } from './test-support'

// Gate 4a: the plan fact (G9). One boolean and a time, from T3's own provider status; never the login, never a name.

let h: Harness

afterEach(async () => h?.cleanup())

function setup() {
  h = makeHarness()
  const sent: Record<string, unknown>[] = []
  const state = { status: 'connected' as 'connected' | 'disconnected' | 'unknown', failWith: undefined as { status: number } | undefined }

  const platform: Pick<WorkPlatform, 'reportSubscription'> = {
    async reportSubscription(report) {
      if (state.failWith) {
        throw Object.assign(new Error('x'), state.failWith)
      }

      sent.push({ ...report })
    }
  }

  const fact = new PlanFact({ ledger: h.ledger, platform, accountId: ACCOUNT, deviceServiceId: DEVICE, now: h.clock.now, status: async () => state.status })

  return { fact, sent, state }
}

describe('when the Mac reports the plan fact', () => {
  it('reports what T3 says on the first read, then nothing until it changes or an hour has passed', async () => {
    const { fact, sent } = setup()

    await fact.tick()
    await fact.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ provider: 'codex', state: 'connected', deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: 1 })

    h.clock.advance(3_599_000)
    await fact.tick()
    expect(sent).toHaveLength(1)

    h.clock.advance(1_000)
    await fact.tick()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ state: 'connected' })
    expect((sent[1].observedAt as number) > (sent[0].observedAt as number)).toBe(true)
  })

  it('a disconnect, then a different login (a disconnect and a connect), then a connect again: every change is reported', async () => {
    const { fact, sent, state } = setup()

    await fact.tick()
    state.status = 'disconnected'
    await fact.tick()
    state.status = 'connected'
    await fact.tick()

    expect(sent.map(report => report.state)).toEqual(['connected', 'disconnected', 'connected'])
    expect(new Set(sent.map(report => report.observedAt)).size).toBe(3)
  })

  it('withdraws this Mac’s plan fact and keeps it withdrawn while T3 is still signed in', async () => {
    const { fact, sent } = setup()

    const heartbeat = fact.tick()
    await fact.setReportingEnabled(false)
    await heartbeat
    expect(sent.map(report => report.state)).toEqual(['connected', 'disconnected'])
    expect(sent[1]).toMatchObject({ deviceServiceId: DEVICE, accountId: ACCOUNT, provider: 'codex' })
    expect((sent[1].observedAt as number) > (sent[0].observedAt as number)).toBe(true)

    h.clock.advance(3_600_000)
    await fact.tick()
    expect(sent).toHaveLength(2)

    await fact.setReportingEnabled(true)
    await fact.tick()
    expect(sent.map(report => report.state)).toEqual(['connected', 'disconnected', 'connected'])
  })

  it('tolerates an absent fact and retries a failed withdrawal', async () => {
    const { fact, sent, state } = setup()

    await fact.setReportingEnabled(false)
    expect(sent).toHaveLength(0)
    await fact.setReportingEnabled(true)
    await fact.tick()
    state.failWith = { status: 503 }
    await expect(fact.setReportingEnabled(false)).rejects.toThrow('work_plan_fact_cleanup_pending')
    state.failWith = undefined
    await fact.tick()
    expect(sent.map(report => report.state)).toEqual(['connected', 'disconnected'])
  })

  it('a status T3 could not give is never claimed either way, and nothing is reported', async () => {
    const { fact, sent, state } = setup()

    state.status = 'unknown'
    await fact.tick()

    expect(sent).toEqual([])
    expect(fact.current()).toBe('unknown')
  })

  it('a report the platform did not take is owed again at the next check, with a newer time; nothing is recorded as sent', async () => {
    const { fact, sent, state } = setup()

    state.failWith = { status: 409 }
    await fact.tick()
    expect(fact.reported()).toBeUndefined()

    state.failWith = undefined
    h.clock.advance(60_000)
    await fact.tick()

    expect(sent).toHaveLength(1)
    expect(fact.reported()).toMatchObject({ state: 'connected' })
  })

  it('sign-out, account switch and Work off send `disconnected` in the last flush; a new sign-in reports the connection again', async () => {
    const { fact, sent } = setup()

    await fact.tick()
    await fact.final()
    expect(sent.map(report => report.state)).toEqual(['connected', 'disconnected'])

    h.clock.advance(1_000)
    await fact.tick()
    expect(sent.map(report => report.state)).toEqual(['connected', 'disconnected', 'connected'])
  })

  it('a report carries exactly the contract\'s six keys: no token, e-mail, plan name or login of any kind', async () => {
    const { fact, sent } = setup()

    await fact.tick()

    expect(Object.keys(sent[0]).sort()).toEqual(['accountId', 'deviceServiceId', 'observedAt', 'provider', 'routeEpoch', 'state'])
  })

  it('overlapping checks share one run', async () => {
    const { fact, sent } = setup()

    await Promise.all([fact.tick(), fact.refresh(), fact.tick()])
    expect(sent).toHaveLength(1)
  })
})

describe('the device-services call', () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('posts `work_subscription_report` with the owner\'s bearer and accepts the platform\'s own record of this Mac', async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string }[] = []

    const platform = createDeviceServicePlatform({
      endpoint: 'https://shell.test/api/matrix/v1/device-services',
      bearer: async () => 'owner-bearer',
      fetch: (async (url: string, init: { body: string; headers: Record<string, string> }) => {
        seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization })

        return new Response(JSON.stringify({ deviceServiceId: DEVICE, provider: 'codex', state: 'connected', observedAt: 5, recordedAt: 6 }), { status: 200 })
      }) as unknown as typeof fetch
    })

    await platform.reportSubscription?.({ deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: 1, provider: 'codex', state: 'connected', observedAt: 5 })

    expect(seen[0]).toMatchObject({ auth: 'Bearer owner-bearer', body: { operation: 'work_subscription_report', provider: 'codex', state: 'connected' } })
  })

  it('a 2xx that is not the contract\'s reply for this Mac is not an acknowledgement', async () => {
    for (const body of [{}, { deviceServiceId: ACCOUNT, provider: 'codex', state: 'connected', observedAt: 1, recordedAt: 1 }, { deviceServiceId: DEVICE, provider: 'codex', state: 'connected', observedAt: 1, recordedAt: 1, email: 'a@b.c' }]) {
      const platform = createDeviceServicePlatform({ endpoint: 'https://shell.test/x', bearer: async () => 'b', fetch: reply(body) })

      await expect(platform.reportSubscription?.({ deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: 1, provider: 'codex', state: 'connected', observedAt: 1 })).rejects.toMatchObject({ status: 502 })
    }
  })

  it('the platform\'s status is the only thing a caller learns from a refusal', async () => {
    const platform = createDeviceServicePlatform({ endpoint: 'https://shell.test/x', bearer: async () => 'b', fetch: reply({ error: 'revoked' }, 403) })

    await expect(platform.reportSubscription?.({ deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: 1, provider: 'codex', state: 'disconnected', observedAt: 1 })).rejects.toMatchObject({ status: 403 })
  })
})
