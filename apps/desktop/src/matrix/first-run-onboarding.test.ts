import { createServer, type Server } from 'node:http'

import { ClientEvent, createClient, MatrixEvent, MemoryStore, SyncState } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_SYNC_GRACE_MS } from '../../shared/matrix-sync-health'

import { MATRIX_FIRST_RUN_MARKER, MATRIX_FIRST_RUN_WELCOME, matrixFirstRunOnboarding } from './first-run-onboarding'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

/** A homeserver's account-data endpoints for the two first-run records, over real HTTP. */
async function server() {
  // The folder answer (v1) and the welcome's record (v2), by account.
  const records = new Map<string, Record<string, unknown>>()
  const welcomes = new Map<string, Record<string, unknown>>()
  const writes: string[] = []
  const welcomeWrites: string[] = []
  let failWrite = false
  // Only the welcome's own record refuses: the folder answer lands and the second write does not.
  let failWelcomeWrite = false

  const http: Server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const match = path.match(/\/user\/([^/]+)\/account_data\/(.+)$/)
    const type = match ? decodeURIComponent(match[2]!) : undefined

    if (
      !match ||
      (type !== MATRIX_FIRST_RUN_MARKER && type !== MATRIX_FIRST_RUN_WELCOME) ||
      request.headers.authorization !== 'Bearer disposable-test'
    ) {
      response.writeHead(403).end()

      return
    }

    const key = decodeURIComponent(match[1]!)
    const store = type === MATRIX_FIRST_RUN_WELCOME ? welcomes : records
    response.setHeader('Content-Type', 'application/json')

    if (request.method === 'PUT') {
      ;(type === MATRIX_FIRST_RUN_WELCOME ? welcomeWrites : writes).push(key)
      let body = ''

      for await (const part of request) {
        body += String(part)
      }

      if (failWrite || (failWelcomeWrite && type === MATRIX_FIRST_RUN_WELCOME)) {
        response.writeHead(403).end(JSON.stringify({ errcode: 'M_FORBIDDEN' }))

        return
      }

      store.set(key, JSON.parse(body))
      response.end('{}')

      return
    }

    const value = store.get(key)
    response.writeHead(value ? 200 : 404).end(JSON.stringify(value ?? { errcode: 'M_NOT_FOUND', error: 'Not found' }))
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })

  const port = (http.address() as { port: number }).port

  cleanups.push(
    () =>
      new Promise<void>(resolve => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
  )

  function device(userId = '@alice:test', deviceId = 'ONE') {
    const identity = { userId, deviceId }
    const store = new MemoryStore()

    const client = createClient({
      baseUrl: `http://127.0.0.1:${port}`,
      userId,
      deviceId,
      accessToken: 'disposable-test',
      store,
      fetchFn: fetch
    })

    const marker = matrixFirstRunOnboarding(client, identity, () => true, () => {}, () => 4321)

    cleanups.push(async () => {
      marker.stop()
      client.stopClient()
    })

    return {
      identity,
      marker,
      sync: (state = SyncState.Syncing) => client.emit(ClientEvent.Sync, state, null),
      echo: (value = records.get(userId)) => {
        if (value) {
          store.storeAccountDataEvents([new MatrixEvent({ type: MATRIX_FIRST_RUN_MARKER, content: value })])
        }
      },
      // The welcome record arriving over sync, as another device (or this one) wrote it.
      echoWelcome: (value = welcomes.get(userId)) => {
        if (value) {
          store.storeAccountDataEvents([new MatrixEvent({ type: MATRIX_FIRST_RUN_WELCOME, content: value })])
        }
      }
    }
  }

  return {
    records,
    welcomes,
    writes,
    welcomeWrites,
    device,
    fail: (value: boolean) => (failWrite = value),
    failWelcome: (value: boolean) => (failWelcomeWrite = value)
  }
}

