import { describe, expect, it, vi } from 'vitest'

import type { ConversationCandidateRead, MatrixConversationView } from '../../../shared/agent-conversation/view'
import { MigrationWriterHolds } from '../device/migration-hold'

import type { ConversationMigrationJournal } from './migrate'
import { ConversationMigrationService, type ConversationMigrationServicePorts } from './service'

const rooms = ['!a:example.test', '!b:example.test', '!c:example.test']

function readable(roomId: string, changes: Partial<ConversationCandidateRead> = {}): ConversationCandidateRead {
  return { roomId, read: 'readable', writable: true, ...changes }
}

function fixture(initial: ConversationCandidateRead[]) {
  let candidates = [...initial]
  let journal: ConversationMigrationJournal | null = null
  let current = true
  let idle = true
  const facts = { cloudMayAnswer: false, cloudReady: false, fleetReady: true }
  const writes: Array<{ roomId: string; role: string }> = []
  const order: string[] = []
  const views: MatrixConversationView[] = []
  let knownMain: string | undefined
  let created = '!new:example.test'
  let failRoom: string | undefined
  let finishFails = false

  const ports: ConversationMigrationServicePorts = {
    current: () => current,
    idle: () => idle,
    read: vi.fn(async () => candidates.map(candidate => ({ ...candidate }))),
    knownMain: () => knownMain,
    facts: vi.fn(async () => ({ ...facts })),
    jobs: vi.fn(async () => {
      order.push('jobs')

      return 2
    }),
    write: vi.fn(async write => {
      order.push(`write:${write.roomId}`)
      writes.push({ roomId: write.roomId, role: 'role' in write.content ? write.content.role : 'rollback' })

      if (write.roomId === failRoom && 'role' in write.content) {
        throw new Error('closed')
      }
    }),
    finish: vi.fn(async () => {
      order.push('finish')

      if (finishFails) {
        throw new Error('closed')
      }
    }),
    create: vi.fn(async () => created),
    readJournal: () => journal,
    saveJournal: value => {
      journal = value ? structuredClone(value) : null
    },
    changed: view => {
      order.push(`view:${view.state}`)
      views.push(structuredClone(view))
    },
    now: () => 1_000
  }

  return {
    service: new ConversationMigrationService(ports),
    ports,
    writes,
    order,
    views,
    facts,
    journal: () => journal,
    setJournal: (value: ConversationMigrationJournal | null) => {
      journal = value
    },
    setCandidates: (value: ConversationCandidateRead[]) => {
      candidates = [...value]
    },
    setKnownMain: (value: string | undefined) => {
      knownMain = value
    },
    setCreated: (value: string) => {
      created = value
    },
    setFailRoom: (value: string | undefined) => {
      failRoom = value
    },
    setCurrent: (value: boolean) => {
      current = value
    },
    setIdle: (value: boolean) => {
      idle = value
    },
    setFinishFails: (value: boolean) => {
      finishFails = value
    }
  }
}

