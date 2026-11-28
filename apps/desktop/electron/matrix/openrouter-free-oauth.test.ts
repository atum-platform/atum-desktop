import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { authorizeOpenRouterFree } from './openrouter-free-oauth'

describe('Atum Free authorization', () => {
  it('validates the loopback state and exchanges a capped PKCE code in main', async () => {
    let challenge: string | null = null
    const fixtureKey = 'sk-or-v1-' + 'f'.repeat(64)
    const exchange = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://openrouter.ai/api/v1/auth/keys')
      const body = JSON.parse(String(init?.body))
      expect(body.code).toBe('offline-code')
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge)
      return Response.json({ key: fixtureKey })
    })
    const result = await authorizeOpenRouterFree({
      signal: AbortSignal.timeout(5_000),
      fetchImpl: exchange,
      openExternal: async link => {
        const auth = new URL(link)
        expect(auth.searchParams.get('limit')).toBe('0.01')
        expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
        challenge = auth.searchParams.get('code_challenge')
        const callback = new URL(auth.searchParams.get('callback_url')!)
        expect(callback.hostname).toBe('127.0.0.1')
        callback.searchParams.set('code', 'offline-code')
        const invalid = await fetch(callback)
        expect(invalid.status).toBe(400)
        await invalid.text()
        callback.searchParams.set('state', auth.searchParams.get('state')!)
        await (await fetch(callback)).text()
      }
    })
    expect(result).toBe(fixtureKey)
    expect(exchange).toHaveBeenCalledTimes(1)
  })
})
