import { createHash } from 'node:crypto'

import { EventType } from 'matrix-js-sdk'
import type { IStateEventWithRoomId, MatrixClient } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type BoundRoomScan, discoveryReport, findBoundRoom } from './joined-room-discovery'

const TYPE = 'com.atum.test_room'
const MANAGER = '@manager:test'
const STRANGER = '@stranger:test'

function creation(roomId: string, content: Record<string, unknown>, sender = MANAGER): IStateEventWithRoomId {
  return {
    type: EventType.RoomCreate,
    state_key: '',
    room_id: roomId,
    content,
    event_id: `$create-${roomId}`,
    sender,
    origin_server_ts: 1
  }
}

const ours = (roomId: string) => [creation(roomId, { type: TYPE, bound: 'ours' })]
const stranger = (roomId: string) => [creation(roomId, { type: 'm.space' })]
// A room that exists but whose state answer carries no create event: an incomplete read, never a verdict.
const incomplete: IStateEventWithRoomId[] = []

const scan: BoundRoomScan<string> = {
  roomType: TYPE,
  binding: (content, sender) => content.type === TYPE && sender === MANAGER && typeof content.bound === 'string'
    ? content.bound : undefined,
  matches: binding => binding === 'ours',
  conflict: () => { throw new Error('conflict') },
  denied: () => { throw new Error('denied') },
  reported: true
}

interface Harness {
  client: MatrixClient
  reads: string[]
  leaves: string[]
  peak(): number
  leavePeak(): number
  /** The state the server answers for a room; replaceable between passes. */
  server: Record<string, IStateEventWithRoomId[]>
  /** What the synced room cache claims for a room's type; replaceable between passes. */
  local: Record<string, string | undefined | 'absent'>
  /** The create event the synced copy of a room holds, for a room that has one. */
  created: Record<string, { sender: string; content: Record<string, unknown> }>
  /** Rooms whose state the server refuses to show, with the HTTP status it answers. */
  refuse: Record<string, number | undefined>
  /** Leaving a room fails. */
  failLeave: boolean
}

function harness(server: Record<string, IStateEventWithRoomId[]>, defer = false): Harness {
  const reads: string[] = []
  const leaves: string[] = []
  let inFlight = 0
  let peak = 0
  let leaving = 0
  let leavePeak = 0

  // Hold a call open for one macrotask so calls that are allowed to overlap really do overlap.
  const hold = async () => {
    if (defer) {await new Promise<void>(resolve => setImmediate(resolve))}
  }

  const value: Harness = {
    reads, leaves, server, local: {}, created: {}, refuse: {}, failLeave: false,
    peak: () => peak, leavePeak: () => leavePeak,
    client: {
      getUserId: () => MANAGER,
      getJoinedRooms: async () => ({ joined_rooms: Object.keys(value.server) }),
      getRoom: (id: string) => {
        const type = value.local[id]

        if (type === 'absent' || !(id in value.local)) {return null}
        const made = value.created[id]

        return {
          getType: () => type,
          currentState: {
            getStateEvents: () => made ? { getSender: () => made.sender, getContent: () => made.content } : null
          }
        }
      },
      roomState: async (id: string) => {
        reads.push(id)
        inFlight += 1
        peak = Math.max(peak, inFlight)

        try {
          await hold()

          if (id in value.refuse) {throw Object.assign(new Error('state refused'), { httpStatus: value.refuse[id] })}

          return value.server[id] ?? []
        } finally {
          inFlight -= 1
        }
      },
      leave: async (id: string) => {
        leaves.push(id)
        leaving += 1
        leavePeak = Math.max(leavePeak, leaving)

        try {
          await hold()

          if (value.failLeave) {throw new Error('leave failed')}
          delete value.server[id]

          return {}
        } finally {
          leaving -= 1
        }
      }
    } as unknown as MatrixClient
  }

  return value
}

const find = (h: Harness, active: () => boolean = () => true) => findBoundRoom(h.client, active, scan)

