import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHermesPagesTransport } from './hermes-pages-transport'

afterEach(() => vi.unstubAllGlobals())

describe('native Hermes pages profile resolution', () => {
  it.each(['default', 'agent-a'])(
    'uses Hermes catalog ownership for %s, not sticky active or a renderer selector',
    async name => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              profiles: [
                { name: 'other', path: '/different/home' },
                { name, path: '/owned/home' }
              ]
            })
          )
        )
        .mockImplementation(async () => new Response('[]'))

      vi.stubGlobal('fetch', fetchMock)
      const pages = createHermesPagesTransport(12345, 'synthetic', '/owned/home', new AbortController().signal)
      await pages({ path: '/api/cron/jobs?profile=default', method: 'GET' })
      await pages({ path: '/api/cron/jobs?profile=default', method: 'POST', body: { prompt: 'fixture' } })
      expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
        'http://127.0.0.1:12345/api/profiles',
        `http://127.0.0.1:12345/api/cron/jobs?profile=${name}`,
        `http://127.0.0.1:12345/api/cron/jobs?profile=${name}`
      ])
    }
  )
  it.each([
    [],
    [{ name: 'default', path: '/different' }],
    [{ name: 'all', path: '/owned/home' }],
    [
      { name: 'default', path: '/owned/home' },
      { name: 'ambiguous', path: '/owned/home' }
    ]
  ])('refuses missing, foreign, aggregate and ambiguous bindings', async profiles => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ profiles })))
    vi.stubGlobal('fetch', fetchMock)
    const pages = createHermesPagesTransport(12345, 'synthetic', '/owned/home', new AbortController().signal)
    await expect(pages({ path: '/api/cron/jobs?profile=default', method: 'POST', body: {} })).rejects.toThrow(
      'pages_profile_unavailable'
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('allows a fresh read after a failed catalog lookup, but never retries a write', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('private failure', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ profiles: [{ name: 'default', path: '/owned/home' }] })))
      .mockResolvedValueOnce(new Response('private failure', { status: 503 }))

    vi.stubGlobal('fetch', fetchMock)
    const pages = createHermesPagesTransport(12345, 'synthetic', '/owned/home', new AbortController().signal)
    const input = { path: '/api/cron/jobs?profile=default', method: 'POST', body: {} }
    await expect(pages(input)).rejects.toMatchObject({ message: 'pages_request_failed', httpStatus: 503 })
    await expect(pages(input)).rejects.toMatchObject({ message: 'pages_request_failed', httpStatus: 503 })
    expect(fetchMock.mock.calls.map(call => call[1].method)).toEqual(['GET', 'GET', 'POST'])
  })
})
