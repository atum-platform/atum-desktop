import { afterEach, describe, expect, it, vi } from 'vitest'

import { APP_BOT_ROOM_WAIT_MS, type RoomArrivals, waitForRoom } from './app-bot-room-wait'

afterEach(() => {
  vi.useRealTimers()
})

/** A store that a test fills by hand: it counts how often it is looked at and who is listening. */
function store(initial: string[] = []) {
  const rooms = new Set(initial)
  const listeners = new Set<(roomId: string) => void>()
  const looks = vi.fn()

  const arrivals: RoomArrivals = {
    has: roomId => {
      looks(roomId)

      return rooms.has(roomId)
    },
    watch: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }

  return {
    arrivals,
    looks,
    listeners,
    arrive(roomId: string) {
      rooms.add(roomId)

      for (const listener of [...listeners]) {
        listener(roomId)
      }
    }
  }
}

describe('waiting for a bot’s room to reach the SDK’s store', () => {
  it('is over at once for a room that is already here, and leaves nothing listening', async () => {
    vi.useFakeTimers()
    const s = store(['!here:test'])

    await expect(waitForRoom(s.arrivals, '!here:test').arrived).resolves.toBe(true)
    expect(s.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends when its room arrives, whenever that is within the bound, and ignores other rooms', async () => {
    vi.useFakeTimers()
    const s = store()
    let result: boolean | undefined
    void waitForRoom(s.arrivals, '!new:test').arrived.then(value => (result = value))

    await vi.advanceTimersByTimeAsync(APP_BOT_ROOM_WAIT_MS - 1_000)
    s.arrive('!other:test')
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBeUndefined()

    s.arrive('!new:test')
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe(true)
    // Nothing is left to fire later: not the timer, not the listener.
    expect(s.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs out at the bound, not before, and reports that the room never came', async () => {
    vi.useFakeTimers()
    const s = store()
    let result: boolean | undefined
    void waitForRoom(s.arrivals, '!never:test').arrived.then(value => (result = value))

    await vi.advanceTimersByTimeAsync(APP_BOT_ROOM_WAIT_MS - 1)
    expect(result).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe(false)
    expect(s.listeners.size).toBe(0)
  })

  it('is driven by the store’s event: it looks once, however long the room takes', async () => {
    vi.useFakeTimers()
    const s = store()
    const wait = waitForRoom(s.arrivals, '!slow:test')

    // The look at the start is the only one; 14 seconds pass without another, and one timer is all it holds.
    expect(s.looks).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(14_000)
    expect(s.looks).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    expect(s.listeners.size).toBe(1)

    s.arrive('!slow:test')
    await expect(wait.arrived).resolves.toBe(true)
  })

  it('listens before it looks, so a room that arrives in between is not missed', async () => {
    vi.useFakeTimers()
    const order: string[] = []

    const arrivals: RoomArrivals = {
      has: () => {
        order.push('look')

        return false
      },
      watch: () => {
        order.push('listen')

        return () => {}
      }
    }

    void waitForRoom(arrivals, '!r:test')
    expect(order).toEqual(['listen', 'look'])
  })

  it('can be cancelled when the SDK stops: it settles false at once and holds nothing', async () => {
    vi.useFakeTimers()
    const s = store()
    const wait = waitForRoom(s.arrivals, '!r:test')

    wait.cancel()
    await expect(wait.arrived).resolves.toBe(false)
    expect(s.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    // Settling is final: a late arrival changes nothing.
    s.arrive('!r:test')
    await expect(wait.arrived).resolves.toBe(false)
  })

  it('takes a bound of its own', async () => {
    vi.useFakeTimers()
    const s = store()
    const wait = waitForRoom(s.arrivals, '!r:test', 250)

    await vi.advanceTimersByTimeAsync(250)
    await expect(wait.arrived).resolves.toBe(false)
  })
})
