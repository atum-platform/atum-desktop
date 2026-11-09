/**
 * An agent's SDK takes its host's renewed token without a gap (launch checklist G1-12,
 * G1-30; stream RT, slice 2): the host renews the executor's credential ahead of its
 * expiry and says so (`renewed`); a request the server refused in between asks the host
 * too, and both share one answer.
 */
import { createClient, HttpApiEvent, type MatrixClient, Method, TokenRefreshError } from 'matrix-js-sdk'
import type * as MatrixSdk from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixRefreshResult } from '../../shared/matrix'

import { startMatrixSdk } from './sdk'

vi.mock('matrix-js-sdk', async importOriginal => {
  const actual = await importOriginal<typeof MatrixSdk>()

  return {
    ...actual,
    createClient: vi.fn(),
    IndexedDBStore: class extends actual.MemoryStore {
      async startup() {}
      async save() {}
    }
  }
})

const stops: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop()
  }

  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function fixture(refresh: (handle: string) => Promise<MatrixRefreshResult>, refreshToken?: string) {
  const actual = await vi.importActual<typeof MatrixSdk>('matrix-js-sdk')

  const client = actual.createClient({
    baseUrl: 'https://matrix.test',
    userId: '@agent:test',
    deviceId: 'AGENT',
    accessToken: 'old-token',
    ...(refreshToken ? { refreshToken } : {})
  })

  vi.mocked(createClient).mockReturnValue(client)
  vi.stubGlobal('indexedDB', {})
  vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined)
  vi.spyOn(client, 'getCrypto').mockReturnValue({ globalBlacklistUnverifiedDevices: false } as unknown as ReturnType<
    MatrixClient['getCrypto']
  >)
  vi.spyOn(client, 'startClient').mockResolvedValue(undefined)
  vi.spyOn(client, 'stopClient').mockImplementation(() => {})
  const retry = vi.spyOn(client, 'retryImmediately').mockReturnValue(true)
  const host = vi.fn(refresh)

  const sdk = await startMatrixSdk(
    {
      baseUrl: 'https://matrix.test',
      userId: '@agent:test',
      deviceId: 'AGENT',
      accessToken: 'old-token',
      ...(refreshToken ? { refreshToken } : {}),
      storageKey: btoa('0'.repeat(32))
    },
    host,
    () => {}
  )

  stops.push(sdk.stop)
  const options = vi.mocked(createClient).mock.calls.at(-1)![0]

  return { client, sdk, host, retry, tokenRefreshFunction: options.tokenRefreshFunction }
}

it("takes the host's renewed token at once and resumes a waiting sync, keeping its device", async () => {
  const f = await fixture(async () => ({ ok: true, accessToken: 'new-token', refreshToken: 'handle' }), 'handle')
  const deviceId = f.client.getDeviceId()
  expect(deviceId).toBe('AGENT')

  await expect(f.sdk.renewed()).resolves.toBe(true)

  expect(f.host).toHaveBeenCalledWith('handle')
  expect(f.client.getAccessToken()).toBe('new-token')
  expect(f.retry).toHaveBeenCalledOnce()
  expect(f.client.getDeviceId()).toBe(deviceId)
})

it('changes nothing when the host has no newer token, or when it has no refresh handle', async () => {
  const refused = await fixture(async () => ({ ok: false, reauthenticate: false }), 'handle')
  await expect(refused.sdk.renewed()).resolves.toBe(false)
  expect(refused.client.getAccessToken()).toBe('old-token')
  expect(refused.retry).not.toHaveBeenCalled()

  const human = await fixture(async () => ({ ok: true, accessToken: 'never', refreshToken: 'x' }))
  await expect(human.sdk.renewed()).resolves.toBe(false)
  expect(human.host).not.toHaveBeenCalled()
  expect(human.client.getAccessToken()).toBe('old-token')
})

it('shares one question to the host between a refused request and the renewal notice', async () => {
  let answer!: (value: MatrixRefreshResult) => void

  const f = await fixture(
    () =>
      new Promise<MatrixRefreshResult>(resolve => {
        answer = resolve
      }),
    'handle'
  )

  // A request refused mid-rotation asks through the SDK's token refresh, and the host's
  // notice arrives while that question is still out.
  const refused = f.tokenRefreshFunction!('handle')
  const renewed = f.sdk.renewed()
  answer({ ok: true, accessToken: 'new-token', refreshToken: 'handle' })

  await expect(refused).resolves.toMatchObject({ accessToken: 'new-token', refreshToken: 'handle' })
  await expect(renewed).resolves.toBe(true)
  expect(f.host).toHaveBeenCalledOnce()
})

