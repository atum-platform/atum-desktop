import { describe, expect, it, vi } from 'vitest'

import { ACME, botApp } from '../../../shared/app-catalog.test-support'
import type { MatrixSdkCommand } from '../../../shared/matrix'
import type { AppBotDmOpened } from '../../../shared/matrix-app-bot-dm'

import { localAppChatRoom, startAppChat } from './open-chat'
import { appBotStartLogLine, platformAppChatRoom, type PlatformRoomPort } from './platform-room'

/**
 * The platform names the bot's chat (spec/canonical-room/v1.1). These tests run the real resolver
 * against a simulated platform and two simulated Macs of one person over one simulated homeserver,
 * and drive the requests by hand so each interleaving is exactly the one named. The simulated
 * platform follows the contract: a candidate is verified (the owner made and is in it; only the
 * owner and the bot are in it; not encrypted), recording is insert-if-absent, every caller is
 * answered with the winner, and a request id cannot move to another app or candidate.
 */

const OWNER = '@owner:atumplatform.com'
const app = botApp(ACME)
const BOT = app.bot.user_id

type Reply = { status: number; body?: unknown }

interface Room {
  id: string
  creator: string
  members: Record<string, 'join' | 'invite' | 'leave'>
  encrypted: boolean
  messages: number
}

class World {
  readonly rooms = new Map<string, Room>()
  private count = 0

  make(options: Partial<Omit<Room, 'id'>> = {}): Room {
    const room: Room = {
      id: `!room${++this.count}:atumplatform.com`,
      creator: OWNER,
      members: { [OWNER]: 'join', [BOT]: 'invite' },
      encrypted: false,
      messages: 0,
      ...options
    }

    this.rooms.set(room.id, room)

    return room
  }

  /** The rooms the owner is still in. */
  joined() {
    return [...this.rooms.values()].filter(room => room.members[OWNER] === 'join').map(room => room.id)
  }

  /** The platform's proof of a candidate. */
  verified(id: string): boolean {
    const room = this.rooms.get(id)

    if (!room || room.creator !== OWNER || room.encrypted || room.members[OWNER] !== 'join') {
      return false
    }

    const present = Object.entries(room.members).filter(([, membership]) => membership !== 'leave')

    return (
      present.length === 2 &&
      present.some(([userId]) => userId === BOT) &&
      present.every(([userId]) => userId === OWNER || userId === BOT)
    )
  }
}

interface Inbox {
  device: string
  slug: string
  body: Record<string, unknown>
  resolve(reply: Reply): void
  reject(error: Error): void
}

class Platform {
  canonical = new Map<string, string>()
  readonly calls: Array<{ device: string; slug: string; body: Record<string, unknown> }> = []
  readonly inbox: Inbox[] = []
  private readonly bound = new Map<string, { slug: string; roomId?: string }>()
  /** `absent`: a Shell without the route. */
  mode: 'route' | 'absent' = 'route'
  /** The app is not open to a chat; the route says why. */
  unavailable?: string
  /** Replies played before the contract answers, in order: a status, or an error (the network failed). */
  script: Array<Reply | Error | ((call: Inbox) => Reply | Error | undefined)> = []
  /** Hold every request in `inbox` until the test answers it. */
  manual = false
  /** Extra fields the answer carries (an additive change). */
  extra: Record<string, unknown> = {}

  constructor(private readonly world: World) {}

  /** The contract, for one request. */
  private handle(call: Inbox): Reply {
    if (this.mode === 'absent') {
      return { status: 404, body: { error: 'matrix_404' } }
    }

    const { body } = call
    const keys = Object.keys(body)
    const requestId = body.requestId

    if (
      typeof requestId !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(requestId) ||
      keys.some(key => !['requestId', 'appVersion', 'roomId'].includes(key))
    ) {
      return { status: 400, body: { error: 'matrix_400' } }
    }

    const bound = this.bound.get(requestId)

    if (bound && (bound.slug !== call.slug || (bound.roomId !== undefined && body.roomId !== undefined && bound.roomId !== body.roomId))) {
      return { status: 409, body: { error: 'matrix_409' } }
    }

    if (this.unavailable) {
      return { status: 200, body: { state: 'unavailable', reason: this.unavailable } }
    }

    const roomId = body.roomId as string | undefined

    if (roomId !== undefined) {
      if (!this.world.verified(roomId)) {
        return { status: 403, body: { error: 'matrix_403' } }
      }

      this.bound.set(requestId, { slug: call.slug, roomId })

      // Insert-if-absent: the first candidate wins, and every caller is answered with the winner.
      if (!this.canonical.has(call.slug)) {
        this.canonical.set(call.slug, roomId)
      }

      return { status: 200, body: { state: 'ready', roomId: this.canonical.get(call.slug), botUserId: BOT, ...this.extra } }
    }

    this.bound.set(requestId, { slug: call.slug })

    const winner = this.canonical.get(call.slug)

    return {
      status: 200,
      body: winner ? { state: 'ready', roomId: winner, botUserId: BOT, ...this.extra } : { state: 'create', botUserId: BOT, ...this.extra }
    }
  }

