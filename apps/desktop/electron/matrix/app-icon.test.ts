import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APP_ICON_FETCH, appIcon, AppIconDiskCache } from './app-icon'

const bytes = Buffer.from('approved bundled raster fixture')
const icon = { url: 'https://atum.test/icons/river.png', sha256: createHash('sha256').update(bytes).digest('hex') }
afterEach(() => vi.unstubAllGlobals())
it('projects only a bounded digest-matching bundled image without credentials or redirects', async () => {
  const fetcher = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(bytes, { headers: { 'content-type': 'image/png' } })
  )

  vi.stubGlobal('fetch', fetcher)
  expect(await appIcon(icon, 'https://atum.test/api/matrix/v1')).toBe(
    `data:image/png;base64,${bytes.toString('base64')}`
  )
  expect(fetcher).toHaveBeenCalledWith(icon.url, expect.objectContaining({ credentials: 'omit', redirect: 'error' }))
  expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers')
})
it('uses initials for remote origins, digest mismatch, SVG or oversized content', async () => {
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', fetcher)
  expect(await appIcon({ ...icon, url: 'https://other.test/avatar' }, 'https://atum.test')).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
  expect(await appIcon({ ...icon, sha256: '0'.repeat(64) }, 'https://atum.test')).toBeNull()
  fetcher.mockImplementation(async () => new Response(bytes, { headers: { 'content-type': 'image/svg+xml' } }))
  expect(await appIcon(icon, 'https://atum.test')).toBeNull()
  fetcher.mockImplementation(
    async () => new Response(Buffer.alloc(131073), { headers: { 'content-type': 'image/png' } })
  )
  expect(await appIcon(icon, 'https://atum.test')).toBeNull()
})

it('admits only the exact production bundled-asset alias from the canonical production API', async () => {
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', fetcher)
  const asset = { ...icon, url: 'https://deployment.example.invalid/specialists/moon.png' }
  expect(await appIcon(asset, 'https://api.atumplatform.com/api/matrix/v1')).toBe(
    `data:image/png;base64,${bytes.toString('base64')}`
  )
  fetcher.mockClear()

  for (const url of [
    'https://foreign.vercel.app/moon.png',
    'http://deployment.example.invalid/moon.png',
    'https://user:secret@deployment.example.invalid/moon.png',
    asset.url + '#fragment'
  ]) {
    expect(await appIcon({ ...asset, url }, 'https://api.atumplatform.com')).toBeNull()
  }

  expect(await appIcon(asset, 'https://preview.example.com')).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})

