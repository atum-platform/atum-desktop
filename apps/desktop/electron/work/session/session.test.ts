import { readFileSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { partitionFor, type WorkSessionAccount } from './paths'
import { WorkSession } from './session'
import type { FakeT3Home} from './test-support';
import { FakeHost, FakeView, removeAccount, tempAccount, type ViewMode } from './test-support'
import type { PinHost, TrialContext, UpdateIncarnation } from './update'

const roots: string[] = []

/** One shared WorkHost-shaped object that serves whichever account is active, like the real one. */
class SwitchHost implements PinHost {
  constructor(private readonly active: () => FakeHost) {}

  current() { return this.active().current() }
  start(options: { continuation: boolean; trial?: TrialContext }): Promise<UpdateIncarnation> { return this.active().start(options) }
  stop() { return this.active().stop() }
  bindOwnerView() { return this.active().bindOwnerView() }
}

function lab(names = ['A']) {
  const accounts = new Map<string, { account: WorkSessionAccount; home: FakeT3Home; host: FakeHost }>()
  const events: string[] = []

  for (const name of names) {
    const { account, home } = tempAccount(name)
    roots.push(account.root)
    accounts.set(name, { account, home, host: new FakeHost(home, events) })
  }

  let active = names[0]
  const cleared: string[] = []
  const resets: string[] = []
  const byRoot = (root: string) => [...accounts.values()].find(entry => entry.account.root === root)!

  const session = new WorkSession({
    account: () => accounts.get(active)?.account,
    host: new SwitchHost(() => accounts.get(active)!.host),
    authTools: paths => {
      const { home } = byRoot(paths.work.replace(/\/work$/u, ''))

      return { cli: home.cli(), grants: home.grants() }
    },
    clearPartition: async partition => void cleared.push(partition),
    homeRunning: paths => byRoot(paths.work.replace(/\/work$/u, '')).home.running,
    pairing: { timeoutMs: 120, pollMs: 15 }
  })

  session.onResetDone(account => void resets.push(account.key))

  return {
    session, events, cleared, resets, accounts,
    switchTo: (name: string) => void (active = name),
    entry: (name: string) => accounts.get(name)!
  }
}

const views = (home: FakeT3Home, ...modes: ViewMode[]) => {
  const made: FakeView[] = []
  const jar = {}

  return { made, create: () => { const view = new FakeView(home, modes[made.length] ?? modes.at(-1) ?? 'ok', jar); made.push(view);

 return view } }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeAccount(root)
  }
})

describe('start goes through the marker first', () => {
  it('finishes an owed reset before the server starts, so nothing earlier is honoured at first readiness', async () => {
    const { session, entry } = lab()
    const { home, host } = entry('A')
    const cookie = home.issueSession()
    const hidden = home.createLink(true)
    let atStart: boolean | undefined
    host.onStart = () => void (atStart = !home.accepts(cookie) && !home.acceptsGrant(hidden))
    // A marker left by an interrupted update, with no restore involved.
    const { AuthResetMarkerStore } = await import('./marker')
    new AuthResetMarkerStore(home.paths.marker).begin('update')

    await session.start()

    expect(atStart).toBe(true)
    expect(host.starts).toBe(1)
  })

  it('does not start at all while a restore is unfinished', async () => {
    const { session, entry } = lab()
    const { home, host } = entry('A')
    const { AuthResetMarkerStore } = await import('./marker')
    new AuthResetMarkerStore(home.paths.marker).begin('update', 'started', 'snap')

    await expect(session.start()).rejects.toThrow()
    expect(host.starts).toBe(0)
    expect(session.held()).toBe(true)
  })

  it('stops a server whose home is not the one this account owns', async () => {
    const { session, entry } = lab()
    const { host } = entry('A')
    const real = host.start.bind(host)
    host.start = async options => ({ ...(await real(options)), home: '/somewhere/else' })

    await expect(session.start()).rejects.toThrow('work_home_mismatch')
    expect(host.current()).toBeUndefined()
  })
})

