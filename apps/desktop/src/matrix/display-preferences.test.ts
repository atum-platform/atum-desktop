import { createClient, MatrixEvent, MemoryStore, Method } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_DISPLAY_EVENTS, matrixDisplayPreferenceChange } from '../../shared/matrix-display-preferences'

import { matrixDisplayPreferences } from './display-preferences'

afterEach(() => vi.restoreAllMocks())

it.each(['notifications', 'sound', 'shareActivity'] as const)(
  'syncs the %s boolean across actual SDK devices, separate from other fields and global push rules',
  async field => {
    const s = server(),
      first = s.device(),
      second = s.device('@alice:test', 'TWO'),
      other = s.device('@bob:test')

    const type = MATRIX_DISPLAY_EVENTS[field]
    await first.preferences.change({ identity: first.identity, field, value: false })
    expect(first.preferences.snapshot(true)[field]?.value).toBe(true)
    expect(s.records.get(`@alice:test:${type}`)).toEqual({ version: 1, value: false })

    for (const device of [first, second]) {
      device.echo(type)
      expect(device.preferences.snapshot(true)[field]).toEqual({ value: false, writable: true })
      expect(device.preferences.snapshot(true)[field === 'sound' ? 'notifications' : 'sound']?.value).toBe(true)
    }

    expect(other.preferences.snapshot(true)[field]?.value).toBe(true)
    expect([...s.records.keys()]).toEqual([`@alice:test:${type}`])
  }
)

it.each(['notifications', 'sound', 'shareActivity'] as const)(
  'retains a false %s under future schema and refuses stale/invalid writes before HTTP',
  async field => {
    const s = server(),
      d = s.device(),
      type = MATRIX_DISPLAY_EVENTS[field]

    d.echo(type, { version: 1, value: false, keep: true })
    expect(d.preferences.snapshot(false)[field]).toEqual({ value: false, writable: false })
    s.records.set(`@alice:test:${type}`, { version: 2, value: true })
    await expect(d.preferences.change({ identity: d.identity, field, value: true })).rejects.toThrow('readonly')
    d.echo(type)
    expect(d.preferences.snapshot(true)[field]).toEqual({ value: false, writable: false })
    expect(() => matrixDisplayPreferenceChange(field, 'false')).toThrow('invalid')
    await expect(
      d.preferences.change({ identity: { ...d.identity, deviceId: 'STALE' }, field, value: false })
    ).rejects.toThrow('stale')
    expect(s.fetcher).toHaveBeenCalledOnce()
  }
)

it("shows an account that never chose a language in the system's, and a saved choice over it", async () => {
  const s = server(),
    fresh = s.device('@alice:test', 'ONE', 'en')

  expect(fresh.preferences.snapshot(true).language).toEqual({ value: 'en', writable: true })
  await fresh.preferences.change({ identity: fresh.identity, field: 'language', value: 'vi' })
  fresh.echo('io.atum.desktop.language')
  expect(fresh.preferences.snapshot(true).language?.value).toBe('vi')
})

it('round-trips language through actual SDK HTTP and independent device echoes without publishing a local global choice', async () => {
  const s = server(),
    first = s.device(),
    second = s.device('@alice:test', 'TWO'),
    other = s.device('@bob:test')

  await first.preferences.change({ identity: first.identity, field: 'language', value: 'ja' })
  const type = 'io.atum.desktop.language'
  expect(s.records.get(`@alice:test:${type}`)).toEqual({ version: 1, value: 'ja' })
  expect(first.preferences.snapshot(true)).not.toHaveProperty('language.value', 'ja')

  for (const d of [first, second]) {
    d.echo(type)
    expect(d.preferences.snapshot(true)).toHaveProperty('language', { value: 'ja', writable: true })
  }

  const restarted = s.device('@alice:test', 'THREE')
  restarted.echo(type)
  expect(restarted.preferences.snapshot(true)).toHaveProperty('language.value', 'ja')
  expect(other.preferences.snapshot(true)).toHaveProperty('language.value', 'vi')
  expect(second.preferences.snapshot(true).appearance.value).toBe('system')
  expect(second.preferences.snapshot(true).textSize.value).toBe(100)
})

it('keeps language extensions and a future schema, isolated from concurrent appearance and size writes', async () => {
  const s = server(),
    a = s.device(),
    b = s.device('@alice:test', 'TWO'),
    type = MATRIX_DISPLAY_EVENTS.language

  s.records.set(`@alice:test:${type}`, { version: 1, value: 'en', extension: { keep: true } })
  await Promise.all([
    a.preferences.change({ identity: a.identity, field: 'language', value: 'zh-hant' }),
    b.preferences.change({ identity: b.identity, field: 'textSize', value: 110 })
  ])
  expect(s.records.get(`@alice:test:${type}`)).toEqual({ version: 1, value: 'zh-hant', extension: { keep: true } })
  a.echo(type)
  expect(a.preferences.snapshot(false).language).toEqual({ value: 'zh-hant', writable: false })
  s.records.set(`@alice:test:${type}`, { version: 2, value: 'future' })
  await expect(a.preferences.change({ identity: a.identity, field: 'language', value: 'vi' })).rejects.toThrow(
    'readonly'
  )
  a.echo(type)
  expect(a.preferences.snapshot(true).language).toEqual({ value: 'zh-hant', writable: false })
  expect(s.records.get(`@alice:test:${MATRIX_DISPLAY_EVENTS.textSize}`)).toEqual({ version: 1, value: 110 })
})

