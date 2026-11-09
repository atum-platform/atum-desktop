import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessagingSyncCoordinator } from './sync-coordinator'
import type { MessagingAccountSession, MessagingSyncStatus } from './types'

function session(expiresAt: number | null = null): MessagingAccountSession {
  return {
    baseUrl: 'https://api.atum.test',
    user: { id: 'account-a', displayName: 'A', handle: null },
    tokens: { accessToken: 'access-a', refreshToken: 'refresh-a', expiresAt }
  }
}

function status(cursor = 'cursor-1'): MessagingSyncStatus {
  return {
    accountId: 'account-a',
    connectivity: 'online',
    synchronized: true,
    cursor,
    lastSuccessfulSyncAt: null,
    nextRetryAt: null,
    errorCode: null
  }
}

function harness(
  options: {
    expiresAt?: number | null
    refresh?: (session: MessagingAccountSession) => Promise<MessagingAccountSession | null>
    unsubscribe?: () => Promise<unknown>
  } = {}
) {
  let current: MessagingAccountSession | null = session(options.expiresAt)
  const broadcasts = new Map<string, (message: unknown) => void>()
  let channelStatus: ((status: string, error?: Error) => void) | null = null
  const setAuth = vi.fn()
  const disconnect = vi.fn()
  const unsubscribe = vi.fn(options.unsubscribe)

  const channel = {
    on: vi.fn((_type, filter, callback) => {
      broadcasts.set(filter.event, callback)

      return channel
    }),
    subscribe: vi.fn(callback => {
      channelStatus = callback

      return channel
    }),
    unsubscribe
  }

  const client = { channel: vi.fn(() => channel), connect: vi.fn(), disconnect, setAuth }
  const sync = vi.fn().mockResolvedValue(status('cursor-2'))
  const refreshImpl = options.refresh ?? vi.fn().mockResolvedValue(current)

  const refresh = vi.fn(async (rejected: MessagingAccountSession) => {
    const result = await refreshImpl(rejected)
    current = result

    return result
  })

  const coordinator = new MessagingSyncCoordinator({
    realtimeUrl: 'https://project.supabase.co',
    anonKey: 'anon-key',
    tokens: { current: () => current, refresh },
    advertisement: vi.fn().mockResolvedValue({
      transport: 'supabase_private_broadcast',
      topic: 'user:account-a:messaging:v1',
      event: 'sync_available'
    }),
    sync,
    status: vi.fn().mockResolvedValue(status()),
    createClient: vi.fn().mockResolvedValue(client),
    debounceMs: 350,
    keepaliveMs: 120_000,
    refreshSkewMs: 60_000,
    now: () => 1_000_000
  })

  return {
    coordinator,
    sync,
    refresh,
    setAuth,
    disconnect,
    unsubscribe,
    emit: (message: unknown) => broadcasts.get('sync_available')?.(message),
    emitTyping: (message: unknown) => broadcasts.get('typing')?.(message),
    channelStatus: (value: string) => channelStatus?.(value),
    setSession: (value: MessagingAccountSession | null) => (current = value)
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('MessagingSyncCoordinator', () => {
  it('collapses a burst of realtime hints into one leading and one trailing serialized sync', async () => {
    const h = harness()
    await h.coordinator.start()
    h.channelStatus('SUBSCRIBED')

    for (let index = 0; index < 20; index += 1) {
      h.emit({ payload: { cursor_hint: `cursor-${index + 2}` } })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(350)
    expect(h.sync).toHaveBeenCalledTimes(2)
  })

  it('skips equal and behind cursor hints', async () => {
    const h = harness()
    await h.coordinator.start()
    h.emit({ payload: { cursor_hint: 'cursor-1' } })
    h.emit({ payload: { cursor_hint: 'cursor-0' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('drops a socket callback from an epoch stopped before the callback settles', async () => {
    const h = harness()
    await h.coordinator.start()
    h.coordinator.stop()
    h.emit({ payload: { cursor_hint: 'cursor-2' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.disconnect).toHaveBeenCalledOnce()
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not acknowledge quiescence until realtime unsubscribe has settled', async () => {
    let release!: () => void
    const h = harness({ unsubscribe: () => new Promise<void>(resolve => (release = resolve)) })
    await h.coordinator.start()
    let stopped = false
    const pending = h.coordinator.stop().then(() => (stopped = true))

    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(h.disconnect).toHaveBeenCalledOnce()
    release()
    await pending
    expect(stopped).toBe(true)
  })

  it('refreshes before persisted expiry and updates channel auth', async () => {
    const refreshed = session(2_000)
    refreshed.tokens.accessToken = 'access-b'
    const refresh = vi.fn().mockResolvedValue(refreshed)
    const h = harness({ expiresAt: 1_061, refresh })
    await h.coordinator.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledOnce()
    expect(h.setAuth).toHaveBeenLastCalledWith('access-b')
  })

  it('recreates the realtime client when main reports power resume', async () => {
    const h = harness()
    await h.coordinator.start()
    h.coordinator.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.disconnect).toHaveBeenCalledOnce()
    expect(h.setAuth).toHaveBeenCalledTimes(2)
  })

  it('keeps scheduling keepalives after a keepalive sync fails', async () => {
    const h = harness()
    await h.coordinator.start()
    h.sync.mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.sync).toHaveBeenCalledTimes(2)
  })

  it('never surfaces a failed hint-driven sync as an unhandled rejection', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)

    try {
      const h = harness()
      await h.coordinator.start()
      h.sync.mockRejectedValueOnce(new Error('pull failed'))
      h.emit({ payload: { cursor_hint: 'cursor-9' } })
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.runOnlyPendingTimersAsync()
      expect(h.sync).toHaveBeenCalled()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
