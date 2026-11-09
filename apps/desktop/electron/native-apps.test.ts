import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NativeAppLaunchRequest } from '../shared/skills-launcher'

import { NativeAppsController } from './native-apps'

const requestId = '00000000-0000-4000-8000-bd7662a5eeb4'
const choiceRequestId = '00000000-0000-4000-8000-b454f82c5857'
const original = { x: 180, y: 100, width: 1200, height: 780 }
const area = { x: -1920, y: 25, width: 1920, height: 1055 }

const entry = { id: 'native-app:word', name: 'Word', bundleId: 'com.microsoft.Word' }
const target = { entry, path: '/Applications/Microsoft Word.app' }
const windowOne = { id: 41, title: 'One document', bounds: { x: 1, y: 2, width: 900, height: 700 }, fullscreen: false, minimized: false }
const windowTwo = { id: 42, title: 'Other document', bounds: { x: 3, y: 4, width: 900, height: 700 }, fullscreen: false, minimized: false }

function request(overrides: Partial<NativeAppLaunchRequest> = {}): NativeAppLaunchRequest {
  return { appId: entry.id, requestId, mode: 'beside', ...overrides }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {resolve = resolvePromise; reject = rejectPromise})

  return { promise, resolve, reject }
}

function setup() {
  let authority = 'account-a:1'
  let bounds = { ...original }
  const trace: string[] = []

  const chat = {
    isDestroyed: vi.fn(() => false), isFullScreen: vi.fn(() => false), isMaximized: vi.fn(() => false),
    getNormalBounds: vi.fn(() => ({ ...original })), getBounds: vi.fn(() => ({ ...bounds })),
    getMinimumSize: vi.fn(() => [800, 600]), setMinimumSize: vi.fn(),
    unmaximize: vi.fn(), maximize: vi.fn(), setBounds: vi.fn(value => {bounds = value}), show: vi.fn()
  }

  const inventory = {
    launch: vi.fn(async (_id: string, _document?: string) => {trace.push('launch');

 return target}),
    resolve: vi.fn(async (_id: string) => {trace.push('resolve');

 return target})
  }

  const windows = {
    list: vi.fn(async () => [windowOne]),
    arrange: vi.fn(async () => {trace.push('arrange')}),
    restore: vi.fn(async () => {trace.push('restore')})
  }

  const beforeLaunch = vi.fn(async () => {trace.push('before-launch')})
  const ended = vi.fn()

  const controller = new NativeAppsController({
    inventory, windows, window: () => chat, authority: () => authority,
    authorizePath: value => String(value), workArea: () => area, beforeLaunch, ended
  })

  return { controller, chat, inventory, windows, beforeLaunch, ended, trace, changeAuthority: () => {authority = 'account-b:2'} }
}

afterEach(() => vi.useRealTimers())

