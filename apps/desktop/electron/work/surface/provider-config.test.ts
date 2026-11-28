import { afterEach, expect, it, vi } from 'vitest'

import { readWorkProviders } from './provider-config'

afterEach(() => vi.unstubAllGlobals())

it('asks Work to re-probe its native providers on the periodic refresh', async () => {
  const providers = [{ driver: 'antigravity', auth: { status: 'authenticated', type: 'oauth-personal' } }]
  const send = vi.fn()

  class Socket extends EventTarget {
    constructor() {
      super()
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }

    send(raw: string) {
      send(JSON.parse(raw))
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: { providers } }
      }) }))
    }

    close() {}
  }

  vi.stubGlobal('WebSocket', Socket)
  const owner = { fetch: vi.fn(async () => Response.json({ ticket: 'fixture' })) }

  expect(await readWorkProviders('http://127.0.0.1:8137', owner, true)).toEqual(providers)
  expect(send).toHaveBeenCalledExactlyOnceWith({
    _tag: 'Request', id: '1', tag: 'server.refreshProviders', payload: {}, headers: []
  })
})
