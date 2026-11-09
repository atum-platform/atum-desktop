import { EventEmitter } from 'node:events'

import { ClientEvent, createClient, type MatrixClient, MatrixEvent, SyncState } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MATRIX_GOOGLE_FENCE_ACCOUNT_DATA,
  type MatrixGoogleFenceObservation,
  parseMatrixGoogleFence
} from '../../shared/matrix-google-fence'
import { MATRIX_SYNC_GRACE_MS } from '../../shared/matrix-sync-health'

import { matrixGoogleFencePublisher, observeMatrixGoogleFence } from './google-fence'

const identity = { userId: '@owner:test', deviceId: 'DEVICE' }

it('uses the real Matrix client HTTP prefix and owner path for a fresh read and exact fence PUT', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push({ url: request.url, method: request.method,
      body: request.method === 'PUT' ? await request.json() : null })
    return request.method === 'GET'
      ? Response.json({ errcode: 'M_NOT_FOUND', error: 'No account data' }, { status: 404 })
      : Response.json({})
  }
  const client = createClient({ baseUrl: 'https://matrix.example', userId: identity.userId,
    deviceId: identity.deviceId, accessToken: 'fixture-access', fetchFn })
  const publish = matrixGoogleFencePublisher(client, identity, () => true)
  const receipt = await publish(identity)
  const url = 'https://matrix.example/_matrix/client/v3/user/%40owner%3Atest/account_data/io.atum.google_fence'
  expect(requests).toEqual([{ url, method: 'GET', body: null }, { url, method: 'PUT', body: receipt }])
  expect(client.getAccountData(MATRIX_GOOGLE_FENCE_ACCOUNT_DATA)).toBeUndefined()
});

function publisherFixture(raw: unknown = undefined) {
  let active = true
  const read = vi.fn().mockImplementation(async () => {
    if (raw === undefined) { throw { errcode: 'M_NOT_FOUND' } }
    return raw
  })
  const write = vi.fn().mockResolvedValue({})
  const cache = vi.fn().mockReturnValue(undefined)
  const client = { http: { authedRequest: read }, setAccountDataRaw: write, getAccountData: cache,
    getUserId: () => identity.userId, getDeviceId: () => identity.deviceId } as unknown as MatrixClient
  return { read, write, cache, retire: () => { active = false },
    publish: matrixGoogleFencePublisher(client, identity, () => active) }
}

it('fresh-reads before publishing exactly v1/since and preserves a valid older fence', async () => {
  const f = publisherFixture()
  const result = await f.publish(identity)
  expect(result.v).toBe(1)
  expect(result.since).toBeGreaterThan(0)
  expect(f.read.mock.calls[0][1]).toContain('/user/%40owner%3Atest/account_data/io.atum.google_fence')
  expect(f.write).toHaveBeenCalledWith(MATRIX_GOOGLE_FENCE_ACCOUNT_DATA, result)
  expect(Object.keys(result)).toEqual(['v', 'since'])
  const old = publisherFixture({ v: 1, since: 1 })
  await expect(old.publish(identity)).resolves.toEqual({ v: 1, since: 1 })
  expect(old.write).not.toHaveBeenCalled()
})

it('refuses malformed/newer state and network failure without overwriting it', async () => {
  for (const raw of [{}, { v: 2, since: 1 }, { v: 1, since: 1, extra: true }, null]) {
    const f = publisherFixture(raw)
    await expect(f.publish(identity)).rejects.toThrow('readonly')
    expect(f.write).not.toHaveBeenCalled()
  }
  const f = publisherFixture()
  f.read.mockRejectedValueOnce({ errcode: 'M_FORBIDDEN', secret: 'never returned' })
  await expect(f.publish(identity)).rejects.toThrow('matrix_google_fence_unavailable')
  expect(f.write).not.toHaveBeenCalled()
})