  private play(call: Inbox): Reply {
    const scripted = this.script.shift()
    const played = typeof scripted === 'function' ? scripted(call) : scripted

    if (played instanceof Error) {
      throw played
    }

    return played ?? this.handle(call)
  }

  start(device: string, slug: string, body: Record<string, unknown>): Promise<Reply> {
    this.calls.push({ device, slug, body: structuredClone(body) })

    return new Promise((resolve, reject) => {
      const call: Inbox = { device, slug, body, resolve, reject }

      if (this.manual) {
        this.inbox.push(call)

        return
      }

      try {
        resolve(this.play(call))
      } catch (error) {
        reject(error as Error)
      }
    })
  }

  /** Answer one held request, in the order the test chooses. */
  answer(device: string, index = 0) {
    const held = this.inbox.filter(call => call.device === device)[index]

    if (!held) {
      throw new Error(`no held request from ${device}`)
    }

    this.inbox.splice(this.inbox.indexOf(held), 1)

    try {
      held.resolve(this.play(held))
    } catch (error) {
      held.reject(error as Error)
    }
  }

  /** Process one held request as the server does, but lose the answer on its way back. */
  loseAnswer(device: string) {
    const held = this.inbox.filter(call => call.device === device)[0]!

    this.inbox.splice(this.inbox.indexOf(held), 1)
    this.handle(held)
    held.reject(new Error('network lost the answer'))
  }
}

/** One Mac of the person: the SDK steps over the shared homeserver, with its own synced pointer. */
class Device {
  pointer?: string
  selected?: string
  /** A chat made in this session, before sync brings it. */
  pending?: string
  selection = 0
  readonly commands: MatrixSdkCommand['kind'][] = []

  constructor(
    readonly name: string,
    private readonly world: World
  ) {}

  private usable(id: string | undefined): id is string {
    const room = id ? this.world.rooms.get(id) : undefined

    return Boolean(room && !room.encrypted && room.members[OWNER] === 'join')
  }

  readonly command = async (command: MatrixSdkCommand): Promise<unknown> => {
    this.commands.push(command.kind)

    if (command.kind === 'findAppBotDm') {
      const roomId = [this.pointer, this.pending].find(id => this.usable(id)) ?? null

      return { roomId, selection: this.selection }
    }

    if (command.kind === 'makeAppBotDm') {
      const room = this.world.make()
      this.pending = room.id

      return { roomId: room.id, moved: false }
    }

    if (command.kind === 'openAppBotRoom') {
      const room = this.world.rooms.get(command.roomId)

      if (room?.encrypted) {
        throw new Error('matrix_app_bot_dm_encrypted')
      }

      if (!room || room.members[OWNER] !== 'join') {
        throw new Error('matrix_app_bot_dm_invalid')
      }

      const outcome = this.pointer === room.id ? 'reused' : this.pending === room.id ? 'created' : 'recovered'
      const pointer = this.pointer === room.id ? 'kept' : 'written'
      this.pointer = room.id
      this.selected = room.id

      return {
        roomId: room.id,
        outcome,
        reason: 'canonical',
        joined: 1,
        left: 0,
        pointer,
        shown: 'none'
      } satisfies AppBotDmOpened
    }

    if (command.kind === 'leaveAppBotDm') {
      const room = this.world.rooms.get(command.roomId)
      const left = Boolean(room && room.messages === 0 && this.pointer !== room.id)

      if (left) {
        room!.members[OWNER] = 'leave'
      }

      if (this.pending === command.roomId) {
        this.pending = undefined
      }

      return { left }
    }

    // The local rule (`openAppBotDm`): the chat it has (the pointer's, or one made before sync), else a new one.
    if (command.kind === 'openAppBotDm') {
      const have = [this.pointer, this.pending].find(id => this.usable(id))
      const room = have ? this.world.rooms.get(have)! : this.world.make()
      const outcome = this.pointer === room.id ? 'reused' : have ? 'recovered' : 'created'
      this.pointer = room.id
      this.selected = room.id

      return {
        roomId: room.id,
        outcome,
        reason: outcome === 'reused' ? 'pointer' : outcome === 'recovered' ? 'pointer_missing' : 'first_use',
        joined: 1,
        left: 0,
        pointer: outcome === 'reused' ? 'kept' : 'written',
        shown: 'none'
      } satisfies AppBotDmOpened
    }

    throw new Error(`unexpected command ${command.kind}`)
  }
}

