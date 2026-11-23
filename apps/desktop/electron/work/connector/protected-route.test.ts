import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { admitProtectedAnswer, protectedThreadsPath, protectedWorkRoute } from './protected-route'

describe('protected Work release', () => {
  it('requires a live managed route, a fenced thread and the same sidecar', async () => {
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
      expect(await admitProtectedAnswer('challenge', ports)).toBe(false)
      expect(callback).not.toHaveBeenCalled()
      served = true
      expect(await admitProtectedAnswer('challenge', ports)).toBe(false)

      callback.mockImplementationOnce(async request => {
        expect(String(request)).toBe(`${origin}/atum-work/connector/prepare`)
        mkdirSync(protectedThreadsPath(root), { recursive: true })

        return new Response(null, { status: 204 })
      })
      expect(await admitProtectedAnswer('challenge', ports)).toBe(true)
      expect(protectedWorkRoute(root)).toBe('protected')

      callback.mockImplementationOnce(async () => {
        origin = 'http://127.0.0.1:12346'

        return new Response(null, { status: 204 })
      })
      expect(await admitProtectedAnswer('challenge', ports)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
