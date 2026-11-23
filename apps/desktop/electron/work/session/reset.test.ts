import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AuthResetMarkerStore } from './marker'
import { homeRunningFromRuntimeFile, resetAuth, ResetCoordinator } from './reset'
import { removeAccount, tempAccount } from './test-support'

const roots: string[] = []

function lab() {
  const { account, home } = tempAccount()
  roots.push(account.root)

  return { account, home, deps: { paths: home.paths, cli: home.cli(), grants: home.grants(), homeRunning: () => home.running } }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeAccount(root)
  }
})

describe('auth reset on a stopped home', () => {
  it('leaves no earlier cookie, bearer, listed grant or hidden startup grant usable', async () => {
    const { home, deps } = lab()
    const cookie = home.issueSession()
    const bearer = home.issueSession()
    const listed = home.createLink(false)
    const hidden = home.createLink(true)
    const fixtures = () => [home.accepts(cookie), home.accepts(bearer), home.acceptsGrant(listed), home.acceptsGrant(hidden)]
    expect(fixtures()).toEqual([true, true, true, true])

    const report = await resetAuth(deps)

    expect(fixtures()).toEqual([false, false, false, false])
    expect(report).toMatchObject({ signingKeyRemoved: true, sessionsRevoked: 2, pairingLinksRevoked: 1, hiddenGrantsRevoked: 1 })
  })

  it('refuses to run while a server may hold the home (its cached key would survive)', async () => {
    const { home, deps } = lab()
    const cookie = home.issueSession()
    home.running = true

    await expect(resetAuth(deps)).rejects.toThrow('work_reset_home_running')
    expect(existsSync(home.paths.signingKey)).toBe(true)
    expect(home.accepts(cookie)).toBe(true)
  })

  it('is finished by running it again after a crash at any step', async () => {
    const { home, deps } = lab()
    const cookie = home.issueSession()
    const hidden = home.createLink(true)
    let revokes = 0

    const crashing = {
      ...deps,
      cli: {
        ...deps.cli,
        revokeSession: async (id: string) => {
          revokes += 1

          if (revokes === 1) {
            throw new Error('killed')
          }

          return deps.cli.revokeSession(id)
        }
      }
    }

    await expect(resetAuth(crashing)).rejects.toThrow('killed')
    // Mid-reset the key is already gone, the hidden grant still lives.
    expect(home.acceptsGrant(hidden)).toBe(true)

    await resetAuth(deps)

    expect(home.accepts(cookie)).toBe(false)
    expect(home.acceptsGrant(hidden)).toBe(false)
  })

  it('fails closed when something is still live afterwards', async () => {
    const { home, deps } = lab()
    home.issueSession()
    const stubborn = { ...deps, cli: { ...deps.cli, revokeSession: async () => undefined } }

    await expect(resetAuth(stubborn)).rejects.toThrow('work_reset_incomplete')
  })

  it('revokes credentials a restore brought back: the launcher-restore hazard', async () => {
    const { home, deps } = lab()
    const cookie = home.issueSession()
    const copy = join(home.root, 'older.sqlite')
    copyFileSync(home.paths.database, copy)
    // The session is revoked after the snapshot, then an older copy is restored over the home.
    await home.cli().revokeSession((await home.cli().sessionIds())[0])
    expect(home.accepts(cookie)).toBe(false)
    copyFileSync(copy, home.paths.database)
    expect(home.accepts(cookie)).toBe(true)

    await resetAuth(deps)

    expect(home.accepts(cookie)).toBe(false)
  })
})

describe('reset coordinator and its marker', () => {
  it('writes the marker before the reset and clears it after, then reports reset done', async () => {
    const { home, deps } = lab()
    const coordinator = new ResetCoordinator(deps)
    const cookie = home.issueSession()
    const seen: (string | undefined)[] = []
    const cli = deps.cli

    const spy = new ResetCoordinator({
      ...deps,
      cli: {
        ...cli,
        sessionIds: async () => {
          seen.push(coordinator.markers.read()?.reason)

          return cli.sessionIds()
        }
      }
    }, coordinator.markers)

    let done = 0
    spy.onResetDone(() => void (done += 1))

    await spy.reset('switch')

    expect(seen[0]).toBe('switch')
    expect(spy.pending()).toBeUndefined()
    expect(done).toBe(1)
    expect(home.accepts(cookie)).toBe(false)
  })

  it('keeps the marker when the reset dies, and reconcile finishes it before anything starts', async () => {
    const { home, deps } = lab()
    const hidden = home.createLink(true)

    const dying = new ResetCoordinator({
      ...deps,
      cli: { ...deps.cli, pairingIds: async () => { throw new Error('killed') } }
    })

    await expect(dying.reset('sign-out')).rejects.toThrow('killed')
    expect(dying.pending()?.reason).toBe('sign-out')
    expect(home.acceptsGrant(hidden)).toBe(true)

    // A new process: same files, fresh objects.
    const restarted = new ResetCoordinator(deps)
    const report = await restarted.reconcile()

    expect(report?.hiddenGrantsRevoked).toBe(1)
    expect(home.acceptsGrant(hidden)).toBe(false)
    expect(restarted.pending()).toBeUndefined()
  })

  it('does nothing without a marker, and refuses a plain reset over a restore in flight', async () => {
    const { home, deps } = lab()
    const coordinator = new ResetCoordinator(deps)
    const cookie = home.issueSession()

    expect(await coordinator.reconcile()).toBeUndefined()
    expect(home.accepts(cookie)).toBe(true)

    coordinator.markers.begin('update', 'started', 'snap-1')
    await expect(coordinator.reconcile()).rejects.toThrow('work_restore_unfinished')
    expect(home.accepts(cookie)).toBe(true)
  })

  it('treats an unreadable marker as a reset still owed, never as no marker', () => {
    const { home } = lab()
    mkdirSync(home.paths.work, { recursive: true })
    writeFileSync(home.paths.marker, '{not json')

    expect(new AuthResetMarkerStore(home.paths.marker).read()?.reason).toBe('corrupt')
  })

  it('does not downgrade a restore already in flight', () => {
    const { home } = lab()
    const store = new AuthResetMarkerStore(home.paths.marker)
    store.begin('update', 'started', 'snap-1')

    expect(store.begin('switch', 'none').restore).toBe('started')
    expect(store.read()?.snapshotId).toBe('snap-1')
  })
})

describe('home liveness from T3 runtime file', () => {
  it('is running only when the recorded pid is alive; an unreadable file counts as running', () => {
    const { home } = lab()
    const running = (pidAlive: (pid: number) => boolean) => homeRunningFromRuntimeFile(home.paths, pidAlive)()

    expect(running(() => true)).toBe(false) // no file: nothing recorded
    writeFileSync(join(home.paths.userdata, 'server-runtime.json'), JSON.stringify({ pid: 4242 }))
    expect(running(pid => pid === 4242)).toBe(true)
    expect(running(() => false)).toBe(false)
    writeFileSync(join(home.paths.userdata, 'server-runtime.json'), 'garbage')
    expect(running(() => false)).toBe(true)
    rmSync(join(home.paths.userdata, 'server-runtime.json'))
  })
})

