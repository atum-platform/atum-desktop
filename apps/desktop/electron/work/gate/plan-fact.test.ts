import { afterEach, describe, expect, it } from 'vitest'

import { type PlanCapabilities, PlanFact } from './plan-fact'
import { createDeviceServicePlatform } from './platform'
import type { WorkPlatform } from './ports'
import { ACCOUNT, DEVICE, type Harness, makeHarness } from './test-support'

// Work projects only native provider capabilities into each account's device facts.

let h: Harness

afterEach(async () => h?.cleanup())

function setup() {
  h = makeHarness()
  const sent: Record<string, unknown>[] = []
  const state = { status: 'connected' as 'connected' | 'disconnected' | 'unknown', extras: {} as PlanCapabilities, failWith: undefined as { status: number } | undefined }

  const platform: Pick<WorkPlatform, 'reportSubscription'> = {
    async reportSubscription(report) {
      if (state.failWith) {
        throw Object.assign(new Error('x'), state.failWith)
      }

      sent.push({ ...report })
    }
  }

  const create = () => new PlanFact({
    ledger: h.ledger, platform, accountId: ACCOUNT, deviceServiceId: DEVICE, now: h.clock.now,
    read: async () => ({ ...state.extras, ...(state.status === 'unknown' ? {} : { codex: { state: state.status } }) })
  })

  return { fact: create(), create, sent, state }
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
    const { fact, create, sent } = setup()

    await fact.tick()
    await fact.final()
    expect(sent.filter(report => report.provider === 'codex').map(report => report.state)).toEqual(['connected', 'disconnected'])
    expect(sent.filter(report => report.state === 'disconnected').map(report => report.provider)).toEqual(['codex', 'claude', 'antigravity'])

    await fact.tick()
    expect(sent).toHaveLength(4)

    h.clock.advance(1_000)
    await create().tick()
    expect(sent.filter(report => report.provider === 'codex').map(report => report.state)).toEqual(['connected', 'disconnected', 'connected'])
  })

  it('a report carries exactly the contract\'s six keys: no token, e-mail, plan name or login of any kind', async () => {
    const { fact, sent } = setup()

    await fact.tick()

    expect(Object.keys(sent[0]).sort()).toEqual(['accountId', 'deviceServiceId', 'observedAt', 'provider', 'routeEpoch', 'state'])
  })

  it('reports all native plans and resends a plan when only its model catalog changes', async () => {
    const { fact, sent, state } = setup()
    const models = [{ id: 'claude-test', displayName: 'Claude Test' }]

    state.extras = { claude: { state: 'connected', models }, antigravity: { state: 'disconnected' } }
    await fact.tick()
    expect(sent).toMatchObject([
      { provider: 'codex', state: 'connected' },
      { provider: 'claude', state: 'connected', models },
      { provider: 'antigravity', state: 'disconnected' }
    ])

    await fact.tick()
    expect(sent).toHaveLength(3)

    state.extras.claude = { state: 'connected', models: [...models, { id: 'claude-test-2', displayName: 'Claude Test 2' }] }
    await fact.tick()
    expect(sent).toHaveLength(4)
    expect(sent[3]).toMatchObject({ provider: 'claude', state: 'connected', models: state.extras.claude.models })
  })

  it('orders a final disconnect ahead of an outstanding connect and keeps the disconnect acknowledgement', async () => {
    h = makeHarness()
    let finishConnect!: () => void
    let startedConnect!: () => void
    const started = new Promise<void>(resolve => { startedConnect = resolve })
    const pending = new Promise<void>(resolve => { finishConnect = resolve })
    const sent: { state: string; observedAt: number }[] = []

    const fact = new PlanFact({
      ledger: h.ledger, accountId: ACCOUNT, deviceServiceId: DEVICE, now: h.clock.now,
      read: async () => ({ codex: { state: 'connected' } }),
      platform: {
        async reportSubscription(report) {
          if (report.provider !== 'codex') {return}

          sent.push(report)

          if (report.state === 'connected') {
            startedConnect()
            await pending
          }
        }
      }
    })

    const tick = fact.tick()
    await started
    await fact.final()
    finishConnect()
    await tick
    expect(sent.map(report => report.state)).toEqual(['connected', 'disconnected'])
    expect(sent[1].observedAt).toBeGreaterThan(sent[0].observedAt)
    expect(fact.reported()?.state).toBe('disconnected')
  })

  it('overlapping checks share one run', async () => {
    const { fact, sent } = setup()

    await Promise.all([fact.tick(), fact.tick(), fact.tick()])
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
