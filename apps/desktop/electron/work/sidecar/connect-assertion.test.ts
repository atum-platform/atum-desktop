import { describe, expect, it, vi } from 'vitest'

import { fetchConnectAssertion } from './connect-assertion'

describe('Connect assertion issuer', () => {
  it('uses the native authenticated route and returns only the assertion', async () => {
    const signal = AbortSignal.timeout(1000)
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ assertion: 'signed', access_token: 'must-stay-in-host' }))
    await expect(fetchConnectAssertion('fixture-bearer', 'https://platform.test/resource', signal, request)).resolves.toBe('signed')
    expect(request).toHaveBeenCalledWith('https://platform.test/api/work/connect/assertion', {
      method: 'POST', redirect: 'error', cache: 'no-store', signal,
      headers: { Authorization: 'Bearer fixture-bearer' }
    })
  })
  it('signals s1Request to refresh a rejected MAS session and rejects malformed replies', async () => {
    const request = vi.fn<typeof fetch>()

    for (const [response, error] of [
      [new Response('', { status: 401 }), 'matrix_s1_authentication'],
      [new Response('', { status: 500 }), 'work_connect_assertion_unavailable'],
      [Response.json({ assertion: '' }), 'work_connect_assertion_invalid'],
      [Response.json({ access_token: 'fixture' }), 'work_connect_assertion_invalid']
    ] as const) {
      request.mockResolvedValueOnce(response)
      await expect(fetchConnectAssertion('fixture', 'https://platform.test', AbortSignal.timeout(1000), request)).rejects.toThrow(error)
    }
  })
})
