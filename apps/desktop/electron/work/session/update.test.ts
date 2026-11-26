import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResetCoordinator } from './reset'
import type { FakeT3Home} from './test-support';
import { FakeHost, type FakeToken, removeAccount, tempAccount } from './test-support'
import { type PinRef, type UpdateDeps, UpdateDriver } from './update'

const roots: string[] = []

const V1: PinRef = { version: '0.1.11', resources: '/pins/0.1.11' }
const V2: PinRef = { version: '0.1.12', resources: '/pins/0.1.12' }

function lab(overrides: Partial<UpdateDeps> = {}) {
  const { account, home } = tempAccount()
  roots.push(account.root)
  writeFileSync(`${home.paths.database}-wal`, 'wal-before')
  writeFileSync(`${home.paths.database}-shm`, 'shm-before')
  const events: string[] = []
  const hosts = { [V1.version]: new FakeHost(home, events, V1.version), [V2.version]: new FakeHost(home, events, V2.version) }
  const log: string[] = []

  const build = (current: PinRef = V1) => {
    const coordinator = new ResetCoordinator({ paths: home.paths, cli: home.cli(), grants: home.grants(), homeRunning: () => home.running })

    const driver = new UpdateDriver({
      paths: home.paths,
      coordinator,
      currentPin: () => current,
      hostFor: pin => hosts[pin.version],
      stopRunning: async () => {
        await hosts[V1.version].stop()
        await hosts[V2.version].stop()
      },
      freeBytes: () => 1e12,
      verifyPin: async () => undefined,
      log: event => void log.push(event),
      ...overrides
    })

    return { coordinator, driver }
  }

  return { account, home, events, hosts, log, ...build(), build }
}

/** Credentials of every kind, minted before an update. */
function fixtures(home: FakeT3Home) {
  const cookie = home.issueSession()
  const bearer = home.issueSession()
  const listed = home.createLink(false)
  const hidden = home.createLink(true)

  return {
    cookie,
    bearer,
    anyAccepted: () => home.accepts(cookie) || home.accepts(bearer) || home.acceptsGrant(listed) || home.acceptsGrant(hidden)
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeAccount(root)
  }
})

describe('main-owned update: baseline', () => {
  it('records the running pin on the first update call, so a later downgrade is refused even if it was never committed by an update', async () => {
    const { driver } = lab()

    expect(driver.readState()).toBeUndefined()
    expect(await driver.update({ version: '0.1.11', resources: '/pins/0.1.11' })).toEqual({ outcome: 'refused', reason: 'not_newer' })
    expect(driver.readState()).toMatchObject({ pin: '0.1.11', committed: [] })
    expect(await driver.update({ version: '0.1.10', resources: '/pins/0.1.10' })).toEqual({ outcome: 'refused', reason: 'downgrade' })
  })
})

describe('main-owned update: success path', () => {
  it('resets BEFORE the snapshot, trials with continuation off, commits, and refuses a downgrade after', async () => {
    const { home, hosts, events, driver, coordinator } = lab()
    await hosts[V1.version].start({ continuation: false })
    const before = fixtures(home)

    hosts[V2.version].onStart = ({ trial }) => {
      expect(trial?.update).toMatchObject({ fromVersion: '0.1.11', targetVersion: '0.1.12', status: 'pending' })
      // At the first moment the new pin could serve, nothing from before is honoured.
      expect(before.anyAccepted()).toBe(false)
      expect(coordinator.pending()?.restore).toBe('pending')
    }

    const outcome = await driver.update(V2)

    expect(outcome.outcome).toBe('committed')
    expect(events.filter(event => event.startsWith('start:0.1.12'))).toEqual(['start:0.1.12:nocont:trial'])
    expect(events.indexOf('stop:0.1.11')).toBeLessThan(events.indexOf('start:0.1.12:nocont:trial'))
    expect(driver.readState()?.pin).toBe('0.1.12')
    expect(coordinator.pending()).toBeUndefined()
    expect(existsSync(home.paths.snapshot)).toBe(false)

    expect((await driver.update(V1)).outcome).toBe('refused')
    expect(await driver.update(V1)).toEqual({ outcome: 'refused', reason: 'downgrade' })
    expect(await driver.update(V2)).toEqual({ outcome: 'refused', reason: 'not_newer' })
  })

  it('answers committed through the trial handle only after prepared, once', async () => {
    const commit = vi.fn(async () => undefined)
    const { hosts, driver } = lab()
    hosts[V2.version].trialMode = () => ({ prepared: Promise.resolve(), commit })

    expect((await driver.update(V2)).outcome).toBe('committed')
    expect(commit).toHaveBeenCalledTimes(1)
  })
})

