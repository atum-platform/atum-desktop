import { expect, it, vi } from 'vitest'
import { requestNativeT3 } from './native-t3'

it('uses the domain base and owner bearer without cookies', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ tools: [] }))
  const signal = new AbortController().signal
  expect(await requestNativeT3('fixture', 'https://shell.test', signal, request, 'agent', '/tools', 'GET')).toEqual({ tools: [] })
  expect(request).toHaveBeenCalledWith('https://shell.test/api/host/native-t3', expect.objectContaining({
    method: 'POST', credentials: 'omit', redirect: 'error', signal,
    headers: expect.objectContaining({ Authorization: 'Bearer fixture', 'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0' }),
    body: JSON.stringify({ agent: 'agent', path: '/tools', method: 'GET' })
  }))
})

it.each([401, 403, 503])('preserves the refresh signal only on 401 (%s)', async status => {
  const request = vi.fn().mockResolvedValue(new Response('{}', { status }))
  await expect(requestNativeT3('fixture', 'https://shell.test', new AbortController().signal, request, 'agent', '/tools', 'GET'))
    .rejects.toThrow(status === 401 ? 'matrix_s1_authentication' : 'native_profile_unavailable')
})