function deferred<T>() {
  let resolve!: (value: T) => void

  return { promise: new Promise<T>(done => (resolve = done)), resolve: (value: T) => resolve(value) }
}

/** Real SDK HTTP serialization and cache, with a disposable account-data server.
 * Echo delivery is explicit: a successful PUT is deliberately not a sync. */
function server() {
  const records = new Map<string, Record<string, unknown>>()

  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const match = url.pathname.match(/\/user\/([^/]+)\/account_data\/(.+)$/)!
    const key = `${decodeURIComponent(match[1]!)}:${decodeURIComponent(match[2]!)}`

    if (init?.method === 'PUT') {
      records.set(key, JSON.parse(String(init.body)))

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const value = records.get(key)

    return new Response(JSON.stringify(value ?? { errcode: 'M_NOT_FOUND', error: 'Not found' }), {
      status: value ? 200 : 404,
      headers: { 'Content-Type': 'application/json' }
    })
  })

  function device(userId = '@alice:test', deviceId = 'ONE', language?: 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant') {
    let active = true
    const identity = { userId, deviceId }
    const store = new MemoryStore()

    const client = createClient({
      baseUrl: 'https://matrix.test',
      userId,
      deviceId,
      accessToken: 'fixture',
      store,
      fetchFn: fetcher
    })

    const preferences = matrixDisplayPreferences(client, identity, () => active, language)

    function echo(type: string, value: Record<string, unknown> | undefined = records.get(`${userId}:${type}`)) {
      if (value) {
        store.storeAccountDataEvents([new MatrixEvent({ type, content: value })])
      }
    }

    return { client, identity, preferences, echo, stop: () => (active = false) }
  }

  return { records, fetcher, device }
}

it('uses real SDK HTTP to save separate fields from two devices, without fabricating either sync echo', async () => {
  const s = server()
  const first = s.device()
  const second = s.device('@alice:test', 'TWO')
  const other = s.device('@bob:test')
  const before = first.preferences.snapshot(true)
  await Promise.all([
    first.preferences.change({ identity: first.identity, field: 'appearance', value: 'dark' }),
    second.preferences.change({ identity: second.identity, field: 'textSize', value: 110 })
  ])
  expect(first.preferences.snapshot(true)).toEqual(before)
  expect(s.records.get(`@alice:test:${MATRIX_DISPLAY_EVENTS.appearance}`)).toEqual({ version: 1, value: 'dark' })
  expect(s.records.get(`@alice:test:${MATRIX_DISPLAY_EVENTS.textSize}`)).toEqual({ version: 1, value: 110 })

  for (const d of [first, second]) {
    d.echo(MATRIX_DISPLAY_EVENTS.appearance)
    d.echo(MATRIX_DISPLAY_EVENTS.textSize)
    expect(d.preferences.snapshot(true)).toEqual({
      appearance: { value: 'dark', writable: true },
      textSize: { value: 110, writable: true },
      language: { value: 'vi', writable: true },
      notifications: { value: true, writable: true },
      sound: { value: true, writable: true },
      shareActivity: { value: true, writable: true }
    })
  }

  expect(other.preferences.snapshot(true)).toEqual(before)
  const restarted = s.device('@alice:test', 'THREE')
  restarted.echo(MATRIX_DISPLAY_EVENTS.appearance)
  restarted.echo(MATRIX_DISPLAY_EVENTS.textSize)
  expect(restarted.preferences.snapshot(true)).toEqual(first.preferences.snapshot(true))
  expect(s.fetcher.mock.calls.every(([url]) => new URL(String(url)).hostname === 'matrix.test')).toBe(true)
})

it('preserves supported record extensions and refuses a newer server schema even when its cache is stale', async () => {
  const s = server(),
    d = s.device(),
    type = MATRIX_DISPLAY_EVENTS.appearance

  s.records.set(`@alice:test:${type}`, { version: 1, value: 'light', extension: { keep: true } })
  d.echo(type)
  await d.preferences.change({ identity: d.identity, field: 'appearance', value: 'dark' })
  expect(s.records.get(`@alice:test:${type}`)).toEqual({ version: 1, value: 'dark', extension: { keep: true } })
  s.records.set(`@alice:test:${type}`, { version: 2, value: 'dark', future: true })
  await expect(d.preferences.change({ identity: d.identity, field: 'appearance', value: 'system' })).rejects.toThrow(
    'readonly'
  )
  expect(s.records.get(`@alice:test:${type}`)?.version).toBe(2)
})