it('reports no expiry to the SDK, so a refused old token is never mistaken for a sign-out', async () => {
  const f = await fixture(
    async () => ({ ok: true, accessToken: 'new-token', refreshToken: 'handle', expiresAt: undefined }),
    'handle'
  )

  const tokens = await f.tokenRefreshFunction!('handle')
  expect(tokens).toEqual({ accessToken: 'new-token', refreshToken: 'handle' })
  expect(tokens).not.toHaveProperty('expiry')
})

it('stops asking once stopped', async () => {
  const f = await fixture(async () => ({ ok: true, accessToken: 'new-token', refreshToken: 'handle' }), 'handle')
  await f.sdk.stop()
  stops.splice(0)

  await expect(f.sdk.renewed()).resolves.toBe(false)
  expect(f.host).not.toHaveBeenCalled()
})

/**
 * The same hand-off through matrix-js-sdk's own TokenRefresher (no mocked client): a request
 * refused with the revoked old token asks the host once and is retried with the new token,
 * the client keeps it, and nothing reads as a sign-out.
 */
async function realClient(refresh: (handle: string) => Promise<MatrixRefreshResult>) {
  const actual = await vi.importActual<typeof MatrixSdk>('matrix-js-sdk')
  const seen: string[] = []

  const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const token = String(new Headers(init?.headers).get('authorization') ?? '').replace('Bearer ', '')
    seen.push(token)

    return token === 'new-token'
      ? Response.json({ user_id: '@agent:test', device_id: 'AGENT' })
      : Response.json({ errcode: 'M_UNKNOWN_TOKEN', error: 'Token is not active' }, { status: 401 })
  })

  let client!: MatrixClient

  vi.mocked(createClient).mockImplementation(options => {
    client = actual.createClient({ ...options, fetchFn })
    vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined)
    vi.spyOn(client, 'getCrypto').mockReturnValue({ globalBlacklistUnverifiedDevices: false } as unknown as ReturnType<
      MatrixClient['getCrypto']
    >)
    vi.spyOn(client, 'startClient').mockResolvedValue(undefined)
    vi.spyOn(client, 'stopClient').mockImplementation(() => {})

    return client
  })

  vi.stubGlobal('indexedDB', {})
  const host = vi.fn(refresh)

  const sdk = await startMatrixSdk(
    {
      baseUrl: 'https://matrix.test',
      userId: '@agent:test',
      deviceId: 'AGENT',
      accessToken: 'old-token',
      refreshToken: 'handle',
      storageKey: btoa('0'.repeat(32))
    },
    host,
    () => {}
  )

  stops.push(sdk.stop)
  const signedOut = vi.fn()
  client.on(HttpApiEvent.SessionLoggedOut, signedOut)

  return { client, sdk, host, seen, signedOut }
}

it("retries a request refused with the old token once, with the host's new token, and stays signed in", async () => {
  const f = await realClient(async () => ({ ok: true, accessToken: 'new-token', refreshToken: 'handle' }))
  const deviceId = f.client.getDeviceId()
  expect(deviceId).toBe('AGENT')

  await expect(f.client.http.authedRequest(Method.Get, '/account/whoami')).resolves.toMatchObject({
    user_id: '@agent:test'
  })

  expect(f.seen).toEqual(['old-token', 'new-token'])
  expect(f.host).toHaveBeenCalledExactlyOnceWith('handle')
  expect(f.client.getAccessToken()).toBe('new-token')
  expect(f.client.getDeviceId()).toBe(deviceId)
  expect(f.signedOut).not.toHaveBeenCalled()
})

it('fails only that request, never signing out, when the host has nothing newer', async () => {
  const f = await realClient(async () => ({ ok: false, reauthenticate: false }))

  await expect(f.client.http.authedRequest(Method.Get, '/account/whoami')).rejects.toBeInstanceOf(TokenRefreshError)

  expect(f.host).toHaveBeenCalledOnce()
  expect(f.signedOut).not.toHaveBeenCalled()
  expect(f.client.getAccessToken()).toBe('old-token')
})

it('asks nothing more of the host when a renewal already swapped the token under a refused request', async () => {
  let answer!: (value: MatrixRefreshResult) => void

  const f = await realClient(
    () =>
      new Promise<MatrixRefreshResult>(resolve => {
        answer = resolve
      })
  )

  // The host's notice and a request already in flight with the old token.
  const renewed = f.sdk.renewed()
  const request = f.client.http.authedRequest(Method.Get, '/account/whoami')
  answer({ ok: true, accessToken: 'new-token', refreshToken: 'handle' })

  await expect(renewed).resolves.toBe(true)
  await expect(request).resolves.toMatchObject({ user_id: '@agent:test' })
  expect(f.host).toHaveBeenCalledOnce()
  expect(f.signedOut).not.toHaveBeenCalled()
})
