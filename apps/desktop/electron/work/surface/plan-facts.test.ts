import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type PlanFactTarget, WorkPlanFacts } from './plan-facts'
import { createWorkConsentClient } from './platform'

const deviceServiceId = '00000000-0000-4000-8000-00000000d001'
const accountId = '00000000-0000-4000-8000-00000000a001'
const agent = '00000000-0000-4000-8000-00000000b001'
const roots: string[] = []
const models = [{ id: 'gpt-6.2-astra', displayName: 'GPT-6.2 Astra' }]

afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}
})

interface RequestBody {
  operation: string
  deviceServiceId: string
  routeEpoch: number
  provider: string
  observedAt: number
  state: string
}

function acknowledges(body: RequestBody) {
  const { deviceServiceId, provider, observedAt, state } = body

  return Response.json({ deviceServiceId, provider, observedAt, state, recordedAt: observedAt })
}

function fixture(reply: (body: RequestBody) => Response | Promise<Response> = acknowledges, publishedEpoch?: number) {
  const root = mkdtempSync(join(tmpdir(), 'plan-facts-'))
  roots.push(root)
  const bodies: RequestBody[] = []
  const fetcher = vi.fn<typeof fetch>(async (_, options) => {
    if (!options?.body) {
      const work = publishedEpoch === undefined ? undefined : { gateId: { accountId, deviceServiceId, routeEpoch: publishedEpoch } }

      return Response.json({ deviceServices: [{ deviceServiceId, work }] })
    }
    const body = JSON.parse(String(options.body)) as RequestBody
    bodies.push(body)

    return reply(body)
  })
  const target: PlanFactTarget = {
    account: { key: 'fixture', root, accountId }, deviceServiceId, home: join('/Users', 'fixture'),
    platform: { endpoint: 'https://example.test/device-services', bearer: async () => 'fixture-bearer', fetch: fetcher }
  }

  return { root, target, bodies, fetcher }
}

describe('native Work plan facts', () => {
  it.each([undefined, 5])('enrolls metadata for a reporting refusal, using the published epoch %s when available', async epoch => {
    const { root, target, bodies } = fixture(body => {
      if (body.operation === 'work_enroll') {return Response.json({ deviceServiceId, work: null })}

      return bodies.some(item => item.operation === 'work_enroll')
        ? acknowledges(body) : new Response(null, { status: epoch === undefined ? 404 : 409 })
    }, epoch)
    const reporter = new WorkPlanFacts(root)
    const read = async () => ({ codex: { state: 'connected' as const, models } })

    await reporter.refresh(target, read)
    await reporter.refresh(target, read)

    expect(bodies).toEqual([
      expect.objectContaining({ operation: 'work_subscription_report', routeEpoch: 1 }),
      {
        operation: 'work_enroll', deviceServiceId, socketPath: expect.stringMatching(/^\/Users\/fixture\/\.atum\/w\/[a-f0-9]{12}\/g$/u),
        gateId: { accountId, deviceServiceId, routeEpoch: epoch ?? 1 }
      },
      expect.objectContaining({ operation: 'work_subscription_report', routeEpoch: epoch ?? 1, accountId, models })
    ])
  })

  it('refreshes an unchanged plan after the device enrollment rotates', async () => {
    const { root, target, bodies } = fixture()
    const reporter = new WorkPlanFacts(root)
    const read = async () => ({ claude: { state: 'connected' as const } })

    await reporter.refresh({ ...target, enrollmentEpoch: 1 }, read)
    await reporter.refresh({ ...target, enrollmentEpoch: 1 }, read)
    expect(bodies).toHaveLength(1)

    await reporter.refresh({ ...target, enrollmentEpoch: 2 }, read)
    expect(bodies).toHaveLength(2)
    expect(bodies[1].observedAt).toBeGreaterThan(bodies[0].observedAt)
  })

  it('reads the old opt-out and epoch, withdraws every plan, and persists the next opt-in outside the ledger', async () => {
    const { root, target, bodies } = fixture()
    const legacy = join(root, 'work', 'gate')
    mkdirSync(legacy, { recursive: true })
    const path = join(legacy, 'ledger.sqlite')
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('route_epoch','7'), ('plan_fact_reporting','off')")
    db.close()

    const reporter = new WorkPlanFacts(root)
    const read = vi.fn(async () => ({ antigravity: { state: 'connected' as const } }))
    await reporter.refresh(target, read)

    expect(read).not.toHaveBeenCalled()
    expect(bodies.map(body => body.provider)).toEqual(['codex', 'claude', 'antigravity'])
    expect(bodies.every(body => body.state === 'disconnected' && body.routeEpoch === 7)).toBe(true)
    reporter.setEnabled(true)

    const restarted = new WorkPlanFacts(root)
    await restarted.refresh(target, read)
    expect(bodies.at(-1)).toMatchObject({ provider: 'antigravity', state: 'connected', routeEpoch: 7 })
    const history = new DatabaseSync(path, { readOnly: true })

    try {
      expect(history.prepare("SELECT v FROM meta WHERE k = 'plan_fact_reporting'").get()?.v).toBe('off')
    } finally {
      history.close()
    }
  })

  it('orders withdrawal after an in-flight report and retries an unacknowledged withdrawal', async () => {
    let finish!: () => void
    const inFlight = new Promise<void>(resolve => {finish = resolve})
    let refuseCodex = true
    const { root, target, bodies } = fixture(async body => {
      if (body.state === 'connected') {await inFlight}
      if (body.state === 'disconnected' && body.provider === 'codex' && refuseCodex) {
        return acknowledges({ ...body, state: 'connected', observedAt: body.observedAt - 1 })
      }

      return acknowledges(body)
    })
    const reporter = new WorkPlanFacts(root)
    const refresh = reporter.refresh(target, async () => ({ codex: { state: 'connected' } }))
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    reporter.setEnabled(false)
    const withdrawal = reporter.withdraw(target)
    expect(reporter.enabled()).toBe(false)
    finish()
    await refresh
    await expect(withdrawal).rejects.toThrow('work_plan_fact_report_failed')
    refuseCodex = false
    await reporter.refresh(target, async () => {throw new Error('unexpected native read')})

    const codex = bodies.filter(body => body.provider === 'codex')
    expect(codex.map(body => body.state)).toEqual(['connected', 'disconnected', 'disconnected'])
    expect(codex[2].observedAt).toBeGreaterThan(codex[1].observedAt)
  })

  it('reads provider-scoped consent with the platform model-object catalog', async () => {
    const consent = { provider: 'codex', state: 'on', agents: [agent], devices: [deviceServiceId], alsoWhenScheduled: true, revision: 4 }
    const facts = [{ provider: 'codex', deviceServiceId, status: 'connected', models }]
    const { target, bodies } = fixture(() => Response.json({ issuedAt: 10, consent, facts }))

    await expect(createWorkConsentClient(target.platform).read('codex')).resolves.toEqual({ issuedAt: 10, consent, facts })
    expect(bodies).toEqual([{ operation: 'work_subscription_read', provider: 'codex' }])
  })
})
