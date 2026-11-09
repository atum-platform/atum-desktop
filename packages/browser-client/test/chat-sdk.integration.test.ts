import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import type { MatrixSnapshot } from '../../../apps/desktop/shared/matrix'
import { TestHomeserver } from '../../../apps/desktop/src/matrix/test-homeserver'
import { startChatRuntime, type ChatRuntime } from '../src/chat-runtime'
import type { BoundDevice } from '../src/session'

const stopped: ChatRuntime[] = []
afterEach(async () => {
  await Promise.all(stopped.splice(0).map(runtime => runtime.stop()))
  vi.unstubAllGlobals()
})

// Real matrix-js-sdk, IndexedDB and protocol traffic, without the desktop command
// dispatcher or Rust crypto. This does not claim real cloud execution acceptance.
it('sends and reloads a plain human/agent transcript without crypto, recovery or verification setup', async () => {
  const owner = '@web-proof:atum.test'
  const deviceId = `WEB_${crypto.randomUUID()}`
  const server = new TestHomeserver(owner)
  const token = server.signIn(deviceId)
  let explicitRetryAttempts = 0
  const local = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key)
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname.endsWith('/web-stable-retry')) {
      explicitRetryAttempts++
      if (explicitRetryAttempts === 1)
        return new Response(JSON.stringify({ errcode: 'M_UNAVAILABLE', error: 'fixture network failure' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
    }
    return server.fetch(input, init)
  })
  const created = await server.fetch(`${server.baseUrl}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      creation_content: { type: 'io.atum.assistant' },
      initial_state: [{ type: 'm.room.member', state_key: '@agent:atum.test', content: { membership: 'join' } }]
    })
  })
  const { room_id: roomId } = await created.json()
  const device = {
    configuration: () => ({
      baseUrl: server.baseUrl,
      userId: owner,
      deviceId,
      accessToken: token,
      storageKey: btoa('x'.repeat(32))
    }),
    sdkStarted: vi.fn(async () => {}),
    refresh: vi.fn()
  } as unknown as BoundDevice
  let snapshot: MatrixSnapshot | undefined
  const start = () => {
    const runtime = startChatRuntime(device, value => {
      snapshot = value
    })
    stopped.push(runtime)
    return runtime
  }
  const first = start()
  expect(first).not.toHaveProperty('command')
  expect(first).not.toHaveProperty('setUpRecovery')
  await first.ready
  await vi.waitFor(() => expect(snapshot?.state).toBe('ready'), { timeout: 15000 })
  await vi.waitFor(
    () => expect(snapshot?.rooms.some(room => room.id === roomId && room.plainAgent && !room.encrypted)).toBe(true),
    { timeout: 15000 }
  )
  await first.select(roomId)
  const id = await first.send(roomId, 'Browser question', 'web-stable-1')
  await vi.waitFor(() =>
    expect(snapshot?.messages.some(message => message.id === id && message.body === 'Browser question')).toBe(true)
  )
  expect(await first.send(roomId, 'Browser question', 'web-stable-1')).toBe(id)
  expect(snapshot?.messages.filter(message => message.body === 'Browser question')).toHaveLength(1)
  await expect(first.send(roomId, 'Explicit retry', 'web-stable-retry')).rejects.toThrow()
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(explicitRetryAttempts).toBe(1)
  const retriedId = await first.send(roomId, 'Explicit retry', 'web-stable-retry')
  expect(explicitRetryAttempts).toBe(2)
  await vi.waitFor(() =>
    expect(snapshot?.messages.filter(message => message.id === retriedId && message.body === 'Explicit retry')).toHaveLength(1)
  )
  expect((await indexedDB.databases()).some(database => database.name?.includes('crypto'))).toBe(false)
  await first.stop()
  await expect(first.send(roomId, 'Too late', 'web-stable-2')).rejects.toThrow('signed_out')
  const second = start()
  await second.ready
  await vi.waitFor(() => expect(snapshot?.state).toBe('ready'), { timeout: 15000 })
  await second.select(roomId)
  await vi.waitFor(
    () =>
      expect(
        snapshot?.messages.some(
          message => message.id === id && message.body === 'Browser question' && !message.encrypted
        )
      ).toBe(true),
    { timeout: 15000 }
  )
  expect(device.sdkStarted).toHaveBeenCalledTimes(2)
  expect((await indexedDB.databases()).some(database => database.name?.includes('crypto'))).toBe(false)
}, 40000)
