import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { admitConnector, protectedThreadsPath, protectedWorkRoute } from './protected-route'

describe('protected Work release', () => {
  it('requires a live managed route, a fenced thread and the same sidecar', async () => {
    const caller = { threadId: 'thread', providerSessionId: 'session', providerInstanceId: 'provider', admission: 'challenge' }
    const root = mkdtempSync(join(tmpdir(), 'atum-work-release-'))
    let origin = 'http://127.0.0.1:12345'
    let served = false
    const callback = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))

    const ports = {
      origin: () => origin,
      current: () => true,
      servesProtectedRoute: async () => served,
      route: () => protectedWorkRoute(root),
      signal: new AbortController().signal,
      secret: 'fixture',
      fetch: callback
    }

    try {
      expect(await admitConnector(caller, true, ports)).toBeUndefined()
      expect(callback).not.toHaveBeenCalled()
      callback.mockResolvedValueOnce(new Response(null, { status: 202 }))
      expect(await admitConnector(caller, false, ports)).toEqual({ protected: false })
      served = true
      expect(await admitConnector(caller, true, ports)).toBeUndefined()

      callback.mockImplementationOnce(async (request, init) => {
        expect(String(request)).toBe(`${origin}/atum-work/connector/prepare`)
        expect(new Headers(init?.headers).get('x-atum-work-action')).toBe('protect')
        expect(new Headers(init?.headers).get('x-atum-work-caller')).toBe(
          Buffer.from(JSON.stringify(['thread', 'session', 'provider'])).toString('base64url')
        )
        mkdirSync(protectedThreadsPath(root), { recursive: true })

        return new Response(null, { status: 204 })
      })
      expect(await admitConnector(caller, true, ports)).toEqual({ protected: true })
      expect(protectedWorkRoute(root)).toBe('protected')

      callback.mockImplementationOnce(async () => {
        origin = 'http://127.0.0.1:12346'

        return new Response(null, { status: 204 })
      })
      expect(await admitConnector(caller, true, ports)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