describe('ConversationMigrationService', () => {
  it('keeps conversation writes and home/job convergence behind the persisted cloud snapshot writer hold', async () => {
    const saved = new Map<string, string>()
    const store = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) },
      removeItem: (key: string) => { saved.delete(key) }, failureCode: () => null }
    const principal = '00000000-0000-4000-8000-bd7662a5eeb4'
    const migration = '00000000-0000-4000-8000-b454f82c5857'
    let holds = new MigrationWriterHolds({ ownerUserId: '@owner:example.test', store })
    const f = fixture([readable(rooms[0])])
    f.ports.idle = () => !holds.held(principal)
    await f.service.request('preview')
    holds.begin(migration, principal)
    holds = new MigrationWriterHolds({ ownerUserId: '@owner:example.test', store })
    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'blocked', reason: 'turn_live' })
    expect(f.writes).toEqual([])
    expect(f.ports.finish).not.toHaveBeenCalled()
    expect(f.journal()).toBeNull()
    holds.release(migration, 'declined')
    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
    expect(f.ports.finish).toHaveBeenCalledOnce()
  })
  it('keeps a single-room preview read-only and marks it only during native reconciliation', async () => {
    const f = fixture([readable(rooms[0])])
    await expect(f.service.request('preview')).resolves.toMatchObject({ state: 'legacy', proposed: rooms[0], jobs: 2 })
    expect(f.writes).toEqual([])
    expect(f.ports.finish).not.toHaveBeenCalled()
    expect(f.journal()).toBeNull()

    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
    expect(f.writes).toEqual([{ roomId: rooms[0], role: 'main' }])
    expect(f.ports.finish).toHaveBeenCalledOnce()
  })

  it('reads a marked stray without sweeping and rechecks live turns before reconciliation', async () => {
    const f = fixture([
      readable(rooms[0], { marker: { role: 'main', main: rooms[0], at: 2 } }),
      readable(rooms[1])
    ])
    await expect(f.service.request('preview')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
    expect(f.writes).toEqual([])
    expect(f.ports.finish).not.toHaveBeenCalled()
    f.setIdle(false)
    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'blocked', reason: 'turn_live' })
    expect(f.writes).toEqual([])
    expect(f.ports.finish).not.toHaveBeenCalled()
    f.setIdle(true)
    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
    expect(f.writes).toEqual([{ roomId: rooms[1], role: 'earlier' }])
  })

  it('previews the selected target with its actual moving-job count without any migration effect', async () => {
    const f = fixture([
      readable(rooms[0], { marker: { role: 'main', main: rooms[0], at: 2 } }),
      readable(rooms[1], { marker: { role: 'earlier', main: rooms[0], at: 2 } })
    ])
    vi.mocked(f.ports.jobs).mockImplementation(async (_rooms, main) => (main === rooms[1] ? 7 : 1))
    await expect(f.service.request('preview', rooms[1])).resolves.toMatchObject({
      state: 'marked',
      main: rooms[0],
      proposed: rooms[1],
      jobs: 7
    })
    expect(f.ports.jobs).toHaveBeenCalledWith(rooms.slice(0, 2), rooms[1])
    expect(f.writes).toEqual([])
    expect(f.ports.finish).not.toHaveBeenCalled()
    expect(f.ports.create).not.toHaveBeenCalled()
    await expect(f.service.request('preview', rooms[2])).resolves.toMatchObject({
      state: 'blocked',
      proposed: rooms[2],
      reason: 'chosen_not_writable'
    })
    expect(f.writes).toEqual([])
  })

  it('shows the ranked legacy proposal and moves the selected room atomically before convergence', async () => {
    const f = fixture([
      readable(rooms[0], { activityAt: 40 }),
      readable(rooms[1], { ownerAt: 900 }),
      readable(rooms[2], { ownerAt: 800 })
    ])

    expect(await f.service.request('preview')).toMatchObject({
      state: 'legacy',
      proposed: rooms[1],
      candidates: [rooms[1], rooms[2], rooms[0]],
      jobs: 2
    })
    expect(await f.service.request('keep', rooms[2])).toMatchObject({ state: 'marked', main: rooms[2], jobs: 2 })
    expect(f.writes).toEqual([
      { roomId: rooms[2], role: 'main' },
      { roomId: rooms[0], role: 'earlier' },
      { roomId: rooms[1], role: 'earlier' }
    ])
    expect(f.order.indexOf('finish')).toBeLessThan(f.order.lastIndexOf('view:marked'))
  })

  it('picks the owner’s most recent unmarked conversation automatically, with no choice', async () => {
    const f = fixture([
      readable(rooms[0], { ownerAt: 900 }),
      readable(rooms[1], { ownerAt: 800, activityAt: 950 }),
      readable(rooms[2], { activityAt: 1_000 })
    ])

    expect(await f.service.request('preview')).toMatchObject({
      state: 'legacy',
      proposed: rooms[0],
      candidates: [rooms[0], rooms[1], rooms[2]],
      jobs: 2
    })
    expect(f.writes).toEqual([])

    await expect(f.service.request('reconcile')).resolves.toMatchObject({
      state: 'marked',
      main: rooms[0],
      jobs: 2
    })
    expect(f.writes).toEqual([
      { roomId: rooms[0], role: 'main' },
      { roomId: rooms[1], role: 'earlier' },
      { roomId: rooms[2], role: 'earlier' }
    ])
    expect(f.ports.finish).toHaveBeenCalledWith(rooms[0], rooms)
    expect(f.ports.jobs).toHaveBeenCalledWith(rooms, rooms[0])
  })

  it('writes nothing on a second automatic pass over the rooms its first pick already marked', async () => {
    const f = fixture([readable(rooms[0], { ownerAt: 900 }), readable(rooms[1], { ownerAt: 800 })])

    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
    expect(f.writes).toEqual([
      { roomId: rooms[0], role: 'main' },
      { roomId: rooms[1], role: 'earlier' }
    ])

    // The server now shows the markers that pass wrote (the fixture does not apply writes itself).
    f.setCandidates([
      readable(rooms[0], { marker: { role: 'main', main: rooms[0], at: 1_000 } }),
      readable(rooms[1], { marker: { role: 'earlier', main: rooms[0], at: 1_000 } })
    ])
    const writes = f.writes.length

    // A second pass reads the same rooms back as marked: the resolution is stable, so the sweep
    // has nothing to rewrite and no new migration starts.
    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
    expect(f.writes.length).toBe(writes)
    expect(f.journal()).toBeNull()
  })

  it('breaks a same-recency tie toward the plain room, avoiding an encrypted-main move', async () => {
    const f = fixture([
      readable(rooms[0], { ownerAt: 900, encrypted: true, createdAt: 0 }),
      readable(rooms[1], { ownerAt: 900, encrypted: false, createdAt: 0 })
    ])

    // The recency order itself is unchanged: the encrypted room still ranks first (lowest ID).
    expect(await f.service.request('preview')).toMatchObject({ state: 'legacy', proposed: rooms[0] })

    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[1] })
    expect(f.writes).toEqual([
      { roomId: rooms[1], role: 'main' },
      { roomId: rooms[0], role: 'earlier' }
    ])
    expect(f.ports.finish).toHaveBeenCalledWith(rooms[1], rooms.slice(0, 2))
  })

  it('follows the room another Mac marks while this one picks', async () => {
    const f = fixture([readable(rooms[0], { ownerAt: 900 }), readable(rooms[1], { ownerAt: 800 })])
    const write = f.ports.write

    // The other Mac's marker lands first: by the time this Mac finishes its own pick, the rooms
    // name the other room main (this pick already reads Earlier there).
    f.ports.write = vi.fn(async value => {
      await write(value)
      f.setCandidates([
        readable(rooms[0], { marker: { role: 'earlier', main: rooms[1], at: 3 }, ownerAt: 900 }),
        readable(rooms[1], { marker: { role: 'main', main: rooms[1], at: 3 }, ownerAt: 800 })
      ])
    })

    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[1] })
    expect(f.ports.finish).toHaveBeenLastCalledWith(rooms[1], rooms.slice(0, 2))
  })

  it('retries a failed automatic pick quietly on the next pass', async () => {
    const f = fixture([readable(rooms[0], { ownerAt: 900 }), readable(rooms[1], { ownerAt: 800 })])
    let t = 1_000
    f.ports.now = () => t
    f.setFailRoom(rooms[0])

    await expect(f.service.request('reconcile')).resolves.toMatchObject({
      state: 'legacy',
      proposed: rooms[0]
    })
    expect(f.views.some(view => view.state === 'retry' && view.reason === 'failed')).toBe(false)
    const failedWrites = f.writes.length

    t += 60_000 - 1
    await f.service.request('reconcile')
    expect(f.writes.length).toBe(failedWrites)

    t += 1
    f.setFailRoom(undefined)
    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
  })

  it('says so once after repeated automatic pick failures, and Try again restarts the quiet retries', async () => {
    const f = fixture([readable(rooms[0], { ownerAt: 900 }), readable(rooms[1], { ownerAt: 800 })])
    let t = 1_000
    f.ports.now = () => t
    f.setFailRoom(rooms[0])

    for (let attempt = 0; attempt < 4; attempt++) {
      const view = await f.service.request('reconcile')

      if (attempt < 3) {
        expect(view).toMatchObject({ state: 'legacy', proposed: rooms[0] })
      } else {
        expect(view).toMatchObject({ state: 'retry', proposed: rooms[0], reason: 'failed' })
      }

      t += 60_000 * 2 ** attempt
    }

    const writes = f.writes.length
    // The preview stays read-only and quiet; the reconcile pass alone reports the stuck pick.
    await expect(f.service.request('preview')).resolves.toMatchObject({
      state: 'legacy',
      proposed: rooms[0]
    })
    await f.service.request('reconcile')
    expect(f.writes.length).toBe(writes)

    // The owner's one action clears the stuck state and retries the same pick.
    f.setFailRoom(undefined)
    await expect(f.service.request('retry')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
  })

  it('accepts make-main as the same owner-confirmed transaction', async () => {
    const f = fixture(rooms.map(roomId => readable(roomId)))

    await expect(f.service.request('makeMain', rooms[1])).resolves.toMatchObject({ state: 'marked', main: rooms[1] })
    expect(f.writes[0]).toEqual({ roomId: rooms[1], role: 'main' })
    expect(f.ports.finish).toHaveBeenCalledWith(rooms[1], rooms)
  })

  it('keeps a durable forward journal after a crash and retries only its remaining work', async () => {
    const f = fixture(rooms.map(roomId => readable(roomId)))
    f.setJournal({
      phase: 'forward',
      main: rooms[1],
      rooms: [...rooms],
      cursor: 1,
      writes: [
        { roomId: rooms[1], content: { v: 1, role: 'main', main: rooms[1], at: 10 } },
        { roomId: rooms[0], content: { v: 1, role: 'earlier', main: rooms[1], at: 10 } }
      ]
    })

    await expect(f.service.request('retry')).resolves.toMatchObject({ state: 'marked', main: rooms[1] })
    expect(f.writes).toEqual([{ roomId: rooms[0], role: 'earlier' }])
    expect(f.journal()).toBeNull()
    expect(f.ports.finish).toHaveBeenCalledWith(rooms[1], rooms)
  })

  it('keeps rollback/effects journals visible and blocks a new action without writing', async () => {
    const f = fixture(rooms.map(roomId => readable(roomId)))
    f.setJournal({
      phase: 'effects',
      main: rooms[0],
      rooms: [...rooms],
      cursor: 0,
      writes: [{ roomId: rooms[0], content: { v: 1, role: 'main', main: rooms[0], at: 10 } }]
    })

    await expect(f.service.request('keep', rooms[1])).resolves.toMatchObject({
      state: 'retry',
      reason: 'effects_pending'
    })
    expect(f.writes).toEqual([])
    expect(f.journal()?.phase).toBe('effects')
  })

  it('never writes a silent single-room marker or creates a replacement while cloud readiness is blocked', async () => {
    const single = fixture([readable(rooms[0])])
    single.facts.cloudMayAnswer = true
    single.facts.cloudReady = false
    await expect(single.service.request('preview')).resolves.toMatchObject({
      state: 'blocked',
      reason: 'cloud_not_ready'
    })
    expect(single.writes).toEqual([])

    const replace = fixture([{ roomId: rooms[0], read: 'unreachable', writable: false }])
    replace.facts.cloudMayAnswer = true
    replace.facts.cloudReady = false
    replace.setKnownMain(rooms[0])
    await expect(replace.service.request('replaceMain', rooms[0])).resolves.toMatchObject({
      state: 'blocked',
      reason: 'cloud_not_ready'
    })
    expect(replace.ports.create).not.toHaveBeenCalled()
    expect(replace.writes).toEqual([])
  })

  it('fails closed on a first transient read and retains a prior answer without writes on a later transient read', async () => {
    const noPrior = fixture([{ roomId: rooms[0], read: 'transient', writable: false }])
    await expect(noPrior.service.request('preview')).resolves.toMatchObject({
      state: 'blocked',
      reason: 'read_unavailable',
      candidates: []
    })
    expect(noPrior.writes).toEqual([])

    const withPrior = fixture([readable(rooms[0], { marker: { role: 'main', main: rooms[0], at: 1 } })])
    await withPrior.service.request('preview')
    withPrior.setCandidates([{ roomId: rooms[0], read: 'transient', writable: false }])
    await expect(withPrior.service.request('makeMain', rooms[0])).resolves.toMatchObject({
      state: 'blocked',
      reason: 'read_unavailable',
      main: rooms[0]
    })
    expect(withPrior.writes).toEqual([])
  })

  it('creates and marks only a re-read, writable replacement room for a definitively unreachable main', async () => {
    const f = fixture([{ roomId: rooms[0], read: 'unreachable', writable: false }])
    f.setKnownMain(rooms[0])
    await expect(f.service.request('preview')).resolves.toMatchObject({
      state: 'blocked',
      main: rooms[0],
      proposed: rooms[0],
      replaceable: true,
      jobs: 2,
      reason: 'read_unavailable'
    })
    expect(f.ports.jobs).toHaveBeenCalledWith([rooms[0]], undefined)
    vi.mocked(f.ports.create).mockImplementation(async () => {
      f.order.push('create')
      f.setCandidates([{ roomId: rooms[0], read: 'unreachable', writable: false }, readable('!new:example.test')])

      return '!new:example.test'
    })

    await expect(f.service.request('replaceMain', rooms[0])).resolves.toMatchObject({
      state: 'marked',
      main: '!new:example.test'
    })
    expect(f.writes).toEqual([{ roomId: '!new:example.test', role: 'main' }])
    expect(f.ports.read).toHaveBeenCalledTimes(3)
    expect(f.order.lastIndexOf('jobs')).toBeLessThan(f.order.indexOf('create'))
    expect(f.ports.finish).toHaveBeenCalledWith('!new:example.test', ['!a:example.test', '!new:example.test'])
    expect(f.ports.jobs).toHaveBeenLastCalledWith([rooms[0]], undefined)
    expect(f.views.at(-1)?.replaceable).toBeUndefined()
    expect(f.views.at(-1)?.reason).toBeUndefined()
  })

  it('does not offer replacement after a transient read even when the previous main was definitively unreadable', async () => {
    const f = fixture([{ roomId: rooms[0], read: 'unreachable', writable: false }])
    f.setKnownMain(rooms[0])
    expect((await f.service.request('preview')).replaceable).toBe(true)
    vi.mocked(f.ports.jobs).mockClear()
    f.setCandidates([{ roomId: rooms[0], read: 'transient', writable: false }])
    const view = await f.service.request('preview')
    expect(view).toMatchObject({ main: rooms[0], jobs: 2, reason: 'read_unavailable' })
    expect(view.replaceable).toBeUndefined()
    expect(f.ports.jobs).not.toHaveBeenCalled()
    expect(f.ports.create).not.toHaveBeenCalled()
  })

  it('retains old-room job origins in a replacement journal and finishes them after a process restart', async () => {
    const f = fixture([{ roomId: rooms[0], read: 'unreachable', writable: false }])
    f.setKnownMain(rooms[0])
    f.setFinishFails(true)
    vi.mocked(f.ports.create).mockImplementation(async () => {
      f.setCandidates([{ roomId: rooms[0], read: 'unreachable', writable: false }, readable('!new:example.test')])
      return '!new:example.test'
    })
    await expect(f.service.request('replaceMain')).resolves.toMatchObject({ state: 'retry', reason: 'effects_pending' })
    expect(f.journal()?.rooms).toEqual([rooms[0], '!new:example.test'])
    expect(f.writes).toEqual([{ roomId: '!new:example.test', role: 'main' }])
    f.setFinishFails(false)
    const restarted = new ConversationMigrationService(f.ports)
    await expect(restarted.request('retry')).resolves.toMatchObject({ state: 'marked', main: '!new:example.test' })
    expect(f.ports.finish).toHaveBeenLastCalledWith('!new:example.test', [rooms[0], '!new:example.test'])
    expect(f.writes).toEqual([{ roomId: '!new:example.test', role: 'main' }])
    expect(f.journal()).toBeNull()
  })

  it('retries the displayed selection after a fully rolled-back write failure, including after service restart', async () => {
    const f = fixture(rooms.map(roomId => readable(roomId)))
    f.setFailRoom(rooms[0])
    await expect(f.service.request('keep', rooms[1])).resolves.toMatchObject({
      state: 'retry',
      proposed: rooms[1],
      reason: 'failed'
    })
    expect(f.journal()).toBeNull()
    expect(f.writes).toEqual([
      { roomId: rooms[1], role: 'main' },
      { roomId: rooms[0], role: 'earlier' },
      { roomId: rooms[0], role: 'rollback' },
      { roomId: rooms[1], role: 'rollback' }
    ])
    f.setFailRoom(undefined)
    const restarted = new ConversationMigrationService(f.ports)
    await expect(restarted.request('retry', rooms[1])).resolves.toMatchObject({ state: 'marked', main: rooms[1] })
    expect(f.writes.slice(4)).toEqual([
      { roomId: rooms[1], role: 'main' },
      { roomId: rooms[0], role: 'earlier' },
      { roomId: rooms[2], role: 'earlier' }
    ])
    expect(f.ports.finish).toHaveBeenCalledTimes(1)
  })

  it('sweeps a marked race with Earlier-only writes before finishing', async () => {
    const f = fixture([
      readable(rooms[0], { marker: { role: 'main', main: rooms[0], at: 1 } }),
      readable(rooms[1], { marker: { role: 'main', main: rooms[1], at: 2 } }),
      readable(rooms[2])
    ])

    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[1] })
    expect(f.writes).toEqual([
      { roomId: rooms[0], role: 'earlier' },
      { roomId: rooms[2], role: 'earlier' }
    ])
    expect(f.ports.finish).toHaveBeenCalledWith(rooms[1], rooms)
  })

  it('leaves preflight-denied strays unmarked and lists them while converging writable rooms', async () => {
    const f = fixture([
      readable(rooms[0], { marker: { role: 'main', main: rooms[0], at: 2 } }),
      readable(rooms[1], { writable: false }),
      readable(rooms[2])
    ])
    await expect(f.service.request('reconcile')).resolves.toMatchObject({
      state: 'marked',
      main: rooms[0],
      skipped: [rooms[1]]
    })
    expect(f.writes).toEqual([{ roomId: rooms[2], role: 'earlier' }])
    expect(f.ports.finish).toHaveBeenCalledWith(rooms[0], rooms)
  })

  it('converges local jobs/home even when another Mac already completed every sweep marker', async () => {
    const f = fixture([
      readable(rooms[0], { marker: { role: 'main', main: rooms[0], at: 2 } }),
      readable(rooms[1], { marker: { role: 'earlier', main: rooms[0], at: 2 } })
    ])

    f.setFinishFails(true)

    await expect(f.service.request('reconcile')).resolves.toMatchObject({
      state: 'retry',
      reason: 'effects_pending',
      main: rooms[0]
    })
    expect(f.writes).toEqual([])
    f.setFinishFails(false)
    await expect(f.service.request('retry')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
    expect(f.writes).toEqual([])
    expect(f.ports.finish).toHaveBeenCalledTimes(2)
  })

  describe('moving an encrypted main to a plain room (0.20)', () => {
    const NEW = '!new:example.test'

    const marked = (roomId: string, encrypted: boolean) =>
      readable(roomId, { encrypted, marker: { role: 'main', main: roomId, at: 2 } })

    function moving(initial = [marked(rooms[0], true)]) {
      const f = fixture(initial)
      Object.assign(f.facts, { plainReady: true })
      vi.mocked(f.ports.create).mockImplementation(async () => {
        f.order.push('create')
        f.setCandidates([...initial, readable(NEW, { encrypted: false })])

        return NEW
      })

      return f
    }

    it('replaces it on reconcile: one new room, then main on it and Earlier on the old one', async () => {
      const f = moving()
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: NEW })
      expect(f.ports.create).toHaveBeenCalledOnce()
      expect(f.writes).toEqual([
        { roomId: NEW, role: 'main' },
        { roomId: rooms[0], role: 'earlier' }
      ])
      expect(f.order.indexOf('create')).toBeLessThan(f.order.indexOf(`write:${NEW}`))
      expect(f.order.indexOf(`write:${rooms[0]}`)).toBeLessThan(f.order.indexOf('finish'))
      expect(f.ports.finish).toHaveBeenCalledWith(NEW, [rooms[0], NEW])
      expect(f.journal()).toBeNull()
    })

    it('marks every readable older room Earlier for the new main too', async () => {
      const f = moving([
        marked(rooms[0], true),
        readable(rooms[1], { encrypted: true, marker: { role: 'earlier', main: rooms[0], at: 2 } })
      ])

      await f.service.request('reconcile')
      expect(f.writes).toEqual([
        { roomId: NEW, role: 'main' },
        { roomId: rooms[0], role: 'earlier' },
        { roomId: rooms[1], role: 'earlier' }
      ])
    })

    it('offers the roster Replace on preview only once every Mac is on 0.20', async () => {
      const f = moving()
      Object.assign(f.facts, { plainReady: false })
      expect((await f.service.request('preview')).replaceable).toBeUndefined()
      await expect(f.service.request('replaceMain')).resolves.toMatchObject({
        state: 'blocked',
        reason: 'fleet_not_ready'
      })
      expect(f.ports.create).not.toHaveBeenCalled()
      Object.assign(f.facts, { plainReady: true })
      expect(await f.service.request('preview')).toMatchObject({ state: 'marked', main: rooms[0], replaceable: true })
      await expect(f.service.request('replaceMain')).resolves.toMatchObject({ state: 'marked', main: NEW })
    })

    it('waits on reconcile while a Mac is not on 0.20: it only sweeps', async () => {
      const f = moving()
      Object.assign(f.facts, { plainReady: false })
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
      expect(f.ports.create).not.toHaveBeenCalled()
      expect(f.writes).toEqual([])
    })

    it('waits while the cloud agent is not ready', async () => {
      const f = moving()
      Object.assign(f.facts, { cloudMayAnswer: true, cloudReady: false })
      await expect(f.service.request('reconcile')).resolves.toMatchObject({
        state: 'blocked',
        reason: 'cloud_not_ready'
      })
      expect(f.ports.create).not.toHaveBeenCalled()
    })

    it('never replaces a plain main', async () => {
      const f = moving([marked(rooms[0], false)])
      expect((await f.service.request('preview')).replaceable).toBeUndefined()
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
      await expect(f.service.request('replaceMain')).resolves.toMatchObject({
        state: 'blocked',
        reason: 'read_unavailable'
      })
      expect(f.ports.create).not.toHaveBeenCalled()
    })

    it('first marks an unmarked legacy room main; the move follows on the next pass', async () => {
      const f = moving([readable(rooms[0], { encrypted: true })])
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: rooms[0] })
      expect(f.ports.create).not.toHaveBeenCalled()
      expect(f.writes).toEqual([{ roomId: rooms[0], role: 'main' }])
    })

    it('finishes the Earlier write after the process died right after the main write', async () => {
      const f = moving()
      f.setCandidates([marked(rooms[0], true), readable(NEW, { encrypted: false })])
      f.setJournal({
        phase: 'forward',
        cursor: 1,
        main: NEW,
        rooms: [rooms[0], NEW],
        writes: [
          { roomId: NEW, content: { v: 1, role: 'main', main: NEW, at: 1_000 } },
          { roomId: rooms[0], content: { v: 1, role: 'earlier', main: NEW, at: 1_000 } }
        ]
      })
      const restarted = new ConversationMigrationService(f.ports)
      await expect(restarted.request('reconcile')).resolves.toMatchObject({ state: 'retry', reason: 'effects_pending' })
      expect(f.writes).toEqual([])
      await expect(restarted.request('retry')).resolves.toMatchObject({ state: 'marked', main: NEW })
      expect(f.writes).toEqual([{ roomId: rooms[0], role: 'earlier' }])
      expect(f.ports.create).not.toHaveBeenCalled()
      expect(f.ports.finish).toHaveBeenCalledWith(NEW, [rooms[0], NEW])
      expect(f.journal()).toBeNull()
    })

    it('reuses the room a failed attempt made instead of making another, and waits longer after it', async () => {
      const f = moving()
      let t = 1_000
      f.ports.now = () => t
      // The room is made on the server, then the agent's join fails: no journal yet.
      vi.mocked(f.ports.create).mockImplementationOnce(async () => {
        f.setCandidates([marked(rooms[0], true), readable(NEW, { encrypted: false })])
        throw new Error('matrix_encrypted_invite_required')
      })
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'retry', reason: 'failed' })
      expect(f.journal()).toBeNull()

      // The next minute's pass is held back: no create, no writes, and the orphan is not swept.
      t += 60_000 - 1
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ main: rooms[0], replaceable: true })
      expect(f.ports.create).toHaveBeenCalledOnce()
      expect(f.writes).toEqual([])

      t += 1
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: NEW })
      expect(f.ports.create).toHaveBeenCalledTimes(2)
      expect(f.ports.create).toHaveBeenLastCalledWith(NEW)
      expect(f.writes).toEqual([
        { roomId: NEW, role: 'main' },
        { roomId: rooms[0], role: 'earlier' }
      ])
    })

    it('reuses the room when a turn started between making it and moving', async () => {
      const f = moving()
      let t = 1_000
      f.ports.now = () => t
      vi.mocked(f.ports.create).mockImplementationOnce(async () => {
        f.setCandidates([marked(rooms[0], true), readable(NEW, { encrypted: false })])
        f.setIdle(false)

        return NEW
      })
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'blocked', reason: 'turn_live' })
      f.setIdle(true)
      t += 60_000
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: NEW })
      expect(vi.mocked(f.ports.create).mock.calls).toEqual([[undefined], [NEW]])
    })

    it('waits longer after each failed background attempt, up to half an hour', async () => {
      const f = moving()
      let t = 0
      f.ports.now = () => t
      vi.mocked(f.ports.create).mockRejectedValue(new Error('matrix_agent_unavailable'))
      const gaps = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]

      for (const gap of gaps) {
        await f.service.request('reconcile')
        const calls = vi.mocked(f.ports.create).mock.calls.length
        t += gap - 1
        await f.service.request('reconcile')
        expect(f.ports.create).toHaveBeenCalledTimes(calls)
        t += 1
      }
    })

    it('never holds back the roster Replace', async () => {
      const f = moving()
      vi.mocked(f.ports.create).mockRejectedValueOnce(new Error('matrix_agent_unavailable'))
      await f.service.request('reconcile')
      await expect(f.service.request('replaceMain')).resolves.toMatchObject({ state: 'marked', main: NEW })
      expect(f.ports.create).toHaveBeenCalledTimes(2)
    })

    it('never reuses an encrypted or marked room', async () => {
      const f = moving([
        marked(rooms[0], true),
        readable(rooms[1], { encrypted: true }),
        readable(rooms[2], { encrypted: false, marker: { role: 'earlier', main: rooms[0], at: 2 } })
      ])

      await f.service.request('reconcile')
      expect(vi.mocked(f.ports.create).mock.calls).toEqual([[undefined]])
    })

    it('resumes from the journal when finishing failed', async () => {
      const f = moving()
      f.setFinishFails(true)
      await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'retry', reason: 'effects_pending' })
      expect(f.journal()).toMatchObject({ phase: 'effects', main: NEW, rooms: [rooms[0], NEW] })
      f.setFinishFails(false)
      // The server shows the markers the move wrote (this fixture does not apply writes itself).
      f.setCandidates([
        readable(rooms[0], { encrypted: true, marker: { role: 'earlier', main: NEW, at: 1_000 } }),
        readable(NEW, { encrypted: false, marker: { role: 'main', main: NEW, at: 1_000 } })
      ])
      const restarted = new ConversationMigrationService(f.ports)
      await expect(restarted.request('retry')).resolves.toMatchObject({ state: 'marked', main: NEW })
      expect(f.ports.create).toHaveBeenCalledOnce()
      expect(f.journal()).toBeNull()
    })
  })
})