describe('joined-room discovery', () => {
  it('never has more than 50 state reads in flight, however many rooms are unclassified', async () => {
    const server: Record<string, IStateEventWithRoomId[]> = {}

    for (let index = 0; index < 230; index++) {
      const id = `!stranger-${String(index).padStart(3, '0')}:test`

      server[id] = stranger(id)
    }

    server['!ours:test'] = ours('!ours:test')
    const h = harness(server, true)

    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads).toHaveLength(231)
    // Bounded, and genuinely parallel (a serial loop would peak at 1).
    expect(h.peak()).toBeLessThanOrEqual(50)
    expect(h.peak()).toBe(50)
  })

  it('settles a room only from a create event the server returned, and never reads it again', async () => {
    const h = harness({
      '!ours:test': ours('!ours:test'), '!space:test': stranger('!space:test'),
      '!lookalike:test': [creation('!lookalike:test', { type: TYPE, bound: 'theirs' })],
      // The right type and binding, but not created by the manager: a different binding, so a permanent negative too.
      '!forged:test': [creation('!forged:test', { type: TYPE, bound: 'ours' }, '@someone-else:test')]
    })

    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads).toHaveLength(4)
    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads).toHaveLength(4)
  })

  it('treats an unknown local type as unknown: it reads the room and remembers only what the server said', async () => {
    const h = harness({ '!ours:test': ours('!ours:test'), '!plain:test': stranger('!plain:test') })

    h.local = { '!ours:test': undefined, '!plain:test': undefined }
    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads.sort()).toEqual(['!ours:test', '!plain:test'])
    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads).toHaveLength(2)
  })

  it('does not hide an incompletely synced room: it is not cached as a negative, and is found once it is complete', async () => {
    const h = harness({ '!ours:test': incomplete })

    // Neither the cache nor the server can say anything yet. "No such room" would invite a second create: refuse.
    h.local = { '!ours:test': undefined }
    await expect(find(h)).rejects.toThrow('denied')
    await expect(find(h)).rejects.toThrow('denied')
    expect(h.reads).toEqual(['!ours:test', '!ours:test'])

    // The room finishes syncing: it is read again, found, and remembered.
    h.server['!ours:test'] = ours('!ours:test')
    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads).toHaveLength(3)
    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads).toHaveLength(3)
  })

  it('never lets the synced cache settle a room: a wrong local type hides it for one pass, not forever', async () => {
    const h = harness({ '!ours:test': ours('!ours:test') })

    h.local = { '!ours:test': 'm.space' }
    // A known, different local type lets the pass skip the room for free...
    await expect(find(h)).resolves.toBeNull()
    expect(h.reads).toEqual([])
    // ...but nothing was recorded, so the corrected cache finds it on the next pass.
    h.local = { '!ours:test': TYPE }
    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads).toEqual(['!ours:test'])
  })

  it('returns a bound room it positively read even while another room is unreadable, and re-reads only the unreadable one', async () => {
    const h = harness({ '!ours:test': ours('!ours:test'), '!broken:test': incomplete })

    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads.sort()).toEqual(['!broken:test', '!ours:test'])
    await expect(find(h)).resolves.toBe('!ours:test')
    expect(h.reads.sort()).toEqual(['!broken:test', '!broken:test', '!ours:test'])
  })

  it('keeps the conflict rule and stops when authority is withdrawn', async () => {
    const twins = harness({ '!a:test': ours('!a:test'), '!b:test': ours('!b:test') })

    await expect(find(twins)).rejects.toThrow('conflict')

    let active = true
    const h = harness({ '!ours:test': ours('!ours:test') })

    h.client.roomState = (async () => { active = false;

 return ours('!ours:test') }) as never
    await expect(find(h, () => active)).rejects.toThrow('denied')
  })
})

const hash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16)

type Made = 'foreign' | 'lookalike' | 'other' | 'target' | 'unknown'

/** A joined room that never gives its create event; its synced create event, if it has one, says who made it and for what. */
function unreadableRoom(h: Harness, id: string, made: Made) {
  h.server[id] = incomplete
  h.local[id] = undefined

  if (made === 'foreign') {h.created[id] = { sender: STRANGER, content: { type: 'm.space' } }}

  // Someone else's room claiming our type and binding is still not the manager's: the manager did not create it.
  if (made === 'lookalike') {h.created[id] = { sender: STRANGER, content: { type: TYPE, bound: 'ours' } }}

  if (made === 'other') {h.created[id] = { sender: MANAGER, content: { type: TYPE, bound: 'theirs' } }}

  if (made === 'target') {h.created[id] = { sender: MANAGER, content: { type: TYPE, bound: 'ours' } }}
}

