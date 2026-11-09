import { describe, expect, it, vi } from 'vitest'

import { appBotCreatedRooms } from './app-bot-created'

const owner = '@owner:test'
const moon = '00000000-0000-4000-8000-e79acd97ac88'
const andy = '00000000-0000-4000-8000-993224b4fe85'
const moonBot = '@app-moon:test'
const andyBot = '@app-andy:test'

/** A device's storage that tests can fill, break, and read back raw. */
function storage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))

  return {
    items,
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void items.set(key, value)),
    removeItem: vi.fn((key: string) => void items.delete(key))
  }
}

describe('the chats this device made for a bot and has not seen arrive', () => {
  it('remembers them per app and forgets them, and holds nothing once none is left', () => {
    const device = storage()
    const created = appBotCreatedRooms(device, owner, 'DEVICE')
    expect(created.read().size).toBe(0)

    created.write(moon, { botUserId: moonBot, roomId: '!moon:test' })
    created.write(andy, { botUserId: andyBot, roomId: '!andy:test' })

    expect(appBotCreatedRooms(device, owner, 'DEVICE').read()).toEqual(
      new Map([
        [moon, { botUserId: moonBot, roomId: '!moon:test' }],
        [andy, { botUserId: andyBot, roomId: '!andy:test' }]
      ])
    )

    created.remove(moon)
    expect([...created.read().keys()]).toEqual([andy])

    created.remove(andy)
    expect(created.read().size).toBe(0)
    // Not an empty record: no record at all.
    expect(device.items.size).toBe(0)
  })

  it('replaces the chat it remembers for an app', () => {
    const created = appBotCreatedRooms(storage(), owner, 'DEVICE')

    created.write(moon, { botUserId: moonBot, roomId: '!first:test' })
    created.write(moon, { botUserId: moonBot, roomId: '!second:test' })

    expect(created.read().get(moon)?.roomId).toBe('!second:test')
  })

  it('forgets a chat by room only while the record still names that room', () => {
    const created = appBotCreatedRooms(storage(), owner, 'DEVICE')

    created.write(moon, { botUserId: moonBot, roomId: '!second:test' })
    created.remove(moon, '!first:test')
    expect(created.read().get(moon)?.roomId).toBe('!second:test')

    created.remove(moon, '!second:test')
    expect(created.read().size).toBe(0)
  })

  it('is this account’s on this device and nobody else’s', () => {
    const device = storage()

    appBotCreatedRooms(device, owner, 'DEVICE').write(moon, { botUserId: moonBot, roomId: '!moon:test' })

    expect(appBotCreatedRooms(device, owner, 'OTHER').read().size).toBe(0)
    expect(appBotCreatedRooms(device, '@other:test', 'DEVICE').read().size).toBe(0)

    // Forgetting under another key leaves it be.
    appBotCreatedRooms(device, owner, 'OTHER').remove(moon)
    expect(appBotCreatedRooms(device, owner, 'DEVICE').read().get(moon)?.roomId).toBe('!moon:test')
  })

  it('reads nothing it cannot vouch for', () => {
    const key = `io.atum.app-bot-created:${JSON.stringify([owner, 'DEVICE'])}`

    const read = (value: unknown) =>
      appBotCreatedRooms(storage({ [key]: typeof value === 'string' ? value : JSON.stringify(value) }), owner, 'DEVICE')
        .read()
        .size

    const good = { botUserId: moonBot, roomId: '!moon:test' }

    expect(read({ [moon]: good })).toBe(1)
    // Not JSON, not an object, or an object of nothing usable.
    expect(read('{')).toBe(0)
    expect(read('null')).toBe(0)
    expect(read([good])).toBe(0)
    expect(read('7')).toBe(0)
    // An id that is not an app's, a bot that is not a user id, a room that is not a room id.
    expect(read({ moon: good })).toBe(0)
    expect(read({ [moon]: { ...good, botUserId: 'moon' } })).toBe(0)
    expect(read({ [moon]: { ...good, botUserId: 7 } })).toBe(0)
    expect(read({ [moon]: { ...good, roomId: 'moon:test' } })).toBe(0)
    expect(read({ [moon]: { ...good, roomId: `!${'x'.repeat(1024)}` } })).toBe(0)
    expect(read({ [moon]: null })).toBe(0)
    // One bad entry does not take the good ones with it.
    expect(read({ [moon]: good, [andy]: { botUserId: andyBot, roomId: 'andy' } })).toBe(1)
  })

  it('is bounded: a record grown past what a person has is not read past its bound', () => {
    const key = `io.atum.app-bot-created:${JSON.stringify([owner, 'DEVICE'])}`

    const record = Object.fromEntries(
      Array.from({ length: 200 }, (_, n) => [
        `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        { botUserId: moonBot, roomId: `!room${n}:test` }
      ])
    )

    expect(appBotCreatedRooms(storage({ [key]: JSON.stringify(record) }), owner, 'DEVICE').read().size).toBe(64)
  })

  it('is optional memory: a device that cannot read or write it loses nothing but the memory', () => {
    const broken = {
      getItem: vi.fn(() => {
        throw new Error('storage unavailable')
      }),
      setItem: vi.fn(() => {
        throw new DOMException('full', 'QuotaExceededError')
      }),
      removeItem: vi.fn(() => {
        throw new Error('storage unavailable')
      })
    }

    const created = appBotCreatedRooms(broken, owner, 'DEVICE')

    expect(created.read().size).toBe(0)
    expect(() => created.write(moon, { botUserId: moonBot, roomId: '!moon:test' })).not.toThrow()
    expect(() => created.remove(moon)).not.toThrow()
  })
})