describe('owner view', () => {
  it('pairs the first view, allows one view at a time, and gives a later view the same session without a grant', async () => {
    const { session, entry } = lab()
    const { home, host } = entry('A')
    const { made, create } = views(home)

    const first = await session.openOwnerView(create)
    expect(first.state).toBe('paired')
    expect(host.starts).toBe(1)

    await expect(session.openOwnerView(create)).rejects.toThrow('work_view_exists')

    made[0].close()
    const second = await session.openOwnerView(create)

    expect(second.state).toBe('reused')
    expect(host.starts).toBe(1) // no restart, no second grant
    expect(made[1].seen).toEqual([`${host.current()!.origin}/`])
  })

  it('after a pairing timeout past a minted session: stops, resets on the stopped home, and pairs again from a fresh grant', async () => {
    const { session, entry, cleared, events } = lab()
    const { home, host } = entry('A')
    // Each attempt gets its own partition jar here, because the failed one is wiped and a new view starts clean.
    const made: FakeView[] = []

    const create = () => {
      const view = new FakeView(home, made.length === 0 ? 'mint_then_hang' : 'ok', {})
      made.push(view)

      return view
    }

    const opened = await session.openOwnerView(create)

    expect(opened.state).toBe('paired')
    expect(home.accepts(made[0].cookie)).toBe(false) // the minted cookie is dead
    expect(home.accepts(made[1].cookie)).toBe(true)
    expect(host.starts).toBe(2)
    expect(events.filter(event => event.startsWith('stop') || event.startsWith('start'))).toEqual([
      'start:0.1.11:nocont', 'stop:0.1.11', 'start:0.1.11:nocont'
    ])
    expect(cleared).toContain(partitionFor('A'))
  })

  it('gives up after a second failure and leaves nothing paired or running with a live grant', async () => {
    const { session, entry } = lab()
    const { home } = entry('A')
    const { create } = views(home, 'mint_then_hang')

    const opened = await session.openOwnerView(create)

    expect(opened).toEqual({ state: 'failed', reason: 'timeout' })
    expect(home.sessionCount()).toBe(0)
  })
})

describe('account switch and switch-back', () => {
  it('retires A completely, keeps B apart, and refuses every old A credential on switch-back', async () => {
    const { session, entry, switchTo, cleared, resets } = lab(['A', 'B'])
    const a = entry('A')
    const aViews = views(a.home)
    await session.openOwnerView(aViews.create)
    const oldCookie = aViews.made[0].cookie
    const strayBearer = a.home.issueSession()
    const strayGrant = a.home.createLink(false)

    await session.retire(a.account)

    expect(aViews.made[0].closed).toBe(true)
    expect(cleared).toContain(partitionFor('A'))
    expect(a.host.current()).toBeUndefined()
    expect([a.home.accepts(oldCookie), a.home.accepts(strayBearer), a.home.acceptsGrant(strayGrant)]).toEqual([false, false, false])
    expect(resets).toEqual(['A'])

    switchTo('B')
    const bViews = views(entry('B').home)
    expect((await session.openOwnerView(bViews.create)).state).toBe('paired')
    expect(entry('B').home.accepts(bViews.made[0].cookie)).toBe(true)

    await session.retire(entry('B').account)
    switchTo('A')
    const back = views(a.home)

    expect((await session.openOwnerView(back.create)).state).toBe('paired')
    expect(a.home.accepts(back.made[0].cookie)).toBe(true)
    expect(a.home.accepts(oldCookie)).toBe(false)
    expect(a.host.starts).toBe(2)
  })

  it('stops the server before the reset runs, so a cached signing key cannot survive it', async () => {
    const { session, entry } = lab()
    const a = entry('A')
    await session.start()
    a.home.running = true // the fake server is up

    // retire() awaits stop() (which clears `running`) before resetting; a reset on a live home would throw.
    await expect(session.retire(a.account)).resolves.toMatchObject({ signingKeyRemoved: true })
  })
})