const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function setup() {
  const world = new World()
  const platform = new Platform(world)
  const a = new Device('A', world)
  const b = new Device('B', world)

  const resolver = (
    device: Device,
    prefix: string,
    overrides: Partial<PlatformRoomPort> = {},
    target = app
  ) => {
    const ids = { n: 0 }
    const logs: string[] = []
    const local = localAppChatRoom(device.command)
    const fallback = vi.fn(local)

    const port: PlatformRoomPort = {
      start: (slug, body) => platform.start(device.name, slug, { ...body }),
      command: device.command,
      fallback,
      requestId: () => uuid(prefix, ++ids.n),
      appVersion: '0.20.17',
      current: () => true,
      log: line => logs.push(line),
      ...overrides
    }

    return { resolve: () => platformAppChatRoom(port)(target), fallback, logs }
  }

  return { world, platform, a, b, resolver }
}

/** Let the resolvers run until they wait for the platform or finish. */
const settle = () => new Promise<void>(done => setTimeout(done, 0))

describe('signed Bot API first contact', () => {
  it('creates the ordinary direct room without calling the legacy bot/start route', async () => {
    const { world, platform, a, resolver } = setup()
    const botApiApp = botApp(ACME, {}, { transport_mode: 'bot_api' })
    const first = resolver(a, 'a', {}, botApiApp)

    await expect(first.resolve()).resolves.toMatchObject({ outcome: 'created', reason: 'first_use' })
    expect(world.rooms.size).toBe(1)
    expect(a.commands).toEqual(['openAppBotDm'])
    expect(first.fallback).toHaveBeenCalledExactlyOnceWith(botApiApp)
    expect(platform.calls).toEqual([])
    expect(first.logs).toEqual([])
  })
})