it('retains an earlier cached boundary without forging its sync projection', async () => {
  const f = publisherFixture({ v: 1, since: 50 })
  const cached = new MatrixEvent({ type: MATRIX_GOOGLE_FENCE_ACCOUNT_DATA, content: { v: 1, since: 20 } })
  f.cache.mockReturnValue(cached)
  await expect(f.publish(identity)).resolves.toEqual({ v: 1, since: 20 })
  expect(f.write).toHaveBeenCalledWith(MATRIX_GOOGLE_FENCE_ACCOUNT_DATA, { v: 1, since: 20 })
  expect(cached.getContent()).toEqual({ v: 1, since: 20 })
})

it('rejects foreign identity and retirement during read/write, and coalesces no hidden retries', async () => {
  const f = publisherFixture()
  await expect(f.publish({ ...identity, deviceId: 'FOREIGN' })).rejects.toThrow('stale')
  expect(f.read).not.toHaveBeenCalled()
  let finish!: (value: unknown) => void
  f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = f.publish(identity)
  await expect(f.publish(identity)).rejects.toThrow('pending')
  f.retire()
  finish({ v: 1, since: 2 })
  await expect(pending).rejects.toThrow('stale')
  expect(f.write).not.toHaveBeenCalled()
  const writing = publisherFixture()
  writing.write.mockImplementationOnce(async () => { writing.retire(); return {} })
  await expect(writing.publish(identity)).rejects.toThrow('stale')
  expect(writing.write).toHaveBeenCalledOnce()
})

class FenceClient extends EventEmitter {
  private event: MatrixEvent | undefined

  getAccountData(type: string): MatrixEvent | undefined {
    return type === MATRIX_GOOGLE_FENCE_ACCOUNT_DATA ? this.event : undefined
  }

  set(content: unknown) {
    this.event = new MatrixEvent({ type: MATRIX_GOOGLE_FENCE_ACCOUNT_DATA, content: content as Record<string, unknown> })
  }

  remove() {
    this.event = undefined
  }

  sync(state: SyncState) {
    this.emit(ClientEvent.Sync, state, null, null)
  }

  accountData(content: unknown) {
    this.set(content)
    this.emit(ClientEvent.AccountData, this.event, undefined)
  }
}

function fixture() {
  const raw = new FenceClient()
  const observations: MatrixGoogleFenceObservation[] = []
  const dispose = observeMatrixGoogleFence(raw as unknown as MatrixClient, observation => observations.push(observation))

  return { raw, observations, dispose }
}

it('strictly parses only the frozen v1 Google fence account-data shape', () => {
  expect(parseMatrixGoogleFence({ v: 1, since: 0 })).toEqual({ v: 1, since: 0 })
  expect(parseMatrixGoogleFence({ v: 1, since: Number.MAX_SAFE_INTEGER })).toEqual({ v: 1, since: Number.MAX_SAFE_INTEGER })
  expect(parseMatrixGoogleFence({ v: 1, since: 1, extra: true })).toBeNull()

  for (const value of [undefined, null, [], {}, { v: 2, since: 1 }, { v: 1, since: -1 }, { v: 1, since: 1.5 }, { v: 1, since: Infinity }]) {
    expect(parseMatrixGoogleFence(value)).toBeNull()
  }
})

it('keeps cached account data unknown until SYNCING proves a completed network view', () => {
  const f = fixture()
  f.raw.set({ v: 1, since: 30 })

  expect(f.observations).toEqual([{ state: 'unknown' }])
  f.raw.sync(SyncState.Prepared)
  expect(f.observations).toEqual([{ state: 'unknown' }, { state: 'unknown' }])

  f.raw.sync(SyncState.Syncing)
  expect(f.observations).toEqual([{ state: 'unknown' }, { state: 'unknown' }, { state: 'current', since: 30 }])
})

it('proves absence only after SYNCING and retains the earliest fence through later values and removal', () => {
  const f = fixture()

  f.raw.sync(SyncState.Syncing)
  expect(f.observations.at(-1)).toEqual({ state: 'current', since: null })

  f.raw.accountData({ v: 1, since: 50 })
  expect(f.observations.at(-1)).toEqual({ state: 'current', since: 50 })
  f.raw.accountData({ v: 1, since: 80 })
  expect(f.observations.at(-1)).toEqual({ state: 'current', since: 50 })
  f.raw.accountData({ v: 1, since: 20 })
  expect(f.observations.at(-1)).toEqual({ state: 'current', since: 20 })

  f.raw.remove()
  f.raw.emit(ClientEvent.AccountData, new MatrixEvent({ type: MATRIX_GOOGLE_FENCE_ACCOUNT_DATA, content: {} }), undefined)
  expect(f.observations.at(-1)).toEqual({ state: 'current', since: 20 })
})

