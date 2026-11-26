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

function ownerRelay(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>()

  for (const reply of replies) {fetcher.mockResolvedValueOnce(reply)}

  const relay = createOwnerRelay(async () => catalog, () => ({
    endpoint: 'https://example.test/device-services', bearer: async () => 'synthetic-test-bearer', fetch: fetcher
  }))

  return { relay, requests: () => fetcher.mock.calls.map(([, init]) => JSON.parse(init?.body as string)) }
}

describe('owner plan selection', () => {
  it('restores the server selection and uses its revision after startup', async () => {
    const snapshot = { selection: claude, revision: 2 }
    const saved = { ...codex, revision: 3 }
    const { relay, requests } = ownerRelay(Response.json(snapshot), Response.json(snapshot), Response.json(saved))

    expect(await relay.readPlans(principal)).toEqual({ ...catalog, selection: { ...claude, revision: 2 } })
    expect(await relay.select(principal, codex.model)).toEqual(saved)
    expect(requests()).toEqual([read, read, write(2)])
  })

  it.each([200, 409])('re-reads and retries a conflict once, then handles HTTP %s', async status => {
    const saved = { ...codex, revision: 4 }

    const { relay, requests } = ownerRelay(
      Response.json({ revision: 2, selection: claude }), new Response(null, { status: 409 }),
      Response.json({ revision: 3, selection: null }),
      status === 200 ? Response.json(saved) : new Response(null, { status })
    )

    const select = relay.select(principal, codex.model)

    if (status === 200) {
      await expect(select).resolves.toEqual(saved)
    } else {
      await expect(select).rejects.toMatchObject({ status })
    }

    expect(requests()).toEqual([read, write(2), read, write(3)])
  })

  it('rejects malformed snapshots before attempting a write', async () => {
    const { relay, requests } = ownerRelay(Response.json({ selection: null }))

    await expect(relay.select(principal, codex.model)).rejects.toThrow()
    expect(requests()).toEqual([read])
  })

  it('does not retry a denied selection', async () => {
    const { relay, requests } = ownerRelay(
      Response.json({ revision: 0, selection: null }), new Response(null, { status: 403 })
    )

    await expect(relay.select(principal, codex.model)).rejects.toMatchObject({ status: 403 })
    expect(requests()).toEqual([read, write(0)])
  })
})
