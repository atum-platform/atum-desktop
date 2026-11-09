import { afterEach, expect, it, vi } from 'vitest'

import { requestMatrixChatGptRelay } from './chatgpt-relay-client'

const resource = 'https://shell.test/api/matrix/v1'

afterEach(() => vi.unstubAllGlobals())

it.each(['enable', 'disable'] as const)('%s sends the JSON media type admitted by Shell', async action => {
  const body = { profile: 'atum.chatgpt-relay/1', requestId: 'synthetic' }

  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const request = new Request(url, init)
    expect(request.method).toBe('POST')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(request.headers.has('cookie')).toBe(false)
    expect(await request.json()).toEqual(body)

    return Response.json({ state: 'disabled' })
  })

  vi.stubGlobal('fetch', fetch)

  const answer = await requestMatrixChatGptRelay(resource, 'synthetic', action, AbortSignal.timeout(1000), body)
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toBe(`${resource}/chatgpt-relay/${action}`)
  expect(answer.status).toBe(200)
})

it('lets the account refresh an expired domain bearer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 }))
  )
  await expect(
    requestMatrixChatGptRelay(resource, 'synthetic', 'enable', AbortSignal.timeout(1000), {})
  ).rejects.toThrow('matrix_s1_authentication')
})