describe('two Macs starting the same app’s chat at once', () => {
  it('ends in one chat when both are told to create: the first candidate is kept and the other is left', async () => {
    const { world, platform, a, b, resolver } = setup()
    platform.manual = true
    const first = resolver(a, 'a')
    const second = resolver(b, 'b')
    const startA = first.resolve()
    const startB = second.resolve()
    await settle()

    // Both asked with nothing but their attempt: no owner, bot or app authority, no room.
    expect(platform.inbox.map(call => [call.device, call.body])).toEqual([
      ['A', { requestId: uuid('a', 1), appVersion: '0.20.17' }],
      ['B', { requestId: uuid('b', 1), appVersion: '0.20.17' }]
    ])
    platform.answer('A')
    platform.answer('B')
    await settle()

    // Both heard "create", and each made a plain chat of its own.
    expect(world.rooms.size).toBe(2)
    const [roomA, roomB] = [a.pending!, b.pending!]
    expect(roomA).not.toBe(roomB)
    expect(platform.inbox.map(call => [call.device, call.body])).toEqual([
      ['A', { requestId: uuid('a', 1), appVersion: '0.20.17', roomId: roomA }],
      ['B', { requestId: uuid('b', 1), appVersion: '0.20.17', roomId: roomB }]
    ])

    // A's candidate reaches the platform first and is kept; B is told the winner.
    platform.answer('A')
    platform.answer('B')

    const [openedA, openedB] = await Promise.all([startA, startB])

    expect(platform.canonical.get('acme')).toBe(roomA)
    expect(openedA).toMatchObject({ roomId: roomA, outcome: 'created', reason: 'canonical' })
    expect(openedB).toMatchObject({ roomId: roomA, outcome: 'recovered', reason: 'canonical' })
    expect([a.selected, b.selected, a.pointer, b.pointer]).toEqual([roomA, roomA, roomA, roomA])
    // B left its empty candidate; A kept its own. One chat remains.
    expect(world.joined()).toEqual([roomA])
    expect(b.commands).toContain('leaveAppBotDm')
    expect(a.commands).not.toContain('leaveAppBotDm')
  })

  it('ends in the same one chat whichever candidate reaches the platform first', async () => {
    const { world, platform, a, b, resolver } = setup()
    platform.manual = true
    const startA = resolver(a, 'a').resolve()
    const startB = resolver(b, 'b').resolve()
    await settle()
    platform.answer('A')
    platform.answer('B')
    await settle()

    const [roomA, roomB] = [a.pending!, b.pending!]

    platform.answer('B')
    platform.answer('A')
    await Promise.all([startA, startB])

    expect(platform.canonical.get('acme')).toBe(roomB)
    expect([a.selected, b.selected]).toEqual([roomB, roomB])
    expect(world.joined()).toEqual([roomB])
    expect(world.rooms.get(roomA)!.members[OWNER]).toBe('leave')
  })

  it('makes nothing when the other Mac already won: the first call is answered with its room', async () => {
    const { world, platform, a, b, resolver } = setup()

    const openedA = await resolver(a, 'a').resolve()
    const openedB = await resolver(b, 'b').resolve()

    expect(world.rooms.size).toBe(1)
    expect(openedB).toMatchObject({ roomId: openedA.roomId, outcome: 'recovered', reason: 'canonical' })
    expect(b.commands).toEqual(['findAppBotDm', 'openAppBotRoom'])
    expect(platform.calls.map(call => call.body)).toEqual([
      { requestId: uuid('a', 1), appVersion: '0.20.17' },
      { requestId: uuid('a', 1), appVersion: '0.20.17', roomId: openedA.roomId },
      { requestId: uuid('b', 1), appVersion: '0.20.17' }
    ])
  })

  it('offers the chat a Mac already has, so the platform keeps it and no second chat is made', async () => {
    const { world, platform, a, b, resolver } = setup()
    const history = world.make({ messages: 12 })
    a.pointer = history.id

    const openedA = await resolver(a, 'a').resolve()

    expect(openedA).toMatchObject({ roomId: history.id, outcome: 'reused', reason: 'canonical' })
    expect(platform.calls[0]!.body).toEqual({ requestId: uuid('a', 1), appVersion: '0.20.17', roomId: history.id })
    expect(platform.canonical.get('acme')).toBe(history.id)

    // The other Mac has not synced that chat: it is told, and opens it.
    await expect(resolver(b, 'b').resolve()).resolves.toMatchObject({ roomId: history.id, outcome: 'recovered' })
    expect(world.rooms.size).toBe(1)
    expect(b.commands).not.toContain('makeAppBotDm')
  })

  it('opens the winner when each Mac offers a chat of its own, and leaves the other one alone', async () => {
    const { world, platform, a, b, resolver } = setup()
    const roomA = world.make({ messages: 3 })
    const roomB = world.make({ messages: 2 })
    a.pointer = roomA.id
    b.pointer = roomB.id
    platform.manual = true
    const startA = resolver(a, 'a').resolve()
    const startB = resolver(b, 'b').resolve()
    await settle()
    platform.answer('A')
    platform.answer('B')

    const [openedA, openedB] = await Promise.all([startA, startB])

    expect(platform.canonical.get('acme')).toBe(roomA.id)
    expect(openedA).toMatchObject({ roomId: roomA.id, outcome: 'reused' })
    expect(openedB).toMatchObject({ roomId: roomA.id, outcome: 'recovered' })
    // B's own chat has a history: B's Mac is asked to leave a chat that lost, and keeps this one.
    expect(world.rooms.get(roomB.id)!.members[OWNER]).toBe('join')
    expect(world.rooms.get(roomA.id)!.members[OWNER]).toBe('join')
  })

  it('leaves the empty chat a Mac offered when the platform keeps another Mac’s, and no other', async () => {
    const { world, platform, a, resolver } = setup()
    const winner = world.make({ messages: 4 })
    const empty = world.make()
    const talked = world.make({ messages: 2 })
    platform.canonical.set('acme', winner.id)

    // A's pointer names an empty chat; the other Mac's chat was kept.
    a.pointer = empty.id
    await expect(resolver(a, 'a').resolve()).resolves.toMatchObject({ roomId: winner.id, outcome: 'recovered' })
    expect(world.rooms.get(empty.id)!.members[OWNER]).toBe('leave')

    // A chat with a history is never left.
    a.pointer = talked.id
    await expect(resolver(a, 'a').resolve()).resolves.toMatchObject({ roomId: winner.id })
    expect(world.rooms.get(talked.id)!.members[OWNER]).toBe('join')
  })

  it('does not leave its candidate when the local rule opened a chat instead of the room the platform named', async () => {
    const { world, platform, a, resolver } = setup()
    // The room the platform keeps first is one this Mac cannot open as the bot's chat.
    const closed = world.make({ members: { [OWNER]: 'leave', [BOT]: 'join' } })
    platform.script = [
      undefined,
      call => {
        platform.canonical.set(call.slug, closed.id)

        return { status: 200, body: { state: 'ready', roomId: closed.id, botUserId: BOT } }
      }
    ]

    const attempt = resolver(a, 'a')
    const opened = await attempt.resolve()

    // The local rule found the chat made a moment ago and opened it; it was not left.
    expect(attempt.fallback).toHaveBeenCalledOnce()
    expect(opened).toMatchObject({ roomId: a.pending, outcome: 'recovered' })
    expect(a.commands).not.toContain('leaveAppBotDm')
    expect(world.rooms.get(a.pending!)!.members[OWNER]).toBe('join')
  })

  it('never leaves a candidate that someone has written in', async () => {
    const { world, platform, a, b, resolver } = setup()
    platform.manual = true
    const startA = resolver(a, 'a').resolve()
    const startB = resolver(b, 'b').resolve()
    await settle()
    platform.answer('A')
    platform.answer('B')
    await settle()

    const [roomA, roomB] = [a.pending!, b.pending!]

    // The bot greeted B's chat while the platform was deciding.
    world.rooms.get(roomB)!.messages = 1
    platform.answer('A')
    platform.answer('B')
    await Promise.all([startA, startB])

    expect(b.selected).toBe(roomA)
    expect(world.joined().sort()).toEqual([roomA, roomB].sort())
  })
})

