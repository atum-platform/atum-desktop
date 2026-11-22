import { describe, expect, it, vi } from 'vitest'

import type { WorkMount } from '../mount/mount'

import { createOwnerRelay } from './relay'

const principal = '00000000-0000-4000-8000-00000000b001'
const account = { issuedAt: 1, consent: { provider: 'codex' as const, state: 'off' as const, agents: [], devices: [], alsoWhenScheduled: false, revision: 0 }, facts: [] }

describe('owner relay adapter', () => {
  it('reads account facts even when this Mac has no running gate', async () => {
    const relay = createOwnerRelay({ service: () => undefined } as unknown as WorkMount, { read: async () => account }, () => { throw new Error('unused') })
    expect(await relay.read(principal, '!dm:test')).toEqual({ account, status: null, turns: [] })
    expect(relay.chats()).toEqual([])
    await expect(relay.stop('!dm:test', '$owner')).rejects.toThrow('work_relay_unavailable')
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
