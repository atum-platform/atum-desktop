import { describe, expect, it, vi } from 'vitest'

import { createOwnerRelay } from './relay'

const principal = '00000000-0000-4000-8000-00000000b001'
const catalog = { published: true, plans: { codex: { state: 'connected' as const } } }
const claude = { provider: 'atum-work', plan: 'claude', model: 'claude-opus-5-5' }
const codex = { provider: 'atum-work', plan: 'codex', model: 'gpt-6.2-astra' }
const read = { operation: 'work_selection_read', agentPrincipal: principal }

const write = (expectedRevision: number) => ({
  operation: 'work_selection_set', agentPrincipal: principal, expectedRevision, selection: codex
})

const NOW = 1_800_000_000_000
const laptop = '00000000-0000-4000-8000-0000000000a1'
const mini = '00000000-0000-4000-8000-0000000000a2'

/** The account's plan read for one plan (`work_subscription_read`): its consent and each Mac's fact. */
function accountRead(
  provider: 'codex' | 'claude' | 'antigravity',
  facts: readonly Record<string, unknown>[],
  devices: readonly string[] = []
) {
  return {
    issuedAt: NOW,
    consent: { provider, state: devices.length ? 'on' : 'off', agents: 'all', devices: [...devices], alsoWhenScheduled: false, revision: 1 },
    facts: facts.map(fact => ({ provider, ...fact }))
  }
}

/**
 * The device-services endpoint: selection reads and writes answer in order; the account's plan
 * reads answer by plan (absent is a 404, as for an account that reports no plans).
 */
function ownerRelay(replies: Response[], account: Partial<Record<string, unknown>> = {}, catalogValue: typeof catalog | Record<string, unknown> = catalog) {
  const queue = [...replies]

  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { operation: string; provider?: string }

    if (body.operation === 'work_subscription_read') {
      const reply = body.provider ? account[body.provider] : undefined

      return reply ? Response.json(reply) : new Response(null, { status: 404 })
    }

    return queue.shift() ?? new Response(null, { status: 500 })
  })

  const relay = createOwnerRelay(async () => catalogValue as typeof catalog, () => ({
    endpoint: 'https://example.test/device-services', bearer: async () => 'synthetic-test-bearer', fetch: fetcher
  }), () => NOW)

  return {
    relay,
    fetcher,
    requests: () => fetcher.mock.calls
      .map(([, init]) => JSON.parse(init?.body as string) as { operation: string })
      .filter(body => body.operation !== 'work_subscription_read')
  }
}

describe('owner plan selection', () => {
  it('restores the server selection and uses its revision after startup', async () => {
    const snapshot = { selection: claude, revision: 2 }
    const saved = { ...codex, revision: 3 }
    const { relay, requests } = ownerRelay([Response.json(snapshot), Response.json(snapshot), Response.json(saved)])

    expect(await relay.readPlans(principal)).toEqual({ ...catalog, selection: { ...claude, revision: 2 } })
    expect(await relay.select(principal, codex.model)).toEqual(saved)
    expect(requests()).toEqual([read, read, write(2)])
  })

  it.each([200, 409])('re-reads and retries a conflict once, then handles HTTP %s', async status => {
    const saved = { ...codex, revision: 4 }

    const { relay, requests } = ownerRelay([
      Response.json({ revision: 2, selection: claude }), new Response(null, { status: 409 }),
      Response.json({ revision: 3, selection: null }),
      status === 200 ? Response.json(saved) : new Response(null, { status })
    ])

    const select = relay.select(principal, codex.model)

    if (status === 200) {
      await expect(select).resolves.toEqual(saved)
    } else {
      await expect(select).rejects.toMatchObject({ status })
    }

    expect(requests()).toEqual([read, write(2), read, write(3)])
  })

  it('rejects malformed snapshots before attempting a write', async () => {
    const { relay, requests } = ownerRelay([Response.json({ selection: null })])

    await expect(relay.select(principal, codex.model)).rejects.toThrow()
    expect(requests()).toEqual([read])
  })

  it('does not retry a denied selection', async () => {
    const { relay, requests } = ownerRelay([
      Response.json({ revision: 0, selection: null }), new Response(null, { status: 403 })
    ])

    await expect(relay.select(principal, codex.model)).rejects.toMatchObject({ status: 403 })
    expect(requests()).toEqual([read, write(0)])
  })
})