describe('a start whose answers get lost', () => {
  it('asks again with the same attempt, and one chat is made', async () => {
    const { world, platform, a, resolver } = setup()
    platform.manual = true
    const start = resolver(a, 'a').resolve()
    await settle()
    platform.answer('A')
    await settle()

    // The platform keeps the candidate, but the answer is lost on its way back.
    platform.loseAnswer('A')
    await settle()

    // The same request again: same attempt, same candidate.
    expect(platform.inbox.map(call => call.body)).toEqual([
      { requestId: uuid('a', 1), appVersion: '0.20.17', roomId: a.pending }
    ])
    platform.answer('A')

    await expect(start).resolves.toMatchObject({ roomId: a.pending, outcome: 'created' })
    expect(world.rooms.size).toBe(1)
    expect(a.commands).not.toContain('leaveAppBotDm')
  })

  it('keeps the candidate when no answer comes back, and the next start offers it instead of making another', async () => {
    const { world, platform, a, resolver } = setup()
    const attempt = resolver(a, 'a')

    // The first call is answered; both tries of the second are lost after the platform kept the room.
    platform.script = [
      undefined,
      call => {
        platform.canonical.set(call.slug, a.pending!)

        return new Error('network lost the answer')
      },
      new Error('network lost the answer')
    ]
    await expect(attempt.resolve()).rejects.toThrow('matrix_app_bot_resting')
    expect(world.rooms.size).toBe(1)
    expect(a.commands).not.toContain('leaveAppBotDm')

    // The next start finds the candidate, offers it as the room, and opens what the platform kept.
    const kept = a.pending!
    await expect(attempt.resolve()).resolves.toMatchObject({ roomId: kept, reason: 'canonical' })
    expect(world.rooms.size).toBe(1)
    expect(platform.calls.at(-1)!.body).toMatchObject({ requestId: uuid('a', 2), roomId: kept })
  })

  it('never makes a second chat when the platform cannot be asked and the Mac has none', async () => {
    const { world, platform, a, resolver } = setup()
    platform.script = [{ status: 503 }, { status: 503 }]
    const attempt = resolver(a, 'a')

    await expect(attempt.resolve()).rejects.toThrow('matrix_app_bot_resting')
    expect(world.rooms.size).toBe(0)
    // One ask, repeated with the same body (the route is idempotent on the attempt).
    expect(platform.calls.map(call => call.body)).toEqual([
      { requestId: uuid('a', 1), appVersion: '0.20.17' },
      { requestId: uuid('a', 1), appVersion: '0.20.17' }
    ])
    expect(attempt.fallback).not.toHaveBeenCalled()
  })

  it.each([
    ['a server error twice', [{ status: 502 }, { status: 502 }]],
    ['the network failing twice', [new Error('offline'), new Error('offline')]],
    ['a rate limit', [{ status: 429 }]],
    ['a refused bearer', [{ status: 401 }]],
    ['an answer that is not one', [{ status: 200, body: { state: 'ready' } }]]
  ])('opens the chat a Mac already has when the platform cannot be asked: %s', async (_case, script) => {
    const { world, platform, a, resolver } = setup()
    const history = world.make({ messages: 5 })
    a.pointer = history.id
    platform.script = script as Platform['script']
    const attempt = resolver(a, 'a')

    await expect(attempt.resolve()).resolves.toMatchObject({ roomId: history.id, outcome: 'reused', reason: 'pointer' })
    expect(attempt.fallback).toHaveBeenCalledOnce()
    expect(world.rooms.size).toBe(1)
  })

  it('does not ask again after the account changed', async () => {
    const { platform, a, resolver } = setup()
    platform.script = [new Error('matrix_not_ready')]
    const attempt = resolver(a, 'a')

    await expect(attempt.resolve()).rejects.toThrow('matrix_not_ready')
    expect(platform.calls).toHaveLength(1)
    expect(attempt.fallback).not.toHaveBeenCalled()
  })

  it('stops between steps once the account is gone, and makes nothing', async () => {
    const { world, platform, a, resolver } = setup()
    let live = true
    platform.script = [
      () => {
        live = false

        return undefined
      }
    ]

    await expect(resolver(a, 'a', { current: () => live }).resolve()).rejects.toThrow('matrix_not_ready')
    expect(world.rooms.size).toBe(0)
    expect(a.commands).toEqual(['findAppBotDm'])
  })
})

