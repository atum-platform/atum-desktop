import { afterEach, describe, expect, it, vi } from 'vitest'

import { ACME, botAppWire } from '../../shared/app-catalog.test-support'
import { AppSurfaceError } from '../../shared/app-view/protocol'

import type { AppAuthSheetRequest } from './app-auth-sheet'
import { createMatrixApps } from './app-workspace'

const river = descriptor(
  'river',
  '00000000-0000-4000-8000-11e594f48195',
  '00000000-0000-4000-8000-dd7df1164681',
  'none'
)

const moon = descriptor(
  'moon',
  '00000000-0000-4000-8000-e79acd97ac88',
  '00000000-0000-4000-8000-5ba39b7cfa53',
  'external_account'
)

const oldScope = { accountKey: 'old-account', generation: 1 }
const newScope = { accountKey: 'new-account', generation: 2 }

function descriptor(app: string, appId: string, version: string, mode: 'none' | 'external_account') {
  return {
    app,
    app_id: appId,
    app_version_id: version,
    name: { en: app[0].toUpperCase() + app.slice(1), vi: app },
    subtitle: null,
    description: null,
    icon: null,
    accent: null,
    affiliation: null,
    verified: true,
    availability: 'available',
    roster_default: true,
    roster_order: 0,
    supported_modes: ['direct'],
    matrix_room_context: 'addressed_only' as string | null | undefined,
    has_surface: true,
    link: { mode, state: 'never_linked' }
  }
}

function catalog(apps = [river, moon]) {
  return { profile: 'atum.app-catalog/1', apps }
}

