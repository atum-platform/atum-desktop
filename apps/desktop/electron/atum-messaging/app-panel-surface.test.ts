import assert from 'node:assert/strict'

import { expect, test, vi } from 'vitest'

import { APP_PANEL_SURFACE_TTL_MS, AtumAppSurfacesClient, parseAppPanelSurface } from './app-surfaces'
import type { MessagingAccountSession } from './types'

const SESSION: MessagingAccountSession = {
  baseUrl: 'https://platform.example',
  tokens: { accessToken: 'test-token', expiresAt: null, refreshToken: 'test-refresh' },
  user: { displayName: 'Minh', handle: null, id: '00000000-0000-4000-8000-303617b97302' }
}

const SESSION_B: MessagingAccountSession = {
  ...SESSION,
  tokens: { ...SESSION.tokens, accessToken: 'test-token-b' },
  user: { ...SESSION.user, id: '00000000-0000-4000-8000-00f765af1c54' }
}

const SURFACE = {
  app: 'moon',
  composer_actions: [{ icon: 'calendar', id: 'book', label_en: 'Book', label_vi: 'Đặt lịch', path: '/book' }],
  panel_menu: [{ icon: 'starmap', id: 'chart', label_en: 'Chart', label_vi: 'Lá số', path: '/chart' }],
  web_origin: 'https://moon.example'
}

const SURFACE_B = { ...SURFACE, web_origin: 'https://moon-b.example' }

test('app panel surface validates the contract shape and bare https origin', () => {
  assert.deepEqual(parseAppPanelSurface(SURFACE), SURFACE)
  expect(() => parseAppPanelSurface({ ...SURFACE, web_origin: 'http://moon.example' })).toThrow('app_panel_surface_invalid')
  expect(() => parseAppPanelSurface({ ...SURFACE, panel_menu: [{ ...SURFACE.panel_menu[0], path: '//evil.example' }] })).toThrow('app_panel_surface_invalid')
})

test('app panel surface caches successful responses per app for a short TTL', async () => {
  let now = 10

  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(SURFACE), {
    headers: { 'content-type': 'application/json' },
    status: 200
  }))

  const client = new AtumAppSurfacesClient({
    fetchImpl: fetchImpl as typeof fetch,
    now: () => now,
    openExternal: async () => undefined,
    refresh: async () => null,
    session: () => SESSION
  })

  assert.deepEqual(await client.panelSurface('moon'), SURFACE)
  assert.deepEqual(await client.panelSurface('moon'), SURFACE)
  assert.equal(fetchImpl.mock.calls.length, 1)
  now += APP_PANEL_SURFACE_TTL_MS + 1
  await client.panelSurface('moon')
  assert.equal(fetchImpl.mock.calls.length, 2)
  assert.equal((fetchImpl.mock.calls as unknown as [string][])[0]?.[0], 'https://platform.example/api/desktop/v1/specialists/moon/surface')
})

test('app panel surface cache is scoped to the signed-in account', async () => {
  let current = SESSION

  const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization')
    const value = authorization === 'Bearer test-token-b' ? SURFACE_B : SURFACE

    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, status: 200 })
  })

  const client = new AtumAppSurfacesClient({
    fetchImpl: fetchImpl as typeof fetch,
    openExternal: async () => undefined,
    refresh: async () => null,
    session: () => current
  })

  assert.deepEqual(await client.panelSurface('moon'), SURFACE)
  current = SESSION_B
  assert.deepEqual(await client.panelSurface('moon'), SURFACE_B)
  assert.equal(fetchImpl.mock.calls.length, 2)
})

test('account revocation clears that account’s panel and connect-probe state', async () => {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    const body = url.endsWith('/connect/candidate') ? { status: 'available' } : SURFACE

    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status: 200 })
  })

  const client = new AtumAppSurfacesClient({
    fetchImpl: fetchImpl as typeof fetch,
    openExternal: async () => undefined,
    refresh: async () => null,
    session: () => SESSION
  })

  await client.panelSurface('moon')
  await client.connectCandidate('moon')
  client.revokeAccount({ accountId: SESSION.user.id, accountGeneration: 1 })
  await client.panelSurface('moon')
  await client.connectCandidate('moon')

  assert.equal(fetchImpl.mock.calls.length, 4)
})
