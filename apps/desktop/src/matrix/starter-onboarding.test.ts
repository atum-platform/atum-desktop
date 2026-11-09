import { createServer, type Server } from 'node:http'

import { ClientEvent, createClient, MatrixEvent, MemoryStore, SyncState } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_SYNC_GRACE_MS } from '../../shared/matrix-sync-health'

import { MATRIX_STARTER_MARKER, matrixStarterOnboarding } from './starter-onboarding'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) { await cleanup() } })

async function server() {
  const records = new Map<string, Record<string, unknown>>()
  const writes: string[] = []
  let failWrite = false
  let pauseRead: Promise<void> | undefined

  const http: Server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const match = path.match(/\/user\/([^/]+)\/account_data\/(.+)$/)

    if (!match || decodeURIComponent(match[2]!) !== MATRIX_STARTER_MARKER || request.headers.authorization !== 'Bearer disposable-test') {
      response.writeHead(403).end();

 return
    }

    const key = decodeURIComponent(match[1]!)
    response.setHeader('Content-Type', 'application/json')

    if (request.method === 'PUT') {
      writes.push(key)
      let body = ''

      for await (const part of request) { body += String(part) }

      if (failWrite) { response.writeHead(403).end(JSON.stringify({ errcode: 'M_FORBIDDEN' }));

 return }

      records.set(key, JSON.parse(body))
      response.end('{}');

 return
    }

    await pauseRead
    const value = records.get(key)
    response.writeHead(value ? 200 : 404).end(JSON.stringify(value ?? { errcode: 'M_NOT_FOUND', error: 'Not found' }))
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve() })
  })
  const port = (http.address() as { port: number }).port
  cleanups.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections() }))

  function device(userId = '@alice:test', deviceId = 'ONE') {
    const identity = { userId, deviceId }, store = new MemoryStore()

    const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, userId, deviceId,
      accessToken: 'disposable-test', store, fetchFn: fetch })

    let active = true
    const marker = matrixStarterOnboarding(client, identity, () => active, () => {}, () => 1234)
    cleanups.push(async () => { marker.stop(); client.stopClient() })

    return { identity, marker,
      sync: (state = SyncState.Syncing) => client.emit(ClientEvent.Sync, state, null),
      echo: (value = records.get(userId)) => { if (value) { store.storeAccountDataEvents([new MatrixEvent({ type: MATRIX_STARTER_MARKER, content: value })]) } },
      stop: () => { active = false; marker.stop() }
    }
  }

  return { records, writes, device, fail: (value: boolean) => { failWrite = value }, pause: (value: Promise<void>) => { pauseRead = value } }
}

it('uses actual SDK HTTP and account cache to acknowledge one account across devices and restart', async () => {
  const s = await server(), first = s.device(), second = s.device('@alice:test', 'TWO'), other = s.device('@bob:test')
  expect(first.marker.snapshot()).toBe('unknown')
  first.sync(SyncState.Prepared)
  expect(first.marker.snapshot()).toBe('unknown')
  first.sync(); second.sync(); other.sync()
  expect(first.marker.snapshot()).toBe('unseen')
  await first.marker.acknowledge(first.identity)
  expect(s.records.get('@alice:test')).toEqual({ v: 1, seenAt: 1234 })
  expect(first.marker.snapshot()).toBe('seen')
  second.echo()
  expect(second.marker.snapshot()).toBe('seen')
  const restarted = s.device('@alice:test', 'THREE'); restarted.echo(); restarted.sync()
  expect(restarted.marker.snapshot()).toBe('seen')
  expect(other.marker.snapshot()).toBe('unseen')
  await second.marker.acknowledge(second.identity)
  expect(s.writes).toEqual(['@alice:test'])
  first.sync(SyncState.Stopped)
  expect(first.marker.snapshot()).toBe('unknown')
})

it('keeps the acknowledgement through a reconnecting sync and loses it once the sync is down past its grace (R4)', async () => {
  const s = await server(), d = s.device()
  d.sync()
  expect(d.marker.snapshot()).toBe('unseen')

  d.sync(SyncState.Reconnecting)
  expect(d.marker.snapshot()).toBe('unseen')
  d.sync(SyncState.Catchup)
  expect(d.marker.snapshot()).toBe('unseen')
  d.sync()
  expect(d.marker.snapshot()).toBe('unseen')

  // An outage that outlasts its grace unsettles it by itself; only a real sync settles it again.
  vi.useFakeTimers()

  try {
    d.sync(SyncState.Error)
    expect(d.marker.snapshot()).toBe('unseen')
    await vi.advanceTimersByTimeAsync(MATRIX_SYNC_GRACE_MS)
    expect(d.marker.snapshot()).toBe('unknown')
    d.sync(SyncState.Catchup)
    expect(d.marker.snapshot()).toBe('unknown')
    d.sync()
    expect(d.marker.snapshot()).toBe('unseen')
  } finally {
    vi.useRealTimers()
  }
})

it('refuses future/malformed server records despite a stale unseen cache and preserves their bytes', async () => {
  const s = await server(), d = s.device(); d.sync()

  for (const value of [{ v: 2, seenAt: 1 }, { v: 1, seenAt: -1 }, { v: 1, seenAt: 'bad' }]) {
    s.records.set('@alice:test', value)
    await expect(d.marker.acknowledge(d.identity)).rejects.toThrow('readonly')
    expect(s.records.get('@alice:test')).toEqual(value)
  }

  d.echo({ v: 2, seenAt: 1 })
  expect(d.marker.snapshot()).toBe('unknown')
  expect(s.writes).toEqual([])
})

it('coalesces acknowledgement, retries failed real writes, and never substitutes a durable receipt', async () => {
  const s = await server(), d = s.device(); d.sync(); s.fail(true)
  const one = d.marker.acknowledge(d.identity), two = d.marker.acknowledge(d.identity)
  expect(two).toBe(one)
  await expect(one).rejects.toThrow()
  expect(d.marker.snapshot()).toBe('unseen')
  expect(s.records.has('@alice:test')).toBe(false)
  s.fail(false)
  await d.marker.acknowledge(d.identity)
  expect(d.marker.snapshot()).toBe('seen')
  expect(s.writes).toHaveLength(2)
})

it('refuses stale identities and a stopped SDK before mutation, including an in-flight read', async () => {
  const s = await server(), d = s.device(); d.sync()
  await expect(d.marker.acknowledge({ ...d.identity, deviceId: 'OTHER' })).rejects.toThrow('stale')
  let resume!: () => void
  s.pause(new Promise<void>(resolve => { resume = resolve }))
  const pending = d.marker.acknowledge(d.identity)
  d.stop(); resume()
  await expect(pending).rejects.toThrow('stale')
  expect(s.writes).toEqual([])
  expect(d.marker.snapshot()).toBe('unknown')
})

it('recognizes a remote acknowledgement during a fresh read and never overwrites its timestamp/extensions', async () => {
  const s = await server(), d = s.device(); d.sync()
  s.records.set('@alice:test', { v: 1, seenAt: 77, extension: 'preserved' })
  await d.marker.acknowledge(d.identity)
  expect(d.marker.snapshot()).toBe('seen')
  expect(s.records.get('@alice:test')).toEqual({ v: 1, seenAt: 77, extension: 'preserved' })
  expect(s.writes).toEqual([])
})