describe('update through the session', () => {
  it('closes the view and clears the partition first, then pairs the committed pin from its own grant', async () => {
    const { entry, cleared, events } = lab()
    const { account, home, host } = entry('A')
    const v2 = new FakeHost(home, events, '0.1.12')

    const session = new WorkSession({
      account: () => account,
      host,
      authTools: () => ({ cli: home.cli(), grants: home.grants() }),
      clearPartition: async partition => void cleared.push(partition),
      homeRunning: () => home.running,
      update: {
        currentPin: () => ({ version: '0.1.11', resources: '/p1' }),
        hostFor: pin => (pin.version === '0.1.12' ? v2 : host),
        stopsOwed: () => false,
        freeBytes: () => 1e12,
        verifyPin: async () => undefined
      },
      pairing: { timeoutMs: 120, pollMs: 15 }
    })

    const first = views(home)
    await session.openOwnerView(first.create)
    const before = home.issueSession()

    const outcome = await session.update({ version: '0.1.12', resources: '/p2' })

    expect(outcome.outcome).toBe('committed')
    expect(first.made[0].closed).toBe(true)
    expect(cleared).toContain(partitionFor('A'))
    expect(home.accepts(before)).toBe(false)
    expect(home.accepts(first.made[0].cookie)).toBe(false)
    expect(session.held()).toBe(false)

    const after = views(home)
    expect((await session.openOwnerView(after.create)).state).toBe('paired')
    expect(v2.starts).toBe(1) // the trial's server is the one serving now
    expect(host.starts).toBe(1)
  })

  it('a refusal known up front (a stop owed) is answered BEFORE the view, the partition or the server are touched', async () => {
    const { entry, cleared } = lab()
    const { account, home, host } = entry('A')

    const session = new WorkSession({
      account: () => account,
      host,
      authTools: () => ({ cli: home.cli(), grants: home.grants() }),
      clearPartition: async partition => void cleared.push(partition),
      homeRunning: () => home.running,
      update: {
        currentPin: () => ({ version: '0.1.11', resources: '/p1' }),
        hostFor: () => host,
        stopsOwed: () => true,
        freeBytes: () => 1e12,
        verifyPin: async () => undefined
      },
      pairing: { timeoutMs: 120, pollMs: 15 }
    })

    const first = views(home)
    await session.openOwnerView(first.create)
    const started = host.starts
    const cookie = first.made[0].cookie

    expect(await session.update({ version: '0.1.12', resources: '/p2' })).toEqual({ outcome: 'refused', reason: 'stops_owed' })

    // nothing moved: the same view, the same server, no reset (the cookie still works), no partition cleared
    expect(first.made[0].closed).toBe(false)
    expect(cleared).toEqual([])
    expect(host.starts).toBe(started)
    expect(home.accepts(cookie)).toBe(true)
    expect(session.held()).toBe(false)
  })

  it('a pin this build ships that is newer than the committed one goes through the driver before the home opens', async () => {
    const { entry, events } = lab()
    const { account, home, host } = entry('A')
    const v2 = new FakeHost(home, events, '0.1.12')
    let shipped = { version: '0.1.11', resources: '/p1' }

    const session = new WorkSession({
      account: () => account,
      host,
      authTools: () => ({ cli: home.cli(), grants: home.grants() }),
      clearPartition: async () => undefined,
      homeRunning: () => home.running,
      update: { currentPin: () => shipped, hostFor: pin => (pin.version === '0.1.12' ? v2 : host), stopsOwed: () => false, freeBytes: () => 1e12, verifyPin: async () => undefined },
      pairing: { timeoutMs: 120, pollMs: 15 }
    })

    await session.start() // first run: the shipped pin is the baseline
    await host.stop()
    expect(host.starts).toBe(1)

    // the app was replaced by a build that ships 0.1.12
    shipped = { version: '0.1.12', resources: '/p2' }
    const before = home.issueSession()
    const incarnation = await session.start()

    expect(v2.starts).toBe(1) // the trial was the start
    expect(host.starts).toBe(1) // the old binary never ran again, and the new one never started outside the driver
    expect(incarnation.home).toBe(home.paths.home)
    expect(home.accepts(before)).toBe(false) // the update reset the home first
    expect(session.held()).toBe(false)
  })

  it('an installed upgrade whose trial fails ends stopped: the restored database is untouched and no binary starts after the restore', async () => {
    const { entry, events } = lab()
    const { account, home, host } = entry('A')
    const v2 = new FakeHost(home, events, '0.1.12')
    let shipped = { version: '0.1.11', resources: '/p1' }

    const session = new WorkSession({
      account: () => account,
      host,
      authTools: () => ({ cli: home.cli(), grants: home.grants() }),
      clearPartition: async () => undefined,
      homeRunning: () => home.running,
      // The previous binary is not part of the new build: only the shipped pin has a host that is not the old one.
      update: { currentPin: () => shipped, hostFor: pin => (pin.version === '0.1.12' ? v2 : host), stopsOwed: () => false, freeBytes: () => 1e12, verifyPin: async () => undefined },
      pairing: { timeoutMs: 120, pollMs: 15 }
    })

    writeFileSync(`${home.paths.database}-wal`, 'wal-before')
    await session.start() // the home last committed 0.1.11
    await host.stop()

    // The app was replaced by a build that ships 0.1.12, whose migration fails (and would fail again on a second start).
    shipped = { version: '0.1.12', resources: '/p2' }

    v2.migrate = h => {
      writeFileSync(`${h.paths.database}-wal`, 'wal-after-migration')

      throw new Error('migration_failed')
    }

    events.length = 0
    await expect(session.start()).rejects.toMatchObject({ code: 'work_update_rolled_back' })

    // exactly one start of the new binary, the failed trial; nothing after the restore
    expect(events.filter(event => event.startsWith('start:'))).toEqual(['start:0.1.12:nocont:trial'])
    expect(events.at(-1)).toBe('stop:0.1.12')
    expect(readFileSync(`${home.paths.database}-wal`, 'utf8')).toBe('wal-before')
    expect(home.running).toBe(false)
    expect(host.starts).toBe(1)
    expect(session.held()).toBe(false)
  })

  it('a stop owed with the server up refuses the shipped pin change before anything starts; a shipped pin below the committed one never starts', async () => {
    const { entry, events } = lab()
    const { account, home, host } = entry('A')
    const v2 = new FakeHost(home, events, '0.1.12')
    let shipped = { version: '0.1.11', resources: '/p1' }
    let owed = false

    const session = new WorkSession({
      account: () => account,
      host,
      authTools: () => ({ cli: home.cli(), grants: home.grants() }),
      clearPartition: async () => undefined,
      homeRunning: () => home.running,
      update: { currentPin: () => shipped, hostFor: pin => (pin.version === '0.1.12' ? v2 : host), stopsOwed: () => owed, freeBytes: () => 1e12, verifyPin: async () => undefined },
      pairing: { timeoutMs: 120, pollMs: 15 }
    })

    // the home last committed 0.1.11
    shipped = { version: '0.1.11', resources: '/p1' }
    await session.start()
    await host.stop()

    shipped = { version: '0.1.12', resources: '/p2' }
    owed = true
    await expect(session.start()).rejects.toMatchObject({ code: 'work_update_stops_owed' })
    expect(v2.starts).toBe(0)
    expect(host.starts).toBe(1)

    shipped = { version: '0.1.10', resources: '/p0' }
    await expect(session.start()).rejects.toMatchObject({ code: 'work_pin_downgrade' })
    expect(host.starts).toBe(1)
  })
})

