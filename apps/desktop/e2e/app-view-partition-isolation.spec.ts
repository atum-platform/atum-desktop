import { readdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'

import { appViewPartition, discoverAppViewPartitions, parseAppViewPartition } from '../electron/app-view/partitions'

import { type NoProviderFixture, setupNoProvider } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

/**
 * Slice 3 / R6: the app-view isolation claims that only a real Electron
 * session can settle. The unit suite drives the controller through fakes;
 * this spec puts the same claims to Chromium itself:
 *
 *  1. **Isolation** — the cookie, origin storage, and HTTP cache written
 *     under one account's app partition are invisible from another
 *     account's partition for the same app.
 *  2. **Revocation** — the barrier's two calls leave that partition with no
 *     cookie, no origin storage, and nothing its cache can serve, and leave
 *     the other account's partition untouched.
 *  3. **Cold-start discovery** — once Electron has exited, the real
 *     `discoverAppViewPartitions` finds the partitions from disk alone,
 *     knowing no app ids and holding no live partitions: the sweep a later
 *     launch performs, with nothing in memory to help it.
 *
 * A local origin stands in for an app, so no Atum account, manifest, or
 * launch code is involved and the proof needs no backend.
 */

const ACCOUNT_A = 'a'.repeat(64)
const ACCOUNT_B = 'b'.repeat(64)
const APP = 'moon'
const PROBE = 'atum_app_view_probe'

const partitionA = appViewPartition(ACCOUNT_A, APP)
const partitionB = appViewPartition(ACCOUNT_B, APP)

/**
 * Every request for the cacheable asset that actually reached the network,
 * labelled by the account that made it. Both partitions request the *same*
 * URL, so a shared cache would show up as a missing hit; the label rides in
 * a request header, which cannot enter the cache key because the response
 * carries no `Vary`.
 */
const networkHits: string[] = []
let origin = ''
let server: Server | null = null
let fixture: NoProviderFixture | null = null

/**
 * A tiny origin: an uncacheable page, and one asset Chromium may keep for
 * ten minutes and can never revalidate (no validator is offered). A second
 * request for that asset therefore means the HTTP cache was dropped, not
 * merely revalidated — and a *missing* second request would mean two
 * partitions shared one cache.
 */
async function startOrigin(): Promise<string> {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://probe')

    if (url.pathname === '/page.html') {
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>app view probe</title>')

      return
    }

    if (url.pathname === '/cacheable.js') {
      networkHits.push(String(request.headers['x-atum-probe'] ?? 'unknown'))
      response.writeHead(200, { 'cache-control': 'public, max-age=600, immutable', 'content-type': 'text/javascript' })
      response.end('globalThis.atumProbe = 1')

      return
    }

    response.writeHead(404)
    response.end()
  })

  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))

  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

test.beforeAll(async () => {
  origin = await startOrigin()
  fixture = await setupNoProvider()
})

test.beforeEach(() => {
  // This spec asserts on Electron sessions, never on the renderer. The bare
  // sandbox boots with no provider and no bundled runtime, so boot banners
  // are expected here and say nothing about app-view isolation.
  allowErrorBanners()
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
  await new Promise<void>(resolve => { server ? server.close(() => resolve()) : resolve() })
  server = null
})

