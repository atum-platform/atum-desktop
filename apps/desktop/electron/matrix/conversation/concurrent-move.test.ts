import { describe, expect, it } from 'vitest'

import { decideConversationTurn, resolveConversationRoom } from '../../../shared/agent-conversation'
import type { ConversationMarker, ConversationWrite } from '../../../shared/agent-conversation/types'
import type { ConversationCandidateRead } from '../../../shared/agent-conversation/view'

import { conversationBackgroundAction } from './activity'
import type { ConversationMigrationJournal } from './migrate'
import { ConversationMigrationService } from './service'

/**
 * 2026-10-11 (0.20.0, agent 895ac081): the MacBook and the mini both ran the background move of
 * the agent's encrypted main to a plain room in the same second. Each made its own room, and
 * their marker writes interleaved: each new room ended up Earlier, pointing at the other's, and
 * no room was main. Every turn in every room was then refused as an earlier conversation, so
 * neither Mac could arm automatic listening, the mini's journal never settled, and its Hermes
 * refused to start. These tests replay that on one shared homeserver.
 */

// Preserve state, recovery and failure handling across interrupted operations.
const MACBOOK_ROOM = '!a-macbook:test'
const OLD_MAIN = '!b-old:test'
const MINI_ROOM = '!c-mini:test'

interface ServerRoom {
  roomId: string
  encrypted: boolean
  createdAt: number
  marker: ConversationMarker | null
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** The homeserver both Macs read and write: one marker per room, the last write wins. */
class Homeserver {
  readonly rooms = new Map<string, ServerRoom>()

  add(room: ServerRoom) {
    this.rooms.set(room.roomId, { ...room })
  }

  candidates(): ConversationCandidateRead[] {
    return [...this.rooms.values()]
      .sort((a, b) => (a.roomId < b.roomId ? -1 : 1))
      .map(room => ({
        roomId: room.roomId,
        read: 'readable' as const,
        writable: true,
        encrypted: room.encrypted,
        createdAt: room.createdAt,
        marker: room.marker ? { ...room.marker } : null
      }))
  }

  write(write: ConversationWrite) {
    const room = this.rooms.get(write.roomId)!

    room.marker = 'role' in write.content ? { role: write.content.role, main: write.content.main, at: write.content.at } : null
  }

  resolution() {
    return resolveConversationRoom(this.candidates())
  }

