import { describe, expect, it, vi } from 'vitest'

import { ACCOUNT_CONNECTIONS_FIXTURE, ACCOUNT_CONNECTIONS_PROFILE } from '../../../shared/account-connections'
import { accountPickerPlans, accountPlanRow } from '../../../src/app/connections/view'

import { readAccountConnections } from './account-connections'
import { projectPlanCapabilities } from './plan-capabilities'

const THIS_MAC = '11111111-1111-4111-8111-11111111abcd'

function deps(reply: () => Promise<Response>, endpoint: string | null = 'https://atum.test/api/matrix/v1/device-services') {
  const fetch = vi.fn(reply)

  return {
    fetch,
    deps: {
      endpoint: () => endpoint ?? undefined,
      bearer: async () => 'owner-bearer',
      thisDevice: () => THIS_MAC,
      localCapabilities: vi.fn(async () => ({ codex: { state: 'connected' as const, models: [{ id: 'gpt-6', displayName: 'GPT-6' }] } })),
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 9
    }
  }
}

const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status })

describe('readAccountConnections', () => {
  it('reads the registry with the owner’s bearer on the device-services endpoint', async () => {
    const { deps: d, fetch } = deps(json({ profile: ACCOUNT_CONNECTIONS_PROFILE, connections: ACCOUNT_CONNECTIONS_FIXTURE.connections }))
    const view = await readAccountConnections(d)

    expect(view.source).toBe('account')
    expect(view.thisDevice).toBe(THIS_MAC)
    expect(view.connections.map(row => row.id)).toContain('google')
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ operation: 'account_connections_read' })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer owner-bearer')
    expect(d.localCapabilities).toHaveBeenCalledOnce()
  })

  it('derives the agent picker and This Mac from Work when the registry omits Antigravity', async () => {
    const { deps: d } = deps(json({ profile: ACCOUNT_CONNECTIONS_PROFILE, connections: ACCOUNT_CONNECTIONS_FIXTURE.connections }))
    const native = {
      instanceId: 'antigravity', driver: 'antigravity', enabled: true, installed: true, status: 'ready',
      auth: { status: 'authenticated', type: 'oauth-personal' },
      models: [{ slug: 'gemini-test', name: 'Gemini Test', isCustom: false }]
    }
    const view = await readAccountConnections({ ...d, localCapabilities: async () => projectPlanCapabilities([native]) })
    expect(accountPlanRow(view, 'antigravity')).toMatchObject({ here: true, state: 'connected' })
    expect(accountPickerPlans(view)).toContainEqual({
      plan: 'antigravity', kind: 'relay', models: [{ id: 'gemini-test', displayName: 'Gemini Test' }]
    })

    const signedOut = await readAccountConnections({
      ...d,
      fetch: json({ profile: ACCOUNT_CONNECTIONS_PROFILE, connections: view.connections }),
      localCapabilities: async () => projectPlanCapabilities([{ ...native, auth: { status: 'unauthenticated' } }])
    })
    expect(accountPickerPlans(signedOut)).toContainEqual({ plan: 'antigravity', kind: 'connect' })
  })

  it('keeps other Macs when Work signs this Mac out', async () => {
    const { deps: d } = deps(json({ profile: ACCOUNT_CONNECTIONS_PROFILE, connections: ACCOUNT_CONNECTIONS_FIXTURE.connections }))
    const view = await readAccountConnections({ ...d, thisDevice: () => '22222222-2222-4222-8222-22222222abcd',
      localCapabilities: async () => ({ codex: { state: 'disconnected' } })
    })

    expect(accountPlanRow(view, 'codex')).toMatchObject({ here: false, state: 'connected' })
  })

  it.each([
    ['the route is not deployed yet', json({ error: 'invalid' }, 400)],
    ['the reply is not the contract', json({ profile: ACCOUNT_CONNECTIONS_PROFILE, connections: [{ id: 'codex' }] })],
    ['the network is down', async () => { throw new TypeError('fetch failed') }]
  ])('falls back to this Mac’s own plan facts when %s', async (_why, reply) => {
    const { deps: d } = deps(reply as () => Promise<Response>)
    const view = await readAccountConnections(d)

    expect(view.source).toBe('this_mac')
    expect(view.connections.find(row => row.id === 'codex')).toMatchObject({
      status: 'connected',
      devices: [{ deviceServiceId: THIS_MAC, status: 'connected' }],
      models: [{ id: 'gpt-6', displayName: 'GPT-6' }]
    })
    expect(view.connections.some(row => row.custody === 'cloud')).toBe(false)
  })

  it('does not call the platform with no endpoint (signed out of the platform)', async () => {
    const { deps: d, fetch } = deps(json({}), null)

    expect((await readAccountConnections(d)).source).toBe('this_mac')
    expect(fetch).not.toHaveBeenCalled()
  })
})