it('reports malformed account data as unknown without forgetting the earlier valid fence', () => {
  const f = fixture()
  f.raw.sync(SyncState.Syncing)
  f.raw.accountData({ v: 1, since: 50 })
  f.raw.accountData({ v: 1, since: 40, ignored: true })
  expect(f.observations.at(-1)).toEqual({ state: 'unknown' })

  f.raw.accountData({ v: 1, since: 60 })
  expect(f.observations.at(-1)).toEqual({ state: 'current', since: 50 })
})

it('does not let offline events confer current state and recovers only on a later SYNCING', () => {
  const f = fixture()

  f.raw.accountData({ v: 1, since: 10 })
  expect(f.observations).toEqual([{ state: 'unknown' }])
  f.raw.sync(SyncState.Syncing)
  expect(f.observations.at(-1)).toEqual({ state: 'current', since: 10 })

  // The client stopped: nothing is known any more.
  f.raw.sync(SyncState.Stopped)
  expect(f.observations.at(-1)).toEqual({ state: 'unknown' })
  f.raw.accountData({ v: 1, since: 5 })
  expect(f.observations.at(-1)).toEqual({ state: 'unknown' })

  f.raw.sync(SyncState.Syncing)
  expect(f.observations.at(-1)).toEqual({ state: 'current', since: 5 })
})

describe('a reconnecting sync does not unsettle the fence (R4)', () => {
  afterEach(() => vi.useRealTimers())

  it('publishes nothing for a blip, and reads the fence again on the next real sync', () => {
    const f = fixture()
    f.raw.accountData({ v: 1, since: 10 })
    f.raw.sync(SyncState.Syncing)
    const count = f.observations.length

    f.raw.sync(SyncState.Reconnecting)
    f.raw.sync(SyncState.Catchup)
    expect(f.observations).toHaveLength(count)

    // Account data still arrives in the first response after the blip (state CATCHUP).
    f.raw.accountData({ v: 1, since: 5 })
    expect(f.observations.at(-1)).toEqual({ state: 'current', since: 5 })

    f.raw.sync(SyncState.Syncing)
    expect(f.observations.at(-1)).toEqual({ state: 'current', since: 5 })
  })

  it('stays current through an ERROR inside the grace and is unknown by itself after it', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.raw.accountData({ v: 1, since: 10 })
    f.raw.sync(SyncState.Syncing)
    const count = f.observations.length

    f.raw.sync(SyncState.Error)
    await vi.advanceTimersByTimeAsync(MATRIX_SYNC_GRACE_MS - 1)
    expect(f.observations).toHaveLength(count)

    await vi.advanceTimersByTimeAsync(1)
    expect(f.observations.at(-1)).toEqual({ state: 'unknown' })

    // Recovered only by a real sync.
    f.raw.sync(SyncState.Catchup)
    expect(f.observations.at(-1)).toEqual({ state: 'unknown' })
    f.raw.sync(SyncState.Syncing)
    expect(f.observations.at(-1)).toEqual({ state: 'current', since: 10 })
  })

  it('is unknown at once for a refused token', () => {
    const f = fixture()
    f.raw.sync(SyncState.Syncing)
    f.raw.emit(ClientEvent.Sync, SyncState.Error, SyncState.Syncing, { error: { errcode: 'M_UNKNOWN_TOKEN' } })
    expect(f.observations.at(-1)).toEqual({ state: 'unknown' })
  })
})

it('stops synchronously and removes its SDK listeners', () => {
  const f = fixture()
  f.raw.sync(SyncState.Syncing)
  f.dispose()
  expect(f.observations.at(-1)).toEqual({ state: 'unknown' })
  const count = f.observations.length

  f.raw.accountData({ v: 1, since: 1 })
  f.raw.sync(SyncState.Syncing)
  expect(f.observations).toHaveLength(count)
})