it('records one answer for the account, so no device of theirs offers again', async () => {
  const s = await server()
  const first = s.device()
  const second = s.device('@alice:test', 'TWO')
  const other = s.device('@bob:test')

  // Never a new account before the first sync.
  expect(first.marker.snapshot()).toBe('unknown')
  first.sync()
  second.sync()
  other.sync()
  expect(first.marker.snapshot()).toBe('unseen')

  await first.marker.answer(first.identity, 'allowed', 'done')
  expect(s.records.get('@alice:test')).toEqual({ v: 1, folders: 'allowed', at: 4321 })
  expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'done', at: 4321 })
  expect(first.marker.snapshot()).toBe('answered')

  second.echo()
  second.echoWelcome()
  expect(second.marker.snapshot()).toBe('answered')
  expect(second.marker.welcome()).toBe('done')
  // Answering again elsewhere keeps the first answer, in both records.
  await second.marker.answer(second.identity, 'declined', 'dismissed')
  expect(s.records.get('@alice:test')).toEqual({ v: 1, folders: 'allowed', at: 4321 })
  expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'done', at: 4321 })
  expect(s.writes).toEqual(['@alice:test'])
  expect(s.welcomeWrites).toEqual(['@alice:test'])
  expect(other.marker.snapshot()).toBe('unseen')
  expect(other.marker.welcome()).toBe('unseen')
})

it('never replaces an answer already on the server, even one this build cannot read', async () => {
  const s = await server()
  const device = s.device()
  device.sync()
  s.records.set('@alice:test', { v: 2, folders: 'some-day' })

  await device.marker.answer(device.identity, 'declined')
  expect(s.records.get('@alice:test')).toEqual({ v: 2, folders: 'some-day' })
  expect(s.writes).toEqual([])
  expect(device.marker.snapshot()).toBe('answered')
  // The welcome still ends: that record is the welcome's own, whatever the folder answer holds.
  expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'dismissed', at: 4321 })

  const fresh = s.device('@alice:test', 'TWO')
  fresh.echo({ v: 2 })
  fresh.sync()
  expect(fresh.marker.snapshot()).toBe('answered')
})

it('keeps offering when the write fails, and refuses another account or a stale device', async () => {
  const s = await server()
  const device = s.device()
  device.sync()
  s.fail(true)

  await expect(device.marker.answer(device.identity, 'allowed')).rejects.toThrow()
  expect(device.marker.snapshot()).toBe('unseen')

  s.fail(false)
  await expect(device.marker.answer({ userId: '@bob:test', deviceId: 'ONE' }, 'allowed')).rejects.toThrow('stale')
  await expect(device.marker.answer({ userId: '@alice:test', deviceId: 'OTHER' }, 'allowed')).rejects.toThrow('stale')
  await device.marker.answer(device.identity, 'declined')
  expect(s.records.get('@alice:test')).toEqual({ v: 1, folders: 'declined', at: 4321 })
  expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'dismissed', at: 4321 })
})

it('stays settled through a reconnecting sync and unsettles only once the sync is down past its grace (R4)', async () => {
  const s = await server()
  const device = s.device()
  device.sync()
  expect(device.marker.snapshot()).toBe('unseen')

  device.sync(SyncState.Reconnecting)
  expect(device.marker.snapshot()).toBe('unseen')
  device.sync(SyncState.Catchup)
  expect(device.marker.snapshot()).toBe('unseen')

  vi.useFakeTimers()

  try {
    device.sync()
    device.sync(SyncState.Error)
    expect(device.marker.snapshot()).toBe('unseen')
    await vi.advanceTimersByTimeAsync(MATRIX_SYNC_GRACE_MS)
    expect(device.marker.snapshot()).toBe('unknown')
    device.sync()
    expect(device.marker.snapshot()).toBe('unseen')
  } finally {
    vi.useRealTimers()
  }
})