describe('a room the platform kept that sync has not brought here yet', () => {
  it('fails with the SDK’s closed code, leaves the candidate in place, and opens that same room on the next start', async () => {
    const { world, platform, a, resolver } = setup()
    let synced = false

    const attempt = resolver(a, 'a', {
      // The SDK selects a room only once it has synced here (src/matrix/app-bot-room-wait.ts).
      command: async command => {
        if (command.kind === 'openAppBotRoom' && !synced) {
          throw new Error('matrix_app_bot_syncing')
        }

        return a.command(command)
      }
    })

    // The platform kept the room this Mac made, but the window cannot show it yet.
    await expect(attempt.resolve()).rejects.toThrow('matrix_app_bot_syncing')
    const made = a.pending!
    expect(platform.canonical.get('acme')).toBe(made)
    expect(world.rooms.size).toBe(1)
    // Nothing was thrown away: the candidate is still this Mac’s, and not left.
    expect(a.commands).not.toContain('leaveAppBotDm')
    expect(world.rooms.get(made)!.members[OWNER]).toBe('join')
    expect(a.selected).toBeUndefined()

    // Sync has brought it. The next start offers the same room and opens it; no second room is made.
    synced = true
    await expect(attempt.resolve()).resolves.toMatchObject({ roomId: made, outcome: 'created', reason: 'canonical' })
    expect(world.rooms.size).toBe(1)
    expect(a.selected).toBe(made)
    expect(platform.calls.at(-1)!.body).toMatchObject({ roomId: made })
  })

  it('leaves its own candidate only after the room the platform names has opened', async () => {
    const { world, platform, a, b, resolver } = setup()

    // B won first: its room is the platform's.
    const won = await resolver(b, 'b').resolve()
    let synced = false

    const attempt = resolver(a, 'a', {
      command: async command => {
        if (command.kind === 'openAppBotRoom' && !synced) {
          throw new Error('matrix_app_bot_syncing')
        }

        return a.command(command)
      }
    })

    // A is told the winner's room, which has not synced to A: A fails with the candidate it had made
    // still in place (it is not left until the winner opens).
    platform.script = [{ status: 200, body: { state: 'create', botUserId: BOT } }]
    await expect(attempt.resolve()).rejects.toThrow('matrix_app_bot_syncing')
    expect(a.commands).not.toContain('leaveAppBotDm')
    const candidate = a.pending!
    expect(world.rooms.get(candidate)!.members[OWNER]).toBe('join')

    synced = true
    await expect(attempt.resolve()).resolves.toMatchObject({ roomId: won.roomId, outcome: 'recovered' })
    expect(a.commands).toContain('leaveAppBotDm')
    expect(world.rooms.get(candidate)!.members[OWNER]).toBe('leave')
  })
})

