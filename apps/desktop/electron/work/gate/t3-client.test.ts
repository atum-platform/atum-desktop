import { describe, expect, it } from 'vitest'

import { createT3Client } from './t3-client'

describe('the T3 client\'s thread list', () => {
  it('always names every project: T3 answers `target_required` to a client that is not inside a thread otherwise', async () => {
    const bodies: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }[] = []

    const fetchStub = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))

      return new Response(JSON.stringify({ result: { structuredContent: { threads: [], nextCursor: null, total: 0 } } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' }
      })
    }) as unknown as typeof fetch

    const client = createT3Client({
      origin: () => 'http://127.0.0.1:1',
      incarnation: () => 'i',
      settingsFile: '/nonexistent',
      delegated: { instanceId: 'a', model: 'b' },
      fetch: fetchStub
    })

    const reply = await client.list('token', { limit: 50 })
    const call = bodies.find(body => body.method === 'tools/call')

    expect(reply).toMatchObject({ transport: 'ok', isError: false })
    expect(call?.params).toMatchObject({ name: 't3_thread_list', arguments: { limit: 50, allProjects: true } })
  })
})
