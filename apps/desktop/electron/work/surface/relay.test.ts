import { describe, expect, it, vi } from 'vitest'

import type { WorkMount } from '../mount/mount'

import { createOwnerRelay } from './relay'

const principal = '00000000-0000-4000-8000-00000000b001'
const account = { issuedAt: 1, consent: { provider: 'codex' as const, state: 'off' as const, agents: [], devices: [], alsoWhenScheduled: false, revision: 0 }, facts: [] }

function mounted(service: unknown): WorkMount {
  return { service: () => service } as WorkMount
}

describe('owner relay adapter', () => {
  it('bounds an optional plan timeout without delaying the working catalog forever', async () => {
    vi.useFakeTimers()
    try {
      const relay = createOwnerRelay(mounted(undefined), { read: async (plan = 'codex') => {
        if (plan === 'claude') {return new Promise<never>(() => {})}
        return { ...structuredClone(account), facts: [{ provider: plan, deviceServiceId: 'mac', status: 'connected' as const }] }
      } }, () => { throw new Error('unused') })
      const pending = relay.read(principal, '!dm:test')
      await vi.advanceTimersByTimeAsync(4000)
      expect((await pending).account.facts.map(fact => fact.provider)).toEqual(['codex', 'antigravity'])
    } finally { vi.useRealTimers() }
  })
  it('keeps each working plan when another optional plan fails', async () => {
    const relay = createOwnerRelay(mounted(undefined), { read: async (plan = 'codex') => {
      if (plan === 'claude') {throw new Error('offline')}
      return { ...structuredClone(account), facts: [{ provider: plan, deviceServiceId: 'mac', status: 'connected' as const, models: ['native-model'] }] }
    } }, () => { throw new Error('unused') })
    const view = await relay.read(principal, '!dm:test')
    expect(view.account.facts.map(fact => fact.provider)).toEqual(['codex', 'antigravity'])
  })

  it('keeps a working Claude plan even when the Codex read fails', async () => {
    const relay = createOwnerRelay(mounted(undefined), { read: async (plan = 'codex') => {
      if (plan !== 'claude') {throw new Error('unavailable')}
      return { ...structuredClone(account), facts: [{ provider: plan, deviceServiceId: 'mac', status: 'connected' as const }] }
    } }, () => { throw new Error('unused') })
    expect((await relay.read(principal, '!dm:test')).account.facts).toHaveLength(1)
  })

  it('keeps account facts when the room gate cannot answer', async () => {
    const relay = createOwnerRelay(mounted({ ledger: { agent: () => ({ entitled: true }), routeEpoch: () => 1 },
      gate: { state: () => ({ agents: [] }), relay: { status: async () => { throw new Error('offline') } } } }),
      { read: async () => structuredClone(account) }, () => { throw new Error('unused') })
    expect(await relay.read(principal, '!dm:test')).toMatchObject({ account, status: null, turns: [] })
  })
  it('reads account facts even when this Mac has no running gate', async () => {
    const relay = createOwnerRelay({ service: () => undefined } as unknown as WorkMount, { read: async () => account }, () => { throw new Error('unused') })
    expect(await relay.read(principal, '!dm:test')).toEqual({ account, status: null, turns: [] })
    expect(relay.chats()).toEqual([])
    await expect(relay.stop('!dm:test', '$owner')).rejects.toThrow('work_relay_unavailable')
  })

  it('keeps account availability when a newly created agent is not enrolled on this Mac', async () => {
    const relay = createOwnerRelay(mounted({ ledger: { agent: () => undefined }, gate: { state: () => ({ agents: [] }) } }),
      { read: async () => structuredClone(account) }, () => { throw new Error('unused') })

    expect(await relay.read(principal, '!dm:test')).toMatchObject({ account, status: null, turns: [] })
  })

  it('extends active grants to newly synced owner agents for every relay plan without reviving revoked grants', async () => {
    const set = vi.fn(async input => ({ ...input, state: 'on', revision: 2 }))

    const relay = createOwnerRelay(mounted({ ledger: { agent: () => undefined },
      gate: { state: () => ({ agents: [{ principal, entitled: true }, { principal: 'foreign', entitled: false }] }) } }),
      { read: async (plan = 'codex') => ({ ...structuredClone(account), consent: { ...account.consent,
        provider: plan, state: plan === 'codex' ? 'off' : 'on', devices: ['mac'] } }), set },
      () => { throw new Error('unused') })

    await relay.read(principal, '!dm:test')
    expect(set.mock.calls.map(([input]) => input.provider)).toEqual(['claude', 'antigravity'])

    for (const [input] of set.mock.calls) {
      expect(input).toMatchObject({ agents: [principal], devices: ['mac'], alsoWhenScheduled: false })
    }
  })

  it('writes the exact 1.3 selection through the existing endpoint and rejects malformed replies', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ operation: 'work_selection_set', agentPrincipal: principal, expectedRevision: 7, selection: { provider: 'atum-work', plan: 'codex', model: 'test-model' } })

      return new Response(JSON.stringify({ provider: 'atum-work', plan: 'codex', model: 'test-model', revision: 8 }), { status: 200 })
    })

    const relay = createOwnerRelay({ service: () => undefined } as unknown as WorkMount, { read: async () => account }, () => ({ endpoint: 'https://example.test/device-services', bearer: async () => 'synthetic-test-bearer', fetch: fetcher as typeof fetch }))
    expect(await relay.select(principal, 7, 'test-model')).toMatchObject({ revision: 8 })
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(relay.select(principal, 7, 'test-model')).rejects.toThrow()
  })
})
