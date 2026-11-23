import { expect, it, vi } from 'vitest'

import { admitConnector } from './admission'

it('checks the challenge and caller on the same live Work sidecar', async () => {
  const caller = { threadId: 'thread', providerSessionId: 'session', providerInstanceId: 'provider', admission: 'challenge' }
  let origin = 'http://127.0.0.1:12345'

  const callback = vi.fn<typeof fetch>(async (request, init) => {
    expect(String(request)).toBe(`${origin}/atum-work/connector/prepare`)
    const headers = new Headers(init?.headers)
    expect(headers.get('x-atum-work-admission')).toBe(caller.admission)
    expect(headers.get('x-atum-work-caller')).toBe(
      Buffer.from(JSON.stringify(['thread', 'session', 'provider'])).toString('base64url')
    )

    return new Response(null, { status: 204 })
  })

  const ports = {
    origin: () => origin,
    current: () => true,
    signal: new AbortController().signal,
    secret: 'fixture',
    fetch: callback
  }

  expect(await admitConnector({ ...caller, admission: undefined }, ports)).toBe(false)
  expect(callback).not.toHaveBeenCalled()
  expect(await admitConnector(caller, ports)).toBe(true)
  callback.mockResolvedValueOnce(new Response(null, { status: 409 }))
  expect(await admitConnector(caller, ports)).toBe(false)
  callback.mockImplementationOnce(async () => {
    origin = 'http://127.0.0.1:12346'

    return new Response(null, { status: 204 })
  })
  expect(await admitConnector(caller, ports)).toBe(false)
})