test('an app-view partition is isolated, is emptied by the revocation barrier, and is discoverable after Electron exits', async () => {
  const input = { origin, partitionA, partitionB, probe: PROBE }

  // 1. Seed both partitions in the Electron main process: a cookie, an
  //    origin-storage entry, and one fetch of the cacheable asset. The
  //    offscreen window binds the page to the partition under test.
  const seeded = await fixture!.app.evaluate(async ({ app, BrowserWindow, session }, argument) => {
    const seed = async (partition: string, who: string): Promise<string | null> => {
      const target = session.fromPartition(partition)

      await target.cookies.set({ url: argument.origin, name: argument.probe, value: who })
      await target.cookies.flushStore()

      const window = new BrowserWindow({ show: false, webPreferences: { partition } })

      try {
        await window.loadURL(`${argument.origin}/page.html`)
        await window.webContents.executeJavaScript(`(async () => {
          localStorage.setItem(${JSON.stringify(argument.probe)}, ${JSON.stringify(who)})
          await fetch('/cacheable.js', { headers: { 'x-atum-probe': ${JSON.stringify(who)} } })
        })()`)
      } finally {
        window.destroy()
      }

      return target.getStoragePath()
    }

    return {
      storagePathA: await seed(argument.partitionA, 'account-a'),
      storagePathB: await seed(argument.partitionB, 'account-b'),
      userDataPath: app.getPath('userData')
    }
  }, input)

  // Both partitions requested the same asset URL and both reached the
  // network, so neither was served from the other's cache: the HTTP caches
  // are separate, and both are now warm. One hit here would mean they share.
  expect(networkHits).toEqual(['account-a', 'account-b'])

  // Chromium keeps `persist:<name>` under `userData/Partitions/<name>`,
  // which is where the sweep translates directory names back from.
  for (const storagePath of [seeded.storagePathA, seeded.storagePathB]) {
    expect(storagePath).toBeTruthy()
    expect(storagePath!.startsWith(`${seeded.userDataPath}/Partitions/`)).toBe(true)
  }

  // 2. Isolation: what each partition can see, and whether its asset still
  //    comes from cache.
  const isolated = await fixture!.app.evaluate(async ({ BrowserWindow, session }, argument) => {
    const read = async (partition: string, who: string): Promise<{ cookies: string[]; storage: string | null }> => {
      const cookies = (await session.fromPartition(partition).cookies.get({ name: argument.probe }))
        .map((cookie: { value: string }) => cookie.value).sort()

      const window = new BrowserWindow({ show: false, webPreferences: { partition } })

      try {
        await window.loadURL(`${argument.origin}/page.html`)

        return {
          cookies,
          storage: await window.webContents.executeJavaScript(`(async () => {
            await fetch('/cacheable.js', { headers: { 'x-atum-probe': ${JSON.stringify(who)} } })

            return localStorage.getItem(${JSON.stringify(argument.probe)})
          })()`)
        }
      } finally {
        window.destroy()
      }
    }

    return { a: await read(argument.partitionA, 'account-a'), b: await read(argument.partitionB, 'account-b') }
  }, input)

  // Neither account sees the other's cookie or origin storage, and neither
  // asset went back to the network: each partition served its own cache.
  expect(isolated.a).toEqual({ cookies: ['account-a'], storage: 'account-a' })
  expect(isolated.b).toEqual({ cookies: ['account-b'], storage: 'account-b' })
  expect(networkHits).toEqual(['account-a', 'account-b'])

  // 3. Revocation: the barrier's calls, on account A only.
  const revoked = await fixture!.app.evaluate(async ({ BrowserWindow, session }, argument) => {
    const read = async (partition: string, who: string): Promise<{ cookies: string[]; storage: string | null }> => {
      const cookies = (await session.fromPartition(partition).cookies.get({ name: argument.probe }))
        .map((cookie: { value: string }) => cookie.value).sort()

      const window = new BrowserWindow({ show: false, webPreferences: { partition } })

      try {
        await window.loadURL(`${argument.origin}/page.html`)

        return {
          cookies,
          storage: await window.webContents.executeJavaScript(`(async () => {
            await fetch('/cacheable.js', { headers: { 'x-atum-probe': ${JSON.stringify(who)} } })

            return localStorage.getItem(${JSON.stringify(argument.probe)})
          })()`)
        }
      } finally {
        window.destroy()
      }
    }

    // Exactly what the revocation barrier does, in its order.
    const target = session.fromPartition(argument.partitionA)

    await target.clearStorageData()
    await target.clearCache()
    await target.cookies.flushStore()

    return { a: await read(argument.partitionA, 'account-a'), b: await read(argument.partitionB, 'account-b') }
  }, input)

  // Account A keeps nothing: no cookie, no origin storage, and nothing its
  // cache can serve — the asset goes back to the network.
  //
  // The two calls are asserted together, not one at a time, because on this
  // Electron `clearStorageData` already drops the HTTP cache: `clearCache`
  // is defence in depth, and a test that claimed to isolate its effect
  // would be claiming more than the runtime does. What is pinned here is
  // the outcome the barrier owes: an emptied partition. Should a later
  // Electron narrow `clearStorageData`, this stays true through
  // `clearCache`, and if neither cleared the cache it would fail.
  expect(revoked.a).toEqual({ cookies: [], storage: null })

  // Account B keeps its cookie, its origin storage, and its warm cache
  // through both calls: nothing crossed the partition boundary. Exactly one
  // new request was made, and account A made it — a collaterally cleared B
  // would have added a second.
  expect(revoked.b).toEqual({ cookies: ['account-b'], storage: 'account-b' })
  expect(networkHits).toEqual(['account-a', 'account-b', 'account-a'])

  // 4. Cold start: end the process that owns the sessions, then discover
  //    from disk alone — no app ids, no live partitions, nothing in memory.
  await fixture!.app.close()

  const discovered = await discoverAppViewPartitions({
    userDataPath: seeded.userDataPath,
    knownAppIds: [],
    readDirectory: async path => {
      try {
        return (await readdir(path, { withFileTypes: true }))
          .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() }))
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {return null}
        throw error
      }
    }
  })

  // The account that still holds state is found, and so is the revoked one
  // whose directory Chromium keeps: a sweep on the next launch reaches both.
  expect(discovered).toEqual(expect.arrayContaining([partitionA, partitionB]))
  expect(parseAppViewPartition(partitionA)).toMatchObject({ accountKey: ACCOUNT_A, app: APP })
})