describe('rooms whose create event cannot be read', () => {
  afterEach(() => { vi.useRealTimers() })

  /** One pass at each instant, in order, each expected to answer `outcome`. */
  async function passAt(h: Harness, times: number[], outcome: string | null) {
    for (const at of times) {
      vi.setSystemTime(at)
      await expect(find(h)).resolves.toBe(outcome)
    }
  }

  it('leaves a foreign room only after 3 consecutive unreadable passes spanning a minute, and it never blocks "none found"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!stranger:test', 'foreign')
    unreadableRoom(h, '!lookalike:test', 'lookalike')

    // Three passes inside a minute: the rooms are not even a reason to refuse, let alone to leave them.
    await passAt(h, [0, 30_000, 59_999], null)
    expect(h.leaves).toEqual([])

    await passAt(h, [60_000], null)
    expect(h.leaves.sort()).toEqual(['!lookalike:test', '!stranger:test'])

    // They are gone from the account: no further reads, no second leave.
    const reads = h.reads.length

    await passAt(h, [90_000], null)
    expect(h.reads).toHaveLength(reads)
    expect(h.leaves).toHaveLength(2)
  })

  it('stops a foreign unreadable room blocking a family that does not journal leaves, but never leaves it there', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!stranger:test', 'foreign')

    for (const at of [0, 30_000, 60_000, 600_000]) {
      vi.setSystemTime(at)
      await expect(findBoundRoom(h.client, () => true, { ...scan, reported: false })).resolves.toBeNull()
    }

    expect(h.leaves).toEqual([])
  })

  it('needs three passes as well as a minute: two passes far apart leave nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!stranger:test', 'foreign')
    await passAt(h, [0, 120_000], null)
    expect(h.leaves).toEqual([])

    await passAt(h, [120_001], null)
    expect(h.leaves).toEqual(['!stranger:test'])
  })

  it('never leaves a room that becomes readable before the window is out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!stranger:test', 'foreign')
    await passAt(h, [0, 30_000, 50_000], null)

    // The server answers at last: the room is read, settled as not ours, and never read (or left) again.
    h.server['!stranger:test'] = stranger('!stranger:test')
    await passAt(h, [61_000, 600_000], null)
    expect(h.leaves).toEqual([])
    expect(h.reads.filter(id => id === '!stranger:test')).toHaveLength(4)
  })

  it('starts the streak afresh when a room that left the account comes back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!stranger:test', 'foreign')
    await passAt(h, [0, 30_000], null)

    // Someone removes the manager from the room, and puts it back much later.
    delete h.server['!stranger:test']
    await passAt(h, [40_000], null)
    unreadableRoom(h, '!stranger:test', 'foreign')
    await passAt(h, [100_000, 130_000], null)
    expect(h.leaves).toEqual([])

    await passAt(h, [160_000], null)
    expect(h.leaves).toEqual(['!stranger:test'])
  })

  it.each([
    ['other', null],
    ['target', 'denied'],
    ['unknown', 'denied']
  ] as const)('never leaves a %s room, however long it stays unreadable, and names it in the report', async (made, outcome) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!kept:test', made)

    // `other` is some other binding's room, so it cannot be the one wanted; the others could be, so "none" is refused.
    for (let at = 0; at <= 600_000; at += 30_000) {
      vi.setSystemTime(at)

      if (outcome === null) {await expect(find(h)).resolves.toBeNull()}
      else {await expect(find(h)).rejects.toThrow(outcome)}
    }

    expect(h.leaves).toEqual([])
    await expect(discoveryReport(h.client)).resolves.toEqual({ left: [], unreadable: [hash('!kept:test')] })
  })

  it('lets a room it created for another binding stay unreadable without hiding the room that is wanted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({ '!ours:test': ours('!ours:test') })

    unreadableRoom(h, '!sibling:test', 'other')
    await passAt(h, [0, 60_000, 600_000], '!ours:test')
    expect(h.leaves).toEqual([])
  })

  it('reports a room it left once, by hash only, and lists the rooms it must keep until they are readable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!stranger:test', 'foreign')
    unreadableRoom(h, '!sibling:test', 'other')
    await passAt(h, [0, 30_000, 59_999], null)
    // Nothing is due yet, so nothing is reported.
    await expect(discoveryReport(h.client)).resolves.toEqual({ left: [], unreadable: [] })

    await passAt(h, [60_000], null)
    await expect(discoveryReport(h.client))
      .resolves.toEqual({ left: [hash('!stranger:test')], unreadable: [hash('!sibling:test')] })
    // The leave is reported once; the room that must stay is a standing condition and is reported until it is fixed.
    await expect(discoveryReport(h.client)).resolves.toEqual({ left: [], unreadable: [hash('!sibling:test')] })

    h.server['!sibling:test'] = [creation('!sibling:test', { type: TYPE, bound: 'theirs' })]
    await passAt(h, [61_000], null)
    await expect(discoveryReport(h.client)).resolves.toEqual({ left: [], unreadable: [] })
  })

  it('ignores a failed leave, goes on without it, and tries again on the next pass', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!stranger:test', 'foreign')
    h.failLeave = true
    await passAt(h, [0, 30_000, 60_000, 90_000], null)
    expect(h.leaves).toEqual(['!stranger:test', '!stranger:test'])
    // A leave that did not happen is not reported as one.
    await expect(discoveryReport(h.client)).resolves.toEqual({ left: [], unreadable: [] })

    h.failLeave = false
    await passAt(h, [120_000], null)
    expect(h.leaves).toHaveLength(3)
    await expect(discoveryReport(h.client)).resolves.toEqual({ left: [hash('!stranger:test')], unreadable: [] })
  })

  it('counts a server refusal as unreadable, but any other failure still fails the pass and counts for nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({ '!zz-ours:test': ours('!zz-ours:test') })

    unreadableRoom(h, '!aa-stranger:test', 'foreign')
    h.refuse['!aa-stranger:test'] = 403
    // A refused room sorts first and must not keep the pass from the room that matters.
    await passAt(h, [0, 30_000, 59_999], '!zz-ours:test')
    expect(h.leaves).toEqual([])
    await passAt(h, [60_000], '!zz-ours:test')
    expect(h.leaves).toEqual(['!aa-stranger:test'])

    // A server error or a network failure says nothing about the room: the pass fails as it always did.
    for (const status of [500, undefined]) {
      const broken = harness({})

      unreadableRoom(broken, '!broken:test', 'foreign')
      broken.refuse['!broken:test'] = status

      for (const at of [0, 120_000, 240_000]) {
        vi.setSystemTime(at)
        await expect(find(broken)).rejects.toThrow('state refused')
      }

      expect(broken.leaves).toEqual([])
    }
  })

  it('keeps state reads and leaves to 50 at a time when many rooms are unreadable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({}, true)

    for (let index = 0; index < 130; index++) {unreadableRoom(h, `!stranger-${String(index).padStart(3, '0')}:test`, 'foreign')}
    await passAt(h, [0, 30_000, 59_999, 60_000], null)
    expect(h.leaves).toHaveLength(130)
    expect(h.peak()).toBe(50)
    expect(h.leavePeak()).toBe(50)
  })

  it('does not leave once its authority is withdrawn, even after the reads were allowed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = harness({})

    unreadableRoom(h, '!stranger:test', 'foreign')
    await passAt(h, [0, 30_000, 59_999], null)

    // Authority goes between the last read being accepted and the leave: classifying the room reads the synced cache.
    let live = true
    const cached = h.client.getRoom.bind(h.client)
    const before = h.reads.length

    h.client.getRoom = ((id: string) => {
      if (h.reads.length > before) {live = false}

      return cached(id)
    }) as never
    vi.setSystemTime(60_000)
    await expect(find(h, () => live)).rejects.toThrow('denied')
    expect(h.leaves).toEqual([])
  })
})
