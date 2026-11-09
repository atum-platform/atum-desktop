import { createClient, MatrixEvent, Method } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { appShortcuts, shortcutEvent } from './app-shortcuts'

const first = '00000000-0000-4000-8000-bd7662a5eeb4'
const second = '00000000-0000-4000-8000-b454f82c5857'
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fixture() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@alice:test' })
  let live = true
  const changed = vi.fn()
  const preferences = appShortcuts(client, () => live, changed, 50)
  const read = vi.spyOn(client.http, 'authedRequest').mockRejectedValue({ errcode: 'M_NOT_FOUND' })
  const write = vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})

  const sync = (id: string, raw: unknown) => {
    client.store.storeAccountDataEvents([new MatrixEvent({ type: shortcutEvent(id), content: raw as never })])
    preferences.observed(shortcutEvent(id), raw)
  }

  return {
    client,
    preferences,
    read,
    write,
    sync,
    stop: () => {
      live = false
      preferences.dispose()
    }
  }
}

it('waits for SDK readiness; malformed future records retain session evidence, never follow defaults', () => {
  const { preferences, sync, stop } = fixture()
  expect(preferences.snapshot([first], false)[first]).toEqual({ status: 'loading', visibility: 'unknown' })
  expect(preferences.snapshot([first], true)[first]).toEqual({ status: 'ready', visibility: 'default' })
  sync(first, { version: 1, visibility: 'hidden' })
  sync(first, { version: 2, visibility: 'shown' })
  expect(preferences.snapshot([first], true)[first]).toEqual({ status: 'readonly', visibility: 'hidden' })
  sync(second, { version: 2, visibility: 'shown' })
  expect(preferences.snapshot([second], true)[second]).toEqual({ status: 'readonly', visibility: 'unknown' })
  stop()
})
it('fresh GET preserves v1 optional fields and a delayed sync is reconciled by an authoritative read', async () => {
  vi.useFakeTimers()
  const { preferences, read, write, sync, client, stop } = fixture()
  read
    .mockResolvedValueOnce({ version: 1, visibility: 'hidden', future: { value: 1 } })
    .mockResolvedValueOnce({ version: 1, visibility: 'shown', future: { value: 1 } })
  await preferences.change(first, 'shown')
  expect(read).toHaveBeenCalledWith(Method.Get, `/user/%40alice%3Atest/account_data/${shortcutEvent(first)}`)
  expect(write).toHaveBeenCalledExactlyOnceWith(shortcutEvent(first), {
    version: 1,
    visibility: 'shown',
    future: { value: 1 }
  })
  expect(client.getAccountData(shortcutEvent(first))).toBeUndefined()
  expect(preferences.snapshot([first], true)[first].status).toBe('saving')
  await vi.advanceTimersByTimeAsync(51)
  expect(preferences.snapshot([first], true)[first]).toEqual({ status: 'ready', visibility: 'shown' })
  sync(first, { version: 1, visibility: 'hidden' })
  expect(preferences.snapshot([first], true)[first].visibility).toBe('hidden')
  stop()
})
it('retries a failed shortcut confirmation read without replaying the write', async () => {
  vi.useFakeTimers()
  const { preferences, read, write, stop } = fixture()
  read
    .mockResolvedValueOnce({ version: 1, visibility: 'shown' })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ version: 1, visibility: 'hidden' })

  await preferences.change(first, 'hidden')
  await vi.advanceTimersByTimeAsync(51)
  expect(preferences.snapshot([first], true)[first].status).toBe('saving')
  await vi.advanceTimersByTimeAsync(51)
  expect(preferences.snapshot([first], true)[first]).toEqual({ status: 'ready', visibility: 'hidden' })
  expect(write).toHaveBeenCalledOnce()
  stop()
})
it('uses one preference owner for upper- and lowercase UUID spellings', async () => {
  const id = '00000000-0000-4000-8000-5619996ccf0d'
  const { preferences, write, sync, stop } = fixture()
  await preferences.change(id.toUpperCase(), 'hidden')
  expect(write).toHaveBeenCalledWith(shortcutEvent(id), { version: 1, visibility: 'hidden' })
  expect(preferences.snapshot([id], true)[id].status).toBe('saving')
  sync(id, { version: 1, visibility: 'hidden' })
  expect(preferences.snapshot([id], true)[id]).toEqual({ status: 'ready', visibility: 'hidden' })
  stop()
})
it('isolates different-app writes, serializes same-app and blocks errors/stopped owner before write', async () => {
  const { preferences, read, write, stop } = fixture()
  let release!: (value: unknown) => void
  read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve
      }) as never
  )
  const pending = preferences.change(first, 'hidden')
  await expect(preferences.change(first, 'shown')).rejects.toThrow('pending')
  await preferences.change(second, 'shown')
  expect(write).toHaveBeenCalledExactlyOnceWith(shortcutEvent(second), { version: 1, visibility: 'shown' })
  stop()
  release({ version: 1, visibility: 'shown' })
  await expect(pending).rejects.toThrow('failed')
  expect(write).toHaveBeenCalledTimes(1)
})
it.each([null, {}, [], { version: 2, visibility: 'hidden' }, { version: 1, visibility: 'bad' }])(
  'does not overwrite unreadable state %j',
  async raw => {
    const { preferences, read, write, stop } = fixture()
    read.mockResolvedValue(raw)
    await expect(preferences.change(first, 'shown')).rejects.toThrow('failed')
    read.mockRejectedValue(new Error('offline'))
    await expect(preferences.change(first, 'shown')).rejects.toThrow('failed')
    expect(write).not.toHaveBeenCalled()
    stop()
  }
)