function workspace(app = river, overrides: Record<string, unknown> = {}) {
  return {
    profile: 'atum.app-workspace/1',
    descriptor: app,
    web_origin: `https://${app.app}.atum.test`,
    network_origins: [],
    manifest: {
      profile: 'atum.remote-app-manifest/1',
      manifest_version: '1.0.0',
      app: {
        id: app.app_id,
        slug: app.app,
        app_version_id: app.app_version_id,
        name: app.name,
        verified: app.verified,
        availability: app.availability
      },
      link: app.link,
      launch: { profile: 'atum.app-launch/1', path: '/open' },
      routes: [
        {
          id: 'open',
          label: { en: 'Open', vi: 'Mở' },
          icon: 'external-link',
          path: '/open',
          placements: ['menu'],
          session: 'required'
        },
        {
          id: 'draft',
          label: { en: 'Draft', vi: 'Nháp' },
          icon: 'edit',
          path: '/draft',
          placements: ['composer'],
          session: 'none'
        }
      ]
    },
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

function fixture(
  handler: (resource: { app?: string; action?: string }, body?: Record<string, unknown>) => Promise<unknown> | unknown,
  extra: {
    schedule?: (run: () => void, ms: number) => () => void
    log?: (line: string) => void
    botStatus?: (slug: string) => Promise<unknown>
    openAuthorize?: (request: AppAuthSheetRequest) => Promise<{ close(): void }>
    locale?: () => 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'
  } = {}
) {
  let scope: { accountKey: string; generation: number } | null = oldScope
  const views = { revokeApp: vi.fn(async () => undefined), revokeAccount: vi.fn(async () => undefined) }

  const account = {
    readDomain: vi.fn(async () => undefined),
    appScope: vi.fn(() => scope),
    appRequest: vi.fn((resource: { app?: string; action?: string }, body?: Record<string, unknown>) =>
      handler(resource, body)
    )
  }

  const changed = vi.fn()
  const catalogChanged = vi.fn(async () => undefined)
  const stopParticipants = vi.fn(async (_slug?: string) => {})
  const withdrawParticipant = vi.fn(async (_slug: string) => {})
  const reconcileParticipants = vi.fn(async (_apps: unknown[], _active: () => boolean) => {})

  const apps = createMatrixApps({
    account: account as never,
    views: () => views as never,
    resource: 'https://matrix.test/api/matrix/v1',
    openExternal: vi.fn(async () => undefined),
    changed,
    catalogChanged,
    stopParticipants,
    withdrawParticipant,
    reconcileParticipants,
    ...extra
  })

  return {
    apps,
    account,
    views,
    changed,
    catalogChanged,
    stopParticipants,
    withdrawParticipant,
    reconcileParticipants,
    setScope: (next: typeof scope) => {
      scope = next
    }
  }
}

async function expectCode(operation: Promise<unknown>, code: string) {
  await expect(operation).rejects.toMatchObject({ code })
}

describe('Matrix app workspace composition', () => {
  describe('an unreadable catalog', () => {
    function timers() {
      const pending: Array<{ run: () => void; ms: number; cancelled: boolean }> = []

      return {
        pending,
        schedule: (run: () => void, ms: number) => {
          const entry = {
            run: () => {
              entry.cancelled = true
              run()
            },
            ms,
            cancelled: false
          }

          pending.push(entry)

          return () => {
            entry.cancelled = true
          }
        },
        due: () => pending.filter(entry => !entry.cancelled)
      }
    }

    it('is read again in the background, with growing gaps, until it answers', async () => {
      const lines: string[] = []
      const clock = timers()
      let outage = 3

      const f = fixture(
        () => {
          if (outage-- > 0) {
            throw new AppSurfaceError('temporarily_unavailable', 503)
          }

          return catalog([moon])
        },
        { schedule: clock.schedule, log: line => lines.push(line) }
      )

      await f.apps.refresh()
      expect(f.apps.snapshot().state).toBe('unavailable')
      expect(clock.due().map(entry => entry.ms)).toEqual([5_000])

      clock.due()[0]!.run()
      await vi.waitFor(() => expect(clock.pending).toHaveLength(2))
      expect(clock.pending[1]!.ms).toBe(15_000)
      // A re-read in the background does not flash the apps pages to "loading".
      expect(f.apps.snapshot().state).toBe('unavailable')

      clock.pending[1]!.run()
      await vi.waitFor(() => expect(clock.pending).toHaveLength(3))
      expect(clock.pending[2]!.ms).toBe(30_000)

      clock.pending[2]!.run()
      await vi.waitFor(() => expect(f.apps.snapshot().state).toBe('ready'))
      expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon'])
      expect(clock.due()).toHaveLength(0)
      // One line per change of outcome: the outage once, then the recovery.
      expect(lines).toEqual([
        '[Matrix] apps catalog outcome=failed code=temporarily_unavailable retry=5',
        '[Matrix] apps catalog outcome=ready apps=1 bots=0 linked=0 slugs=moon'
      ])
    })

    it('is not read again once the account is gone or the person refreshes by hand', async () => {
      const clock = timers()
      let outage = true

      const f = fixture(() => (outage ? Promise.reject(new Error('offline')) : catalog([moon])), {
        schedule: clock.schedule
      })

      await f.apps.refresh()
      expect(clock.due()).toHaveLength(1)

      outage = false
      await f.apps.refresh(true)
      expect(f.apps.snapshot().state).toBe('ready')
      expect(clock.due()).toHaveLength(0)

      outage = true
      await f.apps.refresh()
      expect(clock.due()).toHaveLength(1)
      await f.apps.reset()
      expect(clock.due()).toHaveLength(0)
    })

    it('is read again after an app-only 401 empties it while the person is still signed in', async () => {
      const lines: string[] = []
      const clock = timers()
      let grant = true

      const f = fixture(
        resource => {
          if (!resource.app) {
            return catalog([moon])
          }

          if (grant) {
            grant = false
            throw new AppSurfaceError('account_unavailable', 401)
          }

          return workspace(moon)
        },
        { schedule: clock.schedule, log: line => lines.push(line) }
      )

      await f.apps.refresh()
      expect(f.apps.snapshot().apps).toHaveLength(1)
      await expectCode(f.apps.menu(moon.app_id), 'account_unavailable')
      // The 401 reset the catalog: Moon is gone from it until it is read again.
      expect(f.apps.snapshot()).toMatchObject({ state: 'unavailable', apps: [] })
      expect(clock.due().map(entry => entry.ms)).toEqual([5_000])
      expect(lines.at(-1)).toBe('[Matrix] apps catalog outcome=failed code=account_unavailable retry=5')

      clock.due()[0]!.run()
      await vi.waitFor(() => expect(f.apps.snapshot().state).toBe('ready'))
      expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon'])
    })

    it('stays quiet without a scheduler or when signed out', async () => {
      const clock = timers()
      const quiet = fixture(() => Promise.reject(new Error('offline')))
      await quiet.apps.refresh()
      expect(quiet.apps.snapshot().state).toBe('unavailable')

      const signedOut = fixture(() => Promise.reject(new Error('offline')), { schedule: clock.schedule })
      signedOut.setScope(null)
      await signedOut.apps.refresh()
      expect(clock.due()).toHaveLength(0)
    })

    it('keeps reading every 120 s once a steady outage outlives the backoff', async () => {
      const clock = timers()
      const f = fixture(() => Promise.reject(new Error('offline')), { schedule: clock.schedule, log: () => {} })

      await f.apps.refresh()
      expect(clock.due().map(entry => entry.ms)).toEqual([5_000])

      const expected = [15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000]

      for (const [index, ms] of expected.entries()) {
        clock.due()[0]!.run()
        await vi.waitFor(() => expect(clock.due()).toHaveLength(1))
        expect(clock.due()[0]!.ms, `gap ${index + 2}`).toBe(ms)
      }

      expect(f.account.readDomain).toHaveBeenCalledTimes(expected.length + 1)
    })

    it('does not read once more when a retry scheduled before sign-out fires', async () => {
      const clock = timers()
      const f = fixture(() => Promise.reject(new Error('offline')), { schedule: clock.schedule, log: () => {} })

      await f.apps.refresh()
      expect(f.account.readDomain).toHaveBeenCalledTimes(1)
      expect(clock.due()).toHaveLength(1)

      f.setScope(null)
      clock.due()[0]!.run()
      await Promise.resolve()
      await Promise.resolve()

      // The pending retry belongs to the signed-out scope: it reads nothing and schedules nothing.
      expect(f.account.readDomain).toHaveBeenCalledTimes(1)
      expect(clock.due()).toHaveLength(0)
    })

    it('does not read the next account when a retry scheduled for the previous generation fires', async () => {
      const clock = timers()
      let outage = true

      const f = fixture(
        () => (outage ? Promise.reject(new Error('offline')) : catalog([moon])),
        { schedule: clock.schedule, log: () => {} }
      )

      await f.apps.refresh()
      expect(f.account.readDomain).toHaveBeenCalledTimes(1)
      expect(clock.due()).toHaveLength(1)

      // The person signs into another account before the backoff elapses; its own sign-in
      // reads the catalog. The old timer must not read the new account's domain.
      f.setScope(newScope)
      outage = false
      clock.due()[0]!.run()
      await Promise.resolve()
      await Promise.resolve()

      expect(f.account.readDomain).toHaveBeenCalledTimes(1)
      expect(clock.due()).toHaveLength(0)

      // A read for the new scope still works and is the one that settles it.
      await f.apps.refresh()
      expect(f.account.readDomain).toHaveBeenCalledTimes(2)
      expect(f.apps.snapshot().state).toBe('ready')
    })
  })

  describe('a catalog on a window left open for days', () => {
    afterEach(() => vi.useRealTimers())

    const acme = botAppWire(ACME) as unknown as typeof moon

    function open(handler: (resource: { app?: string; action?: string }) => unknown) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-24T10:00:00Z'))
      const lines: string[] = []
      const f = fixture(handler, { log: line => lines.push(line) })

      return { f, lines }
    }

    const minutes = (count: number) => vi.setSystemTime(Date.now() + count * 60_000)

    // Icons load after a refresh answers and tell the window when they land: let that finish.
    const settle = () => new Promise<void>(resolve => setImmediate(resolve))

    it('adopts an app published after it signed in, the next time the window looks', async () => {
      let published = false
      const { f, lines } = open(() => catalog(published ? [moon, acme] : [moon]))

      await f.apps.refresh()
      expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon'])
      expect(f.catalogChanged).toHaveBeenLastCalledWith([moon.app_id])

      published = true
      minutes(10)
      await f.apps.revalidate()

      expect(f.apps.snapshot().state).toBe('ready')
      expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon', 'acme'])
      // The window learns the new id (its roster preference reads it) and main.log names the app.
      expect(f.catalogChanged).toHaveBeenLastCalledWith([moon.app_id, ACME.appId])
      expect(lines.at(-1)).toBe('[Matrix] apps catalog outcome=ready apps=2 bots=1 linked=0 slugs=moon,acme:active')
    })

    // The platform answers 200 with the apps it could read and leaves out one it could not
    // ("one momentarily unreadable app must not blank the whole roster"), and the wire has no
    // tombstone and no completeness marker: a look can add and update, never withdraw.
    describe('an answer that leaves an app out', () => {
      const linkedMoon = { ...moon, link: { ...moon.link, state: 'linked' } } as typeof moon

      /** The last good catalog holds River and a linked Moon; each look answers what `answer` says. */
      async function partial(answer: () => unknown[]) {
        let first = true
        const harness = open(() => catalog((first ? [river, linkedMoon] : answer()) as never))

        await harness.f.apps.refresh()
        await settle()
        first = false
        harness.f.changed.mockClear()
        harness.f.catalogChanged.mockClear()
        minutes(10)

        return harness
      }

      const nothingWithdrawn = (f: ReturnType<typeof open>['f']) => {
        expect(f.withdrawParticipant).not.toHaveBeenCalled()
        expect(f.stopParticipants).not.toHaveBeenCalled()
        expect(f.views.revokeApp).not.toHaveBeenCalled()
        expect(f.views.revokeAccount).not.toHaveBeenCalled()
      }

      it('keeps the app it leaves out, and revokes nothing', async () => {
        const { f } = await partial(() => [river])
        f.stopParticipants.mockClear()

        await f.apps.revalidate()

        // Moon stays as last read, still linked and still usable; nothing was shown or stopped.
        expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['river', 'moon'])
        expect(f.apps.participant(moon.app_id).link.state).toBe('linked')
        expect(f.changed).not.toHaveBeenCalled()
        expect(f.catalogChanged).not.toHaveBeenCalled()
        nothingWithdrawn(f)
      })

      it('treats an empty answer the same way', async () => {
        const { f } = await partial(() => [])
        f.stopParticipants.mockClear()

        await f.apps.revalidate()

        expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['river', 'moon'])
        nothingWithdrawn(f)
      })

      it('applies what the answer does say: additions and updates join the last good catalog', async () => {
        const quieterRiver = { ...river, subtitle: { en: 'Updated' } }
        const { f } = await partial(() => [quieterRiver, acme])
        f.stopParticipants.mockClear()

        await f.apps.revalidate()

        const apps = f.apps.snapshot().apps
        expect(apps.map(app => app.app)).toEqual(['river', 'moon', 'acme'])
        expect(apps[0]!.subtitle).toEqual({ en: 'Updated' })
        // The window learns all three ids: Moon was left out of the answer, not out of the catalog.
        expect(f.catalogChanged).toHaveBeenLastCalledWith([river.app_id, moon.app_id, ACME.appId])
        // And the step that revokes an enrollment whose app is not in the catalog (main's
        // reconcileParticipants) is given Moon too: it is the one place that revokes durably.
        expect(f.reconcileParticipants.mock.calls.at(-1)![0].map((app: { app: string }) => app.app)).toEqual([
          'river',
          'moon',
          'acme'
        ])
        nothingWithdrawn(f)
      })

      it('still suspends an app the answer calls unavailable, and revokes no account', async () => {
        const { f } = await partial(() => [{ ...river, availability: 'unavailable' }, linkedMoon])
        f.stopParticipants.mockClear()

        await f.apps.revalidate()

        // An explicit state: River's readers and views stop; no enrollment is revoked.
        expect(f.stopParticipants).toHaveBeenCalledWith('river')
        expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'river' })
        expect(f.withdrawParticipant).not.toHaveBeenCalled()
        expect(f.views.revokeAccount).not.toHaveBeenCalled()
      })

      it('does not read an app replaced under its slug as an omission', async () => {
        const replacement = { ...linkedMoon, app_id: '00000000-0000-4000-8000-87d96e07d1bf' }
        const { f } = await partial(() => [river, replacement])
        f.stopParticipants.mockClear()

        await f.apps.revalidate()

        // The slug is positively claimed by another id: that is a replacement, and the old one is withdrawn.
        expect(f.apps.snapshot().apps.map(app => app.app_id)).toEqual([river.app_id, replacement.app_id])
        expect(f.withdrawParticipant).toHaveBeenCalledExactlyOnceWith('moon')
      })

      it('says in main.log which apps it kept, once per change', async () => {
        const lines: string[] = []
        let first = true
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-10-24T10:00:00Z'))

        const f = fixture(() => catalog((first ? [river, linkedMoon] : [river]) as never), {
          log: line => lines.push(line)
        })

        await f.apps.refresh()
        first = false
        minutes(10)
        await f.apps.revalidate()
        minutes(10)
        await f.apps.revalidate()

        expect(lines.filter(line => line.includes('outcome=partial'))).toEqual([
          '[Matrix] apps catalog outcome=partial kept=moon'
        ])
      })
    })

    it('adopts a bot that came back, not only a new app', async () => {
      let state: 'unavailable' | 'active' = 'unavailable'
      const { f } = open(() => catalog([botAppWire(ACME, {}, { state }) as unknown as typeof moon]))

      await f.apps.refresh()
      expect(f.apps.snapshot().apps[0]!.bot?.state).toBe('unavailable')

      state = 'active'
      minutes(10)
      await f.apps.revalidate()
      expect(f.apps.snapshot().apps[0]!.bot?.state).toBe('active')
    })

    it('does nothing, and shows nothing, while the catalog is the same', async () => {
      const { f, lines } = open(() => catalog([moon, acme]))

      await f.apps.refresh()
      await settle()
      f.changed.mockClear()
      f.catalogChanged.mockClear()
      minutes(10)
      await f.apps.revalidate()

      // No "loading" flash, no new snapshot, no new line: the look found nothing to say.
      expect(f.apps.snapshot().state).toBe('ready')
      expect(f.changed).not.toHaveBeenCalled()
      expect(f.catalogChanged).not.toHaveBeenCalled()
      expect(f.reconcileParticipants).toHaveBeenCalledOnce()
      expect(lines).toHaveLength(1)
    })

    it('looks at most once in five minutes, however often the window comes forward', async () => {
      const { f } = open(() => catalog([moon]))

      await f.apps.refresh()
      const reads = () => f.account.appRequest.mock.calls.length

      await f.apps.revalidate()
      expect(reads()).toBe(1)

      minutes(4)
      await f.apps.revalidate()
      expect(reads()).toBe(1)

      minutes(2)
      await f.apps.revalidate()
      await f.apps.revalidate()
      expect(reads()).toBe(2)
    })

    it('keeps the catalog on screen when the look fails, and leaves the apps it runs alone', async () => {
      const clock: Array<() => void> = []
      let outage = false

      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-24T10:00:00Z'))

      const f = fixture(() => (outage ? Promise.reject(new Error('offline')) : catalog([moon])), {
        schedule: run => {
          clock.push(run)

          return () => {}
        },
        log: () => {}
      })

      await f.apps.refresh()
      await settle()
      f.changed.mockClear()
      f.stopParticipants.mockClear()
      outage = true
      minutes(10)
      await f.apps.revalidate()

      expect(f.apps.snapshot().state).toBe('ready')
      expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon'])
      expect(f.stopParticipants).not.toHaveBeenCalled()
      expect(f.views.revokeAccount).not.toHaveBeenCalled()
      expect(f.changed).not.toHaveBeenCalled()
      // A failed look is not an outage of the catalog: nothing is queued to read it again.
      expect(clock).toHaveLength(0)
    })

    it('does not look while there is no ready catalog to compare, or after the account is gone', async () => {
      const { f } = open(() => catalog([moon]))

      await f.apps.revalidate()
      expect(f.account.appRequest).not.toHaveBeenCalled()

      await f.apps.refresh()
      f.account.appRequest.mockClear()
      f.setScope(null)
      minutes(10)
      await f.apps.revalidate()
      expect(f.account.appRequest).not.toHaveBeenCalled()
    })

    it('drops a look that another account made out of date while it was reading', async () => {
      const slow = deferred<unknown>()
      let reads = 0
      const { f } = open(() => (++reads === 1 ? catalog([moon]) : slow.promise))

      await f.apps.refresh()
      minutes(10)
      const looking = f.apps.revalidate()
      await vi.waitFor(() => expect(reads).toBe(2))
      f.setScope(newScope)
      slow.resolve(catalog([moon, acme]))
      await looking

      // The look belonged to the account that signed out: nothing of it was adopted.
      f.setScope(oldScope)
      expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon'])
      expect(f.catalogChanged).toHaveBeenCalledTimes(1)
    })

    it('drops a look that a newer read overtook while it was reading', async () => {
      const slow = deferred<unknown>()
      let reads = 0
      let published = false

      const { f } = open(() => {
        // The window's first read, then the slow look, then the read that overtakes it.
        reads++

        if (reads === 2) {
          return slow.promise
        }

        return catalog(published ? [moon, acme] : [moon])
      })

      await f.apps.refresh()
      minutes(10)
      const looking = f.apps.revalidate()
      await vi.waitFor(() => expect(reads).toBe(2))

      // While the look waits, the person links an app and the window reads a newer catalog.
      published = true
      await f.apps.refresh()
      expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon', 'acme'])

      // The look then answers with the catalog it read before that: it must not put it back.
      slow.resolve(catalog([moon]))
      await looking
      expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon', 'acme'])
      expect(f.catalogChanged).toHaveBeenLastCalledWith([moon.app_id, ACME.appId])
    })

    it('waits out a rate limit the platform asked for instead of spending the bucket again', async () => {
      let limited = false

      const { f } = open(() => {
        if (limited) {
          throw new AppSurfaceError('rate_limited', 429, 600_000)
        }

        return catalog([moon])
      })

      const reads = () => f.account.appRequest.mock.calls.length

      await f.apps.refresh()
      limited = true
      minutes(10)
      await f.apps.revalidate()
      const spent = reads()

      // Inside the ten minutes the platform asked for, the window's own five do not reach it.
      limited = false
      minutes(6)
      await f.apps.revalidate()
      expect(reads()).toBe(spent)

      minutes(5)
      await f.apps.revalidate()
      expect(reads()).toBe(spent + 1)
    })
  })

  it('does not restore a locally withdrawn app from a still-linked catalog when remote disconnect is unknown', async () => {
    const linked = { ...moon, link: { ...moon.link, state: 'linked' } }

    const f = fixture(resource => {
      if (!resource.app) {
        return catalog([linked])
      }

      throw new AppSurfaceError('temporarily_unavailable', 503)
    })

    await f.apps.refresh()
    expect(f.apps.participant(moon.app_id).link.state).toBe('linked')
    f.reconcileParticipants.mockClear()
    await f.apps.connection(moon.app_id, 'disconnect')
    expect(f.apps.snapshot().connections.moon).toMatchObject({ phase: 'failed', error: 'unavailable' })
    expect(() => f.apps.participant(moon.app_id)).toThrow('matrix_app_unavailable')
    await expect(f.apps.surfaces.manifest('moon')).rejects.toMatchObject({ code: 'unlinked' })
    expect(f.reconcileParticipants.mock.calls.every(([apps]) => apps.length === 0)).toBe(true)
    await f.apps.connection(moon.app_id, 'read')
    await f.apps.refresh()
    expect(() => f.apps.participant(moon.app_id)).toThrow('matrix_app_unavailable')
  })

  it('invalidates a restoration callback as soon as its app is locally withdrawn', async () => {
    const linked = { ...moon, link: { ...moon.link, state: 'linked' } }
    const f = fixture(resource => (resource.app ? Promise.reject(new Error('offline')) : catalog([linked])))
    await f.apps.refresh()
    const active = f.reconcileParticipants.mock.calls[0][1]
    expect(active()).toBe(true)
    await f.apps.connection(moon.app_id, 'disconnect')
    expect(active()).toBe(false)
  })

  it.each(['manifest', 'launch'])('rejects an in-flight %s after its app version is withdrawn', async action => {
    const response = deferred<unknown>()
    let current = river

    const f = fixture(resource => {
      if (!resource.app) {
        return catalog([current])
      }

      if (resource.action === action) {
        return response.promise
      }

      return workspace(current)
    })

    await f.apps.refresh()

    const operation =
      action === 'manifest' ? f.apps.surfaces.manifest('river') : f.apps.surfaces.launch('river', 'open')

    const result = expect(operation).rejects.toMatchObject({ code: 'app_version_incompatible' })
    await vi.waitFor(() => {
      expect(f.account.appRequest.mock.calls.some(([request]) => request.action === action)).toBe(true)
    })
    current = { ...river, app_version_id: '00000000-0000-4000-8000-8cca3400b26b' }
    await f.apps.refresh()
    response.resolve(
      action === 'manifest'
        ? workspace(river)
        : { launch_url: `https://river.atum.test/open?code=${'x'.repeat(43)}`, expires_at: new Date().toISOString() }
    )
    await result
  })

  it.each([undefined, null, 'shared_group', 'future'])(
    'does not infer native app chat from legacy modes when context is %s',
    async context => {
      const app = { ...moon, matrix_room_context: context, link: { ...moon.link, state: 'linked' } }
      const f = fixture(() => catalog([app]))
      await f.apps.refresh()
      expect(() => f.apps.participant(app.app_id)).toThrow('matrix_app_unavailable')
      expect(f.apps.snapshot().state).toBe('ready')
    }
  )

  it('accepts a native addressed-only provider without legacy ordinary turn support', async () => {
    const app = { ...moon, supported_modes: [], link: { ...moon.link, state: 'linked' } }
    const f = fixture(() => catalog([app]))
    await f.apps.refresh()
    expect(f.apps.participant(app.app_id).matrix_room_context).toBe('addressed_only')
  })

  // An official bot's group profile is a column of its bot row (atum-app-bots v1 §6.2), not the
  // operator-set `apps.room_context_profile` that the catalog projects as `matrix_room_context`.
  describe('official bots, whatever the operator-set room context', () => {
    const bot = {
      v: 1,
      user_id: '@app-moon:atumplatform.com',
      handle: 'moon_bot',
      display_name: 'Moon',
      avatar: { url: 'https://deployment.example.invalid/specialists/moon.png', sha256: 'a'.repeat(64) },
      device_generation: 1,
      device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
      state: 'active',
      groups: true,
      consent: 'accepted',
      disclosure_version: 1,
      open_route_id: 'chat',
      open_shared_memory: true,
      purchase_route_id: 'chat'
    }

    const demozaBot = {
      ...bot,
      user_id: '@app-demoza:atumplatform.com',
      handle: 'demoza_bot',
      display_name: 'Demoza',
      groups: false,
      open_shared_memory: false,
      guest_enabled: true,
      direct_profile: 'atum.turn-memory/2' as const
    }

    const demoza = {
      ...descriptor(
        'demoza',
        '00000000-0000-4000-8000-f8cea4c3b21c',
        '00000000-0000-4000-8000-ba1eae92ba81',
        'external_account'
      ),
      matrix_room_context: null,
      bot: demozaBot
    }

    it.each([null, undefined, 'future'])('opens its chat and takes its turns when the context is %s', async context => {
      const linked = { ...moon, matrix_room_context: context, link: { ...moon.link, state: 'linked' }, bot }
      const f = fixture(() => catalog([linked]))
      await f.apps.refresh()
      expect(f.apps.botChat(moon.app_id).bot?.user_id).toBe(bot.user_id)
      expect(f.apps.participant(moon.app_id).bot?.user_id).toBe(bot.user_id)
    })

    it('clears a guest app view at the link boundary without withdrawing its chat', async () => {
      let current = demoza
      const f = fixture(() => catalog([current]))

      await f.apps.refresh()
      f.views.revokeApp.mockClear()
      f.withdrawParticipant.mockClear()

      current = { ...demoza, link: { ...demoza.link, state: 'linked' as const } }
      await f.apps.refresh()

      expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'demoza' })
      expect(f.withdrawParticipant).not.toHaveBeenCalled()
    })

    it('clears a guest app view when consent is revoked elsewhere', async () => {
      let current = demoza
      const f = fixture(() => catalog([current]))

      await f.apps.refresh()
      f.views.revokeApp.mockClear()

      current = { ...demoza, bot: { ...demozaBot, consent: 'required' as const } }
      await f.apps.refresh()

      expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'demoza' })
    })

    it('keeps the room-context gate for the same app without a bot', async () => {
      const linked = { ...moon, matrix_room_context: null, link: { ...moon.link, state: 'linked' } }
      const f = fixture(() => catalog([linked]))
      await f.apps.refresh()
      expect(() => f.apps.participant(moon.app_id)).toThrow('matrix_app_unavailable')
      expect(() => f.apps.botChat(moon.app_id)).toThrow('matrix_app_bot_unavailable')
    })

    it('still refuses a withdrawn or unlinked bot turn, and opens setup before linking', async () => {
      const unlinked = { ...moon, matrix_room_context: null, bot }
      const f = fixture(() => catalog([unlinked]))
      await f.apps.refresh()
      expect(f.apps.botChat(moon.app_id).link.state).toBe('never_linked')
      expect(() => f.apps.participant(moon.app_id)).toThrow('matrix_app_unavailable')
    })

    it.each([
      [{ state: 'starting', device: null }, 'matrix_app_bot_starting'],
      [{ state: 'paused' }, 'matrix_app_bot_paused'],
      [{ state: 'unavailable' }, 'matrix_app_bot_resting']
    ])('names why a %o bot cannot open (%s)', async (change, code) => {
      const app = { ...moon, matrix_room_context: null, bot: { ...bot, ...change } }
      const f = fixture(() => catalog([app]))
      await f.apps.refresh()
      expect(() => f.apps.botChat(moon.app_id)).toThrow(code)
    })
  })

  it('lets a chat-only provider reach the existing connection authority without permitting a browser launch', async () => {
    const app = { ...moon, has_surface: false, supported_modes: [] }

    const f = fixture(resource =>
      !resource.app
        ? catalog([app])
        : resource.action === 'connection'
          ? {
              connection: { state: 'never_linked', connectionRequired: true, available: true, readiness: 'not_linked' }
            }
          : Promise.reject(new Error('connection reached'))
    )

    await f.apps.refresh()
    await f.apps.connection(app.app_id, 'begin').catch(() => {})
    expect(
      f.account.appRequest.mock.calls.some(([resource]) => resource.app === app.app && resource.action === 'connect')
    ).toBe(true)
    f.account.appRequest.mockClear()
    await expect(f.apps.menu(app.app_id)).rejects.toMatchObject({ code: 'app_unavailable' })
    expect(f.account.appRequest).not.toHaveBeenCalled()
    await f.apps.reset()
  })

  it('opens authentication in an app-bound sheet with only server and manifest origins', async () => {
    const close = vi.fn()
    const openAuthorize = vi.fn(async (_request: AppAuthSheetRequest) => ({ close }))
    const token = 't'.repeat(43)
    const attempt = 'a'.repeat(43)
    const f = fixture((resource, body) => {
      if (!resource.app) {
        return catalog([moon])
      }

      if (resource.action === 'connection') {
        return {
          connection: { state: 'never_linked', connectionRequired: true, available: true, readiness: 'not_linked' }
        }
      }

      if (resource.action === 'connect') {
        expect(body?.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/atum\/app-link\/[A-Za-z0-9_-]{43}$/u)

        return {
          authorize_url: `https://account.atum.test/link/start?t=${token}&a=${attempt}`,
          initiation_id: '00000000-0000-4000-8000-232a373eb43a'
        }
      }

      if (resource.action === 'manifest') {
        return workspace(moon, {
          web_origin: 'https://moon.atum.test',
          network_origins: [{ origin: 'https://moon-auth.atum.test', kinds: ['connect'] }]
        })
      }

      throw new Error(`unexpected ${resource.action}`)
    }, { openAuthorize, locale: () => 'ja' })

    await f.apps.refresh()
    await f.apps.connection(moon.app_id, 'begin', { autoConfirm: true })
    expect(openAuthorize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      app: 'moon',
      appName: 'Moon',
      approvedOrigins: ['https://moon.atum.test', 'https://moon-auth.atum.test'],
      authorizeUrl: `https://account.atum.test/link/start?t=${token}&a=${attempt}`,
      locale: 'ja'
    }))

    await f.apps.reset()
    expect(close).toHaveBeenCalledOnce()
  })
  it('refreshes a stale catalog link after the signed connection becomes ready', async () => {
    let linked = false

    const f = fixture(resource =>
      !resource.app
        ? catalog([{ ...moon, link: { ...moon.link, state: linked ? 'linked' : 'never_linked' } }])
        : { connection: { state: 'linked', connectionRequired: true, available: true, readiness: 'ready' } }
    )

    await f.apps.refresh()
    expect(() => f.apps.participant(moon.app_id)).toThrow('matrix_app_unavailable')
    linked = true
    await f.apps.connection(moon.app_id, 'read')
    expect(f.apps.participant(moon.app_id).link.state).toBe('linked')
  })
  it('suspends a temporarily unavailable linked app without revoking consent or keys', async () => {
    const f = fixture(resource =>
      !resource.app
        ? catalog([moon])
        : {
            connection: {
              state: 'linked',
              connectionRequired: true,
              available: false,
              readiness: 'unavailable'
            }
          }
    )

    await f.apps.refresh()
    await f.apps.connection(moon.app_id, 'read')
    expect(f.stopParticipants).toHaveBeenCalledWith('moon')
    expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'moon' })
    expect(f.withdrawParticipant).not.toHaveBeenCalled()
  })

  it('still resets an outgoing account if stopping its app readers fails in the catalog error path', async () => {
    const f = fixture(() => catalog([river]))
    await f.apps.refresh()
    f.account.readDomain.mockImplementationOnce(async () => {
      f.setScope(newScope)
      throw new Error('offline')
    })
    f.stopParticipants.mockRejectedValueOnce(new Error('stop failed'))
    await expect(f.apps.refresh()).rejects.toThrow('stop failed')
    expect(f.apps.account()).toBeNull()
    expect(f.views.revokeAccount).toHaveBeenCalledWith(oldScope)
  })
  it('does not restore readers from a catalog arriving after reset; live callbacks are generation-bound', async () => {
    const f = fixture(() => catalog([river]))
    await f.apps.refresh()
    const active = f.reconcileParticipants.mock.calls[0][1]
    expect(active()).toBe(true)
    const delayed = deferred<void>()
    f.catalogChanged.mockImplementationOnce(() => delayed.promise)
    const refreshing = f.apps.refresh()
    await vi.waitFor(() => expect(f.catalogChanged).toHaveBeenCalledTimes(2))
    await f.apps.reset()
    expect(active()).toBe(false)
    delayed.resolve()
    await refreshing
    expect(f.reconcileParticipants).toHaveBeenCalledOnce()
  })
  it('still closes browser views if stopping app SDK hosts fails', async () => {
    const f = fixture(() => catalog([river]))
    await f.apps.refresh()
    f.stopParticipants.mockRejectedValueOnce(new Error('host stop failed'))
    await expect(f.apps.reset()).rejects.toThrow('host stop failed')
    expect(f.views.revokeAccount).toHaveBeenCalledWith(oldScope)
    expect(f.apps.account()).toBeNull()
  })

  it.each(['view', 'participant'])(
    'attempts app unlink and both local cleanups even if %s cleanup fails',
    async failure => {
      const f = fixture(resource => (resource.app ? { status: 'unlinked' } : catalog([moon])))
      await f.apps.refresh()

      if (failure === 'view') {
        f.views.revokeApp.mockRejectedValueOnce(new Error('cleanup failed'))
      } else {
        f.withdrawParticipant.mockRejectedValueOnce(new Error('cleanup failed'))
      }

      await expect(f.apps.connection(moon.app_id, 'disconnect')).rejects.toThrow('cleanup failed')
      expect(f.withdrawParticipant).toHaveBeenCalledWith('moon')
      expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'moon' })
      expect(f.account.appRequest).toHaveBeenCalledWith({ app: 'moon', action: 'disconnect' }, undefined)
    }
  )

  it('still closes a withdrawn catalog view when participant revocation is offline', async () => {
    let current = catalog([river])
    const f = fixture(() => current)
    await f.apps.refresh()
    current = catalog([])
    f.withdrawParticipant.mockRejectedValueOnce(new Error('offline'))
    await f.apps.refresh()
    expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'river' })
    expect(f.apps.snapshot().state).toBe('unavailable')
    await f.apps.refresh()
    expect(f.withdrawParticipant).toHaveBeenCalledTimes(2)
    expect(f.apps.snapshot()).toMatchObject({ state: 'ready', apps: [] })
  })

  it('cannot reacquire ownership when stop/reset joins a refresh-owned cleanup', async () => {
    const f = fixture(() => catalog([river]))
    await f.apps.refresh()
    const cleared = deferred<void>()
    f.views.revokeAccount.mockImplementationOnce(() => cleared.promise)
    f.setScope(newScope)
    const refreshing = f.apps.refresh()
    await vi.waitFor(() => expect(f.views.revokeAccount).toHaveBeenCalledWith(oldScope))
    const stopped = f.apps.reset()
    cleared.resolve()
    await Promise.all([refreshing, stopped])
    expect(f.apps.account()).toBeNull()
    expect(f.apps.snapshot()).toMatchObject({ state: 'unavailable', apps: [] })
    expect(f.account.appRequest).toHaveBeenCalledTimes(1)
  })

  it('cannot reacquire ownership after stop while the domain read was pending', async () => {
    const f = fixture(() => catalog([river]))
    const read = deferred<void>()
    f.account.readDomain.mockImplementationOnce(() => read.promise)
    const refreshing = f.apps.refresh()
    await f.apps.reset()
    read.resolve()
    await refreshing
    expect(f.apps.account()).toBeNull()
    expect(f.account.appRequest).not.toHaveBeenCalled()
  })

  it('binds equivalent upper- and lowercase catalog/manifest UUIDs', async () => {
    const lower = descriptor(
      'river',
      '00000000-0000-4000-8000-5619996ccf0d',
      '00000000-0000-4000-8000-6eda05325463',
      'none'
    )

    const upper = { ...lower, app_id: lower.app_id.toUpperCase(), app_version_id: lower.app_version_id.toUpperCase() }
    const f = fixture(resource => (resource.app ? workspace(upper) : catalog([lower])))
    await f.apps.refresh()
    await expect(f.apps.menu(lower.app_id)).resolves.toMatchObject({ app: { app_id: lower.app_id } })
  })

  it('drops app ownership even if native storage cleanup fails', async () => {
    const f = fixture(() => catalog([river]))
    await f.apps.refresh()
    f.views.revokeAccount.mockRejectedValueOnce(new Error('storage busy'))
    await expect(f.apps.reset()).rejects.toThrow('storage busy')
    expect(f.apps.account()).toBeNull()
    expect(f.apps.snapshot()).toMatchObject({ state: 'unavailable', apps: [] })
    expect(f.account.appScope()).toEqual(oldScope)
  })

  it('withdraws app views on an app-only 401 without revoking the shared domain owner', async () => {
    const f = fixture(resource => {
      if (!resource.app) {
        return catalog([moon])
      }

      throw new AppSurfaceError('account_unavailable', 401)
    })

    await f.apps.refresh()
    await f.apps.connection(moon.app_id, 'read')
    expect(f.views.revokeAccount).toHaveBeenCalledWith(oldScope)
    expect(f.apps.account()).toBeNull()
    expect(f.apps.snapshot()).toMatchObject({ state: 'unavailable', apps: [] })
    expect(f.account.appScope()).toEqual(oldScope)
  })

  it('keeps ownership during catalog refresh so an in-flight launch settles normally', async () => {
    const launch = deferred<unknown>()
    const nextCatalog = deferred<unknown>()
    let reads = 0

    const f = fixture(resource => {
      if (!resource.app) {
        return ++reads === 1 ? catalog([river]) : nextCatalog.promise
      }

      if (resource.action === 'manifest') {
        return workspace(river)
      }

      if (resource.action === 'launch') {
        return launch.promise
      }

      throw new Error('unexpected')
    })

    await f.apps.refresh()
    const launching = f.apps.surfaces.launch('river', 'open')
    await vi.waitFor(() =>
      expect(f.account.appRequest).toHaveBeenCalledWith({ app: 'river', action: 'launch' }, expect.anything())
    )
    const refreshing = f.apps.refresh()
    await vi.waitFor(() => expect(reads).toBe(2))
    expect(f.apps.snapshot().state).toBe('loading')
    expect(f.apps.account()).toEqual(oldScope)
    launch.resolve({
      launch_url: `https://river.atum.test/open?code=${'x'.repeat(43)}`,
      expires_at: '2026-09-23T12:00:00.000Z'
    })
    await expect(launching).resolves.toMatchObject({ launchUrl: `https://river.atum.test/open?code=${'x'.repeat(43)}` })
    nextCatalog.resolve(catalog([river]))
    await refreshing
    expect(f.apps.snapshot().state).toBe('ready')
    expect(f.views.revokeAccount).not.toHaveBeenCalled()
  })

  it('uses the same declared path for neutral River and Moon without implicit linking or launching', async () => {
    const f = fixture(resource => {
      if (!resource.app) {
        return catalog()
      }

      if (resource.action === 'manifest') {
        return workspace(resource.app === 'river' ? river : moon)
      }

      throw new Error(`unexpected ${resource.action}`)
    })

    await f.apps.refresh()
    expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['river', 'moon'])
    expect(f.catalogChanged).toHaveBeenCalledWith([river.app_id, moon.app_id])
    expect(f.account.appRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.stringMatching(/^(connect|confirm|launch)$/) }),
      expect.anything()
    )

    await expect(f.apps.menu(river.app_id)).resolves.toMatchObject({
      app: { app: 'river' },
      routes: [{ id: 'open', session: 'required' }]
    })
    await expect(f.apps.menu(moon.app_id)).resolves.toMatchObject({
      app: { app: 'moon' },
      routes: [{ id: 'open', session: 'required' }]
    })
    expect(
      f.account.appRequest.mock.calls.filter(([request]) => request.action === 'launch' || request.action === 'connect')
    ).toHaveLength(0)
  })

  it('reads linked app history through main and rejects authority fields in the projection', async () => {
    const linkedMoon = {
      ...moon,
      has_history: true,
      link: { ...moon.link, state: 'linked' as const },
      bot: {
        v: 1 as const,
        user_id: '@app-moon:atumplatform.com',
        handle: 'moon_bot',
        display_name: 'Moon',
        avatar: { url: 'https://deployment.example.invalid/specialists/moon.png', sha256: 'a'.repeat(64) },
        device_generation: 1,
        device: { device_id: 'MOON_1', ed25519: 'A'.repeat(43), curve25519: 'B'.repeat(43) },
        state: 'active' as const,
        groups: true,
        consent: 'accepted' as const,
        disclosure_version: 2,
        open_route_id: 'chat',
        open_shared_memory: true,
        purchase_route_id: 'chat'
      }
    }
    const f = fixture((resource, body) => {
      if (!resource.app) {
        return catalog([linkedMoon])
      }

      if (resource.action === 'manifest') {
        return workspace(linkedMoon)
      }

      if (resource.action === 'history') {
        expect(body).toEqual({ app_version_id: linkedMoon.app_version_id, cursor: null, limit: 20 })

        return {
          profile: 'atum.app-history/1',
          app: { id: linkedMoon.app_id, app_version_id: linkedMoon.app_version_id },
          entries: [{ id: 'moon-message-1', revision: 1, occurred_at: '2026-10-12T01:02:03Z',
            role: 'owner', text: 'Earlier on Moon web', source: { id: 'web', label: { en: 'Moon web', vi: 'Moon web' } } }],
          next_cursor: null, has_more: false, freshness_ms: 0
        }
      }
      throw new Error('unexpected request')
    })
    await f.apps.refresh()
    const page = await f.apps.history(linkedMoon.app_id)
    expect(page).toMatchObject({
      appId: linkedMoon.app_id,
      entries: [{ id: 'moon-message-1', source: { id: 'web' } }],
      hasMore: false
    })
    expect(JSON.stringify(page)).not.toMatch(/provider|subject|installation|link_epoch/)
  })

  it('refuses history without its signed capability and current disclosure consent', async () => {
    const linked = { ...moon, link: { ...moon.link, state: 'linked' as const } }
    const f = fixture(resource => resource.app ? workspace(linked) : catalog([linked]))
    await f.apps.refresh()
    await expect(f.apps.history(linked.app_id)).rejects.toThrow('matrix_app_unavailable')

    const stale = {
      ...linked,
      has_history: true,
      bot: {
        v: 1 as const, user_id: '@app-moon:atumplatform.com', handle: 'moon_bot', display_name: 'Moon',
        avatar: { url: '', sha256: 'a'.repeat(64) }, device_generation: 1,
        device: { device_id: 'MOON_1', ed25519: 'A'.repeat(43), curve25519: 'B'.repeat(43) },
        state: 'active' as const, groups: true, consent: 'accepted' as const, disclosure_version: 1,
        open_route_id: 'chat', open_shared_memory: true, purchase_route_id: 'chat'
      }
    }
    const staleFixture = fixture(resource => resource.app ? workspace(stale) : catalog([stale]))
    await staleFixture.apps.refresh()
    await expect(staleFixture.apps.history(stale.app_id)).rejects.toThrow('matrix_app_unavailable')
  })

  it('rejects mismatched manifest bindings and forged launch origins while retaining a sanitized menu', async () => {
    let mode: 'good' | 'version' | 'launch-origin' = 'good'

    const f = fixture(resource => {
      if (!resource.app) {
        return catalog([river])
      }

      if (resource.action === 'manifest') {
        if (mode === 'version') {
          const response = workspace(river)

          return {
            ...response,
            manifest: { ...response.manifest, app: { ...response.manifest.app, app_version_id: moon.app_version_id } }
          }
        }

        return workspace(river)
      }

      if (resource.action === 'launch') {
        return {
          launch_url: `${mode === 'launch-origin' ? 'https://forged.test' : 'https://river.atum.test'}/open?code=${'x'.repeat(43)}`,
          expires_at: '2026-09-23T12:00:00.000Z'
        }
      }

      throw new Error('unexpected')
    })

    await f.apps.refresh()
    const surface = await f.apps.surfaces.manifest('river')
    expect(surface.manifest.routes).toEqual([
      expect.objectContaining({ id: 'open', placements: ['menu'] }),
      expect.objectContaining({ id: 'draft', placements: ['composer'] })
    ])
    const menu = await f.apps.menu(river.app_id)
    expect(menu.routes).toEqual([expect.objectContaining({ id: 'open' })])
    expect(menu.actions).toEqual([expect.objectContaining({ id: 'draft' })])
    expect(JSON.stringify(menu)).not.toContain('/draft')
    await expect(f.apps.surfaces.launch('river', 'open')).resolves.toMatchObject({
      launchUrl: 'https://river.atum.test/open?code=' + 'x'.repeat(43)
    })
    // The mismatch check belongs to a read; a cached manifest would answer without one.
    await f.apps.reset()
    await f.apps.refresh()
    mode = 'version'
    await expectCode(f.apps.surfaces.manifest('river'), 'app_version_incompatible')
    mode = 'launch-origin'
    await expectCode(f.apps.surfaces.launch('river', 'open'), 'app_launch_invalid')
  })

  it('withdraws old app views and participant readers on catalog changes without human/Hermes teardown', async () => {
    let currentCatalog = catalog([river, moon])

    const f = fixture(resource => {
      if (!resource.app) {
        return currentCatalog
      }

      throw new Error('manifest should not be needed')
    })

    await f.apps.refresh()
    currentCatalog = catalog([
      { ...river, app_version_id: '00000000-0000-4000-8000-8cca3400b26b' },
      { ...moon, availability: 'unavailable' }
    ])
    await f.apps.refresh()
    expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'river' })
    expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'moon' })
    expect(f.withdrawParticipant.mock.calls).toEqual([['river']])
    expect(f.stopParticipants).toHaveBeenCalledWith('moon')
    expect(f.views.revokeAccount).not.toHaveBeenCalled()
    expect(
      f.account.appRequest.mock.calls.some(([request]) => ['connect', 'confirm', 'disconnect'].includes(request.action))
    ).toBe(false)
  })

  it('waits for outgoing reset before accepting a new account and drops a late catalog', async () => {
    const oldCatalog = deferred<unknown>()
    const revoked = deferred<void>()
    let calls = 0

    const f = fixture(resource => {
      if (resource.app) {
        throw new Error('unexpected app call')
      }

      calls++

      return calls === 1 ? oldCatalog.promise : catalog([moon])
    })

    f.views.revokeAccount.mockImplementation(() => revoked.promise)

    const oldRefresh = f.apps.refresh()
    await vi.waitFor(() => expect(calls).toBe(1))
    const reset = f.apps.reset()
    expect(f.apps.snapshot()).toMatchObject({ state: 'unavailable', apps: [] })
    f.setScope(newScope)
    revoked.resolve()
    await reset
    oldCatalog.resolve(catalog([river]))
    await oldRefresh
    expect(f.apps.snapshot()).toMatchObject({ state: 'unavailable', apps: [] })
    expect(f.catalogChanged).not.toHaveBeenCalled()

    await f.apps.refresh()
    expect(f.apps.account()).toEqual(newScope)
    expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon'])
  })

  it('contains an independent app read outage to that app state rather than tearing down Matrix ownership', async () => {
    const f = fixture(resource => {
      if (!resource.app) {
        return catalog([river])
      }

      if (resource.action === 'connection') {
        throw new AppSurfaceError('temporarily_unavailable', 503)
      }

      throw new Error('unexpected')
    })

    await f.apps.refresh()
    await f.apps.connection(river.app_id, 'read')
    expect(f.apps.account()).toEqual(oldScope)
    expect(f.apps.snapshot()).toMatchObject({
      state: 'ready',
      connections: { river: { phase: 'failed', error: 'unavailable' } }
    })
    expect(f.views.revokeAccount).not.toHaveBeenCalled()
  })

  it('closes app views on authoritative unlink and retains explicit withdrawal through catalog outages', async () => {
    let available = true

    const f = fixture(resource => {
      if (!resource.app) {
        if (!available) {
          throw new Error('catalog offline')
        }

        return catalog([moon])
      }

      if (resource.action === 'connection') {
        return {
          connection: {
            state: 'unlinked',
            connectionRequired: true,
            available: true,
            readiness: 'not_linked',
            cleanup: 'pending'
          }
        }
      }

      if (resource.action === 'disconnect') {
        return { status: 'unlinked' }
      }

      throw new Error('unexpected')
    })

    await f.apps.refresh()
    await f.apps.connection(moon.app_id, 'read')
    expect(f.views.revokeApp).toHaveBeenCalledWith({ ...oldScope, app: 'moon' })
    expect(f.withdrawParticipant).toHaveBeenCalledWith('moon')
    available = false
    await f.apps.refresh()
    expect(f.apps.snapshot().apps.map(app => app.app)).toEqual(['moon'])
    await expect(f.apps.menu(moon.app_id)).rejects.toMatchObject({ code: 'account_unavailable' })
    await f.apps.connection(moon.app_id, 'disconnect')
    expect(f.account.appRequest).toHaveBeenCalledWith({ app: 'moon', action: 'disconnect' }, undefined)
  })

  it('revokes local account views when the connection helper contains an authority failure', async () => {
    const f = fixture(resource => {
      if (!resource.app) {
        return catalog([moon])
      }

      f.setScope(null)
      throw new Error('domain unauthorized')
    })

    await f.apps.refresh()
    await f.apps.connection(moon.app_id, 'read')
    expect(f.views.revokeAccount).toHaveBeenCalledWith(oldScope)
    expect(f.apps.snapshot()).toMatchObject({ state: 'unavailable', apps: [] })
  })
  describe('the shared app-read budget', () => {
    const withBot = {
      ...moon,
      bot: {
        v: 1 as const,
        user_id: '@app-moon:atumplatform.com',
        handle: 'moon_bot',
        display_name: 'Moon',
        avatar: { url: 'https://atum.example/moon.png', sha256: 'a'.repeat(64) },
        device_generation: 1,
        device: { device_id: 'MOON_1', ed25519: 'A'.repeat(43), curve25519: 'B'.repeat(43) },
        state: 'active' as const,
        groups: true,
        consent: 'accepted' as const,
        disclosure_version: 1,
        open_route_id: 'chat',
        open_shared_memory: true,
        purchase_route_id: 'chat'
      }
    }

    const manifestReads = (f: ReturnType<typeof fixture>) =>
      f.account.appRequest.mock.calls.filter(([resource]) => resource.action === 'manifest')

    it('serves repeated menus from one read for the cache lifetime', async () => {
      const f = fixture(resource => (resource.app ? workspace(moon) : catalog([moon])))

      await f.apps.refresh()
      await f.apps.menu(moon.app_id)
      await f.apps.menu(moon.app_id)
      expect(manifestReads(f)).toHaveLength(1)
    })

    it('shares one in-flight manifest read between concurrent menus', async () => {
      const response = deferred<unknown>()
      const f = fixture(async resource => {
        if (!resource.app) {
          return catalog([moon])
        }

        await response.promise

        return workspace(moon)
      })

      await f.apps.refresh()
      const first = f.apps.menu(moon.app_id)
      const second = f.apps.menu(moon.app_id)
      await vi.waitFor(() => expect(manifestReads(f)).toHaveLength(1))
      response.resolve(undefined)
      await Promise.all([first, second])
      expect(manifestReads(f)).toHaveLength(1)
    })

    it('does not reach the Shell again until the rate-limit wait passes', async () => {
      vi.useFakeTimers()

      try {
        let reads = 0
        const f = fixture(resource => {
          if (!resource.app) {
            return catalog([moon])
          }

          reads++

          if (reads === 1) {
            throw new AppSurfaceError('rate_limited', 429, 60_000)
          }

          return workspace(moon)
        })

        await f.apps.refresh()
        await expectCode(f.apps.menu(moon.app_id), 'rate_limited')
        await expectCode(f.apps.menu(moon.app_id), 'rate_limited')
        expect(reads).toBe(1)

        await vi.advanceTimersByTimeAsync(59_999)
        await expectCode(f.apps.menu(moon.app_id), 'rate_limited')
        expect(reads).toBe(1)

        await vi.advanceTimersByTimeAsync(1)
        await expect(f.apps.menu(moon.app_id)).resolves.toMatchObject({ app: { app_id: moon.app_id } })
        expect(reads).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('shares one bot status read and applies the same wait to it', async () => {
      const response = deferred<unknown>()
      const botStatus = vi.fn(() => response.promise)
      const f = fixture(resource => (resource.app ? workspace(withBot) : catalog([withBot])), { botStatus })

      await f.apps.refresh()
      const first = f.apps.botStatus(withBot.app_id)
      const second = f.apps.botStatus(withBot.app_id)
      await vi.waitFor(() => expect(botStatus).toHaveBeenCalledTimes(1))
      response.resolve({ profile: 'atum.app-bot-status/1' })
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)

      vi.useFakeTimers()

      try {
        const blockedBotStatus = vi.fn(async () => ({}))
        const blocked = fixture(resource => {
          if (!resource.app) {
            return catalog([withBot])
          }

          throw new AppSurfaceError('rate_limited', 429, 60_000)
        }, { botStatus: blockedBotStatus })

        await blocked.apps.refresh()
        await expectCode(blocked.apps.menu(withBot.app_id), 'rate_limited')
        await expectCode(blocked.apps.botStatus(withBot.app_id), 'rate_limited')
        expect(blockedBotStatus).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('reads again once the catalog shows a new link state under the same version', async () => {
      let current: typeof moon = moon
      const f = fixture(resource => (resource.app ? workspace(current) : catalog([current])))

      await f.apps.refresh()
      await f.apps.menu(moon.app_id)
      current = { ...moon, link: { ...moon.link, state: 'linked' } }
      await f.apps.refresh()
      await expect(f.apps.menu(moon.app_id)).resolves.toMatchObject({ app: { link: { state: 'linked' } } })
      expect(manifestReads(f)).toHaveLength(2)
    })

    it('starts another account with fresh reads rather than the previous cache', async () => {
      const f = fixture(resource => (resource.app ? workspace(moon) : catalog([moon])))

      await f.apps.refresh()
      await f.apps.menu(moon.app_id)
      await f.apps.menu(moon.app_id)
      expect(manifestReads(f)).toHaveLength(1)

      f.setScope(newScope)
      await f.apps.refresh()
      await f.apps.menu(moon.app_id)
      expect(manifestReads(f)).toHaveLength(2)
    })
  })

})

it('reads frozen panel completion through the authenticated fixed route for an unknown app', async () => {
  const unknown = { ...river, app: 'unknown-orchid' }
  const surface = workspace(unknown)
  surface.manifest.launch.profile = 'atum.app-launch/2'
  const status = { profile: 'atum.bot-panel-status/1', attempt_id: '00000000-0000-4000-8000-bd7662a5eeb4', state: 'pending', binding_revision: 0 }
  const f = fixture(resource => !resource.app ? catalog([unknown]) : resource.action === 'manifest' ? surface : status)
  await f.apps.refresh()
  expect(await f.apps.surfaces.panelLink('unknown-orchid', true)).toEqual(status)
  expect(f.account.appRequest).toHaveBeenLastCalledWith({ app: 'unknown-orchid', action: 'panel-link' }, {})
  expect(await f.apps.surfaces.panelLink('unknown-orchid', false)).toEqual(status)
  expect(f.account.appRequest).toHaveBeenLastCalledWith({ app: 'unknown-orchid', action: 'panel-link' }, undefined)
})

it.each([true, false])('projects a version-bound declaration or falls back without crashing (valid=%s)', async valid => {
  const log = vi.fn()
  const f = fixture(resource => resource.action === 'manifest'
    ? workspace(river, { app_panel: { profile: 'atum.app-panel/1', default_page: 'open', pages: [{ route_id: valid ? 'open' : 'draft', glyph: 'article' }] } })
    : catalog(), { log })
  await f.apps.refresh()
  const menu = await f.apps.menu(river.app_id)
  expect(menu.routes.map(route => route.id)).toEqual(['open'])
  expect(menu.pages).toEqual(valid ? [{ routeId: 'open', glyph: 'article' }] : undefined)
  expect(menu.defaultPage).toBe(valid ? 'open' : undefined)
  expect(log.mock.calls.some(([line]) => line === 'app_panel ignored reason=invalid')).toBe(!valid)
})