describe('main-owned update: preflight refusals change nothing', () => {
  it.each([
    ['pin_unverified', { verifyPin: async () => { throw new Error('digest') } }],
    ['insufficient_space', { freeBytes: () => 1024 }],
  ] as const)('refuses %s before stopping anything', async (reason, overrides) => {
    const { home, events, driver } = lab(overrides)
    const before = fixtures(home)

    expect(await driver.update(V2)).toEqual({ outcome: 'refused', reason })
    expect(events).toEqual([])
    expect(before.anyAccepted()).toBe(true)
    expect(existsSync(home.paths.marker)).toBe(false)
  })

  it('runs one update at a time', async () => {
    const { driver, hosts } = lab()
    hosts[V2.version].trialMode = () => ({ prepared: new Promise(resolve => setTimeout(resolve, 30)), commit: async () => undefined })
    const first = driver.update(V2)

    expect(await driver.update(V2)).toEqual({ outcome: 'refused', reason: 'in_progress' })
    expect((await first).outcome).toBe('committed')
  })
})

describe('main-owned update: a failed trial restores, then resets, then starts the old pin', () => {
  it('restores the snapshot bytes, and no credential from before or from the trial survives', async () => {
    const { home, hosts, events, driver, coordinator } = lab()
    await hosts[V1.version].start({ continuation: false })
    const before = fixtures(home)
    let trialSession: FakeToken | undefined

    hosts[V2.version].migrate = h => {
      trialSession = h.issueSession()
      writeFileSync(`${h.paths.database}-wal`, 'wal-after-migration')

      throw new Error('migration_failed')
    }

    let atOldStart: boolean | undefined

    hosts[V1.version].onStart = () => {
      // First moment the restored home could serve: marker gone, everything refused.
      atOldStart = !before.anyAccepted() && !home.accepts(trialSession) && coordinator.pending() === undefined
    }

    const outcome = await driver.update(V2)

    expect(outcome).toMatchObject({ outcome: 'rolled_back', reason: 'migration_failed' })
    expect(atOldStart).toBe(true)
    expect(events.slice(-2)).toEqual(['stop:0.1.12', 'start:0.1.11:nocont'])
    expect(readFileSync(`${home.paths.database}-wal`, 'utf8')).toBe('wal-before')
    expect(driver.readState()?.pin ?? '0.1.11').toBe('0.1.11')
    expect(existsSync(home.paths.snapshot)).toBe(false)
  })

  it.each([
    ['start throws', (h: FakeHost) => { h.failStart = true }],
    ['commit is too slow', (h: FakeHost) => { h.trialMode = () => ({ prepared: Promise.resolve(), commit: () => new Promise<void>(() => undefined) }) }],
    ['prepared never arrives', (h: FakeHost) => { h.trialMode = () => ({ prepared: new Promise<void>(() => undefined), commit: async () => undefined }) }]
  ])('rolls back when %s', async (_name, break_) => {
    const { hosts, driver, home } = lab({ prepareWithinMs: 40, commitWithinMs: 40 })
    const before = fixtures(home)
    break_(hosts[V2.version])

    const outcome = await driver.update(V2)

    expect(outcome.outcome).toBe('rolled_back')
    expect(before.anyAccepted()).toBe(false)
    expect(driver.readState()?.pin ?? '0.1.11').toBe('0.1.11')
  })

  it('reports no incarnation when the old pin cannot restart, and keeps nothing live', async () => {
    const { hosts, driver, home } = lab()
    hosts[V2.version].failStart = true
    hosts[V1.version].failStart = true

    const outcome = await driver.update(V2)

    expect(outcome).toMatchObject({ outcome: 'rolled_back' })
    expect((outcome as { incarnation?: unknown }).incarnation).toBeUndefined()
    expect(home.running).toBe(false)
  })

  it('never lets a pairing URL reach the outcome or the log', async () => {
    const { hosts, driver, log } = lab()

    hosts[V2.version].migrate = () => {
      throw new Error('boom pairingUrl: http://127.0.0.1:1/pair#token=SECRETTOKEN123')
    }

    const outcome = await driver.update(V2)

    expect(JSON.stringify(outcome)).not.toContain('SECRETTOKEN123')
    expect(log.join('\n')).not.toContain('SECRETTOKEN123')
  })
})