describe('NativeAppsController', () => {
  it('honors cancellation immediately after the IPC request, before cleanup has resolved', async () => {
    const s = setup()
    const launching = s.controller.launch(request())
    const ending = s.controller.end(requestId)
    await expect(launching).rejects.toThrow('NATIVE_APP_CANCELLED')
    await ending
    expect(s.inventory.launch).not.toHaveBeenCalled()
    expect(s.windows.arrange).not.toHaveBeenCalled()
  })

  it('arranges exactly one eligible native window beside chat after ending the prior companion', async () => {
    const s = setup()

    await expect(s.controller.launch(request())).resolves.toMatchObject({ id: requestId, app: entry, status: 'beside' })

    expect(s.trace).toEqual(['before-launch', 'resolve', 'launch', 'arrange'])
    expect(s.beforeLaunch).toHaveBeenCalledOnce()
    expect(s.windows.arrange).toHaveBeenCalledWith(target, windowOne, { x: -1243, y: 25, width: 1243, height: 1055 })
    expect(s.chat.setBounds).toHaveBeenCalledWith({ x: -1920, y: 25, width: 669, height: 1055 })
    expect(s.controller.isActive()).toBe(true)
  })

  it('opens normally with an honest no-window result after bounded window checks', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.windows.list.mockResolvedValue([])
    const launching = s.controller.launch(request())

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(launching).resolves.toMatchObject({ status: 'opened', reason: 'no-window' })
    expect(s.windows.list).toHaveBeenCalledTimes(9)
    expect(s.windows.arrange).not.toHaveBeenCalled()
    expect(s.chat.setBounds).not.toHaveBeenCalled()
  })

  it('waits for a cold app process and then its first window before arranging', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.windows.list.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([])
    const launching = s.controller.launch(request())

    await vi.advanceTimersByTimeAsync(500)
    await expect(launching).resolves.toMatchObject({ status: 'beside' })
    expect(s.windows.list).toHaveBeenCalledTimes(3)
    expect(s.windows.arrange).toHaveBeenCalledOnce()
  })

  it('bounds cold-process retries and leaves chat alone when no process appears', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.windows.list.mockRejectedValue(new Error('unavailable'))
    const launching = s.controller.launch(request())

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(launching).resolves.toMatchObject({ status: 'opened', reason: 'no-window' })
    expect(s.windows.list).toHaveBeenCalledTimes(9)
    expect(s.chat.setBounds).not.toHaveBeenCalled()
  })

  it('requires an explicit retained choice when several ordinary windows exist', async () => {
    const s = setup()
    s.windows.list.mockResolvedValue([windowOne, windowTwo])

    await expect(s.controller.launch(request())).resolves.toEqual({
      id: requestId, app: entry, status: 'choose-window',
      windows: [{ id: windowOne.id, title: windowOne.title }, { id: windowTwo.id, title: windowTwo.title }]
    })
    expect(s.windows.arrange).not.toHaveBeenCalled()

    await expect(s.controller.launch(request({ requestId: choiceRequestId, windowId: windowTwo.id }))).rejects.toThrow('NATIVE_APP_WINDOW_UNAVAILABLE')
    expect(s.inventory.resolve).toHaveBeenCalledOnce()

    await expect(s.controller.launch(request({ windowId: windowTwo.id }))).resolves.toMatchObject({ status: 'beside' })
    expect(s.inventory.launch).toHaveBeenCalledOnce()
    expect(s.inventory.resolve).toHaveBeenCalledWith(entry.id)
    expect(s.windows.arrange).toHaveBeenCalledWith(target, windowTwo, expect.any(Object))
  })

  it('does not mislabel minimized-only windows as fullscreen', async () => {
    const s = setup()
    s.windows.list.mockResolvedValue([{ ...windowOne, minimized: true }])
    await expect(s.controller.launch(request())).resolves.toMatchObject({ status: 'opened', reason: 'no-window' })
    expect(s.chat.setBounds).not.toHaveBeenCalled()
  })

  it('leaves chat untouched when native window access is denied after launching', async () => {
    const s = setup()
    s.windows.list.mockRejectedValue(new Error('permission'))

    await expect(s.controller.launch(request())).resolves.toMatchObject({ status: 'opened', reason: 'permission' })

    expect(s.inventory.launch).toHaveBeenCalledOnce()
    expect(s.windows.arrange).not.toHaveBeenCalled()
    expect(s.windows.restore).not.toHaveBeenCalled()
    expect(s.windows.list).toHaveBeenCalledOnce()
    expect(s.chat.setBounds).not.toHaveBeenCalled()
    expect(s.chat.setMinimumSize).not.toHaveBeenCalled()
  })

  it('cancels an arrangement in flight, restores the native window once, and never applies stale chat geometry', async () => {
    const s = setup()
    const arranging = deferred<void>()
    s.windows.arrange.mockImplementation(async () => arranging.promise)
    const launching = s.controller.launch(request())
    await vi.waitFor(() => expect(s.windows.arrange).toHaveBeenCalledOnce())

    const clearing = s.controller.clear()
    arranging.resolve()
    await expect(launching).rejects.toThrow('NATIVE_APP_CANCELLED')
    await clearing

    expect(s.windows.restore).toHaveBeenCalledTimes(1)
    expect(s.chat.setBounds).not.toHaveBeenCalled()
    expect(s.chat.setMinimumSize).not.toHaveBeenCalled()
    expect(s.ended).toHaveBeenCalledWith(requestId)
    expect(s.controller.isActive()).toBe(false)
  })

  it('invalidates an arrangement when the active account changes and avoids stale geometry', async () => {
    const s = setup()
    const arranging = deferred<void>()
    s.windows.arrange.mockImplementation(async () => arranging.promise)
    const launching = s.controller.launch(request())
    await vi.waitFor(() => expect(s.windows.arrange).toHaveBeenCalledOnce())

    s.changeAuthority()
    arranging.resolve()

    await expect(launching).rejects.toThrow('NATIVE_APP_CANCELLED')
    expect(s.windows.restore).toHaveBeenCalledTimes(1)
    expect(s.chat.setBounds).not.toHaveBeenCalled()
    expect(s.chat.setMinimumSize).not.toHaveBeenCalled()
    expect(s.controller.isActive()).toBe(false)
  })

  it('restores the original chat frame synchronously before waiting for native restoration', async () => {
    const s = setup()
    await s.controller.launch(request())
    const restoring = deferred<void>()
    s.windows.restore.mockImplementation(async () => restoring.promise)

    const clearing = s.controller.clear()

    expect(s.chat.setMinimumSize).toHaveBeenLastCalledWith(800, 600)
    expect(s.chat.setBounds).toHaveBeenLastCalledWith(original)
    expect(s.controller.isActive()).toBe(false)
    await vi.waitFor(() => expect(s.windows.restore).toHaveBeenCalledOnce())
    restoring.resolve()
    await clearing
  })

  it('only permits Office documents that match the selected app bundle', async () => {
    const s = setup()

    await expect(s.controller.launch(request({ documentPath: '/documents/book.xlsx' }))).rejects.toThrow('NATIVE_APP_INVALID_DOCUMENT')
    expect(s.inventory.launch).not.toHaveBeenCalled()
    expect(s.inventory.resolve).toHaveBeenCalledOnce()

    await expect(s.controller.launch(request({ documentPath: '/documents/report.docx' }))).resolves.toMatchObject({ status: 'beside' })
    expect(s.inventory.launch).toHaveBeenCalledWith(entry.id, '/documents/report.docx')
  })

  it('coalesces focus refreshes and throttles repeated native window reads', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'))
    const s = setup()
    await s.controller.launch(request())
    s.windows.list.mockClear()
    const reading = deferred<typeof windowOne[]>()
    s.windows.list.mockImplementationOnce(() => reading.promise)

    const first = s.controller.refresh()
    const second = s.controller.refresh()
    expect(first).toBe(second)
    await vi.advanceTimersByTimeAsync(0)
    expect(s.windows.list).toHaveBeenCalledOnce()
    reading.resolve([windowOne])
    await first
    await s.controller.refresh()
    expect(s.windows.list).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(500)
    s.windows.list.mockResolvedValue([])
    await s.controller.refresh()
    expect(s.windows.list).toHaveBeenCalledTimes(2)
    expect(s.controller.isActive()).toBe(false)
    expect(s.chat.setBounds).toHaveBeenLastCalledWith(original)
    expect(s.windows.restore).toHaveBeenCalledOnce()
  })
})