describe('the owner\u2019s Macs on each plan', () => {
  const sol = { id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' }
  const opus = { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' }

  it('lists every Mac that reports a plan, on while it reported within the hour and off once it went quiet', async () => {
    const { relay } = ownerRelay([Response.json({ revision: 1, selection: null })], {
      codex: accountRead('codex', [
        { deviceServiceId: laptop, status: 'connected', observedAt: NOW - 5 * 60_000, displayName: 'MacBook Air', models: [sol] },
        { deviceServiceId: mini, status: 'connected', observedAt: NOW - 3 * 60 * 60_000, displayName: 'Mac mini', models: [sol] }
      ], [laptop, mini])
    })

    const plans = await relay.readPlans(principal)

    expect(plans?.machines?.codex).toEqual([
      { id: laptop, name: 'MacBook Air', kind: 'laptop', online: true, models: [sol.id] },
      { id: mini, name: 'Mac mini', kind: 'mac-mini', online: false, models: [sol.id] }
    ])
    expect(plans?.machines?.claude).toBeUndefined()
  })

  it('shows only the Macs the owner allowed once a plan is allowed on some', async () => {
    const { relay } = ownerRelay([Response.json({ revision: 1, selection: null })], {
      codex: accountRead('codex', [
        { deviceServiceId: laptop, status: 'connected', observedAt: NOW, displayName: 'MacBook Air' },
        { deviceServiceId: mini, status: 'connected', observedAt: NOW, displayName: 'Mac mini' }
      ], [mini])
    })

    expect((await relay.readPlans(principal))?.machines?.codex?.map(machine => machine.id)).toEqual([mini])
  })

  it('offers a plan another Mac serves while this Mac lacks it, and keeps this Mac\u2019s own catalog first', async () => {
    const { relay } = ownerRelay([Response.json({ revision: 1, selection: null })], {
      claude: accountRead('claude', [
        { deviceServiceId: mini, status: 'connected', observedAt: NOW, displayName: 'Mac mini', models: [opus] }
      ]),
      codex: accountRead('codex', [
        { deviceServiceId: mini, status: 'connected', observedAt: NOW, displayName: 'Mac mini', models: [{ id: 'other', displayName: 'Other' }] }
      ])
    }, { published: true, plans: { codex: { state: 'connected', models: [sol] } } })

    const plans = await relay.readPlans(principal)

    expect(plans?.plans.claude).toEqual({ state: 'connected', models: [opus] })
    expect(plans?.plans.codex).toEqual({ state: 'connected', models: [sol] })
  })

  it('still reads the selection when the account\u2019s plan facts cannot be read', async () => {
    const { relay } = ownerRelay([Response.json({ revision: 2, selection: claude })])

    expect(await relay.readPlans(principal)).toEqual({ ...catalog, selection: { ...claude, revision: 2 } })
  })
})

describe('a thinking level with a plan selection', () => {
  it('offers levels only once the platform advertises them, and writes the chosen level with the model', async () => {
    const saved = { ...codex, effort: 'high', revision: 3 }

    const { relay, requests, fetcher } = ownerRelay([
      Response.json({ revision: 2, selection: { ...codex, effort: 'low' }, efforts: ['low', 'medium', 'high'] }),
      Response.json({ revision: 2, selection: null }),
      Response.json(saved)
    ])

    const plans = await relay.readPlans(principal)

    expect(plans?.efforts).toEqual(['low', 'medium', 'high'])
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('x-atum-work-selection-effort')).toBe('1')
    expect(plans?.selection).toEqual({ ...codex, effort: 'low', revision: 2 })
    expect(await relay.select(principal, codex.model, 'codex', 'high')).toEqual(saved)
    expect(requests().at(-1)).toEqual({ ...write(2), selection: { ...codex, effort: 'high' } })
  })

  it('writes no level when none was chosen, so today\u2019s platform takes the pick unchanged', async () => {
    const { relay, requests } = ownerRelay([Response.json({ revision: 0, selection: null }), Response.json({ ...codex, revision: 1 })])

    await relay.select(principal, codex.model)

    expect(requests()).toEqual([read, write(0)])
    expect((await ownerRelay([Response.json({ revision: 0, selection: null })]).relay.readPlans(principal))?.efforts).toBeUndefined()
  })
})