describe('what the platform can answer instead', () => {
  it('falls back to the local rule on a Shell without the route (404), making and asking nothing more', async () => {
    const { world, platform, a, resolver } = setup()
    platform.mode = 'absent'
    const attempt = resolver(a, 'a')

    await expect(attempt.resolve()).resolves.toMatchObject({ outcome: 'created', reason: 'first_use' })
    expect(attempt.fallback).toHaveBeenCalledOnce()
    expect(platform.calls).toHaveLength(1)
    expect(a.commands).toEqual(['findAppBotDm', 'openAppBotDm'])
    expect(world.rooms.size).toBe(1)
    expect(attempt.logs).toContain('[Matrix] app bot start app=acme step=first answer=absent')
  })

  it.each([
    ['app_unavailable', 'matrix_app_bot_unavailable'],
    ['bot_unavailable', 'matrix_app_bot_resting'],
    ['not_published', 'matrix_app_bot_unavailable'],
    ['a_reason_from_the_future', 'matrix_app_bot_unavailable'],
    // Words every object has are no reason at all.
    ['constructor', 'matrix_app_bot_unavailable'],
    ['__proto__', 'matrix_app_bot_unavailable']
  ])('refuses with the app’s unavailable state when the platform says %s, and opens nothing', async (reason, code) => {
    const { world, platform, a, resolver } = setup()
    platform.unavailable = reason
    // Even a chat the Mac has is not opened: the platform's word is the fresher one.
    a.pointer = world.make({ messages: 4 }).id

    await expect(resolver(a, 'a').resolve()).rejects.toThrow(code)
    expect(a.commands).toEqual(['findAppBotDm'])
    expect(world.rooms.size).toBe(1)
  })

  it('refuses a bot that is not the catalog’s: the app changed while the chat was opening', async () => {
    const { platform, a, resolver } = setup()
    platform.script = [{ status: 200, body: { state: 'ready', roomId: '!x:atumplatform.com', botUserId: '@app-other:atumplatform.com' } }]

    await expect(resolver(a, 'a').resolve()).rejects.toThrow('matrix_app_bot_changed')
    expect(a.commands).toEqual(['findAppBotDm'])
  })

  it('refuses an answer from the SDK it cannot read, before asking the platform anything', async () => {
    const { platform, a, resolver } = setup()

    await expect(resolver(a, 'a', { command: async () => ({ roomId: 7 }) }).resolve()).rejects.toThrow(
      'matrix_app_bot_dm_invalid'
    )
    expect(platform.calls).toHaveLength(0)
  })

  it('sends no version hint the route would refuse', async () => {
    const { platform, a, resolver } = setup()

    await resolver(a, 'a', { appVersion: 'has a space' }).resolve()
    expect(platform.calls[0]!.body).toEqual({ requestId: uuid('a', 1) })
  })

  it('reads the platform’s answer by what it means and ignores a field it does not know', async () => {
    const { world, platform, a, resolver } = setup()
    platform.extra = { added_later: { anything: true } }

    const opened = await resolver(a, 'a').resolve()

    expect(opened).toMatchObject({ roomId: a.pending, outcome: 'created' })
    expect(world.rooms.size).toBe(1)
  })

  it('asks again without a chat the platform will not keep, under a new attempt, and leaves that chat alone', async () => {
    const { world, platform, a, resolver } = setup()
    // A chat the bot made: the platform requires the owner to have made it.
    const strange = world.make({ creator: BOT, messages: 2 })
    a.pointer = strange.id

    const opened = await resolver(a, 'a').resolve()

    expect(platform.calls.map(call => call.body)).toEqual([
      { requestId: uuid('a', 1), appVersion: '0.20.17', roomId: strange.id },
      { requestId: uuid('a', 2), appVersion: '0.20.17' },
      { requestId: uuid('a', 2), appVersion: '0.20.17', roomId: a.pending }
    ])
    expect(opened).toMatchObject({ roomId: a.pending, outcome: 'created' })
    expect(world.rooms.get(strange.id)!.members[OWNER]).toBe('join')
  })

  it('asks again under a new attempt when the platform saw the id with other input', async () => {
    const { platform, a, resolver } = setup()
    platform.script = [{ status: 409, body: { error: 'matrix_409' } }]

    await expect(resolver(a, 'a').resolve()).resolves.toMatchObject({ reason: 'canonical' })
    expect(platform.calls.map(call => call.body.requestId)).toEqual([uuid('a', 1), uuid('a', 2), uuid('a', 2)])
  })

  it('does not ask again for a request the platform calls malformed', async () => {
    const { world, platform, a, resolver } = setup()
    platform.script = [{ status: 400, body: { error: 'matrix_400' } }]

    await expect(resolver(a, 'a').resolve()).rejects.toThrow('matrix_app_bot_unavailable')
    expect(platform.calls).toHaveLength(1)
    expect(world.rooms.size).toBe(0)
  })

  it('leaves its candidate when the platform will not keep it and names no other', async () => {
    const { world, platform, a, resolver } = setup()
    platform.script = [undefined, { status: 200, body: { state: 'create', botUserId: BOT } }]

    await expect(resolver(a, 'a').resolve()).rejects.toThrow('matrix_app_bot_unavailable')
    expect(world.joined()).toEqual([])
  })

  it('keeps its candidate when the platform says the app is unavailable after it was made', async () => {
    const { world, platform, a, resolver } = setup()

    platform.script = [
      undefined,
      () => {
        platform.unavailable = 'bot_unavailable'

        return undefined
      }
    ]
    await expect(resolver(a, 'a').resolve()).rejects.toThrow('matrix_app_bot_resting')
    // Kept: the next start offers it.
    expect(world.joined()).toEqual([a.pending])
  })
})