it('shares recovery and pin setup when background warmup overlaps first open', async () => {
  const { session } = lab()
  const first = session.start()
  const second = session.start()
  expect(second).toBe(first)
  const [a, b] = await Promise.all([first, second])
  expect(a).toBe(b)
})

it('joins background startup before a sign-out restart stops and resets the server', async () => {
  const { session, entry } = lab()
  const { host } = entry('A')
  const original = host.start.bind(host)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const start = vi.spyOn(host, 'start').mockImplementationOnce(async options => {
    await gate
    return original(options)
  })
  const stop = vi.spyOn(host, 'stop')
  const warming = session.start()
  await vi.waitFor(() => expect(start).toHaveBeenCalled())
  const restarting = session.restart('sign-out')
  await Promise.resolve()
  expect(stop).not.toHaveBeenCalled()
  release()
  await warming
  await restarting
  expect(stop).toHaveBeenCalledOnce()
  expect(host.starts).toBe(2)
})


it('awaits background startup before an explicit update preflights and replaces the pin', async () => {
  const { entry } = lab()
  const { account, home, host } = entry('A')
  const next = new FakeHost(home, [], '0.1.12')
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const original = host.start.bind(host)
  const starting = vi.spyOn(host, 'start').mockImplementationOnce(async options => {
    await pending
    return original(options)
  })
  const stop = vi.spyOn(host, 'stop')
  const session = new WorkSession({
    account: () => account, host,
    authTools: () => ({ cli: home.cli(), grants: home.grants() }),
    clearPartition: async () => undefined,
    homeRunning: () => home.running,
    update: {
      currentPin: () => ({ version: '0.1.11', resources: '/p1' }),
      hostFor: pin => pin.version === '0.1.12' ? next : host,
      stopsOwed: () => false, freeBytes: () => 1e12,
      verifyPin: async () => undefined
    }
  })
  const warm = session.start()
  await vi.waitFor(() => expect(starting).toHaveBeenCalled())
  const update = session.update({ version: '0.1.12', resources: '/p2' })
  await Promise.resolve()
  expect(stop).not.toHaveBeenCalled()
  release()
  await warm
  expect(await update).toMatchObject({ outcome: 'committed' })
  expect(next.starts).toBe(1)
})