describe("the welcome's own record (conversational first run)", () => {
  it('is unknown before the first sync and unseen for an account nobody has evaluated', async () => {
    const s = await server()
    const device = s.device()

    expect(device.marker.welcome()).toBe('unknown')
    await expect(device.marker.settle(device.identity, 'open')).rejects.toThrow('unavailable')
    device.sync()
    expect(device.marker.welcome()).toBe('unseen')
    // The folder answer is a different record: it says nothing about the welcome.
    s.records.set('@alice:test', { v: 1, folders: 'declined', at: 1 })
    device.echo()
    expect(device.marker.snapshot()).toBe('answered')
    expect(device.marker.welcome()).toBe('unseen')
  })

  it('opens the welcome for a new account, once, and it is still open after a reload and on every device', async () => {
    const s = await server()
    const first = s.device()
    const phone = s.device('@alice:test', 'TWO')
    first.sync()
    phone.sync()

    await first.marker.settle(first.identity, 'open')
    expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'open', at: 4321 })
    // This device follows its own write at once, before the account data echoes back.
    expect(first.marker.welcome()).toBe('open')
    // Settling again changes nothing and writes nothing.
    await first.marker.settle(first.identity, 'open')
    expect(s.welcomeWrites).toEqual(['@alice:test'])

    // Another device, and a reload of this one (a fresh client that only has the synced account data).
    phone.echoWelcome()
    expect(phone.marker.welcome()).toBe('open')
    const reloaded = s.device()
    reloaded.echoWelcome()
    reloaded.sync()
    expect(reloaded.marker.welcome()).toBe('open')
    // The first reply never changes it: only the person's answer does.
    expect(reloaded.marker.snapshot()).toBe('unseen')
  })

  it('writes done for an account that already exists, and nothing reopens it', async () => {
    const s = await server()
    const device = s.device()
    device.sync()

    await device.marker.settle(device.identity, 'done')
    expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'done', at: 4321 })
    expect(device.marker.welcome()).toBe('done')

    // A later evaluation, from this device or another, never replaces a terminal record.
    await device.marker.settle(device.identity, 'open')

    const other = s.device('@alice:test', 'TWO')
    other.sync()
    await other.marker.settle(other.identity, 'open')
    expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'done', at: 4321 })
    expect(s.welcomeWrites).toEqual(['@alice:test'])
    expect(other.marker.welcome()).toBe('done')
  })

  it('lets a record another device already wrote stand, even one this device has not synced yet', async () => {
    const s = await server()
    const device = s.device()
    device.sync()
    s.welcomes.set('@alice:test', { v: 2, state: 'dismissed', at: 99 })
    expect(device.marker.welcome()).toBe('unseen')

    await device.marker.settle(device.identity, 'open')
    expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'dismissed', at: 99 })
    expect(s.welcomeWrites).toEqual([])
    expect(device.marker.welcome()).toBe('dismissed')
  })

  it("never lets another device's evaluation close an open welcome; only the person's answer ends it", async () => {
    const s = await server()
    const device = s.device()
    device.sync()
    // Mac A opened the welcome for this new account; Mac B has not synced that record yet and judges
    // the account existing.
    s.welcomes.set('@alice:test', { v: 2, state: 'open', at: 99 })
    expect(device.marker.welcome()).toBe('unseen')

    await device.marker.settle(device.identity, 'done')
    expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'open', at: 99 })
    expect(s.welcomeWrites).toEqual([])
    expect(device.marker.welcome()).toBe('open')
  })

  it('keeps both legacy terminal states stable, and only the first ending stands', async () => {
    const s = await server()
    const notNow = s.device('@alice:test')
    const finished = s.device('@bob:test')
    notNow.sync()
    finished.sync()

    await notNow.marker.settle(notNow.identity, 'open')
    await notNow.marker.answer(notNow.identity, 'declined', 'dismissed')
    expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'dismissed', at: 4321 })
    expect(s.records.get('@alice:test')).toEqual({ v: 1, folders: 'declined', at: 4321 })
    expect(notNow.marker.welcome()).toBe('dismissed')

    await finished.marker.settle(finished.identity, 'open')
    await finished.marker.answer(finished.identity, 'declined', 'done')
    expect(s.welcomes.get('@bob:test')).toEqual({ v: 2, state: 'done', at: 4321 })
    expect(finished.marker.welcome()).toBe('done')

    // Answering again, in any way, keeps the ending that is there.
    await notNow.marker.answer(notNow.identity, 'allowed', 'done')
    expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'dismissed', at: 4321 })
  })

  it('reads a record this build cannot read as ended, never as an offer', async () => {
    const s = await server()
    const device = s.device()
    device.echoWelcome({ v: 3, state: 'open' })
    device.sync()
    expect(device.marker.welcome()).toBe('done')

    // A record with no version, or one this build does not know, is not an offer either.
    const garbled = s.device('@bob:test')
    s.welcomes.set('@bob:test', { state: 'open' })
    garbled.echoWelcome()
    garbled.sync()
    expect(garbled.marker.welcome()).toBe('done')
  })

  it('keeps the welcome open when ending it could not be recorded, and ends it on the retry', async () => {
    const s = await server()
    const device = s.device()
    device.sync()
    await device.marker.settle(device.identity, 'open')

    s.fail(true)
    await expect(device.marker.answer(device.identity, 'declined', 'dismissed')).rejects.toThrow()
    expect(device.marker.welcome()).toBe('open')
    expect(device.marker.snapshot()).toBe('unseen')

    s.fail(false)
    await device.marker.answer(device.identity, 'declined', 'dismissed')
    expect(device.marker.welcome()).toBe('dismissed')
    expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'dismissed', at: 4321 })
    expect(s.records.get('@alice:test')).toEqual({ v: 1, folders: 'declined', at: 4321 })
  })

  it('closes the first run for every reader even when only the second write fails: the folder answer lands first', async () => {
  const s = await server()
  const device = s.device()
  const phone = s.device('@alice:test', 'PHONE')
  device.sync()
  phone.sync()
  await device.marker.settle(device.identity, 'open')

  s.failWelcome(true)
  await expect(device.marker.answer(device.identity, 'declined', 'dismissed')).rejects.toThrow()
  // The record every build reads is written, so this device, an older Mac and the phone all stop
  // offering; the welcome's own record is left `open`, which nothing offers without an unanswered folder answer.
  expect(s.records.get('@alice:test')).toEqual({ v: 1, folders: 'declined', at: 4321 })
  expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'open', at: 4321 })
  expect(device.marker.snapshot()).toBe('answered')
  phone.echo()
  expect(phone.marker.snapshot()).toBe('answered')

  // A retry ends the welcome too, and writes the folder answer nowhere twice.
  s.failWelcome(false)
  await device.marker.answer(device.identity, 'declined', 'dismissed')
  expect(s.welcomes.get('@alice:test')).toEqual({ v: 2, state: 'dismissed', at: 4321 })
  expect(s.writes).toEqual(['@alice:test'])
  expect(device.marker.welcome()).toBe('dismissed')
})

it('refuses another account, a stale device and an unknown state', async () => {
  const s = await server()
  const device = s.device()
  device.sync()

  await expect(device.marker.settle({ userId: '@bob:test', deviceId: 'ONE' }, 'open')).rejects.toThrow('stale')
  await expect(device.marker.settle({ userId: '@alice:test', deviceId: 'OTHER' }, 'open')).rejects.toThrow('stale')
  await expect(device.marker.settle(device.identity, 'dismissed' as 'open')).rejects.toThrow('invalid')
  await expect(device.marker.answer(device.identity, 'declined', 'open' as 'done')).rejects.toThrow('invalid')
  expect(s.welcomeWrites).toEqual([])
})

it('goes unknown again once the sync is down past its grace, like the folder answer', async () => {
  const s = await server()
  const device = s.device()
  device.sync()
  expect(device.marker.welcome()).toBe('unseen')

  vi.useFakeTimers()

  try {
    device.sync()
    device.sync(SyncState.Error)
    await vi.advanceTimersByTimeAsync(MATRIX_SYNC_GRACE_MS)
    expect(device.marker.welcome()).toBe('unknown')
    device.sync()
    expect(device.marker.welcome()).toBe('unseen')
  } finally {
    vi.useRealTimers()
  }
})
})