describe('a chat from before 0.20 that the platform names', () => {
  it('is never opened as the bot’s chat: the local rule moves out of it, and nothing is left', async () => {
    const { world, platform, a, resolver } = setup()
    const old = world.make({ encrypted: true, messages: 30 })
    platform.canonical.set('acme', old.id)
    const attempt = resolver(a, 'a')

    await expect(attempt.resolve()).resolves.toMatchObject({ outcome: 'created', reason: 'first_use' })
    expect(attempt.fallback).toHaveBeenCalledOnce()
    expect(a.commands).toEqual(['findAppBotDm', 'openAppBotRoom', 'openAppBotDm'])
    expect(world.rooms.get(old.id)!.members[OWNER]).toBe('join')
    expect(attempt.logs).toContain('[Matrix] app bot start app=acme step=open answer=local')
  })

  it('falls back the same way for a room that is not the bot’s one-to-one chat here', async () => {
    const { world, platform, a, resolver } = setup()
    const left = world.make({ members: { [OWNER]: 'leave', [BOT]: 'join' } })
    platform.canonical.set('acme', left.id)
    const attempt = resolver(a, 'a')

    await expect(attempt.resolve()).resolves.toMatchObject({ reason: 'first_use' })
    expect(attempt.fallback).toHaveBeenCalledOnce()
  })
})

describe('the action around the resolver', () => {
  it('writes what the platform said and what the open did, in closed words', async () => {
    const { platform, a, resolver } = setup()
    const attempt = resolver(a, 'a')
    const logs: string[] = []

    const room = await startAppChat({
      descriptor: () => app,
      current: () => true,
      resolveRoom: () => attempt.resolve(),
      slug: 'acme',
      log: line => logs.push(line)
    })

    expect(room).toBe(a.selected)
    expect(attempt.logs).toEqual([
      '[Matrix] app bot start app=acme step=first answer=create',
      '[Matrix] app bot start app=acme step=second answer=ready'
    ])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(
      /^\[Matrix\] app bot open app=acme outcome=created reason=canonical room=[0-9a-f]+ joined=1 left=0 pointer=written shown=none$/u
    )
    expect(platform.canonical.get('acme')).toBe(room)
  })

  it('names a refusal by its closed code and logs no text', async () => {
    const { platform, a, resolver } = setup()
    platform.unavailable = 'bot_unavailable'
    const logs: string[] = []

    await expect(
      startAppChat({
        descriptor: () => app,
        current: () => true,
        resolveRoom: () => resolver(a, 'a').resolve(),
        slug: 'acme',
        log: line => logs.push(line)
      })
    ).rejects.toThrow('matrix_app_bot_resting')
    expect(logs).toEqual(['[Matrix] app bot open app=acme outcome=failed code=matrix_app_bot_resting'])
  })

  it('writes only the app, the step and a closed answer', () => {
    expect(appBotStartLogLine('acme', 'first', { kind: 'unavailable', reason: 'bot_unavailable' })).toBe(
      '[Matrix] app bot start app=acme step=first answer=unavailable reason=bot_unavailable'
    )
    expect(appBotStartLogLine('acme', 'first', { kind: 'unavailable', reason: 'someone@example.com' })).toBe(
      '[Matrix] app bot start app=acme step=first answer=unavailable reason=unknown'
    )
    expect(appBotStartLogLine('acme', 'first', { kind: 'unavailable', reason: 'constructor' })).toBe(
      '[Matrix] app bot start app=acme step=first answer=unavailable reason=unknown'
    )
    expect(appBotStartLogLine('Not A Slug', 'second', { kind: 'refused', status: 403 })).toBe(
      '[Matrix] app bot start app=unknown step=second answer=refused status=403'
    )
  })
})