  /** The owner SDK's `findAssistantRoom`: the marked main, else the first eligible room by ID. */
  selected(): string | undefined {
    return this.resolution().main ?? this.candidates()[0]?.roomId
  }
}

/** Lets the two Macs' writes reach the server in a fixed order, as they did on 2026-10-11. */
function lockstep(order: string[]) {
  let at = 0

  return async (mac: string) => {
    for (let spins = 0; at < order.length && order[at] !== mac && spins < 200; spins++) {
      await tick()
    }

    at++
  }
}

/** One Mac's native ports around the shared service, as main.ts wires them. */
function mac(
  server: Homeserver,
  name: string,
  options: { create?: () => Promise<string>; turn?: (mac: string) => Promise<void>; journal?: ConversationMigrationJournal }
) {
  let journal: ConversationMigrationJournal | null = options.journal ? structuredClone(options.journal) : null
  const finished: string[] = []
  const created: string[] = []

  const service = new ConversationMigrationService({
    current: () => true,
    idle: () => true,
    read: async () => {
      await tick()

      return server.candidates()
    },
    knownMain: () => undefined,
    facts: async () => ({ cloudMayAnswer: false, cloudReady: false, fleetReady: true, plainReady: true }),
    jobs: async () => 0,
    write: async write => {
      await options.turn?.(name)
      server.write(write)
    },
    // main's finish: the owner's room selection must name the main this move wrote.
    finish: async main => {
      await tick()

      if (server.selected() !== main) {
        throw new Error('matrix_conversation_main_changed')
      }

      finished.push(main)
    },
    create: async reuse => {
      const room = reuse ?? (await options.create!())
      created.push(room)

      return room
    },
    readJournal: () => journal,
    saveJournal: value => {
      journal = value ? structuredClone(value) : null
    },
    changed: () => {},
    now: () => 1_000
  })

  return {
    service,
    finished,
    created,
    journal: () => journal,
    /** main's minute pass (scheduleConversationPreviews): a read-only preview, then whatever
     * native work it found, with no owner action. */
    async background() {
      const view = await service.request('preview')
      const home = finished.at(-1)
      const action = conversationBackgroundAction(view, home, home)

      return action ? service.request(action) : view
    }
  }
}

function admitted(server: Homeserver, roomId: string) {
  return decideConversationTurn({ roomId, privateAssistant: true, forTurn: true, resolution: server.resolution() }).admit
}

function encryptedMain() {
  const server = new Homeserver()
  server.add({ roomId: OLD_MAIN, encrypted: true, createdAt: 0, marker: { role: 'main', main: OLD_MAIN, at: 1 } })

  return server
}

describe('two Macs moving one agent to a plain room at once (0.20.1 incident)', () => {
  it('ends with exactly one main both Macs agree on, and turns admitted there', async () => {
    const server = encryptedMain()
    // Both Macs make their room in the same second, before either reads the rooms again.
    let made = 0
    let release!: () => void

    const both = new Promise<void>(resolve => {
      release = resolve
    })

    const create = (roomId: string, createdAt: number) => async () => {
      made++

      if (made === 2) {
        release()
      }

      await both
      server.add({ roomId, encrypted: false, createdAt, marker: null })

      return roomId
    }

    // The writes reached the server alternately, MacBook first (log of 2026-10-11T05:05:41-44Z).
    const turn = lockstep(['macbook', 'mini', 'macbook', 'mini', 'macbook', 'mini'])
    const macbook = mac(server, 'macbook', { create: create(MACBOOK_ROOM, 2), turn })
    const mini = mac(server, 'mini', { create: create(MINI_ROOM, 1), turn })

    await Promise.all([macbook.service.request('reconcile'), mini.service.request('reconcile')])
    // The move itself converges: both Macs settle on the room made first, so it never has no main.
    expect(server.resolution().main).toBe(MINI_ROOM)
    expect(macbook.created).toEqual([MACBOOK_ROOM, MINI_ROOM])
    expect(server.rooms.get(MACBOOK_ROOM)?.marker).toMatchObject({ role: 'earlier', main: MINI_ROOM })
    // A minute later each Mac's background pass runs once more.
    await macbook.background()
    await mini.background()

    const main = server.resolution().main

    expect(main).toBeDefined()
    expect(macbook.journal()).toBeNull()
    expect(mini.journal()).toBeNull()
    expect(macbook.finished.at(-1)).toBe(main)
    expect(mini.finished.at(-1)).toBe(main)
    // The new main is a plain room (the move's purpose), and the agent answers there.
    expect(server.rooms.get(main!)?.encrypted).toBe(false)
    expect(admitted(server, main!)).toBe(true)
  })

  it('a Mac whose move another Mac finished first follows that main instead of writing its own', async () => {
    const server = encryptedMain()
    let entered!: () => void
    let done!: () => void
    const macbookEntered = new Promise<void>(resolve => {
      entered = resolve
    })
    const miniDone = new Promise<void>(resolve => {
      done = resolve
    })

    // The MacBook read the rooms and started making its room; the mini's whole move lands meanwhile.
    const macbook = mac(server, 'macbook', {
      create: async () => {
        entered()
        await miniDone
        server.add({ roomId: MACBOOK_ROOM, encrypted: false, createdAt: 2, marker: null })

        return MACBOOK_ROOM
      }
    })

    const mini = mac(server, 'mini', {
      create: async () => {
        await macbookEntered
        server.add({ roomId: MINI_ROOM, encrypted: false, createdAt: 1, marker: null })

        return MINI_ROOM
      }
    })

    await Promise.all([
      macbook.service.request('reconcile'),
      mini.service.request('reconcile').finally(() => done())
    ])

    expect(server.resolution().main).toBe(MINI_ROOM)
    // The MacBook never marked its own room main: it swept it Earlier and settled on the mini's.
    expect(server.rooms.get(MACBOOK_ROOM)?.marker).toMatchObject({ role: 'earlier', main: MINI_ROOM })
    expect(macbook.finished).toEqual([MINI_ROOM])
    expect(mini.finished).toEqual([MINI_ROOM])
    expect(macbook.journal()).toBeNull()
  })

  it('restores a main from the rooms the race left, on whichever Mac looks first', async () => {
    // The rooms exactly as 0.20.0 left them: every room Earlier, none main.
    const server = new Homeserver()
    server.add({ roomId: MACBOOK_ROOM, encrypted: false, createdAt: 2, marker: { role: 'earlier', main: MINI_ROOM, at: 2 } })
    server.add({ roomId: OLD_MAIN, encrypted: true, createdAt: 0, marker: { role: 'earlier', main: MINI_ROOM, at: 2 } })
    server.add({ roomId: MINI_ROOM, encrypted: false, createdAt: 1, marker: { role: 'earlier', main: MACBOOK_ROOM, at: 1 } })
    expect(server.resolution().main).toBeUndefined()
    expect(admitted(server, MACBOOK_ROOM)).toBe(false)
    expect(admitted(server, MINI_ROOM)).toBe(false)

    // The mini's move never settled: its journal waits on effects for its own room.
    const miniJournal: ConversationMigrationJournal = {
      phase: 'effects',
      cursor: 0,
      main: MINI_ROOM,
      rooms: [MACBOOK_ROOM, OLD_MAIN, MINI_ROOM],
      writes: [
        { roomId: MINI_ROOM, content: { v: 1, role: 'main', main: MINI_ROOM, at: 1 } },
        { roomId: MACBOOK_ROOM, content: { v: 1, role: 'earlier', main: MINI_ROOM, at: 1 } },
        { roomId: OLD_MAIN, content: { v: 1, role: 'earlier', main: MINI_ROOM, at: 1 } }
      ]
    }

    for (const first of ['macbook', 'mini'] as const) {
      const rooms = new Homeserver()

      for (const room of server.rooms.values()) {
        rooms.add({ ...room, marker: room.marker ? { ...room.marker } : null })
      }

      const macbook = mac(rooms, 'macbook', {})
      const mini = mac(rooms, 'mini', { journal: miniJournal })
      const order = first === 'macbook' ? [macbook, mini] : [mini, macbook]

      for (const each of order) {
        await each.background()
      }

      const main = rooms.resolution().main

      // The plain room both crossed markers named, made first: the same pick whoever looks first.
      expect(main).toBe(MINI_ROOM)
      expect(rooms.rooms.get(main!)?.encrypted).toBe(false)
      expect(admitted(rooms, main!)).toBe(true)
      expect(mini.journal()).toBeNull()
      expect(macbook.finished.at(-1)).toBe(main)
      expect(mini.finished.at(-1)).toBe(main)
      // No room is made: the repair only marks rooms that exist.
      expect(macbook.created).toEqual([])
      expect(mini.created).toEqual([])
    }
  })

  it('two Macs repairing the rooms at the same moment settle on the same main', async () => {
    const server = new Homeserver()
    server.add({ roomId: MACBOOK_ROOM, encrypted: false, createdAt: 2, marker: { role: 'earlier', main: MINI_ROOM, at: 2 } })
    server.add({ roomId: OLD_MAIN, encrypted: true, createdAt: 0, marker: { role: 'earlier', main: MINI_ROOM, at: 2 } })
    server.add({ roomId: MINI_ROOM, encrypted: false, createdAt: 1, marker: { role: 'earlier', main: MACBOOK_ROOM, at: 1 } })
    const turn = lockstep(['macbook', 'mini', 'macbook', 'mini', 'macbook', 'mini'])
    const macbook = mac(server, 'macbook', { turn })
    const mini = mac(server, 'mini', { turn })

    await Promise.all([macbook.background(), mini.background()])

    const main = server.resolution().main

    expect(main).toBeDefined()
    expect(macbook.finished.at(-1)).toBe(main)
    expect(mini.finished.at(-1)).toBe(main)
  })
})