describe('main-owned update: a crash at any point is finished before the home serves', () => {
  /** Run an update that "dies" at an event, then bring up fresh objects over the same files. */
  async function crashAt(event: string) {
    const crash = lab({
      log: name => {
        if (name === event) {
          throw new Error('killed')
        }
      }
    })

    await crash.hosts[V1.version].start({ continuation: false })
    const before = fixtures(crash.home)
    crash.hosts[V2.version].failStart = event === 'update_trial_failed'
    await expect(crash.driver.update(V2)).rejects.toThrow('killed')
    crash.home.running = false

    return { ...crash, before }
  }

  it.each(['update_reset_before_snapshot', 'update_snapshot_taken', 'update_trial_failed'])(
    'after %s: recover, reconcile, then the old pin starts on a reset, restored home',
    async event => {
      const { home, hosts, before, build } = await crashAt(event)
      hosts[V2.version].migrate = h => void h.issueSession()
      const { driver, coordinator } = build()

      if (event === 'update_trial_failed') {
        // The server was mid-migration when the app died.
        home.issueSession()
      }

      expect(coordinator.pending()).toBeDefined()
      expect(await driver.recover()).toMatch(/reset_only|restored/u)
      await coordinator.reconcile()

      expect(coordinator.pending()).toBeUndefined()
      expect(before.anyAccepted()).toBe(false)
      expect(home.sessionCount()).toBe(0)
      expect(existsSync(home.paths.snapshot)).toBe(false)
    }
  )

  it('refuses to serve while a restore is unfinished: reconcile alone cannot proceed', async () => {
    const { build } = await crashAt('update_snapshot_taken')
    const { coordinator } = build()

    await expect(coordinator.reconcile()).rejects.toThrow('work_restore_unfinished')
    expect(coordinator.pending()?.restore).toBe('pending')
  })

  it('repeats a half-done restore from the kept snapshot', async () => {
    const { home, build } = await crashAt('update_snapshot_taken')
    const { driver, coordinator } = build()
    // The restore had begun: the live database is half replaced.
    coordinator.markers.advance('started')
    rmSync(`${home.paths.database}-wal`)
    writeFileSync(home.paths.database, 'half written')

    expect(await driver.recover()).toBe('restored')
    expect(coordinator.pending()?.restore).toBe('done')
    expect(readFileSync(`${home.paths.database}-wal`, 'utf8')).toBe('wal-before')
    await coordinator.reconcile()
    expect(home.sessionCount()).toBe(0)
  })

  it('takes a crash after the commit was recorded as a commit, without restoring', async () => {
    const { home, hosts, driver, coordinator, build } = lab()
    hosts[V2.version].migrate = h => void h.issueSession()
    await driver.update(V2)
    const migrated = readFileSync(home.paths.database, 'utf8')
    const state = driver.readState()!
    // Die between "commit recorded" and "marker cleared".
    coordinator.markers.begin('update', 'pending', state.committed[0])
    home.running = false
    const fresh = build(V2)

    expect(await fresh.driver.recover()).toBe('committed')
    await fresh.coordinator.reconcile()

    expect(readFileSync(home.paths.database, 'utf8').length).toBeGreaterThan(0)
    expect(migrated).toContain('sessions')
    expect(fresh.driver.readState()?.pin).toBe('0.1.12')
  })

  it('cleans a snapshot that never completed and resets only', async () => {
    const { home, build } = lab()
    const { driver, coordinator } = build()
    coordinator.markers.begin('update', 'none')
    writeFileSync(join(home.paths.work, 'placeholder'), '')

    expect(await driver.recover()).toBe('reset_only')
    await coordinator.reconcile()
    expect(coordinator.pending()).toBeUndefined()
  })
})