describe('after two Macs moved the agent at once (0.20.1)', () => {
  const [a, b, c] = rooms

  /** Every Mac reports 0.20: the gate the move to a plain room ran under, and its repair too. */
  function repairing(candidates: ConversationCandidateRead[]) {
    const f = fixture(candidates)
    Object.assign(f.facts, { plainReady: true })

    return f
  }

  /** The rooms as 0.20.0 left them: each new plain room Earlier, pointing at the other's. */
  function crossed() {
    return [
      readable(a, { encrypted: false, createdAt: 2, marker: { role: 'earlier', main: c, at: 2 } }),
      readable(b, { encrypted: true, createdAt: 0, marker: { role: 'earlier', main: c, at: 2 } }),
      readable(c, { encrypted: false, createdAt: 1, marker: { role: 'earlier', main: a, at: 1 } })
    ]
  }

  it('restores one main to marked rooms that have none, and its preview asks for it', async () => {
    const f = repairing(crossed())
    const preview = await f.service.request('preview')
    expect(preview).toMatchObject({ state: 'legacy', earlier: [a, b, c], proposed: c, replaceable: true })
    expect(f.writes).toEqual([])

    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: c })
    expect(f.writes).toEqual([
      { roomId: c, role: 'main' },
      { roomId: a, role: 'earlier' },
      { roomId: b, role: 'earlier' }
    ])
    expect(f.ports.finish).toHaveBeenCalledWith(c, [a, b, c])
    expect(f.ports.create).not.toHaveBeenCalled()
    expect(f.journal()).toBeNull()
  })

  it('picks a plain room a marker named, the one made first; never a room it may not write', async () => {
    // Nobody named the plain room a: the named plain room c wins even though a was made first.
    const f = repairing([
      readable(a, { encrypted: false, createdAt: 0, marker: { role: 'earlier', main: c, at: 1 } }),
      readable(b, { encrypted: true, createdAt: 0, marker: { role: 'earlier', main: c, at: 1 } }),
      readable(c, { encrypted: false, createdAt: 5, marker: { role: 'earlier', main: b, at: 1 } })
    ])

    await expect(f.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: c })

    // The pick it cannot write is passed over for the next one.
    const g = repairing(crossed().map(room => (room.roomId === c ? { ...room, writable: false } : room)))
    await expect(g.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: a })
    expect(g.writes.map(write => write.roomId)).not.toContain(c)
  })

  it('picks unmarked rooms automatically, and never repairs on an uncertain read', async () => {
    const legacy = repairing([readable(a, { encrypted: false }), readable(b, { encrypted: false })])
    await expect(legacy.service.request('reconcile')).resolves.toMatchObject({ state: 'marked', main: a })
    expect(legacy.writes).toEqual([
      { roomId: a, role: 'main' },
      { roomId: b, role: 'earlier' }
    ])
    expect(legacy.ports.finish).toHaveBeenCalledWith(a, [a, b])

    const uncertain = repairing([...crossed(), { roomId: '!d:example.test', read: 'transient', writable: false }])
    await uncertain.service.request('reconcile')
    expect(uncertain.writes).toEqual([])
    expect(uncertain.ports.finish).not.toHaveBeenCalled()
  })

  it('repairs the crossed-move shape, and picks the most recent room for any other no-main shape', async () => {
    const shapes: Record<string, { candidates: ConversationCandidateRead[]; main: string }> = {
      // The agent left its main (or it is no longer a private room): the markers name a room
      // that is not a candidate any more. The most recently created writable room becomes main.
      'main left': {
        candidates: [
          readable(a, { encrypted: false, createdAt: 1, marker: { role: 'earlier', main: '!gone:example.test', at: 1 } }),
          readable(b, { encrypted: true, createdAt: 0, marker: { role: 'earlier', main: '!gone:example.test', at: 1 } })
        ],
        main: b
      },
      // A move that rolled back: a stale Earlier room still names the encrypted former main (its
      // marker cleared), and the empty plain room the failed attempt made is named by nobody.
      'rolled back': {
        candidates: [
          readable(a, { encrypted: true, writable: false, createdAt: 0, marker: { role: 'earlier', main: b, at: 1 } }),
          readable(b, { encrypted: true, createdAt: 0, marker: null }),
          readable(c, { encrypted: false, createdAt: 5, marker: null })
        ],
        main: b
      }
    }

    for (const [shape, { candidates, main }] of Object.entries(shapes)) {
      const f = repairing(candidates)
      const preview = await f.service.request('preview')
      expect(preview.replaceable, shape).toBeUndefined()
      await expect(f.service.request('reconcile'), shape).resolves.toMatchObject({ state: 'marked', main })
      expect(f.writes[0], shape).toEqual({ roomId: main, role: 'main' })
      expect(f.ports.finish, shape).toHaveBeenCalledOnce()
    }

    // A crossed move is not repaired before every Mac can follow a plain main either.
    const early = fixture(crossed())
    expect((await early.service.request('preview')).replaceable).toBeUndefined()
    await early.service.request('reconcile')
    expect(early.writes).toEqual([])
  })

  it('drops an unsettled move whose main another Mac marked Earlier, and follows the rooms instead', async () => {
    const f = repairing(crossed())
    // The mini's journal: markers written for its room c, its finish never passed.
    f.setJournal({
      phase: 'effects',
      cursor: 0,
      main: c,
      rooms: [a, b, c],
      writes: [
        { roomId: c, content: { v: 1, role: 'main', main: c, at: 1 } },
        { roomId: a, content: { v: 1, role: 'earlier', main: c, at: 1 } },
        { roomId: b, content: { v: 1, role: 'earlier', main: c, at: 1 } }
      ]
    })
    expect(await f.service.request('preview')).toMatchObject({ state: 'retry', reason: 'effects_pending' })

    await expect(f.service.request('resume')).resolves.toMatchObject({ state: 'marked', main: c })
    expect(f.journal()).toBeNull()
    expect(f.writes[0]).toEqual({ roomId: c, role: 'main' })
    expect(f.ports.finish).toHaveBeenCalledOnce()
  })

  it('drops one whose main lost to a newer main, and sweeps toward the winner', async () => {
    const f = fixture([
      readable(a, { encrypted: false, marker: { role: 'main', main: a, at: 1 } }),
      readable(c, { encrypted: false, marker: { role: 'main', main: c, at: 2 } })
    ])

    f.setJournal({
      phase: 'effects',
      cursor: 0,
      main: a,
      rooms: [a, c],
      writes: [
        { roomId: a, content: { v: 1, role: 'main', main: a, at: 1 } },
        { roomId: c, content: { v: 1, role: 'earlier', main: a, at: 1 } }
      ]
    })

    await expect(f.service.request('retry')).resolves.toMatchObject({ state: 'marked', main: c })
    expect(f.journal()).toBeNull()
    expect(f.writes).toEqual([{ roomId: a, role: 'earlier' }])
    expect(f.ports.finish).toHaveBeenCalledWith(c, [a, c])
  })

  it("drops an unsettled move whose main marker another Mac cleared (its rollback)", async () => {
    // This Mac's effects journal names a; another Mac's rollback cleared a's marker since.
    const f = fixture([
      readable(a, { encrypted: false, marker: null }),
      readable(c, { encrypted: false, marker: { role: 'main', main: c, at: 2 } })
    ])

    f.setJournal({
      phase: 'effects',
      cursor: 0,
      main: a,
      rooms: [a, c],
      writes: [
        { roomId: a, content: { v: 1, role: 'main', main: a, at: 1 } },
        { roomId: c, content: { v: 1, role: 'earlier', main: a, at: 1 } }
      ]
    })

    await expect(f.service.request('resume')).resolves.toMatchObject({ state: 'marked', main: c })
    expect(f.journal()).toBeNull()
    expect(f.ports.finish).toHaveBeenCalledWith(c, [a, c])
    expect(f.writes.map(write => write.roomId)).not.toContain(c)
  })

  it("goes on writing an owner's move whose markers are not all written yet", async () => {
    // The owner made the Earlier room a main; the move stopped before its first write, so a
    // still reads Earlier. That is the owner's choice being written, not another Mac's.
    const f = fixture([
      readable(a, { encrypted: false, marker: { role: 'earlier', main: c, at: 1 } }),
      readable(c, { encrypted: false, marker: { role: 'main', main: c, at: 1 } })
    ])

    f.setJournal({
      phase: 'forward',
      cursor: 0,
      main: a,
      rooms: [a, c],
      writes: [
        { roomId: a, content: { v: 1, role: 'main', main: a, at: 2 } },
        { roomId: c, content: { v: 1, role: 'earlier', main: a, at: 2 } }
      ]
    })

    await f.service.request('retry')
    expect(f.writes).toEqual([
      { roomId: a, role: 'main' },
      { roomId: c, role: 'earlier' }
    ])
    expect(f.ports.finish).toHaveBeenCalledWith(a, [a, c])
  })

  it('resumes only a move whose markers are written, and waits longer after each pass that fails', async () => {
    const f = fixture([readable(a, { encrypted: false, marker: { role: 'main', main: a, at: 1 } })])
    let t = 1_000
    f.ports.now = () => t

    const effects: ConversationMigrationJournal = {
      phase: 'effects',
      cursor: 0,
      main: a,
      rooms: [a],
      writes: [{ roomId: a, content: { v: 1, role: 'main', main: a, at: 1 } }]
    }

    // A rollback clears markers: the owner's Retry, never the background.
    f.setJournal({ ...effects, phase: 'rollback', writes: [{ roomId: a, content: {} }] })
    await expect(f.service.request('resume')).resolves.toMatchObject({ state: 'retry', reason: 'rollback_pending' })
    expect(f.writes).toEqual([])

    f.setJournal(effects)
    f.setFinishFails(true)
    await expect(f.service.request('resume')).resolves.toMatchObject({ state: 'retry', reason: 'effects_pending' })
    expect(f.ports.finish).toHaveBeenCalledOnce()

    t += 60_000 - 1
    await f.service.request('resume')
    expect(f.ports.finish).toHaveBeenCalledOnce()

    t += 1
    f.setFinishFails(false)
    await expect(f.service.request('resume')).resolves.toMatchObject({ state: 'marked', main: a })
    expect(f.ports.finish).toHaveBeenCalledTimes(2)
    expect(f.journal()).toBeNull()
  })
})
