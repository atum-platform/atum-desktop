import { describe, expect, it, vi } from 'vitest'

import type { WorkMount } from '../mount/mount'

import { createOwnerRelay } from './relay'

const principal = '00000000-0000-4000-8000-00000000b001'
const catalog = { published: true, plans: { codex: { state: 'connected' as const } } }

describe('owner plan selection', () => {
  it('reads the existing revision from the local ledger even when the gate route is unavailable', async () => {
    const selection = { provider: 'atum-work', plan: 'codex', model: 'test-model', revision: 7 }
    const meta = vi.fn(() => JSON.stringify([{ agentPrincipal: principal, selection }]))
    const mount = { service: () => ({ ledger: { meta } }) } as unknown as WorkMount
    const relay = createOwnerRelay(mount, async () => catalog, () => { throw new Error('unused') })

    expect(await relay.readPlans(principal)).toEqual({ ...catalog, selection })
    expect(meta).toHaveBeenCalledWith('relay_selections')
  })

  it('writes the exact 1.3 selection through the existing endpoint and rejects malformed replies', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ operation: 'work_selection_set', agentPrincipal: principal, expectedRevision: 7, selection: { provider: 'atum-work', plan: 'codex', model: 'test-model' } })

      return new Response(JSON.stringify({ provider: 'atum-work', plan: 'codex', model: 'test-model', revision: 8 }), { status: 200 })
    })

    const relay = createOwnerRelay({ service: () => undefined } as unknown as WorkMount, async () => catalog, () => ({ endpoint: 'https://example.test/device-services', bearer: async () => 'synthetic-test-bearer', fetch: fetcher as typeof fetch }))
    expect(await relay.select(principal, 7, 'test-model')).toMatchObject({ revision: 8 })
    expect(await relay.readPlans(principal)).toEqual({ ...catalog, selection: { provider: 'atum-work', plan: 'codex', model: 'test-model', revision: 8 } })
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(relay.select(principal, 7, 'test-model')).rejects.toThrow()
  })
})