it('retains the last valid choice offline or under a future/malformed record, without blocking the other field', () => {
  const d = server().device(),
    type = MATRIX_DISPLAY_EVENTS.appearance

  expect(d.preferences.snapshot(false).appearance).toEqual({ value: 'system', writable: false })
  d.echo(type, { version: 1, value: 'dark' })
  expect(d.preferences.snapshot(false).appearance).toEqual({ value: 'dark', writable: false })
  expect(d.preferences.snapshot(true).appearance.value).toBe('dark')
  expect(d.preferences.snapshot(false).appearance).toEqual({ value: 'dark', writable: false })

  for (const raw of [{ version: 2, value: 'light' }, { version: 1, value: 'invalid' }, {}]) {
    d.echo(type, raw)
    expect(d.preferences.snapshot(true)).toEqual({
      appearance: { value: 'dark', writable: false },
      textSize: { value: 100, writable: true },
      language: { value: 'vi', writable: true },
      notifications: { value: true, writable: true },
      sound: { value: true, writable: true },
      shareActivity: { value: true, writable: true }
    })
  }
})

it('rejects stale account/device identities and invalid fields before performing HTTP', async () => {
  const s = server(),
    d = s.device()

  for (const identity of [
    { userId: '@bob:test', deviceId: 'ONE' },
    { userId: '@alice:test', deviceId: 'TWO' }
  ]) {
    await expect(d.preferences.change({ identity, field: 'appearance', value: 'dark' })).rejects.toThrow('stale')
  }

  await expect(
    d.preferences.change({ identity: d.identity, field: 'appearance', value: 'secret' } as never)
  ).rejects.toThrow('invalid')
  expect(s.fetcher).not.toHaveBeenCalled()
})

it('fences retirement while the fresh GET is pending, before any write', async () => {
  const d = server().device(),
    read = deferred<unknown>()

  vi.spyOn(d.client.http, 'authedRequest').mockReturnValue(read.promise as never)
  const write = vi.spyOn(d.client, 'setAccountDataRaw')
  const pending = d.preferences.change({ identity: d.identity, field: 'textSize', value: 90 })
  d.stop()
  read.resolve({ version: 1, value: 100 })
  await expect(pending).rejects.toThrow('stale')
  expect(write).not.toHaveBeenCalled()
})

it.each([
  ['appearance', 'system', 'dark', 'light'],
  ['language', 'vi', 'ja', 'en']
] as const)(
  'rejects a late %s PUT after retirement and refuses same-field overlap',
  async (field, initial, firstValue, secondValue) => {
    const d = server().device(),
      put = deferred<{}>()

    vi.spyOn(d.client.http, 'authedRequest').mockResolvedValue({ version: 1, value: initial } as never)
    const write = vi.spyOn(d.client, 'setAccountDataRaw').mockReturnValue(put.promise)
    const first = d.preferences.change({ identity: d.identity, ...matrixDisplayPreferenceChange(field, firstValue) })
    await expect(
      d.preferences.change({ identity: d.identity, ...matrixDisplayPreferenceChange(field, secondValue) })
    ).rejects.toThrow('pending')
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    d.stop()
    put.resolve({})
    await expect(first).rejects.toThrow('stale')
    expect(d.preferences.snapshot(false)[field]?.value).toBe(initial)
  }
)

it('does not convert permission/network refusal into absent account data or save success; a later real retry works', async () => {
  const d = server().device()
  const read = vi.spyOn(d.client.http, 'authedRequest').mockRejectedValueOnce({ errcode: 'M_FORBIDDEN' })
  const write = vi.spyOn(d.client, 'setAccountDataRaw')
  await expect(d.preferences.change({ identity: d.identity, field: 'textSize', value: 90 })).rejects.toEqual({
    errcode: 'M_FORBIDDEN'
  })
  expect(write).not.toHaveBeenCalled()
  await d.preferences.change({ identity: d.identity, field: 'textSize', value: 90 })
  expect(read).toHaveBeenCalledWith(Method.Get, '/user/%40alice%3Atest/account_data/io.atum.desktop.text_size')
  expect(write).toHaveBeenCalledOnce()
})

it('surfaces a refused PUT, retains its last synced projection, and releases the field for a real retry', async () => {
  const d = server().device()
  const write = vi.spyOn(d.client, 'setAccountDataRaw').mockRejectedValueOnce(new Error('refused'))
  await expect(d.preferences.change({ identity: d.identity, field: 'textSize', value: 110 })).rejects.toThrow('refused')
  expect(d.preferences.snapshot(true).textSize.value).toBe(100)
  await d.preferences.change({ identity: d.identity, field: 'textSize', value: 110 })
  expect(write).toHaveBeenCalledTimes(2)
})

it('rejects the retired model-picker display preference', () => {
  expect(() => matrixDisplayPreferenceChange('modelPicker', true)).toThrow('invalid')
})