describe('a slow or lossy link', () => {
  const resource = 'https://atum.test/api/matrix/v1'
  const ok = () => new Response(bytes, { headers: { 'content-type': 'image/png' } })
  const timedOut = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))

  /** A server that answers after `ms` of (fake) time (never, for null), unless the request is aborted first. */
  const answersAfter = (ms: number | null) => (_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const answer = ms === null ? undefined : setTimeout(() => resolve(ok()), ms)

      init.signal?.addEventListener('abort', () => {
        clearTimeout(answer)
        reject(init.signal!.reason)
      })
    })

  const expected = `data:image/png;base64,${bytes.toString('base64')}`

  it('waits for an answer that takes several seconds on a slow link', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const fetcher = vi.fn(answersAfter(8_000))
      vi.stubGlobal('fetch', fetcher)
      const sleep = vi.fn(async (_ms: number) => {})

      const pending = appIcon(icon, resource, { sleep })
      await vi.advanceTimersByTimeAsync(8_000)

      expect(await pending).toBe(expected)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons an attempt that never answers, then tries again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      fetcher.mockImplementationOnce(answersAfter(null)).mockImplementation(async () => ok())
      vi.stubGlobal('fetch', fetcher)
      const sleep = vi.fn(async (_ms: number) => {})

      const pending = appIcon(icon, resource, { sleep })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(await pending).toBe(expected)
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls[0]![1].signal!.aborted).toBe(true)
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(APP_ICON_FETCH.backoffMs.slice(0, 1))
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries one that timed out', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
    fetcher
      .mockImplementationOnce(timedOut)
      .mockImplementationOnce(timedOut)
      .mockImplementation(async () => ok())
    vi.stubGlobal('fetch', fetcher)
    const sleep = vi.fn(async (_ms: number) => {})

    expect(await appIcon(icon, resource, { sleep })).toBe(expected)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(APP_ICON_FETCH.backoffMs.slice(0, 2))
  })

  it('gives up after a few backed-off attempts, retries server trouble but not a final refusal', async () => {
    const fetcher = vi.fn(timedOut)
    vi.stubGlobal('fetch', fetcher)
    const sleep = vi.fn(async (_ms: number) => {})

    expect(await appIcon(icon, resource, { sleep })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(APP_ICON_FETCH.backoffMs.length + 1)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...APP_ICON_FETCH.backoffMs])

    const flaky = vi.fn<() => Promise<Response>>()
    flaky.mockResolvedValueOnce(new Response('busy', { status: 503 })).mockImplementation(async () => ok())
    vi.stubGlobal('fetch', flaky)
    expect(await appIcon(icon, resource, { sleep })).not.toBeNull()
    expect(flaky).toHaveBeenCalledTimes(2)

    const gone = vi.fn(async () => new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', gone)
    expect(await appIcon(icon, resource, { sleep })).toBeNull()
    expect(gone).toHaveBeenCalledTimes(1)
  })

  it('stops retrying once nobody wants the icon', async () => {
    const fetcher = vi.fn(timedOut)
    vi.stubGlobal('fetch', fetcher)
    let wanted = true

    const sleep = vi.fn(async () => {
      wanted = false
    })

    expect(await appIcon(icon, resource, { sleep, wanted: () => wanted })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('icons kept on disk', () => {
  const resource = 'https://atum.test/api/matrix/v1'
  const accountA = 'a'.repeat(64)
  const accountB = 'b'.repeat(64)
  const expected = `data:image/png;base64,${bytes.toString('base64')}`

  const sleep = async () => {}
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atum-app-icons-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('serves an icon fetched once from disk on later launches, with no network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    )
    expect(await appIcon(icon, resource, { cache: new AppIconDiskCache(root).forAccount(accountA) })).toBe(expected)

    // A later launch: a new cache over the same directory, and no network at all.
    const offline = vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
    vi.stubGlobal('fetch', offline)
    expect(await appIcon(icon, resource, { cache: new AppIconDiskCache(root).forAccount(accountA), sleep })).toBe(
      expected
    )
    expect(offline).not.toHaveBeenCalled()

    // Another account on this Mac does not read it.
    expect(await appIcon(icon, resource, { cache: new AppIconDiskCache(root).forAccount(accountB), sleep })).toBeNull()
    expect(offline).toHaveBeenCalled()
    expect(new AppIconDiskCache(root).forAccount('../escape')).toBeNull()
  })

  it('never keeps a failure: the next attempt fetches again', async () => {
    const cache = new AppIconDiskCache(root).forAccount(accountA)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
    )
    expect(await appIcon(icon, resource, { cache, sleep })).toBeNull()

    const online = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', online)
    expect(await appIcon(icon, resource, { cache, sleep })).toBe(expected)
    expect(online).toHaveBeenCalledTimes(1)
  })

  it('refetches a damaged file and never caches a refused image', async () => {
    const cache = new AppIconDiskCache(root).forAccount(accountA)!
    await cache.write(icon.sha256, 'image/png', bytes)
    const file = join(root, accountA, `${icon.sha256}.png`)
    writeFileSync(file, 'tampered')

    const online = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', online)
    expect(await appIcon(icon, resource, { cache, sleep })).toBe(expected)
    expect(online).toHaveBeenCalledTimes(1)
    expect(readFileSync(file)).toEqual(bytes)

    // Wrong type, wrong digest: nothing is written.
    const svg = { url: 'https://atum.test/icons/logo.svg', sha256: createHash('sha256').update('svg').digest('hex') }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('svg', { headers: { 'content-type': 'image/svg+xml' } }))
    )
    expect(await appIcon(svg, resource, { cache, sleep })).toBeNull()
    await cache.write(svg.sha256, 'image/svg+xml', Buffer.from('svg'))
    await cache.write('0'.repeat(64), 'image/png', bytes)
    expect(readdirSync(join(root, accountA))).toEqual([`${icon.sha256}.png`])
  })

  it('keeps only the most recently used icons within its limits', async () => {
    const cache = new AppIconDiskCache(root, { maxEntries: 2, maxBytes: 1024 * 1024 }).forAccount(accountA)!
    const images = ['one', 'two', 'three'].map(text => Buffer.from(`raster ${text}`))
    const digests = images.map(image => createHash('sha256').update(image).digest('hex'))

    for (const [index, image] of images.entries()) {
      await cache.write(digests[index]!, 'image/webp', image)
      // Distinct, increasing use times regardless of the file system's clock resolution.
      const at = new Date(Date.UTC(2026, 9, 10, 0, index))
      utimesSync(join(root, accountA, `${digests[index]}.webp`), at, at)
    }

    // One more icon: the two most recently used stay.
    const fourth = Buffer.from('raster four')
    const fourthDigest = createHash('sha256').update(fourth).digest('hex')
    await cache.write(fourthDigest, 'image/jpeg', fourth)

    expect(readdirSync(join(root, accountA)).sort()).toEqual([`${digests[2]}.webp`, `${fourthDigest}.jpg`].sort())
    expect(await cache.read(fourthDigest)).toEqual({ mime: 'image/jpeg', bytes: fourth })
    expect(await cache.read(digests[0]!)).toBeNull()
  })
})
